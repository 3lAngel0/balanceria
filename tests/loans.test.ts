import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LOANS_FILE,
	decideLoan,
	effectiveLoan,
	expireLoans,
	formatLoan,
	loanSummary,
	preferredSpent,
	proposeLoan,
	readLoans,
	recommendLoan,
	writeLoans,
	type Loan,
} from "../src/loans.ts";
import type { Grant } from "../src/permissions.ts";
import type { Pool } from "../src/pools.ts";
import { QuotaState } from "../src/state.ts";

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
const FLASH: Pool = { id: "flash", name: "Flash", candidates: [{ provider: "antigravity", model: "gemini-3-8-flash", quotaKey: "antigravity/gemini" }] };
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

const hhmm = (ms: number) => new Date(ms).toTimeString().slice(0, 5);
const request = { pool: OPUS, pools: POOLS, role: "gentle-ai-apply", profile: "default", now: T0, contextTokens: 12_000 };

test("preferredSpent: the pool's first model with every candidate spent, and when it reopens", () => {
	assert.equal(preferredSpent(OPUS, new QuotaState(), T0), undefined);
	const one = new QuotaState();
	one.markExhausted("antigravity/claude", T0 + 40 * MIN, "quota-error", T0);
	assert.equal(preferredSpent(OPUS, one, T0), undefined, "one opus candidate still answers");
	assert.deepEqual(preferredSpent(OPUS, spentOpus(), T0), {
		model: "claude-opus-5-5",
		spent: ["antigravity/claude-opus-5-5", "claude-bridge/claude-opus-5-5"],
		reopensAt: T0 + 25 * MIN,
	});
	const all = spentOpus();
	all.markExhausted("antigravity/gemini-4-argon", undefined, "quota-error", T0);
	assert.equal(preferredSpent(ORCHESTRATOR, all, T0)?.model, "gemini-4-argon", "argon is spent: the pool would fall to flash");
});

test("recommendLoan: the granted target with the most quota left, the others as alternatives", () => {
	const proposal = recommendLoan({ ...request, grants: [grant()], state: spentOpus() });
	assert.deepEqual(proposal, {
		profile: "default",
		role: "gentle-ai-apply",
		pool: "opus",
		from: "pool/opus",
		to: "pool/flash",
		alternatives: ["pool/orchestrator"],
		level: "auto",
		grantId: "g-1",
		why: "opus: claude-opus-5-5 is spent (antigravity/claude-opus-5-5, claude-bridge/claude-opus-5-5); it reopens at 2026-10-22T15:25:00.000Z",
		advice: { action: "switch", why: "context 12k is under 30k: re-sending it costs about one ordinary turn" },
		endsAt: T0 + 25 * MIN,
	});
});

test("recommendLoan: no loan without a spent preferred model, a covering grant or an available target", () => {
	const state = spentOpus();
	assert.equal(recommendLoan({ ...request, grants: [grant()], state: new QuotaState() }), undefined, "nothing spent");
	assert.equal(recommendLoan({ ...request, grants: [], state }), undefined, "no grant");
	assert.equal(recommendLoan({ ...request, grants: [grant({ roles: ["gentle-ai-verify"] })], state }), undefined, "other role");
	assert.equal(recommendLoan({ ...request, grants: [grant({ profiles: ["fast"] })], state }), undefined, "other profile");
	assert.equal(recommendLoan({ ...request, grants: [grant({ expiresAt: T0 })], state }), undefined, "expired");
	assert.equal(recommendLoan({ ...request, grants: [grant({ models: ["pool/opus", "antigravity/gemini-4-argon"] })], state }), undefined, "a candidate of the pool is its own fallback, not a loan");
	const dry = spentOpus();
	dry.markExhausted("antigravity/gemini", T0 + 90 * MIN, "quota-error", T0);
	dry.markExhausted("antigravity/gemini-4-argon", T0 + 90 * MIN, "quota-error", T0);
	assert.equal(recommendLoan({ ...request, grants: [grant()], state: dry }), undefined, "every target is spent");
});

test("recommendLoan: a direct model target, the highest grant level, and the advice for a large context", () => {
	const grants = [
		grant({ id: "g-s", level: "suggest", models: ["pool/opus", "antigravity/gemini-3-8-flash"] }),
		grant({ id: "g-a", level: "auto", models: ["pool/opus", "pool/orchestrator"] }),
	];
	const proposal = recommendLoan({ ...request, grants, state: spentOpus(), contextTokens: 150_000 });
	assert.equal(proposal?.to, "antigravity/gemini-3-8-flash");
	assert.deepEqual(proposal?.alternatives, ["pool/orchestrator"]);
	assert.equal(proposal?.level, "suggest", "the level is the one of the grant that covers the recommended target");
	assert.equal(proposal?.grantId, "g-s");
	assert.equal(proposal?.advice.action, "wait", "the window reopens in 25 min");
});

