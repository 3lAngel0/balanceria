import { priceFor, type PriceTable } from "./prices.ts";
import type { QuotaState } from "./state.ts";

// Pure routing policy for one virtual model.
// Strategies:
// - "waterfall": Spends candidate 1 completely before moving to candidate 2.
// - "highest-quota": Selects the candidate with the highest remaining quota fraction on initial turns.
// - "hybrid": Prioritizes highest remaining quota fraction on initial session turns, but preserves
//   stickiness for continuations to protect prompt caching.

export type RoutingStrategy = "waterfall" | "highest-quota" | "hybrid";

export interface Candidate {
	provider: string;
	model: string;
	quotaKey: string;
}

export interface RouteInput {
	reason: "user" | "continuation" | "retry" | "direct";
	candidates: readonly Candidate[];
	state: QuotaState;
	now: number;
	/** Provider of the latest successful response, for continuations. */
	previousProvider?: string;
	/** Model of the latest successful response; narrows `previousProvider` when the pool has that exact model. */
	previousModel?: string;
	/** Provider of the failed request, for retries. */
	failedProvider?: string;
	/** Model of the failed request; narrows `failedProvider` when the pool has that exact model. */
	failedModel?: string;
	/** Routing strategy (defaults to "hybrid"); ignored when `rules` is given. */
	strategy?: RoutingStrategy;
	/** The pool's rule pipeline; without it the default list of `strategy` decides. */
	rules?: readonly RuleBlock[];
	/** Agent role of the session asking, for `prefer-for-role`. */
	role?: string;
	/** Tokens in the session context, for `prefer-for-context`; unknown when null or absent. */
	contextTokens?: number | null;
	/** API list prices, for `pick: lowest-cost`; without them that pick behaves as `highest-quota`. */
	prices?: PriceTable;
}

// One block of a pool's rule pipeline (docs/design/control-plane.md §6), run in
// order until one chooses. Two guarantees are not blocks and cannot be removed:
// a spent window is never chosen, and when no block chooses, the window that
// reopens first is the fallback.
export type RuleBlock =
	| { rule: "sticky" }
	| { rule: "prefer-for-role"; role: string; candidate: string }
	| { rule: "prefer-for-context"; candidate: string; minTokens?: number; maxTokens?: number }
	| { rule: "pick"; mode: PickMode };

export type PickMode = "first" | "highest-quota" | "lowest-cost";

/** The rule list that reproduces a strategy: sticky, then its pick. */
export function defaultRules(strategy: RoutingStrategy | undefined): RuleBlock[] {
	return [{ rule: "sticky" }, { rule: "pick", mode: strategy === "waterfall" ? "first" : "highest-quota" }];
}

/** The rule that settled a route; names match the rule pipeline of docs/design/control-plane.md. */
export type DecidedBy = "sticky" | "prefer-for-role" | "prefer-for-context" | "waterfall" | "direct" | "highest-quota" | "lowest-cost" | "fallback" | "loan";

export interface TraceStep {
	rule: "sticky" | "available" | "prefer-for-role" | "prefer-for-context" | "pick" | "fallback" | "loan";
	/** "chosen", "skipped", or for `available` the count, e.g. "2 of 3". */
	result: string;
	why: string;
}

export interface CandidateState {
	provider: string;
	quotaKey: string;
	available: boolean;
	/** Last known remaining fraction (0..1), when recorded. */
	remaining?: number;
	/** Epoch ms when a spent window reopens. */
	availableAt?: number;
}

export interface RouteTrace {
	decidedBy: DecidedBy;
	steps: TraceStep[];
	candidates: CandidateState[];
}

export function chooseCandidate(input: RouteInput): Candidate {
	return routeWithTrace(input).candidate;
}

