import test from "node:test";
import assert from "node:assert/strict";
import { routeWithLoans } from "../src/loan-routing.ts";
import { routeWithTrace } from "../src/router.ts";
import { QuotaState } from "../src/state.ts";
import type { Pool } from "../src/pools.ts";
import type { Grant } from "../src/permissions.ts";
import { proposalBlock, type Loan } from "../src/loans.ts";

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 22, 15, 0, 0);

const OPUS: Pool = {
	id: "opus",
	name: "Opus",
	candidates: [
		{ provider: "antigravity", model: "claude-opus-5-5", quotaKey: "antigravity/claude" },
		{ provider: "claude-bridge", model: "claude-opus-5-5", quotaKey: "claude-bridge/claude" },
		{ provider: "antigravity", model: "gemini-4-argon", quotaKey: "antigravity/gemini-4-argon" },
	],
};

const ORCHESTRATOR: Pool = {
	id: "orchestrator",
	name: "Orchestrator",
	candidates: [
		{ provider: "antigravity", model: "gemini-4-argon", quotaKey: "antigravity/gemini-4-argon" },
		{ provider: "antigravity", model: "gemini-3-8-flash", quotaKey: "antigravity/gemini" },
	],
};

const FLASH: Pool = {
	id: "flash",
	name: "Flash",
	candidates: [
		{ provider: "antigravity", model: "gemini-3-8-flash", quotaKey: "antigravity/gemini" },
	],
};

const POOLS = [OPUS, ORCHESTRATOR, FLASH];

function grant(overrides: Partial<Grant> = {}): Grant {
	return {
		id: "g-1",
		level: "auto",
		profiles: ["default"],
		roles: ["gentle-ai-apply"],
		models: ["pool/opus", "pool/orchestrator", "pool/flash", "antigravity/gemini-4-argon"],
		grantedAt: T0 - 60 * MIN,
		expiresAt: T0 + 24 * 60 * MIN,
		...overrides,
	};
}

function spentOpus(): QuotaState {
	const state = new QuotaState();
	state.markExhausted("antigravity/claude", T0 + 40 * MIN, "quota-error", T0);
	state.markExhausted("claude-bridge/claude", T0 + 25 * MIN, "quota-error", T0);
	state.setQuotaFraction("antigravity/gemini-4-argon", 0.3, undefined, T0);
	state.setQuotaFraction("antigravity/gemini", 0.8, undefined, T0);
	return state;
}

function baseLoan(overrides: Partial<Loan> = {}): Loan {
	return {
		id: "loan-20261022150000-gentle-ai-apply",
		status: "active",
		profile: "default",
		role: "gentle-ai-apply",
		pool: "opus",
		from: "pool/opus",
		to: "pool/flash",
		alternatives: ["pool/orchestrator"],
		level: "auto",
		grantId: "g-1",
		why: "opus: claude-opus-5-5 is spent; it reopens at 2026-10-22T15:25:00.000Z",
		advice: { action: "switch", why: "context under 30k" },
		proposedAt: T0 - 5 * MIN,
		endsAt: T0 + 25 * MIN,
		decidedAt: T0 - 3 * MIN,
		decidedBy: "grace",
		...overrides,
	};
}

test("(a) no loans + nothing spent equals routeWithTrace exactly; permissions never called", () => {
	const state = new QuotaState();
	let permissionsCalled = false;
	const permissions = () => {
		permissionsCalled = true;
		return { grants: [grant()], profile: "default" };
	};
	const input = {
		pool: OPUS,
		pools: POOLS,
		reason: "user" as const,
		role: "gentle-ai-apply",
		state,
		now: T0,
		processStartedAt: T0 - 10 * MIN,
		loans: [] as Loan[],
		contextTokens: 12_000,
		permissions,
	};
	const result = routeWithLoans(input);
	const expected = routeWithTrace({
		reason: "user",
		candidates: OPUS.candidates,
		state,
		now: T0,
		strategy: OPUS.strategy,
		rules: OPUS.rules,
		role: "gentle-ai-apply",
	});
	assert.deepEqual(result.candidate, expected.candidate);
	assert.deepEqual(result.trace, expected.trace);
	assert.equal(result.changed.length, 0);
	assert.equal(result.loans, input.loans);
	assert.equal(permissionsCalled, false, "permissions must not be called when preferred candidate is available");
});

