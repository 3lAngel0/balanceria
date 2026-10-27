import type { HistoryEntry, QuotaSample } from "./history.ts";
import { quotaKeyFor } from "./pools.ts";
import type { Candidate } from "./router.ts";
import type { QuotaState } from "./state.ts";

// Switch-cost model (docs/design/control-plane.md §7, R4, D3). Each turn
// re-sends the whole context: on the same provider most of it is a cache read,
// on a new one it is sent uncached and written to a new cache. Subscription
// windows count a cache read at about a tenth of an uncached token, so the
// cost is measured in weighted tokens and, where history allows, in percent of
// each window. Pure: it advises, it never routes.

const MINUTE = 60_000;

/** D3 defaults; editable from the panel later (T16). */
export const SWITCH_DEFAULTS = {
	/** A loan applies after this long without an answer (or at the next subagent launch). */
	graceMs: 2 * MINUTE,
	/** Minimum time between two switches of one role. */
	cooldownMs: 15 * MINUTE,
	/** Under this context a switch is cheap: re-sending it costs about one ordinary turn. */
	smallContext: 30_000,
	/** With a larger context, a window that resets within this long is worth waiting for. */
	resetSoonMs: 30 * MINUTE,
};

export type SwitchPolicy = typeof SWITCH_DEFAULTS;

/** R4: how much one token of each kind counts against a subscription window. */
export const DEFAULT_WEIGHTS = { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 };

export type TokenWeights = typeof DEFAULT_WEIGHTS;

/** A window is calibrated with at least this many intervals and this R². */
export const MIN_INTERVALS = 10;
export const MIN_R2 = 0.3;
/** Two samples further apart than this are not one interval. */
const MAX_INTERVAL_MS = 30 * MINUTE;
/** Providers report a reset as "now + seconds left", so one reset jitters by under a second. */
const SAME_RESET_MS = MINUTE;

export interface WindowFit {
	key: string;
	window: string;
	intervals: number;
	/** Percent of the window per million weighted tokens; null when not calibrated. */
	percentPerMillion: number | null;
	/** Fit quality; null with too few intervals or no Pi traffic. */
	r2: number | null;
}

type Tokens = Pick<HistoryEntry, "input" | "output" | "cacheRead" | "cacheWrite">;

export function weightedTokens(tokens: Tokens, weights: TokenWeights = DEFAULT_WEIGHTS): number {
	return (
		tokens.input * weights.input +
		tokens.cacheRead * weights.cacheRead +
		tokens.cacheWrite * weights.cacheWrite +
		tokens.output * weights.output
	);
}

/**
 * Fits each window's growth against the weighted tokens Pi sent to it, from
 * pairs of consecutive samples of one reset. Windows that also move without Pi
 * traffic (shared with other clients) fit badly and stay uncalibrated.
 */
export function fitWindows(
	history: { requests: readonly HistoryEntry[]; samples: readonly QuotaSample[] },
	weights: TokenWeights = DEFAULT_WEIGHTS,
): WindowFit[] {
	const series = new Map<string, QuotaSample[]>();
	for (const sample of [...history.samples].sort((a, b) => a.ts - b.ts)) {
		if (!sample.key) continue;
		const id = `${sample.key}\n${sample.window}`;
		series.set(id, [...(series.get(id) ?? []), sample]);
	}
	const requestsByKey = new Map<string, HistoryEntry[]>();
	for (const request of history.requests) {
		const key = quotaKeyFor(request.provider, request.model);
		requestsByKey.set(key, [...(requestsByKey.get(key) ?? []), request]);
	}

	return [...series.values()].map(samples => {
		const { key, window } = samples[0] as QuotaSample & { key: string };
		const requests = requestsByKey.get(key) ?? [];
		const points: { x: number; y: number }[] = [];
		for (let i = 1; i < samples.length; i++) {
			const earlier = samples[i - 1];
			const later = samples[i];
			if (earlier.resetAt === null || later.resetAt === null || Math.abs(earlier.resetAt - later.resetAt) > SAME_RESET_MS) continue;
			if (later.ts - earlier.ts > MAX_INTERVAL_MS) continue;
			if (earlier.usedPercent >= 100 || later.usedPercent >= 100) continue;
			const y = later.usedPercent - earlier.usedPercent;
			if (y < 0) continue;
			let x = 0;
			for (const request of requests) {
				if (request.ts > earlier.ts && request.ts <= later.ts) x += weightedTokens(request, weights) / 1_000_000;
			}
			points.push({ x, y });
		}
		return { key, window, intervals: points.length, ...fit(points) };
	});
}