/** The routing decision plus why it was taken; the trace never changes the choice. */
export function routeWithTrace(input: RouteInput): { candidate: Candidate; trace: RouteTrace } {
	const { candidates, state, now } = input;
	if (candidates.length === 0) throw new Error("ai-balancer: a pool needs at least one candidate");
	const rules = input.rules ?? defaultRules(input.strategy);
	const available = (candidate: Candidate) => state.isAvailable(candidate.quotaKey, now);
	// A provider may serve several models of a pool: prefer the exact model, else the first of the provider.
	const byProvider = (provider: string | undefined, model?: string) =>
		(model === undefined ? undefined : candidates.find(candidate => candidate.provider === provider && candidate.model === model)) ??
		candidates.find(candidate => candidate.provider === provider);
	const spentUntil = (candidate: Candidate) => `${label(candidate)} spent until ${isoTime(state.availableAt(candidate.quotaKey, now))}`;
	const steps: TraceStep[] = [];
	const done = (candidate: Candidate, decidedBy: DecidedBy) => ({
		candidate,
		trace: { decidedBy, steps, candidates: candidates.map(c => candidateState(c, input)) },
	});

	const availableCandidates = candidates.filter(available);
	// Counted once, before the first block that is not sticky, as the router always has.
	let counted = false;
	const countAvailable = () => {
		if (counted) return;
		counted = true;
		const spent = candidates.filter(candidate => !available(candidate));
		steps.push({
			rule: "available",
			result: `${availableCandidates.length} of ${candidates.length}`,
			why: spent.length === 0 ? "no window is spent" : spent.map(spentUntil).join("; "),
		});
	};

	for (const block of rules) {
		if (block.rule === "sticky") {
			// Stay on the provider that handled the turn while it can still answer:
			// this keeps prompt caches and thinking signatures valid.
			if (input.reason !== "retry" && input.reason !== "continuation") continue;
			const previous = input.reason === "retry" ? input.failedProvider : input.previousProvider;
			const sticky = input.reason === "retry" ? byProvider(previous, input.failedModel) : byProvider(previous, input.previousModel);
			if (sticky && available(sticky)) {
				steps.push({ rule: "sticky", result: "chosen", why: `${sticky.provider} answered the previous turn and is available` });
				return done(sticky, "sticky");
			}
			const why = sticky ? spentUntil(sticky) : previous === undefined ? "no previous provider" : `${previous} is not in this pool`;
			steps.push({ rule: "sticky", result: "skipped", why });
			continue;
		}

		countAvailable();
		if (block.rule === "prefer-for-role") {
			const preferred = candidates.find(candidate => label(candidate) === block.candidate);
			let why: string;
			if (input.role !== block.role) why = `role is ${input.role ?? "unknown"}, not ${block.role}`;
			else if (!preferred) why = `${block.candidate} is not in this pool`;
			else if (!available(preferred)) why = spentUntil(preferred);
			else {
				steps.push({ rule: "prefer-for-role", result: "chosen", why: `role ${block.role} prefers ${block.candidate}` });
				return done(preferred, "prefer-for-role");
			}
			steps.push({ rule: "prefer-for-role", result: "skipped", why });
			continue;
		}

		if (block.rule === "prefer-for-context") {
			const preferred = candidates.find(candidate => label(candidate) === block.candidate);
			const tokens = input.contextTokens;
			let why: string;
			let reason: string | undefined;
			if (tokens === null || tokens === undefined) why = "context size is unknown";
			else if (block.minTokens !== undefined && tokens < block.minTokens) why = `context ${tokens} tokens is below ${block.minTokens}`;
			else if (block.maxTokens !== undefined && tokens >= block.maxTokens) why = `context ${tokens} tokens is not below ${block.maxTokens}`;
			else if (!preferred) why = `${block.candidate} is not in this pool`;
			else if (!available(preferred)) why = spentUntil(preferred);
			else {
				reason = block.minTokens !== undefined ? `at least ${block.minTokens}` : `below ${block.maxTokens}`;
				steps.push({ rule: "prefer-for-context", result: "chosen", why: `context ${tokens} tokens is ${reason}, prefers ${block.candidate}` });
				return done(preferred, "prefer-for-context");
			}
			steps.push({ rule: "prefer-for-context", result: "skipped", why });
			continue;
		}

		// pick: the last block; with nothing available the fallback below decides.
		if (availableCandidates.length === 0) break;
		if (input.reason === "direct") {
			steps.push({ rule: "pick", result: "chosen", why: "direct request: first available in pool order" });
			return done(availableCandidates[0], "direct");
		}
		if (block.mode === "first") {
			steps.push({ rule: "pick", result: "chosen", why: "first available in pool order" });
			return done(availableCandidates[0], "waterfall");
		}

		// After an expensive model fails, a retry stays below its price while a cheaper one can answer; otherwise quota decides.
		const cheaper = input.reason === "retry" ? cheaperThanFailed(availableCandidates, byProvider(input.failedProvider, input.failedModel), input.prices) : undefined;
		const pickFrom = cheaper ?? availableCandidates;
		if (block.mode === "lowest-cost") {
			const cheapest = cheapestCandidates(pickFrom, input.prices);
			if (cheapest) {
				const best = bestByQuota(cheapest.tied, state);
				steps.push({ rule: "pick", result: "chosen", why: costComparison(best, cheapest.tied, pickFrom, cheapest.rate) });
				return done(best, "lowest-cost");
			}
			// A candidate without a price cannot be ranked: keep the quota-based pick.
		}

		// Highest known remaining fraction; without fraction data or on a tie the
		// pool order decides.
		const bestCandidate = bestByQuota(pickFrom, state);
		steps.push({
			rule: "pick",
			result: "chosen",
			why: quotaComparison(bestCandidate, pickFrom, state) + (cheaper ? `; retry stays below the rate of ${label(byProvider(input.failedProvider, input.failedModel)!)}` : ""),
		});
		return done(bestCandidate, "highest-quota");
	}
	countAvailable();

	// Every window is spent: pick the one that reopens first, so the request
	// fails with that provider's own message instead of a made-up one.
	const reopensFirst = [...candidates].sort(
		(a, b) => (state.availableAt(a.quotaKey, now) ?? 0) - (state.availableAt(b.quotaKey, now) ?? 0),
	)[0];
	steps.push({
		rule: "fallback",
		result: "chosen",
		why: `every window is spent; ${label(reopensFirst)} reopens first at ${isoTime(state.availableAt(reopensFirst.quotaKey, now))}`,
	});
	return done(reopensFirst, "fallback");
}