test("(b) active loan to a target pool routes to target pool candidate with loan step first and decidedBy loan", () => {
	const state = spentOpus();
	const loan = baseLoan({ to: "pool/flash" });
	const result = routeWithLoans({
		pool: OPUS,
		pools: POOLS,
		reason: "user",
		role: "gentle-ai-apply",
		state,
		now: T0,
		processStartedAt: T0 - 10 * MIN,
		loans: [loan],
		contextTokens: 12_000,
		permissions: () => {
			throw new Error("must not call permissions");
		},
	});
	assert.equal(result.candidate.provider, "antigravity");
	assert.equal(result.candidate.model, "gemini-3-8-flash");
	assert.equal(result.trace.decidedBy, "loan");
	assert.equal(result.trace.steps[0].rule, "loan");
	assert.equal(result.trace.steps[0].result, "chosen");
	assert.match(result.trace.steps[0].why, new RegExp(`^${loan.id}: gentle-ai-apply pool/opus → pool/flash until`));
	assert.equal(result.changed.length, 0);
	assert.deepEqual(result.loans, [loan]);
});

test("(c) active loan to a direct model routes directly with loan step", () => {
	const state = spentOpus();
	const loan = baseLoan({ to: "antigravity/gemini-4-argon" });
	const result = routeWithLoans({
		pool: OPUS,
		pools: POOLS,
		reason: "user",
		role: "gentle-ai-apply",
		state,
		now: T0,
		processStartedAt: T0 - 10 * MIN,
		loans: [loan],
		contextTokens: 12_000,
		permissions: () => {
			throw new Error("must not call permissions");
		},
	});
	assert.deepEqual(result.candidate, {
		provider: "antigravity",
		model: "gemini-4-argon",
		quotaKey: "antigravity/gemini-4-argon",
	});
	assert.equal(result.trace.decidedBy, "loan");
	assert.equal(result.trace.steps[0].rule, "loan");
	assert.equal(result.trace.steps[0].result, "chosen");
	assert.match(result.trace.steps[0].why, new RegExp(`^${loan.id}: gentle-ai-apply pool/opus → antigravity/gemini-4-argon until`));
	assert.equal(result.changed.length, 0);
});

test("(d) loan target spent falls back to normal pool route with loan skipped step", () => {
	const state = spentOpus();
	state.markExhausted("antigravity/gemini", T0 + 90 * MIN, "quota-error", T0);
	const loan = baseLoan({ to: "pool/flash" });
	const result = routeWithLoans({
		pool: OPUS,
		pools: POOLS,
		reason: "user",
		role: "gentle-ai-apply",
		state,
		now: T0,
		processStartedAt: T0 - 10 * MIN,
		loans: [loan],
		contextTokens: 12_000,
		permissions: () => ({ grants: [], profile: "default" }),
	});
	assert.equal(result.candidate.model, "gemini-4-argon");
	assert.equal(result.trace.decidedBy, "highest-quota");
	assert.deepEqual(result.trace.steps[0], {
		rule: "loan",
		result: "skipped",
		why: `${loan.id}: pool/flash is spent`,
	});
	assert.equal(result.changed.length, 0);
	assert.deepEqual(result.loans, [loan]);
});

test("(e) loan past endsAt ends in changed and pool routes normally", () => {
	const state = spentOpus();
	const loan = baseLoan({ to: "pool/flash", endsAt: T0 });
	const result = routeWithLoans({
		pool: OPUS,
		pools: POOLS,
		reason: "user",
		role: "gentle-ai-apply",
		state,
		now: T0,
		processStartedAt: T0 - 10 * MIN,
		loans: [loan],
		contextTokens: 12_000,
		permissions: () => ({ grants: [], profile: "default" }),
	});
	assert.equal(result.changed.length, 1);
	assert.equal(result.changed[0].id, loan.id);
	assert.equal(result.changed[0].status, "ended");
	assert.equal(result.changed[0].endedAt, T0);
	assert.notEqual(result.trace.decidedBy, "loan");
	assert.equal(result.candidate.model, "gemini-4-argon");
});

