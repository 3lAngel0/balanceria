import { readFileSync } from "node:fs";
import { dayKey, type HistoryEntry, type QuotaError, type QuotaSample } from "./history.ts";
import { formatTokens } from "./panel.ts";
import type { Pool } from "./pools.ts";
import { routeWithTrace } from "./router.ts";
import { QuotaState } from "./state.ts";

// Pure counterfactual simulation of routing rules and pools over historical
// requests and quota telemetry. Replays history in chronological order,
// updating quota availability from recorded samples and quota-errors, and
// routes each request using the candidate rules of the draft pool.

export interface CandidateStats {
	/** `baseline` stays 0 without a baseline. */
	requests: { actual: number; baseline: number; simulated: number };
	tokens: { actual: number; baseline: number; simulated: number };
}

export interface SwitchStats {
	count: number;
	resentTokens: number;
}

export interface SwitchesStats {
	actual: SwitchStats;
	baseline: SwitchStats;
	simulated: SwitchStats;
}

export interface RoleStats {
	requests: number;
	changed: number;
}

export interface PoolSimulationReport {
	id: string;
	name: string;
	requests: number;
	/** Requests whose draft candidate differs from the baseline's, or from the actual one without a baseline. */
	changed: number;
	candidates: Record<string, CandidateStats>;
	switches: SwitchesStats;
	roles: Record<string, RoleStats>;
}

export interface SimulationOverall {
	from: number | undefined;
	to: number | undefined;
	requests: number;
	outsidePools: number;
}

export interface SimulationReport {
	/** True when the draft was compared with a baseline replayed the same way. */
	hasBaseline: boolean;
	overall: SimulationOverall;
	pools: Record<string, PoolSimulationReport>;
}

export interface SimulateInput {
	pools: readonly Pool[];
	/**
	 * The pools as they are today, replayed the same way. The replay cannot
	 * rebuild every past turn exactly, so comparing the draft with this baseline
	 * (not with what happened) isolates what the draft itself changes.
	 */
	baseline?: readonly Pool[];
	history: {
		requests: readonly HistoryEntry[];
		samples?: readonly QuotaSample[];
		errors?: readonly QuotaError[];
	};
	/** Maps a request to its selected pool id, or null when not on a pool model. */
	poolOf: (request: HistoryEntry) => string | null;
	/** The pool the baseline routes a request in; defaults to `poolOf` (a draft that moves roles between pools differs). */
	baselinePoolOf?: (request: HistoryEntry) => string | null;
	/** Agent role of the request (orchestrator, subagent name, etc.). */
	roleOf: (request: HistoryEntry) => string;
}

interface SessionPoolState {
	actualProvider: string;
	baselineProvider: string | undefined;
	simulatedProvider: string;
	contextTokens: number | null;
}

/**
 * Reads model selections from a Pi session file.
 * Returns each model_change event in chronological order.
 * A non-pool provider records `pool: null`.
 */
export function readPoolSelections(sessionFile: string): Array<{ ts: number; pool: string | null }> {
	let raw: string;
	try {
		raw = readFileSync(sessionFile, "utf8");
	} catch {
		return [];
	}

	const selections: Array<{ ts: number; pool: string | null }> = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (entry?.type !== "model_change") continue;
		const ts = typeof entry.timestamp === "string" ? new Date(entry.timestamp).getTime() : typeof entry.timestamp === "number" ? entry.timestamp : undefined;
		if (ts === undefined || Number.isNaN(ts)) continue;
		const pool = entry.provider === "pool" && typeof entry.modelId === "string" ? entry.modelId : null;
		selections.push({ ts, pool });
	}

	return selections.sort((a, b) => a.ts - b.ts);
}

/**
 * Resolves a request's pool id from the session's recorded selections.
 * Takes the last selection before or at the request timestamp; if none precede
 * it, takes the first selection recorded for the session.
 */
export function poolOfSelection(selections: readonly { ts: number; pool: string | null }[], requestTs: number): string | null {
	if (selections.length === 0) return null;
	for (let i = selections.length - 1; i >= 0; i--) {
		if (selections[i].ts <= requestTs) return selections[i].pool;
	}
	return selections[0].pool;
}

function candidateKey(provider: string, model: string): string {
	return `${provider}/${model}`;
}

function ensureCandidateStats(candidates: Record<string, CandidateStats>, key: string): CandidateStats {
	let stats = candidates[key];
	if (!stats) {
		stats = {
			requests: { actual: 0, baseline: 0, simulated: 0 },
			tokens: { actual: 0, baseline: 0, simulated: 0 },
		};
		candidates[key] = stats;
	}
	return stats;
}

/**
 * Simulates routing against historical requests and recorded quota telemetry.
 */