function proposed(overrides: Partial<Loan> = {}): Loan {
	const proposal = recommendLoan({ ...request, grants: [grant()], state: spentOpus() });
	assert.ok(proposal);
	const { loan } = proposeLoan([], proposal, T0);
	assert.ok(loan);
	return { ...loan, ...overrides };
}

test("proposeLoan: one open loan per role and pool", () => {
	const proposal = recommendLoan({ ...request, grants: [grant()], state: spentOpus() });
	assert.ok(proposal);
	const first = proposeLoan([], proposal, T0);
	assert.equal(first.loan?.status, "proposed");
	assert.equal(first.loan?.id, "loan-20261022150000-gentle-ai-apply");
	assert.equal(first.loan?.proposedAt, T0);
	assert.equal(first.loans.length, 1);
	const again = proposeLoan(first.loans, proposal, T0 + MIN);
	assert.equal(again.loan, undefined);
	assert.equal(again.loans, first.loans, "nothing changes");
	const declined = decideLoan(first.loans, first.loan.id, { action: "cancel" }, T0 + MIN).loans;
	assert.equal(proposeLoan(declined, proposal, T0 + 2 * MIN).loan?.status, "proposed", "a closed loan does not block a new one");
	assert.equal(proposeLoan(first.loans, { ...proposal, role: "gentle-ai-verify" }, T0).loan?.role, "gentle-ai-verify");
});

test("effectiveLoan: auto applies after the grace period or at the next launch; suggest waits", () => {
	const loan = proposed();
	const at = (now: number, processStartedAt = T0 - 10 * MIN, loans = [loan]) =>
		effectiveLoan(loans, { role: "gentle-ai-apply", pool: "opus", now, processStartedAt });
	assert.equal(at(T0 + MIN), undefined, "within the grace period");
	const grace = at(T0 + 2 * MIN);
	assert.equal(grace?.loan.status, "active");
	assert.equal(grace?.loan.decidedBy, "grace");
	assert.equal(grace?.loan.decidedAt, T0 + 2 * MIN);
	assert.equal(grace?.changed, true);
	const launch = at(T0 + 30_000, T0 + 10_000);
	assert.equal(launch?.loan.decidedBy, "launch", "a process started after the proposal is the next subagent launch");
	assert.equal(at(T0 + 10 * MIN, T0 + MIN, [{ ...loan, level: "suggest" }]), undefined, "suggest never applies on its own");
	assert.equal(effectiveLoan([loan], { role: "gentle-ai-verify", pool: "opus", now: T0 + 3 * MIN, processStartedAt: T0 }), undefined, "other role");
	const active = { ...loan, status: "active" as const, decidedAt: T0, decidedBy: "user" as const };
	assert.deepEqual(at(T0 + 5 * MIN, T0, [active]), { loan: active, changed: false });
	assert.equal(at(T0 + 25 * MIN, T0, [active]), undefined, "the window reopened: the loan is over");
});

test("decideLoan: apply, pick another, cancel, end, keep and revert, and nothing else", () => {
	const loan = proposed({ level: "suggest" });
	const applied = decideLoan([loan], loan.id, { action: "apply" }, T0 + MIN).loan;
	assert.deepEqual([applied.status, applied.to, applied.decidedBy, applied.decidedAt], ["active", "pool/flash", "user", T0 + MIN]);
	const picked = decideLoan([loan], loan.id, { action: "apply", to: "pool/orchestrator" }, T0 + MIN).loan;
	assert.deepEqual([picked.to, picked.alternatives], ["pool/orchestrator", ["pool/flash"]]);
	assert.throws(() => decideLoan([loan], loan.id, { action: "apply", to: "pool/other" }, T0), /pool\/other is not a target of loan-/);
	assert.equal(decideLoan([loan], loan.id, { action: "cancel" }, T0 + MIN).loan.status, "declined");
	const ended = decideLoan([applied], loan.id, { action: "end" }, T0 + 5 * MIN).loan;
	assert.deepEqual([ended.status, ended.endedAt], ["ended", T0 + 5 * MIN]);
	assert.equal(decideLoan([ended], loan.id, { action: "keep" }, T0 + 6 * MIN).loan.status, "kept");
	assert.equal(decideLoan([ended], loan.id, { action: "revert" }, T0 + 6 * MIN).loan.status, "reverted");
	assert.throws(() => decideLoan([loan], loan.id, { action: "end" }, T0), /loan-\S+ is proposed: cannot end/);
	assert.throws(() => decideLoan([applied], loan.id, { action: "cancel" }, T0), /is active: cannot cancel/);
	assert.throws(() => decideLoan([loan], "loan-nope", { action: "cancel" }, T0), /no loan loan-nope/);
});