// Least squares through the origin: no Pi traffic, no growth.
function fit(points: { x: number; y: number }[]): { percentPerMillion: number | null; r2: number | null } {
	const sxx = points.reduce((sum, p) => sum + p.x * p.x, 0);
	if (points.length < MIN_INTERVALS || sxx === 0) return { percentPerMillion: null, r2: null };
	const slope = points.reduce((sum, p) => sum + p.x * p.y, 0) / sxx;
	const mean = points.reduce((sum, p) => sum + p.y, 0) / points.length;
	const residual = points.reduce((sum, p) => sum + (p.y - slope * p.x) ** 2, 0);
	const total = points.reduce((sum, p) => sum + (p.y - mean) ** 2, 0);
	const r2 = total === 0 ? (residual === 0 ? 1 : 0) : 1 - residual / total;
	return { percentPerMillion: r2 >= MIN_R2 ? slope : null, r2 };
}

export interface WindowCost {
	key: string;
	window: string;
	/** Percent of the window; null when the window is not calibrated. */
	percent: number | null;
}

export interface SwitchCost {
	/** Weighted tokens of the next turn's context on the current provider (cache read). */
	stayTokens: number;
	/** Weighted tokens of the same context on a new provider (sent and cached again). */
	switchTokens: number;
	stay: WindowCost[];
	switch: WindowCost[];
}

/** What the next turn's context costs if it stays, and if it moves; `from`/`to` are the windows of each side. */
export function switchCost(
	contextTokens: number | null,
	from: readonly WindowFit[],
	to: readonly WindowFit[],
	weights: TokenWeights = DEFAULT_WEIGHTS,
): SwitchCost {
	const context = contextTokens ?? 0;
	const stayTokens = context * weights.cacheRead;
	const switchTokens = context * weights.cacheWrite;
	const percentOf = (tokens: number) => (fit: WindowFit): WindowCost => ({
		key: fit.key,
		window: fit.window,
		percent: fit.percentPerMillion === null ? null : round4((tokens / 1_000_000) * fit.percentPerMillion),
	});
	return { stayTokens, switchTokens, stay: from.map(percentOf(stayTokens)), switch: to.map(percentOf(switchTokens)) };
}

export type SwitchAction = "switch" | "wait" | "propose";

export interface SwitchAdvice {
	action: SwitchAction;
	why: string;
}

/**
 * The policy table of §7: switch freely with no or a small context; with a
 * large one, wait for a window that reopens soon, else propose compacting or
 * continuing from a summary. `resetAt` is when the current window reopens.
 */
export function switchAdvice(
	input: { contextTokens: number | null; resetAt: number | null; now: number },
	policy: SwitchPolicy = SWITCH_DEFAULTS,
): SwitchAdvice {
	const { contextTokens, resetAt, now } = input;
	if (contextTokens === null) return { action: "switch", why: "no context yet (new session or right after compaction): switching is cheap" };
	const context = `context ${thousands(contextTokens)}`;
	if (contextTokens < policy.smallContext) {
		return { action: "switch", why: `${context} is under ${thousands(policy.smallContext)}: re-sending it costs about one ordinary turn` };
	}
	if (resetAt !== null && resetAt - now <= policy.resetSoonMs) {
		return { action: "wait", why: `${context} and the window resets in ${minutes(resetAt - now)}: waiting beats re-sending it uncached` };
	}
	const reset = resetAt === null ? "the reset time is unknown" : `the window resets in ${minutes(resetAt - now)}`;
	return { action: "propose", why: `${context} and ${reset}: compact then switch, or continue from a summary on another model` };
}