export function simulate(input: SimulateInput): SimulationReport {
	const poolMap = new Map<string, Pool>();
	const baselineMap = new Map((input.baseline ?? []).map(pool => [pool.id, pool]));
	const report: SimulationReport = {
		hasBaseline: input.baseline !== undefined,
		overall: { from: undefined, to: undefined, requests: 0, outsidePools: 0 },
		pools: {},
	};

	// Initialize pools from the draft config
	for (const pool of input.pools) {
		poolMap.set(pool.id, pool);
		const candidates: Record<string, CandidateStats> = {};
		for (const cand of pool.candidates) {
			ensureCandidateStats(candidates, candidateKey(cand.provider, cand.model));
		}
		report.pools[pool.id] = {
			id: pool.id,
			name: pool.name,
			requests: 0,
			changed: 0,
			candidates,
			switches: {
				actual: { count: 0, resentTokens: 0 },
				baseline: { count: 0, resentTokens: 0 },
				simulated: { count: 0, resentTokens: 0 },
			},
			roles: {},
		};
	}

	// Build unified timeline of replay events
	type TimelineEvent =
		| { kind: "sample"; ts: number; sample: QuotaSample }
		| { kind: "error"; ts: number; error: QuotaError }
		| { kind: "request"; ts: number; request: HistoryEntry };

	const timeline: TimelineEvent[] = [
		...(input.history.samples ?? []).map(sample => ({ kind: "sample" as const, ts: sample.ts, sample })),
		...(input.history.errors ?? []).map(error => ({ kind: "error" as const, ts: error.ts, error })),
		...input.history.requests.map(request => ({ kind: "request" as const, ts: request.ts, request })),
	];

	// Quota updates take precedence over requests at the same millisecond
	const KIND_ORDER = { sample: 0, error: 1, request: 2 };
	timeline.sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : KIND_ORDER[a.kind] - KIND_ORDER[b.kind]));

	const state = new QuotaState();
	// Latest usedPercent and resetAt per quota key window
	const keyWindows = new Map<string, Map<string, { usedPercent: number; resetAt: number | null }>>();
	// Session continuation state per pool
	const sessionPoolState = new Map<string, SessionPoolState>();

	for (const event of timeline) {
		if (event.kind === "sample") {
			const { key, window, usedPercent, resetAt, ts } = event.sample;
			if (!key) continue;
			let windows = keyWindows.get(key);
			if (!windows) {
				windows = new Map();
				keyWindows.set(key, windows);
			}
			windows.set(window, { usedPercent, resetAt });

			// Key availability is bounded by the most-used active window
			let maxUsed = 0;
			let maxResetAt: number | null = null;
			for (const entry of windows.values()) {
				if (entry.usedPercent > maxUsed) {
					maxUsed = entry.usedPercent;
					maxResetAt = entry.resetAt;
				}
			}
			const remainingFraction = Math.max(0, 1 - maxUsed / 100);
			state.setQuotaFraction(key, remainingFraction, maxResetAt ?? undefined, ts);
			continue;
		}

		if (event.kind === "error") {
			const { key, until, ts } = event.error;
			state.markExhausted(key, until ?? undefined, "quota-error", ts);
			continue;
		}

		const req = event.request;
		report.overall.requests++;
		if (report.overall.from === undefined || req.ts < report.overall.from) report.overall.from = req.ts;
		if (report.overall.to === undefined || req.ts > report.overall.to) report.overall.to = req.ts;

		const poolId = input.poolOf(req);
		const pool = poolId ? poolMap.get(poolId) : undefined;
		if (!pool) {
			// Unpooled models or pools absent from the draft count as outside pools
			report.overall.outsidePools++;
			continue;
		}

		const poolReport = report.pools[pool.id];
		poolReport.requests++;

		const role = input.roleOf(req);
		let roleReport = poolReport.roles[role];
		if (!roleReport) {
			roleReport = { requests: 0, changed: 0 };
			poolReport.roles[role] = roleReport;
		}
		roleReport.requests++;

		const sessionKey = `${req.session}:${pool.id}`;
		const prev = sessionPoolState.get(sessionKey);
		const isFirstInPool = prev === undefined;
		const reason = isFirstInPool ? "user" : "continuation";
		const route = (routed: Pool, previousProvider: string | undefined) =>
			routeWithTrace({
				candidates: routed.candidates,
				strategy: routed.strategy,
				rules: routed.rules,
				state,
				now: req.ts,
				reason,
				previousProvider,
				role,
			}).candidate;
		const chosen = route(pool, prev?.simulatedProvider);
		// A pool new in the draft has no baseline; its requests compare with the actual ones.
		const baselinePoolId = input.baselinePoolOf ? input.baselinePoolOf(req) : pool.id;
		const basePool = baselinePoolId ? baselineMap.get(baselinePoolId) : undefined;
		const base = basePool ? route(basePool, prev?.baselineProvider) : undefined;

		const actualKey = candidateKey(req.provider, req.model);
		const simulatedKey = candidateKey(chosen.provider, chosen.model);
		const baselineKey = base ? candidateKey(base.provider, base.model) : undefined;
		const isChanged = simulatedKey !== (report.hasBaseline && baselineKey ? baselineKey : actualKey);
		if (isChanged) {
			poolReport.changed++;
			roleReport.changed++;
		}

		const tokens = req.input + req.output + req.cacheRead + req.cacheWrite;

		const actualStats = ensureCandidateStats(poolReport.candidates, actualKey);
		actualStats.requests.actual++;
		actualStats.tokens.actual += tokens;

		if (baselineKey) {
			const baseStats = ensureCandidateStats(poolReport.candidates, baselineKey);
			baseStats.requests.baseline++;
			baseStats.tokens.baseline += tokens;
		}

		const simStats = ensureCandidateStats(poolReport.candidates, simulatedKey);
		simStats.requests.simulated++;
		simStats.tokens.simulated += tokens;

		// Track provider switches within the session in this pool
		if (prev !== undefined) {
			const resent = prev.contextTokens ?? 0;
			if (req.provider !== prev.actualProvider) {
				poolReport.switches.actual.count++;
				poolReport.switches.actual.resentTokens += resent;
			}
			if (base && prev.baselineProvider !== undefined && base.provider !== prev.baselineProvider) {
				poolReport.switches.baseline.count++;
				poolReport.switches.baseline.resentTokens += resent;
			}
			if (chosen.provider !== prev.simulatedProvider) {
				poolReport.switches.simulated.count++;
				poolReport.switches.simulated.resentTokens += resent;
			}
		}

		sessionPoolState.set(sessionKey, {
			actualProvider: req.provider,
			baselineProvider: base?.provider,
			simulatedProvider: chosen.provider,
			contextTokens: req.contextTokens,
		});
	}

	return report;
}

