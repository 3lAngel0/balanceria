import type { WindowConsumption } from "./consumption.ts";
import { topConsumers } from "./consumers.ts";
import type { HistoryEntry, QuotaError } from "./history.ts";
import { CONTEXT_WARN_TOKENS, formatTokens } from "./panel.ts";
import { priceFor, requestCost, type PriceTable } from "./prices.ts";
import { ORCHESTRATOR_ROLE, resolveRole, type AgentTask } from "./roles.ts";
import { formatUsd } from "./usage-panel.ts";

// Optimization suggestions for the HUD. Each one names its evidence and an
// estimated saving; none changes anything, and none knows whether quality
// would hold, so every suggestion carries QUALITY_NOTE.
//
// Rules, in the order they are listed:
// - large-context: a session sent at least LARGE_MIN_REQUESTS requests whose
//   prompt (input + cacheRead + cacheWrite) reached CONTEXT_WARN_TOKENS.
//   Saving: the tokens above that line, a lower bound because compacting
//   drops the context well below it; USD at the model's cache-read rate.
// - provider-switch: inside a session the provider or model changed and the
//   requests right after each change re-sent at least SWITCH_MIN_TOKENS as
//   input + cacheWrite. Saving: those tokens; USD is what writing them cost
//   on the new model above reading them from its cache.
// - expensive-role: a subagent role ran at least ROLE_MIN_SESSIONS sessions
//   on one model with a median output per session of at most
//   SMALL_OUTPUT_TOKENS, and the same tokens on the cheapest priced model
//   already used in the history cost at most half. Saving: the USD difference.
// - idle-quota: a subscription window projects at least IDLE_MIN_PERCENT unused
//   at its reset (current % plus pace times hours left; no pace counts as
//   zero) while a window of another quota fills before its own reset.
//   Saving: the percent that would expire unused.
// - pool-bypass: a session hit a quota that an earlier error had already
//   marked spent past that moment, and the quota is a candidate of a pool.
//   The call named the model itself (a profile or a manual pick), so the
//   balancer never routed it. One per role and quota, on its latest session.
//   No saving: the cost is a failed call, not tokens.

export const QUALITY_NOTE = "Quality is not measured: compare the results before adopting this.";

const HOUR_MS = 3_600_000;
const LARGE_MIN_REQUESTS = 5;
const SWITCH_MIN_TOKENS = 100_000;
const ROLE_MIN_SESSIONS = 3;
const SMALL_OUTPUT_TOKENS = 2_000;
const ROLE_MIN_COST_RATIO = 2;
const IDLE_MIN_PERCENT = 50;

export type SuggestionRule = "large-context" | "provider-switch" | "expensive-role" | "idle-quota" | "pool-bypass";

export interface SuggestionTarget {
	session?: string;
	alias?: string | null;
	role?: string;
	model?: string;
	cheaperModel?: string;
	quotaKey?: string;
	window?: string;
}

export interface Saving {
	tokens: number | null;
	/** API-equivalent USD; null when a model involved has no price. */
	usd: number | null;
	quotaPercent: number | null;
}

export interface Suggestion {
	rule: SuggestionRule;
	title: string;
	target: SuggestionTarget;
	evidence: string[];
	saving: Saving;
	quality: string;
}

export interface SuggestionInput {
	requests: readonly HistoryEntry[];
	tasks: ReadonlyMap<string, AgentTask>;
	/** Current subscription windows, as summarizeConsumption reports them. */
	windows: readonly WindowConsumption[];
	prices: PriceTable;
	now: number;
	/** Quota errors, oldest first or not; read only by pool-bypass. */
	errors?: readonly QuotaError[];
	/** Pools and the quotas they route between; read only by pool-bypass. */
	pools?: readonly { id: string; candidates: readonly { quotaKey: string }[] }[];
	/** Names a session that has no name or task label (e.g. its first message); asked only for suggested sessions. */
	resolveAlias?: (session: string) => string | null;
}

function promptOf(request: HistoryEntry): number {
	return request.input + request.cacheRead + request.cacheWrite;
}

function suggestion(rule: SuggestionRule, title: string, target: SuggestionTarget, evidence: string[], saving: Partial<Saving>): Suggestion {
	return { rule, title, target, evidence, saving: { tokens: null, usd: null, quotaPercent: null, ...saving }, quality: QUALITY_NOTE };
}

function bySaving(a: Suggestion, b: Suggestion): number {
	return (b.saving.usd ?? 0) - (a.saving.usd ?? 0) || (b.saving.tokens ?? 0) - (a.saving.tokens ?? 0) || (b.saving.quotaPercent ?? 0) - (a.saving.quotaPercent ?? 0);
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const item of items) {
		const key = keyOf(item);
		const group = groups.get(key);
		if (group) group.push(item);
		else groups.set(key, [item]);
	}
	return groups;
}