export interface RouteSwitchCost extends SwitchCost {
	/** "provider/model" the session leaves; the bare provider when it is not a candidate of the pool. */
	from: string;
	to: string;
	contextTokens: number | null;
	advice: SwitchAdvice;
}

/**
 * The cost of a continuation or retry that moves a session to another
 * provider, for its history row; undefined when nothing moved. The reset that
 * decides "wait" is the one of the window the session leaves.
 */
export function routeSwitchCost(input: {
	reason: string;
	previousProvider?: string;
	failedProvider?: string;
	candidates: readonly Candidate[];
	chosen: Candidate;
	contextTokens: number | null;
	state: QuotaState;
	now: number;
	fits: readonly WindowFit[];
	policy?: SwitchPolicy;
}): RouteSwitchCost | undefined {
	const previous = input.reason === "retry" ? input.failedProvider : input.reason === "continuation" ? input.previousProvider : undefined;
	if (!previous || previous === input.chosen.provider) return undefined;
	const left = input.candidates.find(candidate => candidate.provider === previous);
	const from = left ? input.fits.filter(fit => fit.key === left.quotaKey) : [];
	const to = input.fits.filter(fit => fit.key === input.chosen.quotaKey);
	const resetAt = left
		? (input.state.availableAt(left.quotaKey, input.now) ?? input.state.snapshot().get(left.quotaKey)?.resetAt ?? null)
		: null;
	return {
		from: left ? `${left.provider}/${left.model}` : previous,
		to: `${input.chosen.provider}/${input.chosen.model}`,
		contextTokens: input.contextTokens,
		...switchCost(input.contextTokens, from, to),
		advice: switchAdvice({ contextTokens: input.contextTokens, resetAt, now: input.now }, input.policy),
	};
}

/** `/balancer switch-cost`: the defaults and how well each window is calibrated. */
export function formatSwitchCostReport(fits: readonly WindowFit[], policy: SwitchPolicy = SWITCH_DEFAULTS, weights: TokenWeights = DEFAULT_WEIGHTS): string {
	const lines = [
		"ai-balancer switch cost (30 days of history)",
		`Defaults: grace ${minutes(policy.graceMs)} · cooldown ${minutes(policy.cooldownMs)} · small context under ${thousands(policy.smallContext)} · reset soon under ${minutes(policy.resetSoonMs)}`,
		`Weights per token: input ${weights.input} · cache read ${weights.cacheRead} · cache write ${weights.cacheWrite} · output ${weights.output}`,
		`A switch re-sends the context uncached (× ${weights.cacheWrite}); staying reads it from cache (× ${weights.cacheRead}).`,
	];
	if (fits.length === 0) return [...lines, "Windows: none with quota samples yet."].join("\n");
	lines.push("Windows (% of the window per million weighted tokens):");
	for (const fit of fits) {
		const name = `  ${fit.key} ${fit.window}`;
		const intervals = `${fit.intervals} interval${fit.intervals === 1 ? "" : "s"}`;
		if (fit.percentPerMillion !== null) {
			lines.push(`${name}: ${fit.percentPerMillion.toFixed(2)} %/M · R² ${fit.r2?.toFixed(2)} · ${intervals}`);
		} else if (fit.intervals < MIN_INTERVALS) {
			lines.push(`${name}: not calibrated · ${intervals} (needs ${MIN_INTERVALS})`);
		} else if (fit.r2 === null) {
			lines.push(`${name}: not calibrated · ${intervals} (no Pi traffic in them)`);
		} else {
			lines.push(`${name}: not calibrated · R² ${fit.r2.toFixed(2)} · ${intervals} (needs R² ≥ ${MIN_R2})`);
		}
	}
	return lines.join("\n");
}

function thousands(tokens: number): string {
	return `${Math.round(tokens / 1000)}k`;
}

function minutes(ms: number): string {
	return `${Math.round(ms / MINUTE)} min`;
}

function round4(value: number): number {
	return Math.round(value * 10_000) / 10_000;
}
