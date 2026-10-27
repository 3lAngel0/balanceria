import {
	effectiveLoan,
	expireLoans,
	preferredSpent,
	proposalBlock,
	proposeLoan,
	recommendLoan,
	type Loan,
	type LoanChange,
	type LoanStatus,
} from "./loans.ts";
import type { PriceTable } from "./prices.ts";
import type { Grant } from "./permissions.ts";
import { quotaKeyFor, type Pool } from "./pools.ts";
import { routeWithTrace, type Candidate, type RouteTrace } from "./router.ts";
import type { QuotaState } from "./state.ts";
import type { SwitchPolicy } from "./switch-cost.ts";

export interface RouteWithLoansInput {
	pool: Pool;
	pools: readonly Pool[];
	reason: "user" | "continuation" | "retry" | "direct";
	previousProvider?: string;
	previousModel?: string;
	failedProvider?: string;
	failedModel?: string;
	role?: string;
	prices?: PriceTable;
	state: QuotaState;
	now: number;
	processStartedAt: number;
	loans: readonly Loan[];
	contextTokens: number | null;
	/** Lazy: read only when preferredSpent holds, so ordinary requests read no extra files. */
	permissions: () => { grants: Grant[]; profile: string | undefined };
	policy?: SwitchPolicy;
}

export interface RouteWithLoansResult {
	candidate: Candidate;
	trace: RouteTrace;
	loans: readonly Loan[];
	changed: Loan[];
	changes: LoanChange[];
}

function formatLoanWhy(loan: Loan): string {
	const until =
		loan.endsAt === null
			? "until ended by hand"
			: `until ${new Date(loan.endsAt).toTimeString().slice(0, 5)}`;
	return `${loan.id}: ${loan.role} ${loan.from} → ${loan.to} ${until}`;
}

/**
 * Routes a pooled request taking into account active and proposed model loans
 * (docs/design/control-plane.md §8, R2 layer 1).
 *
 * Guarantees:
 * - With no loans and no trigger, returns candidate and trace deep-equal to routeWithTrace,
 *   and permissions() is never called.
 * - A turn that can stay on its provider (sticky) keeps it (S10); the loan, or its
 *   activation, waits for a turn that would move anyway.
 * - A loan target answers with its own preferred model, never with a lower-tier fallback.
 * - A proposal never changes the current request's route.
 */
export function routeWithLoans(input: RouteWithLoansInput): RouteWithLoansResult {
	const { now, state } = input;
	const expired = expireLoans(input.loans, now);
	let loans = expired.loans;
	const changes: LoanChange[] = expired.ended.map(endedLoan => {
		const orig = input.loans.find(l => l.id === endedLoan.id);
		return { from: (orig?.status ?? "active") as LoanStatus, loan: endedLoan };
	});
	const changed: Loan[] = [...expired.ended];
	const result = (routed: { candidate: Candidate; trace: RouteTrace }): RouteWithLoansResult => ({
		candidate: routed.candidate,
		trace: routed.trace,
		loans: changes.length === 0 ? input.loans : loans,
		changed,
		changes,
	});
	const routePool = (pool: Pool) =>
		routeWithTrace({
			reason: input.reason,
			candidates: pool.candidates,
			state,
			now,
			previousProvider: input.previousProvider,
			previousModel: input.previousModel,
			failedProvider: input.failedProvider,
			failedModel: input.failedModel,
			strategy: pool.strategy,
			rules: pool.rules,
			role: input.role,
			contextTokens: input.contextTokens,
			prices: input.prices,
		});

	const normal = routePool(input.pool);
	const effective = input.role
		? effectiveLoan(loans, { role: input.role, pool: input.pool.id, now, processStartedAt: input.processStartedAt }, input.policy)
		: undefined;

	if (effective) {
		const { loan } = effective;
		const skip = (why: string) => {
			normal.trace.steps.unshift({ rule: "loan", result: "skipped", why: `${loan.id}: ${why}` });
			return result(normal);
		};
		if (normal.trace.decidedBy === "sticky") return skip(`a running turn keeps its provider (${normal.candidate.provider})`);
		const loaned = routeTarget(loan.to, input.pools, state, now, routePool);
		if (!loaned) return skip(`${loan.to} is spent`);
		if (effective.changed) {
			loans = loans.map(other => (other.id === loan.id ? loan : other));
			changed.push(loan);
			changes.push({ from: "proposed", loan });
		}
		loaned.trace.steps.unshift({ rule: "loan", result: "chosen", why: formatLoanWhy(loan) });
		loaned.trace.decidedBy = "loan";
		return result(loaned);
	}

	// The trigger: propose a loan for later turns; this one keeps the pool's route.
	if (input.role && preferredSpent(input.pool, state, now)) {
		const blockReason = proposalBlock(loans, input.role, input.pool.id, now, input.policy);
		if (blockReason) {
			normal.trace.steps.unshift({ rule: "loan", result: "skipped", why: blockReason });
			return result(normal);
		}
		const { grants, profile } = input.permissions();
		const proposal = profile
			? recommendLoan({
					pool: input.pool,
					pools: input.pools,
					role: input.role,
					profile,
					grants,
					state,
					now,
					contextTokens: input.contextTokens,
					policy: input.policy,
				})
			: undefined;
		const proposed = proposal ? proposeLoan(loans, proposal, now) : undefined;
		if (proposed?.loan) {
			loans = proposed.loans;
			changed.push(proposed.loan);
			changes.push({ from: "new", loan: proposed.loan });
		}
	}
	return result(normal);
}

// The route of a loan target, or undefined when its own preferred model cannot answer.
function routeTarget(
	to: string,
	pools: readonly Pool[],
	state: QuotaState,
	now: number,
	routePool: (pool: Pool) => { candidate: Candidate; trace: RouteTrace },
): { candidate: Candidate; trace: RouteTrace } | undefined {
	if (to.startsWith("pool/")) {
		const pool = pools.find(candidate => `pool/${candidate.id}` === to);
		if (!pool || preferredSpent(pool, state, now)) return undefined;
		// Restrict the target to its preferred model so a loan never lands on its fallback.
		const model = pool.candidates[0].model;
		return routePool({ ...pool, candidates: pool.candidates.filter(candidate => candidate.model === model) });
	}
	const slash = to.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = to.slice(0, slash);
	const model = to.slice(slash + 1);
	const quotaKey = quotaKeyFor(provider, model);
	if (!state.isAvailable(quotaKey, now)) return undefined;
	const remaining = state.remainingFraction(quotaKey);
	return {
		candidate: { provider, model, quotaKey },
		trace: {
			decidedBy: "loan",
			steps: [],
			candidates: [{ provider, quotaKey, available: true, ...(remaining !== undefined ? { remaining } : {}) }],
		},
	};
}