/**
 * Another way out of a spent window: the first candidate on a different quota key that can still answer.
 * The key, not the provider, tells windows apart: one provider can serve models of several windows.
 */
export function failoverAlternative(candidates: readonly Candidate[], failedQuotaKey: string, state: QuotaState, now?: number): Candidate | undefined {
	return candidates.find(candidate => candidate.quotaKey !== failedQuotaKey && state.isAvailable(candidate.quotaKey, now));
}

/** Highest known remaining fraction; the first in order wins ties and unknown fractions. */
function bestByQuota(candidates: readonly Candidate[], state: QuotaState): Candidate {
	let best = candidates[0];
	let bestFraction = state.remainingFraction(best.quotaKey) ?? -1;
	for (let i = 1; i < candidates.length; i++) {
		const fraction = state.remainingFraction(candidates[i].quotaKey) ?? -1;
		if (fraction > bestFraction) {
			best = candidates[i];
			bestFraction = fraction;
		}
	}
	return best;
}

/** Input plus output USD per million tokens, or undefined when the model has no price. */
function costRate(candidate: Candidate, prices: PriceTable): number | undefined {
	const price = priceFor(prices, candidate.model);
	return price ? price.input + price.output : undefined;
}

/** Input plus output USD per million tokens above which a failed model counts as expensive (Opus, Fable; not Sonnet or Argon). */
export const EXPENSIVE_RATE = 15;

/** The available candidates priced strictly below an expensive failed model, or undefined when it was not expensive, none is cheaper or a price is unknown. */
function cheaperThanFailed(available: readonly Candidate[], failed: Candidate | undefined, prices: PriceTable | undefined): Candidate[] | undefined {
	if (!failed || !prices) return undefined;
	const failedRate = costRate(failed, prices);
	if (failedRate === undefined || failedRate <= EXPENSIVE_RATE) return undefined;
	const cheaper = available.filter(candidate => {
		const rate = costRate(candidate, prices);
		return rate !== undefined && rate < failedRate;
	});
	return cheaper.length > 0 ? cheaper : undefined;
}

/** The candidates tied at the lowest rate, or undefined when any of them cannot be priced. */
function cheapestCandidates(candidates: readonly Candidate[], prices: PriceTable | undefined): { rate: number; tied: Candidate[] } | undefined {
	if (!prices) return undefined;
	const rates = candidates.map(candidate => costRate(candidate, prices));
	if (rates.some(rate => rate === undefined)) return undefined;
	const rate = Math.min(...(rates as number[]));
	return { rate, tied: candidates.filter((_, i) => rates[i] === rate) };
}

function costComparison(chosen: Candidate, tied: readonly Candidate[], available: readonly Candidate[], rate: number): string {
	const base = `${label(chosen)} has the lowest rate ($${rate} per million input plus output tokens)`;
	if (available.length === 1) return `${label(chosen)} is the only available candidate`;
	return tied.length > 1 ? `${base}; ${tied.length} tied, most quota wins` : base;
}

function candidateState(candidate: Candidate, input: RouteInput): CandidateState {
	const remaining = input.state.remainingFraction(candidate.quotaKey);
	const availableAt = input.state.availableAt(candidate.quotaKey, input.now);
	return {
		provider: candidate.provider,
		quotaKey: candidate.quotaKey,
		available: input.state.isAvailable(candidate.quotaKey, input.now),
		...(remaining === undefined ? {} : { remaining }),
		...(availableAt === undefined ? {} : { availableAt }),
	};
}

// "claude-bridge 0.62 > antigravity 0.30", or "=" with the pool order when the
// winner is not strictly ahead of the runner-up.
function quotaComparison(chosen: Candidate, availableCandidates: readonly Candidate[], state: QuotaState): string {
	const fraction = (candidate: Candidate) => {
		const value = state.remainingFraction(candidate.quotaKey);
		return value === undefined ? "unknown" : value.toFixed(2);
	};
	const others = availableCandidates.filter(candidate => candidate !== chosen);
	if (others.length === 0) return `${label(chosen)} is the only available candidate`;
	const rank = (candidate: Candidate) => state.remainingFraction(candidate.quotaKey) ?? -1;
	const runnerUp = others.reduce((best, candidate) => (rank(candidate) > rank(best) ? candidate : best));
	if (rank(chosen) > rank(runnerUp)) return `${label(chosen)} ${fraction(chosen)} > ${label(runnerUp)} ${fraction(runnerUp)}`;
	return `${label(chosen)} ${fraction(chosen)} = ${label(runnerUp)} ${fraction(runnerUp)}: first in pool order`;
}

// One provider may serve several models of a pool, so traces name both.
function label(candidate: Candidate): string {
	return `${candidate.provider}/${candidate.model}`;
}

function isoTime(ms: number | undefined): string {
	return ms === undefined ? "unknown" : new Date(ms).toISOString();
}