test("expireLoans: active loans end at the reset, open proposals lapse", () => {
	const loan = proposed();
	const active = { ...loan, id: "a", role: "r1", status: "active" as const, decidedAt: T0, decidedBy: "grace" as const };
	const kept = { ...loan, id: "k", status: "kept" as const, endedAt: T0 };
	const loans = [loan, active, kept];
	assert.equal(expireLoans(loans, T0 + 24 * MIN).ended.length, 0);
	assert.equal(expireLoans(loans, T0 + 24 * MIN).loans, loans, "nothing changes before the reset");
	const { loans: after, ended } = expireLoans(loans, T0 + 25 * MIN);
	assert.deepEqual(ended.map(l => [l.id, l.status]), [[loan.id, "declined"], ["a", "ended"]]);
	assert.equal(after.find(l => l.id === loan.id)?.decidedBy, "reset");
	assert.equal(after.find(l => l.id === "a")?.endedAt, T0 + 25 * MIN);
	assert.equal(after.find(l => l.id === "k"), kept);
	const unknownReset = { ...active, endsAt: null };
	assert.equal(expireLoans([unknownReset], T0 + 999 * MIN).ended.length, 0, "an unknown reset ends only by hand");
});

test("the journal round-trips through data/loans.json, written 0600, and ignores broken rows", () => {
	const dir = mkdtempSync(join(tmpdir(), "loans-"));
	try {
		assert.deepEqual(readLoans(dir), { loans: [] });
		const loan = proposed();
		writeLoans(dir, [loan]);
		assert.deepEqual(readLoans(dir), { loans: [loan] });
		assert.equal(statSync(join(dir, LOANS_FILE)).mode & 0o777, 0o600);
		writeFileSync(join(dir, LOANS_FILE), JSON.stringify({ version: 1, loans: [loan, { id: "x" }, null] }));
		assert.deepEqual(readLoans(dir), { loans: [loan] });
		writeFileSync(join(dir, LOANS_FILE), "{oops");
		const broken = readLoans(dir);
		assert.deepEqual(broken.loans, []);
		assert.match(broken.error ?? "", /loans\.json is not readable JSON/);
		writeFileSync(join(dir, LOANS_FILE), JSON.stringify({ version: 2, loans: [] }));
		assert.match(readLoans(dir).error ?? "", /not a version 1 loans file/);
		assert.equal(readFileSync(join(dir, LOANS_FILE), "utf8"), JSON.stringify({ version: 2, loans: [] }), "reading never rewrites");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loanSummary counts the role's requests while the loan was active, by model", () => {
	const loan = { ...proposed(), status: "ended" as const, decidedAt: T0 + 2 * MIN, endedAt: T0 + 25 * MIN };
	const row = (ts: number, role: string, model: string) => ({ ts, role, provider: "antigravity", model, input: 1000, output: 100, cacheRead: 10_000, cacheWrite: 0 });
	const summary = loanSummary(loan, [
		row(T0 + MIN, "gentle-ai-apply", "gemini-3-8-flash"), // before it applied
		row(T0 + 3 * MIN, "gentle-ai-apply", "gemini-3-8-flash"),
		row(T0 + 4 * MIN, "gentle-ai-apply", "gemini-3-8-flash"),
		row(T0 + 5 * MIN, "gentle-ai-apply", "gemini-4-argon"),
		row(T0 + 6 * MIN, "gentle-ai-verify", "gemini-3-8-flash"), // other role
		row(T0 + 26 * MIN, "gentle-ai-apply", "gemini-3-8-flash"), // after it ended
	]);
	assert.deepEqual(summary, {
		requests: 3,
		weightedTokens: 7500,
		byModel: [
			{ model: "antigravity/gemini-3-8-flash", requests: 2, weightedTokens: 5000 },
			{ model: "antigravity/gemini-4-argon", requests: 1, weightedTokens: 2500 },
		],
	});
});

test("formatLoan says what moved, its state and what happens next", () => {
	const loan = proposed();
	assert.equal(
		formatLoan(loan, T0 + MIN),
		`gentle-ai-apply: pool/opus → pool/flash · proposed (auto: applies at the next launch or in 1 min) · ends ${hhmm(T0 + 25 * MIN)} · opus: claude-opus-5-5 is spent (antigravity/claude-opus-5-5, claude-bridge/claude-opus-5-5); it reopens at 2026-10-22T15:25:00.000Z`,
	);
	assert.match(formatLoan({ ...loan, level: "suggest" }, T0), /proposed \(suggest: waits for you\)/);
	assert.match(formatLoan({ ...loan, status: "active", decidedAt: T0, decidedBy: "grace" }, T0), new RegExp(` · active \\(applied by grace\\) · ends ${hhmm(T0 + 25 * MIN)} · `));
	assert.match(formatLoan({ ...loan, endsAt: null, status: "active", decidedBy: "user" }, T0), /ends when you end it/);
});
