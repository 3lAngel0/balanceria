import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	commitLoanChanges,
	LOANS_LOCK,
	mergeLoanChanges,
	readLoans,
	tryLoansLock,
	withLoansLock,
	type Loan,
	type LoanChange,
} from "../src/loans.ts";
import { AUDIT_FILE } from "../src/permissions.ts";

const T0 = Date.UTC(2026, 9, 22, 15, 0, 0);

function sampleLoan(overrides: Partial<Loan> = {}): Loan {
	return {
		id: "loan-20261022150000-gentle-ai-apply",
		status: "proposed",
		profile: "default",
		role: "gentle-ai-apply",
		pool: "opus",
		from: "pool/opus",
		to: "pool/flash",
		alternatives: ["pool/orchestrator"],
		level: "auto",
		grantId: "g-1",
		why: "opus spent",
		advice: { action: "switch", why: "cheap switch" },
		proposedAt: T0,
		endsAt: T0 + 25 * 60_000,
		...overrides,
	};
}

test("lock acquired and released (file gone after)", () => {
	const dir = mkdtempSync(join(tmpdir(), "loan-lock-"));
	try {
		const lockPath = join(dir, LOANS_LOCK);
		let ran = false;
		const res = tryLoansLock(dir, T0, () => {
			ran = true;
			assert.equal(existsSync(lockPath), true, "lock file must exist while fn is running");
			const parsed = JSON.parse(readFileSync(lockPath, "utf8"));
			assert.equal(parsed.pid, process.pid);
			assert.equal(parsed.at, T0);
			return "done";
		});
		assert.equal(ran, true);
		assert.deepEqual(res, { ok: true, result: "done" });
		assert.equal(existsSync(lockPath), false, "lock file must be removed after fn finishes");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("busy lock -> tryLoansLock { ok: false } and fn not called", () => {
	const dir = mkdtempSync(join(tmpdir(), "loan-lock-"));
	try {
		const lockPath = join(dir, LOANS_LOCK);
		writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: T0 }) + "\n", "utf8");
		let ran = false;
		const res = tryLoansLock(
			dir,
			T0 + 1000,
			() => {
				ran = true;
			},
			{ isAlive: () => true },
		);
		assert.deepEqual(res, { ok: false });
		assert.equal(ran, false, "fn must not be called when lock is busy");
		assert.equal(existsSync(lockPath), true, "existing lock file must remain");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("stale by dead pid and by age is taken over", () => {
	const dir = mkdtempSync(join(tmpdir(), "loan-lock-"));
	try {
		const lockPath = join(dir, LOANS_LOCK);
		// 1. Dead pid (age < 30s)
		writeFileSync(lockPath, JSON.stringify({ pid: 999999, at: T0 }) + "\n", "utf8");
		let ran = false;
		const deadRes = tryLoansLock(
			dir,
			T0 + 5000,
			() => {
				ran = true;
				return "took-dead";
			},
			{ isAlive: () => false },
		);
		assert.equal(ran, true);
		assert.deepEqual(deadRes, { ok: true, result: "took-dead" });
		assert.equal(existsSync(lockPath), false);

		// 2. Old age (> 30s), even if pid is alive
		writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: T0 - 35_000 }) + "\n", "utf8");
		let ranOld = false;
		const oldRes = tryLoansLock(
			dir,
			T0,
			() => {
				ranOld = true;
				return "took-old";
			},
			{ isAlive: () => true },
		);
		assert.equal(ranOld, true);
		assert.deepEqual(oldRes, { ok: true, result: "took-old" });
		assert.equal(existsSync(lockPath), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("withLoansLock times out with the exact message", () => {
	const dir = mkdtempSync(join(tmpdir(), "loan-lock-"));
	try {
		const lockPath = join(dir, LOANS_LOCK);
		writeFileSync(lockPath, JSON.stringify({ pid: process.pid, at: Date.now() }) + "\n", "utf8");
		assert.throws(
			() => {
				withLoansLock(
					dir,
					() => {
						// should not be reached
					},
					{ waitMs: 60, retryMs: 20, isAlive: () => true },
				);
			},
			(err: unknown) => {
				assert.ok(err instanceof Error);
				assert.equal(err.message, "ai-balancer: another Pi is writing the loans journal; try again");
				return true;
			},
		);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("fn throwing still releases the lock", () => {
	const dir = mkdtempSync(join(tmpdir(), "loan-lock-"));
	try {
		const lockPath = join(dir, LOANS_LOCK);
		assert.throws(
			() => {
				tryLoansLock(dir, T0, () => {
					throw new Error("failure inside fn");
				});
			},
			/failure inside fn/,
		);
		assert.equal(existsSync(lockPath), false, "lock must be released even when fn throws");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("mergeLoanChanges applies a matching transition", () => {
	const loanA = sampleLoan({ id: "loan-1", status: "proposed" });
	const fresh = [loanA];
	const change: LoanChange = {
		from: "proposed",
		loan: { ...loanA, status: "active", decidedAt: T0 + 1000, decidedBy: "user" },
	};
	const merged = mergeLoanChanges(fresh, [change]);
	assert.equal(merged.applied.length, 1);
	assert.equal(merged.skipped.length, 0);
	assert.equal(merged.loans.length, 1);
	assert.equal(merged.loans[0].status, "active");
	assert.equal(merged.loans[0].decidedBy, "user");
});

test("mergeLoanChanges skips a transition whose fresh status differs (another Pi decided first — the fresh decision survives)", () => {
	const loanA = sampleLoan({ id: "loan-1", status: "declined", decidedAt: T0 + 500, decidedBy: "user" });
	const fresh = [loanA];
	const change: LoanChange = {
		from: "proposed", // we thought it was proposed, but another Pi already declined it
		loan: { ...loanA, status: "active", decidedAt: T0 + 1000, decidedBy: "grace" },
	};
	const merged = mergeLoanChanges(fresh, [change]);
	assert.equal(merged.applied.length, 0);
	assert.equal(merged.skipped.length, 1);
	assert.equal(merged.skipped[0].id, "loan-1");
	assert.equal(merged.loans.length, 1);
	assert.equal(merged.loans[0].status, "declined", "the fresh decision must survive");
	assert.equal(merged.loans[0].decidedBy, "user");
});

test("mergeLoanChanges skips a 'new' proposal when fresh already has an open loan for that role/pool", () => {
	const openLoan = sampleLoan({ id: "loan-open", role: "gentle-ai-apply", pool: "opus", status: "proposed" });
	const fresh = [openLoan];
	const newProposal = sampleLoan({ id: "loan-new", role: "gentle-ai-apply", pool: "opus", status: "proposed" });
	const change: LoanChange = {
		from: "new",
		loan: newProposal,
	};
	const merged = mergeLoanChanges(fresh, [change]);
	assert.equal(merged.applied.length, 0);
	assert.equal(merged.skipped.length, 1);
	assert.equal(merged.skipped[0].id, "loan-new");
	assert.deepEqual(merged.loans, [openLoan]);
});

test("mergeLoanChanges applies a 'new' proposal when fresh has no open loan for that role/pool and keeps unrelated loans", () => {
	const unrelated = sampleLoan({ id: "loan-other", role: "gentle-ai-verify", pool: "orchestrator", status: "active" });
	const closedLoan = sampleLoan({ id: "loan-closed", role: "gentle-ai-apply", pool: "opus", status: "ended", endedAt: T0 - 1000 });
	const fresh = [unrelated, closedLoan];
	const newProposal = sampleLoan({ id: "loan-new", role: "gentle-ai-apply", pool: "opus", status: "proposed" });
	const change: LoanChange = {
		from: "new",
		loan: newProposal,
	};
	const merged = mergeLoanChanges(fresh, [change]);
	assert.equal(merged.applied.length, 1);
	assert.equal(merged.applied[0].id, "loan-new");
	assert.equal(merged.skipped.length, 0);
	assert.equal(merged.loans.length, 3);
	assert.equal(merged.loans[0], unrelated, "unrelated loan preserved");
	assert.equal(merged.loans[1], closedLoan, "closed loan preserved");
	assert.equal(merged.loans[2].id, "loan-new");
});

test("commitLoanChanges merges under the lock, audits what applied, and skips when busy", () => {
	const dir = mkdtempSync(join(tmpdir(), "loan-commit-"));
	try {
		const loanA = sampleLoan({ id: "loan-1", status: "proposed" });
		const first = commitLoanChanges(dir, T0, [{ from: "new", loan: loanA }]);
		assert.deepEqual(first, { ok: true, applied: [loanA], skipped: [] });

		// Another Pi already applied it: a stale "decline" from this copy loses.
		const active: Loan = { ...loanA, status: "active", decidedAt: T0 + 1000, decidedBy: "user" };
		assert.equal(commitLoanChanges(dir, T0, [{ from: "proposed", loan: active }]).ok, true);
		const stale = commitLoanChanges(dir, T0, [{ from: "proposed", loan: { ...loanA, status: "declined" } }]);
		assert.deepEqual(stale, { ok: true, applied: [], skipped: [{ ...loanA, status: "declined" }] });
		assert.deepEqual(readLoans(dir).loans, [active], "the first answer survives");
		const audit = readFileSync(join(dir, AUDIT_FILE), "utf8").trim().split("\n").map(line => JSON.parse(line).action);
		assert.deepEqual(audit, ["loan-proposed", "loan-active"], "only applied changes are audited");

		// Busy lock: nothing written, no wait.
		writeFileSync(join(dir, LOANS_LOCK), JSON.stringify({ pid: process.pid, at: T0 }) + "\n");
		const busy = commitLoanChanges(dir, T0, [{ from: "active", loan: { ...active, status: "ended", endedAt: T0 } }], { isAlive: () => true });
		assert.deepEqual(busy, { ok: false });
		assert.deepEqual(readLoans(dir).loans, [active]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
