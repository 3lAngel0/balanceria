import type { Decision } from "./api.ts";

// Pure model of the decision explorer: the filter choices and the filtering.

/** The filter value that matches every decision. */
export const ALL = "";

export interface DecisionFilter {
	pool: string;
	role: string;
	rule: string;
}

const distinct = (values: readonly string[]) => [...new Set(values)].sort((a, b) => a.localeCompare(b));

/** Each pool, role and deciding rule of the decisions once, sorted. */
export function decisionFilters(recent: readonly Decision[]): { pool: string[]; role: string[]; rule: string[] } {
	return {
		pool: distinct(recent.map(d => d.pool)),
		role: distinct(recent.map(d => d.role)),
		rule: distinct(recent.map(d => d.decidedBy)),
	};
}

/** The decisions matching every chosen filter, in their order. */
export function filterDecisions(recent: readonly Decision[], filter: DecisionFilter): Decision[] {
	return recent.filter(
		d =>
			(filter.pool === ALL || d.pool === filter.pool) &&
			(filter.role === ALL || d.role === filter.role) &&
			(filter.rule === ALL || d.decidedBy === filter.rule),
	);
}

type SwitchCost = NonNullable<Decision["switchCost"]>;

function windowsText(list: SwitchCost["stay"]): string {
	if (list.length === 0) return "";
	return ` (${list.map(w => `${w.key} ${w.window} ${w.percent === null ? "not calibrated" : `${w.percent.toFixed(2)}%`}`).join(", ")})`;
}

/** What a move to another provider cost: cache read staying against a full resend moving, and the advice. */
export function switchCostText(c: SwitchCost): string {
	return `moved from ${c.from}: staying ${c.stayTokens.toLocaleString("en-US")} weighted tokens${windowsText(c.stay)} · moving ${c.switchTokens.toLocaleString("en-US")}${windowsText(c.switch)} · advice: ${c.advice.action} — ${c.advice.why}`;
}

/** A candidate's remaining quota as a whole percent, or a dash when unknown. */
export function remainingText(remaining: number | undefined): string {
	return remaining === undefined ? "–" : `${Math.round(remaining * 100)}%`;
}