test("(f) trigger with covering auto grant proposes loan in changed; current route unchanged; second call proposes nothing", () => {
	const state = spentOpus();
	let callCount = 0;
	const permissions = () => {
		callCount++;
		return { grants: [grant()], profile: "default" };
	};
	const first = routeWithLoans({
		pool: OPUS,
		pools: POOLS,
		reason: "user",
		role: "gentle-ai-apply",
		state,
		now: T0,
		processStartedAt: T0 - 10 * MIN,
		loans: [],
		contextTokens: 12_000,
		permissions,
	});
	assert.equal(first.changed.length, 1);
	assert.equal(first.changed[0].status, "proposed");
	assert.equal(first.changed[0].level, "auto");
	assert.equal(first.changed[0].to, "pool/flash");
	assert.equal(first.candidate.model, "gemini-4-argon");
	assert.equal(first.trace.decidedBy, "highest-quota");
	assert.equal(first.loans.length, 1);
	assert.equal(callCount, 1);

	const second = routeWithLoans({
		pool: OPUS,
		pools: POOLS,
		reason: "user",
		role: "gentle-ai-apply",
		state,
		now: T0 + 1000,
		processStartedAt: T0 - 10 * MIN,
		loans: first.loans,
		contextTokens: 12_000,
		permissions,
	});
	assert.equal(second.changed.length, 0, "no new proposal");
	assert.equal(second.loans, first.loans);
});

test("(g) trigger without grant or without profile proposes nothing", () => {
	const state = spentOpus();
	const withoutGrant = routeWithLoans({
		pool: OPUS,
		pools: POOLS,
		reason: "user",
		role: "gentle-ai-apply",
		state,
		now: T0,
		processStartedAt: T0 - 10 * MIN,
		loans: [],
		contextTokens: 12_000,
		permissions: () => ({ grants: [], profile: "default" }),
	});
	assert.equal(withoutGrant.changed.length, 0);

	const withoutProfile = routeWithLoans({
		pool: OPUS,
		pools: POOLS,
		reason: "user",
		role: "gentle-ai-apply",
		state,
		now: T0,
		processStartedAt: T0 - 10 * MIN,
		loans: [],
		contextTokens: 12_000,
		permissions: () => ({ grants: [grant()], profile: undefined }),
	});
	assert.equal(withoutProfile.changed.length, 0);
});

test("(h) auto proposal after grace period is activated in changed and used; suggest proposal is not used", () => {
	const state = spentOpus();
	const autoProposal: Loan = {
		...baseLoan({ to: "pool/flash" }),
		status: "proposed",
		level: "auto",
		proposedAt: T0 - 3 * MIN,
		decidedAt: undefined,
		decidedBy: undefined,
	};
	const activated = routeWithLoans({
		pool: OPUS,
		pools: POOLS,
		reason: "user",
		role: "gentle-ai-apply",
		state,
		now: T0,
		processStartedAt: T0 - 10 * MIN,
		loans: [autoProposal],
		contextTokens: 12_000,
		permissions: () => ({ grants: [], profile: "default" }),
	});
	assert.equal(activated.candidate.model, "gemini-3-8-flash");
	assert.equal(activated.trace.decidedBy, "loan");
	assert.equal(activated.changed.length, 1);
	assert.equal(activated.changed[0].status, "active");
	assert.equal(activated.changed[0].decidedBy, "grace");
	assert.equal(activated.changed[0].decidedAt, T0);
	assert.equal(activated.loans[0].status, "active");

	const suggestProposal: Loan = {
		...autoProposal,
		level: "suggest",
	};
	const notActivated = routeWithLoans({
		pool: OPUS,
		pools: POOLS,
		reason: "user",
		role: "gentle-ai-apply",
		state,
		now: T0,
		processStartedAt: T0 - 10 * MIN,
		loans: [suggestProposal],
		contextTokens: 12_000,
		permissions: () => ({ grants: [], profile: "default" }),
	});
	assert.notEqual(notActivated.candidate.model, "gemini-3-8-flash");
	assert.equal(notActivated.candidate.model, "gemini-4-argon");
	assert.notEqual(notActivated.trace.decidedBy, "loan");
	assert.equal(notActivated.changed.length, 0);
});