/**
 * Formats a simulation report into plain text.
 */
export function formatSimulation(report: SimulationReport, label: string): string {
	const lines: string[] = [];
	const columns = report.hasBaseline ? "actual · current rules → draft" : "actual → draft";
	const row = (actual: string, baseline: string, simulated: string) =>
		report.hasBaseline ? `${actual} · ${baseline} → ${simulated}` : `${actual} → ${simulated}`;
	lines.push(`=== Simulation: ${label} ===`);
	const period = report.overall.from !== undefined && report.overall.to !== undefined
		? `${dayKey(report.overall.from)} to ${dayKey(report.overall.to)}`
		: "none";
	lines.push(`Period: ${period}`);
	lines.push(`Requests: ${report.overall.requests} total (${report.overall.outsidePools} outside pools)`);
	lines.push(`Columns: ${columns}`);

	for (const pool of Object.values(report.pools)) {
		lines.push("");
		lines.push(`Pool: ${pool.id}`);
		lines.push(`  Requests: ${pool.requests} (${pool.changed} changed by the draft)`);
		const switches = (stats: SwitchStats) => `${stats.count} (${formatTokens(stats.resentTokens)} re-sent)`;
		lines.push(`  Switches: ${row(switches(pool.switches.actual), switches(pool.switches.baseline), switches(pool.switches.simulated))}`);
		lines.push("  Candidates (requests, tokens):");
		for (const [cand, stats] of Object.entries(pool.candidates)) {
			const cell = (requests: number, tokens: number) => `${requests} ${formatTokens(tokens)}`;
			lines.push(`    ${cand}: ${row(cell(stats.requests.actual, stats.tokens.actual), cell(stats.requests.baseline, stats.tokens.baseline), cell(stats.requests.simulated, stats.tokens.simulated))}`);
		}
		if (Object.keys(pool.roles).length > 0) {
			lines.push("  Roles:");
			for (const [role, stats] of Object.entries(pool.roles).sort(([a], [b]) => a.localeCompare(b))) {
				lines.push(`    ${role}: ${stats.requests} requests (${stats.changed} changed)`);
			}
		}
	}

	lines.push("");
	lines.push("Assumptions:");
	if (report.hasBaseline) lines.push("- \"changed\" compares the draft with the current rules replayed the same way, not with what happened");
	lines.push("- Same tokens on the new candidate");
	lines.push("- Recorded quota windows, not re-simulated fills");
	lines.push("- Turns after a session's first count as continuations");

	return lines.join("\n");
}