interface SessionInfo {
	alias: string | null;
	role: string;
}

type DescribeSession = (session: string) => SessionInfo;

function sessionLabel(session: string, info: SessionInfo): string {
	return info.alias ?? session.slice(0, 8);
}

function largeContext(sessions: Map<string, HistoryEntry[]>, describe: DescribeSession, prices: PriceTable): Suggestion[] {
	const found: Suggestion[] = [];
	for (const [session, requests] of sessions) {
		const large = requests.filter(request => promptOf(request) >= CONTEXT_WARN_TOKENS);
		if (large.length < LARGE_MIN_REQUESTS) continue;
		let excess = 0;
		let usd: number | null = 0;
		for (const request of large) {
			const extra = promptOf(request) - CONTEXT_WARN_TOKENS;
			excess += extra;
			const price = priceFor(prices, request.model);
			usd = price && usd !== null ? usd + (extra * price.cacheRead) / 1e6 : null;
		}
		const peak = Math.max(...requests.map(request => request.contextTokens ?? promptOf(request)));
		const target = describe(session);
		found.push(
			suggestion(
				"large-context",
				`Compact or split "${sessionLabel(session, target)}"`,
				{ session, alias: target.alias, role: target.role },
				[
					`${large.length} of ${requests.length} requests sent at least ${CONTEXT_WARN_TOKENS / 1000}k tokens of context`,
					`peak context ${formatTokens(peak)} tokens`,
					`${formatTokens(excess)} tokens re-sent above ${CONTEXT_WARN_TOKENS / 1000}k`,
				],
				{ tokens: excess, usd },
			),
		);
	}
	return found;
}