test("(i) other role's loan is not used", () => {
	const state = spentOpus();
	const loan = baseLoan({ role: "gentle-ai-other", to: "pool/flash" });
	const result = routeWithLoans({
		pool: OPUS,
		pools: POOLS,
		reason: "user",
		role: "gentle-ai-apply",
		state,
		now: T0,
		processStartedAt: T0 - 10 * MIN,
		loans: [loan],
		contextTokens: 12_000,
		permissions: () => ({ grants: [], profile: "default" }),
	});
	assert.notEqual(result.trace.decidedBy, "loan");
	assert.equal(result.candidate.model, "gemini-4-argon");
});

test("loan with endsAt null formats why as until ended by hand", () => {
	const state = spentOpus();
	const loan = baseLoan({ to: "pool/flash", endsAt: null });
	const result = routeWithLoans({
		pool: OPUS,
		pools: POOLS,
		reason: "user",
		role: "gentle-ai-apply",
		state,
		now: T0,
		processStartedAt: T0 - 10 * MIN,
		loans: [loan],
		contextTokens: 12_000,
		permissions: () => {
			throw new Error("must not call permissions");
		},
	});
	assert.match(result.trace.steps[0].why, new RegExp(`^${loan.id}: gentle-ai-apply pool/opus → pool/flash until ended by hand$`));
});

test("auto proposal applies at next launch (processStartedAt > proposedAt)", () => {
	const state = spentOpus();
	const autoProposal: Loan = {
		...baseLoan({ to: "pool/flash" }),
		status: "proposed",
		level: "auto",
		proposedAt: T0 - 30_000,
		decidedAt: undefined,
		decidedBy: undefined,
	};
	const result = routeWithLoans({
		pool: OPUS,
		pools: POOLS,
		reason: "user",
		role: "gentle-ai-apply",
		state,
		now: T0,
		processStartedAt: T0 - 10_000,
		loans: [autoProposal],
		contextTokens: 12_000,
		permissions: () => ({ grants: [], profile: "default" }),
	});
	assert.equal(result.candidate.model, "gemini-3-8-flash");
	assert.equal(result.trace.decidedBy, "loan");
	assert.equal(result.changed[0].decidedBy, "launch");
});

const route = (overrides: Record<string, unknown>) =>
	routeWithLoans({
		pool: OPUS,
		pools: POOLS,
		reason: "user",
		role: "gentle-ai-apply",
		state: spentOpus(),
		now: T0,
		processStartedAt: T0 - 10 * MIN,
		loans: [baseLoan()],
		contextTokens: 150_000,
		permissions: () => ({ grants: [grant()], profile: "default" }),
		...overrides,
	} as Parameters<typeof routeWithLoans>[0]);

test("S10: a continuation that can stay on its provider keeps it; the loan waits for a new turn", () => {
	// Opus only on claude-bridge, then argon on antigravity: a turn already on argon can stick to it.
	const pool: Pool = { id: "opus", name: "Opus", candidates: [OPUS.candidates[1], OPUS.candidates[2]] };
	const result = route({ pool, reason: "continuation", previousProvider: "antigravity" });
	assert.equal(`${result.candidate.provider}/${result.candidate.model}`, "antigravity/gemini-4-argon");
	assert.equal(result.trace.decidedBy, "sticky");
	assert.deepEqual(result.trace.steps[0], {
		rule: "loan",
		result: "skipped",
		why: "loan-20261022150000-gentle-ai-apply: a running turn keeps its provider (antigravity)",
	});
	assert.deepEqual(result.changed, []);
	const proposal = route({ pool, reason: "continuation", previousProvider: "antigravity", loans: [baseLoan({ status: "proposed", decidedAt: undefined, decidedBy: undefined })] });
	assert.deepEqual(proposal.changed, [], "a sticky turn does not activate a proposal either");
	assert.equal(route({ pool, reason: "continuation", previousProvider: "openai" }).trace.decidedBy, "loan", "a provider outside the pool is not sticky: the loan applies");
	assert.equal(route({ pool, reason: "user", previousProvider: "antigravity" }).trace.decidedBy, "loan", "a new turn takes the loan");
});

