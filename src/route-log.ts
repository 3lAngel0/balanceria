import type { RouteDecision } from "./history.ts";
import type { RoutingRole } from "./roles.ts";
import type { Candidate, DecidedBy, RouteTrace } from "./router.ts";
import type { RouteSwitchCost } from "./switch-cost.ts";

// Decision traces for the history. Most turns repeat the previous decision
// (a sticky continuation), so a row is written only when a pool's provider or
// deciding rule changes; a turn without a row kept the last recorded decision.

export interface RoutedRequest {
	ts: number;
	session: string;
	project: string;
	pool: string;
	reason: string;
	role: RoutingRole;
	contextTokens: number | null;
	candidate: Candidate;
	trace: RouteTrace;
	switchCost?: RouteSwitchCost;
}

export function routeDecision(request: RoutedRequest): RouteDecision {
	return {
		kind: "route",
		ts: request.ts,
		session: request.session,
		project: request.project,
		pool: request.pool,
		role: request.role.role,
		roleSource: request.role.source,
		reason: request.reason,
		chosen: `${request.candidate.provider}/${request.candidate.model}`,
		decidedBy: request.trace.decidedBy,
		steps: request.trace.steps,
		candidates: request.trace.candidates,
		contextTokens: request.contextTokens,
		...(request.switchCost ? { switchCost: request.switchCost } : {}),
	};
}

/** Remembers the last decision per pool in this process. */
export class DecisionChanges {
	readonly #last = new Map<string, string>();

	/** True, and remembered, when the decision differs from the pool's last one. */
	changed(pool: string, chosen: string, decidedBy: DecidedBy): boolean {
		const key = `${chosen}\n${decidedBy}`;
		if (this.#last.get(pool) === key) return false;
		this.#last.set(pool, key);
		return true;
	}
}