function providerSwitch(sessions: Map<string, HistoryEntry[]>, describe: DescribeSession, prices: PriceTable): Suggestion[] {
	const found: Suggestion[] = [];
	for (const [session, requests] of sessions) {
		let switches = 0;
		let rewritten = 0;
		let usd: number | null = 0;
		for (let index = 1; index < requests.length; index++) {
			const previous = requests[index - 1];
			const request = requests[index];
			if (request.provider === previous.provider && request.model === previous.model) continue;
			switches += 1;
			rewritten += request.input + request.cacheWrite;
			const price = priceFor(prices, request.model);
			usd = price && usd !== null ? usd + (request.input * (price.input - price.cacheRead) + request.cacheWrite * (price.cacheWrite - price.cacheRead)) / 1e6 : null;
		}
		if (rewritten < SWITCH_MIN_TOKENS) continue;
		const target = describe(session);
		found.push(
			suggestion(
				"provider-switch",
				`Keep "${sessionLabel(session, target)}" on one model`,
				{ session, alias: target.alias, role: target.role },
				[
					`${switches} provider or model ${switches === 1 ? "switch" : "switches"} inside the session`,
					`${formatTokens(rewritten)} tokens re-sent without cache after switching`,
					"failover after an exhausted quota also switches; those switches are expected",
				],
				{ tokens: rewritten, usd },
			),
		);
	}
	return found;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Sum of requestCost, or undefined when any request has no price. */
function totalCost(prices: PriceTable, requests: readonly HistoryEntry[], model?: string): number | undefined {
	let total = 0;
	for (const request of requests) {
		const cost = requestCost(prices, model ? { ...request, model } : request);
		if (cost === undefined) return undefined;
		total += cost;
	}
	return total;
}

function expensiveRole(requests: readonly HistoryEntry[], tasks: ReadonlyMap<string, AgentTask>, prices: PriceTable): Suggestion[] {
	const pricedModels = [...new Set(requests.map(request => request.model))].filter(model => priceFor(prices, model));
	const found: Suggestion[] = [];
	const byRoleAndModel = groupBy(
		requests.filter(request => resolveRole(request, tasks) !== ORCHESTRATOR_ROLE),
		request => `${resolveRole(request, tasks)}\u0000${request.model}`,
	);
	for (const [key, group] of byRoleAndModel) {
		const [role, model] = key.split("\u0000");
		const outputs = [...groupBy(group, request => request.session).values()].map(session => session.reduce((sum, request) => sum + request.output, 0));
		if (outputs.length < ROLE_MIN_SESSIONS) continue;
		const medianOutput = median(outputs);
		if (medianOutput > SMALL_OUTPUT_TOKENS) continue;
		const current = totalCost(prices, group);
		if (current === undefined) continue;
		let cheapest: { model: string; cost: number } | undefined;
		for (const candidate of pricedModels) {
			if (candidate === model) continue;
			const cost = totalCost(prices, group, candidate)!;
			if (!cheapest || cost < cheapest.cost) cheapest = { model: candidate, cost };
		}
		if (!cheapest || current < ROLE_MIN_COST_RATIO * cheapest.cost) continue;
		found.push(
			suggestion(
				"expensive-role",
				`Try ${cheapest.model} for ${role}`,
				{ role, model, cheaperModel: cheapest.model },
				[
					`${outputs.length} sessions with a median output of ${formatTokens(medianOutput)} tokens`,
					`API-equivalent cost on ${model}: ${formatUsd(current)}`,
					`same tokens on ${cheapest.model}, already used here: ${formatUsd(cheapest.cost)}`,
				],
				{ usd: current - cheapest.cost },
			),
		);
	}
	return found;
}

function formatHours(hours: number): string {
	return hours < 48 ? `${Math.round(hours)}h` : `${Math.round(hours / 24)}d`;
}

function idleQuota(windows: readonly WindowConsumption[], now: number): Suggestion[] {
	const found: Suggestion[] = [];
	for (const window of windows) {
		if (window.resetAt === null || window.resetAt <= now) continue;
		const hours = (window.resetAt - now) / HOUR_MS;
		const projected = Math.min(100, window.usedPercent + (window.pace?.percentPerHour ?? 0) * hours);
		const unused = Math.round(100 - projected);
		if (unused < IDLE_MIN_PERCENT) continue;
		const filling = windows.filter(other => other.key !== window.key && other.pace?.fillsBeforeReset);
		if (filling.length === 0) continue;
		found.push(
			suggestion(
				"idle-quota",
				`Move work to ${window.key} before it resets`,
				{ quotaKey: window.key, window: window.window },
				[
					`${window.key} ${window.window}: ${Math.round(window.usedPercent)}% used, about ${Math.round(projected)}% at reset in ${formatHours(hours)}`,
					...filling.map(other => `${other.key} ${other.window} fills before its reset`),
				],
				{ quotaPercent: unused },
			),
		);
	}
	return found;
}

function poolBypass(errors: readonly QuotaError[], pools: NonNullable<SuggestionInput["pools"]>, tasks: ReadonlyMap<string, AgentTask>): Suggestion[] {
	const latest = new Map<string, Suggestion>();
	const sorted = [...errors].sort((a, b) => a.ts - b.ts);
	sorted.forEach((error, index) => {
		const routing = pools.filter(pool => pool.candidates.some(candidate => candidate.quotaKey === error.key));
		if (routing.length === 0) return;
		const known = sorted.slice(0, index).find(earlier => earlier.key === error.key && earlier.ts < error.ts && earlier.until !== null && earlier.until > error.ts);
		if (!known || known.until === null) return;
		const role = resolveRole(error, tasks);
		const reopens = error.until ?? known.until;
		latest.set(
			`${role}\u0000${error.key}`,
			suggestion(
				"pool-bypass",
				`${role} called ${error.key} directly while it was spent`,
				{ session: error.session, alias: tasks.get(error.session)?.label ?? null, role, quotaKey: error.key },
				[
					`${error.key} was known spent for ${formatHours((error.ts - known.ts) / HOUR_MS)} before this call and reopens ${formatHours((reopens - error.ts) / HOUR_MS)} after it`,
					"the call named the model itself, so the balancer never got to choose",
					`${routing.map(pool => `pool/${pool.id}`).join(" or ")} would have routed around it`,
				],
				{},
			),
		);
	});
	return [...latest.values()];
}

export function suggestOptimizations(input: SuggestionInput): Suggestion[] {
	const { requests, tasks, windows, prices, now, resolveAlias, errors = [], pools = [] } = input;
	const info = new Map<string, SessionInfo>();
	for (const role of topConsumers(requests, tasks)) {
		for (const session of role.sessions) info.set(session.session, { alias: session.alias, role: role.role });
	}
	const describe: DescribeSession = session => {
		const found = info.get(session)!;
		if (found.alias === null && resolveAlias) found.alias = resolveAlias(session);
		return found;
	};
	const sessions = groupBy(
		[...requests].sort((a, b) => a.ts - b.ts),
		request => request.session,
	);
	return [
		...largeContext(sessions, describe, prices).sort(bySaving),
		...providerSwitch(sessions, describe, prices).sort(bySaving),
		...expensiveRole(requests, tasks, prices).sort(bySaving),
		...idleQuota(windows, now).sort(bySaving),
		...poolBypass(errors, pools, tasks),
	];
}