test("a target pool whose own preferred model is spent is not used: the loan never falls to a lower tier", () => {
	const state = spentOpus();
	state.markExhausted("antigravity/gemini-4-argon", T0 + 90 * MIN, "quota-error", T0);
	const result = route({ state, loans: [baseLoan({ to: "pool/orchestrator" })] });
	assert.equal(result.trace.decidedBy !== "loan", true);
	assert.deepEqual(result.trace.steps[0], { rule: "loan", result: "skipped", why: "loan-20261022150000-gentle-ai-apply: pool/orchestrator is spent" });
});

const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

test("proposalBlock: cooldown blocks 5 min after a loan ended and allows it after 15 min", () => {
	const endedLoan = baseLoan({
		status: "ended",
		endedAt: T0,
	});
	// 5 min after closing: in cooldown
	assert.equal(
		proposalBlock([endedLoan], "gentle-ai-apply", "opus", T0 + 5 * MIN),
		`gentle-ai-apply cooldown until ${hhmm(T0 + 15 * MIN)}`,
	);
	// 15 min after closing: cooldown over
	assert.equal(proposalBlock([endedLoan], "gentle-ai-apply", "opus", T0 + 15 * MIN), undefined);
});

test("proposalBlock: user-declined loan blocks until its endsAt", () => {
	const declinedWithEndsAt = baseLoan({
		status: "declined",
		decidedBy: "user",
		decidedAt: T0,
		endsAt: T0 + 25 * MIN,
	});
	// While now < endsAt
	assert.equal(
		proposalBlock([declinedWithEndsAt], "gentle-ai-apply", "opus", T0 + 5 * MIN),
		`gentle-ai-apply: you chose to wait for the reset (${hhmm(T0 + 25 * MIN)})`,
	);
	assert.equal(
		proposalBlock([declinedWithEndsAt], "gentle-ai-apply", "opus", T0 + 20 * MIN),
		`gentle-ai-apply: you chose to wait for the reset (${hhmm(T0 + 25 * MIN)})`,
	);
	// Once now >= endsAt
	assert.equal(proposalBlock([declinedWithEndsAt], "gentle-ai-apply", "opus", T0 + 25 * MIN), undefined);

	// User-declined with endsAt null blocks indefinitely
	const declinedNoEndsAt = baseLoan({
		status: "declined",
		decidedBy: "user",
		decidedAt: T0,
		endsAt: null,
	});
	assert.equal(
		proposalBlock([declinedNoEndsAt], "gentle-ai-apply", "opus", T0 + 999 * MIN),
		"gentle-ai-apply: you chose to wait for the reset",
	);
});

test("routeWithLoans: cooldown adds skipped loan trace step with exact reason and does not propose", () => {
	const endedLoan = baseLoan({ status: "ended", endedAt: T0 });
	let permissionsCalled = false;
	const result = routeWithLoans({
		pool: OPUS,
		pools: POOLS,
		reason: "user",
		role: "gentle-ai-apply",
		state: spentOpus(),
		now: T0 + 5 * MIN,
		processStartedAt: T0,
		loans: [endedLoan],
		contextTokens: 12_000,
		permissions: () => {
			permissionsCalled = true;
			return { grants: [grant()], profile: "default" };
		},
	});
	assert.equal(permissionsCalled, false, "permissions must not be called when proposal is blocked by cooldown");
	assert.equal(result.changed.length, 0);
	assert.deepEqual(result.trace.steps[0], {
		rule: "loan",
		result: "skipped",
		why: `gentle-ai-apply cooldown until ${hhmm(T0 + 15 * MIN)}`,
	});
});

test("routeWithLoans: user-declined loan adds skipped loan trace step with exact reason and does not propose", () => {
	const declined = baseLoan({
		status: "declined",
		decidedBy: "user",
		decidedAt: T0,
		endsAt: T0 + 25 * MIN,
	});
	const result = routeWithLoans({
		pool: OPUS,
		pools: POOLS,
		reason: "user",
		role: "gentle-ai-apply",
		state: spentOpus(),
		now: T0 + 5 * MIN,
		processStartedAt: T0,
		loans: [declined],
		contextTokens: 12_000,
		permissions: () => ({ grants: [grant()], profile: "default" }),
	});
	assert.equal(result.changed.length, 0);
	assert.deepEqual(result.trace.steps[0], {
		rule: "loan",
		result: "skipped",
		why: `gentle-ai-apply: you chose to wait for the reset (${hhmm(T0 + 25 * MIN)})`,
	});
});
