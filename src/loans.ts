import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { AUDIT_FILE, permissionFor, type Grant } from "./permissions.ts";
import { quotaKeyFor, type Pool } from "./pools.ts";
import type { Candidate } from "./router.ts";
import type { QuotaState } from "./state.ts";
import { DEFAULT_WEIGHTS, SWITCH_DEFAULTS, switchAdvice, weightedTokens, type SwitchAdvice, type SwitchPolicy, type TokenWeights } from "./switch-cost.ts";

// Model loans (docs/design/control-plane.md §8, R2 layer 1): while a pool's
// preferred model is spent, one role's requests for that pool are routed to
// another model the user granted as interchangeable, until the window reopens.
// This module is the lifecycle and its journal; routing and the console use it.

export const LOANS_FILE = "loans.json";
export const LOANS_LOCK = "loans.lock";

export type LoanStatus = "proposed" | "active" | "declined" | "ended" | "kept" | "reverted";
/** Who moved the loan last: the user, the grace period, a new subagent launch, or the window reset. */
export type LoanDecider = "user" | "grace" | "launch" | "reset";

export interface Loan {
	id: string;
	status: LoanStatus;
	profile: string;
	role: string;
	pool: string;
	/** `pool/<id>`: what the role asks for. */
	from: string;
	/** `pool/<id>` or `provider/model`: where the loan routes it. */
	to: string;
	alternatives: string[];
	level: "suggest" | "auto";
	grantId: string;
	why: string;
	advice: SwitchAdvice;
	proposedAt: number;
	/** When the preferred model reopens; null when unknown (the loan then ends by hand). */
	endsAt: number | null;
	decidedAt?: number;
	decidedBy?: LoanDecider;
	endedAt?: number;
}

export type LoanProposal = Omit<Loan, "id" | "status" | "proposedAt" | "decidedAt" | "decidedBy" | "endedAt">;

export interface PreferredSpent {
	model: string;
	/** `provider/model` of every spent candidate with the preferred model. */
	spent: string[];
	reopensAt: number | null;
}

const label = (candidate: Candidate) => `${candidate.provider}/${candidate.model}`;

/** The trigger (L24): every candidate of the pool's first model is spent, so routing would fall to another model. */
export function preferredSpent(pool: Pool, state: QuotaState, now: number): PreferredSpent | undefined {
	const model = pool.candidates[0]?.model;
	if (model === undefined) return undefined;
	const preferred = pool.candidates.filter(candidate => candidate.model === model);
	if (preferred.some(candidate => state.isAvailable(candidate.quotaKey, now))) return undefined;
	const reopens = preferred.map(candidate => state.availableAt(candidate.quotaKey, now)).filter((at): at is number => at !== undefined);
	return { model, spent: preferred.map(label), reopensAt: reopens.length ? Math.min(...reopens) : null };
}

// Remaining fraction of a target, -1 when unknown; undefined when it cannot answer.
function targetQuota(target: string, pools: readonly Pool[], state: QuotaState, now: number): number | undefined {
	const keys: string[] = [];
	if (target.startsWith("pool/")) {
		const pool = pools.find(candidate => `pool/${candidate.id}` === target);
		const model = pool?.candidates[0]?.model;
		for (const candidate of pool?.candidates ?? []) if (candidate.model === model) keys.push(candidate.quotaKey);
	} else {
		const slash = target.indexOf("/");
		if (slash <= 0) return undefined;
		keys.push(quotaKeyFor(target.slice(0, slash), target.slice(slash + 1)));
	}
	const available = keys.filter(key => state.isAvailable(key, now));
	if (available.length === 0) return undefined;
	return Math.max(...available.map(key => state.remainingFraction(key) ?? -1));
}

/**
 * The loan to propose for a role whose pool lost its preferred model: the
 * granted target with the most quota left. Undefined when the preferred model
 * still answers, no grant covers the role, or no granted target can answer.
 */
export function recommendLoan(input: {
	pool: Pool;
	pools: readonly Pool[];
	role: string;
	profile: string;
	grants: readonly Grant[];
	state: QuotaState;
	now: number;
	contextTokens: number | null;
	policy?: SwitchPolicy;
}): LoanProposal | undefined {
	const { pool, pools, role, profile, grants, state, now } = input;
	const spent = preferredSpent(pool, state, now);
	if (!spent) return undefined;
	const from = `pool/${pool.id}`;
	// The pool's own candidates are its fallback, not a loan.
	const own = new Set(pool.candidates.map(label));
	const targets: { to: string; quota: number; grant: Grant; level: "suggest" | "auto" }[] = [];
	for (const to of new Set(grants.flatMap(grant => grant.models))) {
		if (to === from || own.has(to)) continue;
		const permission = permissionFor(grants, { profile, role, from, to }, now);
		if (permission.level === "off" || !permission.grant) continue;
		const quota = targetQuota(to, pools, state, now);
		if (quota === undefined) continue;
		targets.push({ to, quota, grant: permission.grant, level: permission.level });
	}
	if (targets.length === 0) return undefined;
	// Stable sort: equal quota keeps the grant order.
	targets.sort((a, b) => b.quota - a.quota);
	const [best, ...rest] = targets;
	const reopens = spent.reopensAt === null ? "its reset time is unknown" : `it reopens at ${new Date(spent.reopensAt).toISOString()}`;
	return {
		profile,
		role,
		pool: pool.id,
		from,
		to: best.to,
		alternatives: rest.map(target => target.to),
		level: best.level,
		grantId: best.grant.id,
		why: `${pool.id}: ${spent.model} is spent (${spent.spent.join(", ")}); ${reopens}`,
		advice: switchAdvice({ contextTokens: input.contextTokens, resetAt: spent.reopensAt, now }, input.policy),
		endsAt: spent.reopensAt,
	};
}

const isOpen = (loan: Loan) => loan.status === "proposed" || loan.status === "active";

/** Adds a proposal unless the role already has an open loan for the pool; `loan` is then undefined and `loans` unchanged. */
export function proposeLoan(loans: readonly Loan[], proposal: LoanProposal, now: number): { loans: readonly Loan[]; loan?: Loan } {
	if (loans.some(loan => isOpen(loan) && loan.role === proposal.role && loan.pool === proposal.pool)) return { loans };
	const stamp = new Date(now).toISOString().replace(/\D/g, "").slice(0, 14);
	const loan: Loan = { id: `loan-${stamp}-${proposal.role}`, status: "proposed", ...proposal, proposedAt: now };
	return { loans: [...loans, loan], loan };
}

/**
 * The loan that routes this request, if any. An `auto` proposal applies after
 * the grace period, or at once in a process started after it (the next
 * subagent launch); `changed` says the journal must record that.
 */
export function effectiveLoan(
	loans: readonly Loan[],
	request: { role: string; pool: string; now: number; processStartedAt: number },
	policy: SwitchPolicy = SWITCH_DEFAULTS,
): { loan: Loan; changed: boolean } | undefined {
	const { role, pool, now, processStartedAt } = request;
	const loan = loans.find(candidate => isOpen(candidate) && candidate.role === role && candidate.pool === pool);
	if (!loan || (loan.endsAt !== null && now >= loan.endsAt)) return undefined;
	if (loan.status === "active") return { loan, changed: false };
	if (loan.level !== "auto") return undefined;
	const decidedBy: LoanDecider | undefined =
		processStartedAt > loan.proposedAt ? "launch" : now - loan.proposedAt >= policy.graceMs ? "grace" : undefined;
	if (!decidedBy) return undefined;
	return { loan: { ...loan, status: "active", decidedAt: now, decidedBy }, changed: true };
}

export type LoanChoice =
	| { action: "apply"; to?: string }
	| { action: "cancel" }
	| { action: "end" }
	| { action: "keep" }
	| { action: "revert" };

const FROM: Record<LoanChoice["action"], LoanStatus> = { apply: "proposed", cancel: "proposed", end: "active", keep: "ended", revert: "ended" };

/** A user decision. Throws, changing nothing, on an unknown loan, a wrong state or a target the loan does not offer. */
export function decideLoan(loans: readonly Loan[], id: string, choice: LoanChoice, now: number): { loans: Loan[]; loan: Loan } {
	const current = loans.find(loan => loan.id === id);
	if (!current) throw new Error(`ai-balancer: no loan ${id}`);
	if (current.status !== FROM[choice.action]) throw new Error(`ai-balancer: ${id} is ${current.status}: cannot ${choice.action}`);
	let loan: Loan;
	if (choice.action === "apply") {
		const to = choice.to ?? current.to;
		if (to !== current.to && !current.alternatives.includes(to)) throw new Error(`ai-balancer: ${to} is not a target of ${id}`);
		const alternatives = to === current.to ? current.alternatives : [current.to, ...current.alternatives.filter(other => other !== to)];
		loan = { ...current, status: "active", to, alternatives, decidedAt: now, decidedBy: "user" };
	} else if (choice.action === "cancel") {
		loan = { ...current, status: "declined", decidedAt: now, decidedBy: "user" };
	} else if (choice.action === "end") {
		loan = { ...current, status: "ended", endedAt: now, decidedBy: "user" };
	} else {
		loan = { ...current, status: choice.action === "keep" ? "kept" : "reverted" };
	}
	return { loans: loans.map(other => (other.id === id ? loan : other)), loan };
}

/** At the reset: active loans end and open proposals lapse. Returns `loans` itself when nothing changed. */
export function expireLoans(loans: readonly Loan[], now: number): { loans: readonly Loan[]; ended: Loan[] } {
	const ended: Loan[] = [];
	const next = loans.map(loan => {
		if (!isOpen(loan) || loan.endsAt === null || now < loan.endsAt) return loan;
		const closed: Loan =
			loan.status === "active"
				? { ...loan, status: "ended", endedAt: now }
				: { ...loan, status: "declined", decidedAt: now, decidedBy: "reset" };
		ended.push(closed);
		return closed;
	});
	return { loans: ended.length ? next : loans, ended };
}

const STATUSES: readonly LoanStatus[] = ["proposed", "active", "declined", "ended", "kept", "reverted"];

function isLoan(value: unknown): value is Loan {
	if (!value || typeof value !== "object") return false;
	const loan = value as Record<string, unknown>;
	const text = (key: string) => typeof loan[key] === "string" && (loan[key] as string).length > 0;
	return (
		["id", "profile", "role", "pool", "from", "to", "grantId", "why"].every(text) &&
		STATUSES.includes(loan.status as LoanStatus) &&
		(loan.level === "suggest" || loan.level === "auto") &&
		Array.isArray(loan.alternatives) &&
		typeof loan.proposedAt === "number" &&
		(loan.endsAt === null || typeof loan.endsAt === "number") &&
		!!loan.advice &&
		typeof loan.advice === "object"
	);
}

/** The journal; broken rows are skipped, an unusable file reads as empty with an error. Never writes. */
export function readLoans(dataDir: string): { loans: Loan[]; error?: string } {
	const file = join(dataDir, LOANS_FILE);
	if (!existsSync(file)) return { loans: [] };
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		return { loans: [], error: `${LOANS_FILE} is not readable JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	const store = parsed as { version?: unknown; loans?: unknown } | null;
	if (!store || typeof store !== "object" || store.version !== 1 || !Array.isArray(store.loans)) {
		return { loans: [], error: `${LOANS_FILE} is not a version 1 loans file` };
	}
	return { loans: store.loans.filter(isLoan) };
}

/** Atomic (temp + rename), 0600. */
export function writeLoans(dataDir: string, loans: readonly Loan[]): void {
	mkdirSync(dataDir, { recursive: true });
	const temporary = join(dataDir, `${LOANS_FILE}.${process.pid}.tmp`);
	writeFileSync(temporary, `${JSON.stringify({ version: 1, loans }, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, join(dataDir, LOANS_FILE));
}

/** One audit row per loan transition, next to the permission rows (§8.1 step 7). */
export function auditLoan(dataDir: string, ts: number, loan: Loan): void {
	appendFileSync(join(dataDir, AUDIT_FILE), `${JSON.stringify({ ts, action: `loan-${loan.status}`, by: loan.decidedBy ?? "rule", loan })}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
}

export interface LoanSummary {
	requests: number;
	weightedTokens: number;
	byModel: { model: string; requests: number; weightedTokens: number }[];
}

type RoleRequest = { ts: number; role: string; provider: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number };

/** What the role sent while the loan was active, for the end-of-loan review. */
export function loanSummary(loan: Loan, requests: readonly RoleRequest[], weights: TokenWeights = DEFAULT_WEIGHTS): LoanSummary {
	const start = loan.decidedAt ?? loan.proposedAt;
	const end = loan.endedAt ?? Number.POSITIVE_INFINITY;
	const byModel = new Map<string, { model: string; requests: number; weightedTokens: number }>();
	for (const request of requests) {
		if (request.role !== loan.role || request.ts < start || request.ts > end) continue;
		const model = `${request.provider}/${request.model}`;
		const entry = byModel.get(model) ?? { model, requests: 0, weightedTokens: 0 };
		entry.requests += 1;
		entry.weightedTokens += weightedTokens(request, weights);
		byModel.set(model, entry);
	}
	const models = [...byModel.values()].sort((a, b) => b.requests - a.requests || a.model.localeCompare(b.model));
	return {
		requests: models.reduce((sum, entry) => sum + entry.requests, 0),
		weightedTokens: models.reduce((sum, entry) => sum + entry.weightedTokens, 0),
		byModel: models,
	};
}

/** Local HH:MM, as notices and the trace show times. */
export const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

interface LockPayload {
	pid: number;
	at: number;
}

function defaultIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		const err = error as NodeJS.ErrnoException;
		return err.code !== "ESRCH";
	}
}

function syncSleep(ms: number): void {
	if (ms <= 0) return;
	const sab = new SharedArrayBuffer(4);
	const int32 = new Int32Array(sab);
	Atomics.wait(int32, 0, 0, ms);
}

function tryCreateLock(lockPath: string, now: number): boolean {
	try {
		const fd = openSync(lockPath, "wx", 0o600);
		try {
			writeSync(fd, `${JSON.stringify({ pid: process.pid, at: now })}\n`, undefined, "utf8");
		} finally {
			closeSync(fd);
		}
		return true;
	} catch (error: unknown) {
		const err = error as NodeJS.ErrnoException;
		if (err && err.code === "EEXIST") {
			return false;
		}
		throw error;
	}
}

export interface LockOptions {
	isAlive?: (pid: number) => boolean;
	now?: () => number;
}

export interface WithLoansLockOptions extends LockOptions {
	waitMs?: number;
	retryMs?: number;
}

/**
 * Attempts to acquire the loans lock without waiting.
 * Returns { ok: false } if busy (never throws for busy).
 * If stale (pid dead or at older than 30s), removes and retries once.
 */
export function tryLoansLock<T>(
	dataDir: string,
	now: number,
	fn: () => T,
	options?: LockOptions | ((pid: number) => boolean),
): { ok: true; result: T } | { ok: false } {
	mkdirSync(dataDir, { recursive: true });
	const lockPath = join(dataDir, LOANS_LOCK);
	const isAlive = typeof options === "function" ? options : (options?.isAlive ?? defaultIsAlive);

	let acquired = tryCreateLock(lockPath, now);
	if (!acquired) {
		let stale = false;
		let text = "";
		try {
			text = readFileSync(lockPath, "utf8");
			const parsed = JSON.parse(text) as Partial<LockPayload>;
			if (typeof parsed.pid === "number" && typeof parsed.at === "number") {
				const alive = isAlive(parsed.pid);
				const age = now - parsed.at;
				if (!alive || age > 30_000) {
					stale = true;
				}
			} else {
				stale = true;
			}
		} catch {
			stale = true;
		}

		if (stale) {
			try {
				// Another Pi may have taken over the stale lock meanwhile: remove only the one judged stale.
				if (readFileSync(lockPath, "utf8") === text) unlinkSync(lockPath);
			} catch {
				// Already removed.
			}
			acquired = tryCreateLock(lockPath, now);
		}
	}

	if (!acquired) {
		return { ok: false };
	}

	try {
		const result = fn();
		return { ok: true, result };
	} finally {
		try {
			const text = readFileSync(lockPath, "utf8");
			const parsed = JSON.parse(text) as Partial<LockPayload>;
			if (parsed.pid === process.pid && parsed.at === now) {
				unlinkSync(lockPath);
			}
		} catch {
			// Ignored if file disappeared or unreadable
		}
	}
}

/**
 * Acquires the loans lock, retrying every retryMs (default 50ms) until waitMs (default 2000ms),
 * using synchronous sleep. Throws "ai-balancer: another Pi is writing the loans journal; try again" if busy.
 */
export function withLoansLock<T>(
	dataDir: string,
	fn: () => T,
	options?: WithLoansLockOptions | number,
): T {
	const opts: WithLoansLockOptions = typeof options === "number" ? { waitMs: options } : (options ?? {});
	const waitMs = opts.waitMs ?? 2000;
	const retryMs = opts.retryMs ?? 50;
	const nowFn = opts.now ?? Date.now;
	const start = nowFn();

	while (true) {
		const currentNow = nowFn();
		const attempt = tryLoansLock(dataDir, currentNow, fn, opts);
		if (attempt.ok) {
			return attempt.result;
		}
		const elapsed = nowFn() - start;
		if (elapsed >= waitMs) {
			throw new Error("ai-balancer: another Pi is writing the loans journal; try again");
		}
		const sleepTime = Math.min(retryMs, Math.max(1, waitMs - elapsed));
		syncSleep(sleepTime);
	}
}

export interface LoanChange {
	from: LoanStatus | "new";
	loan: Loan;
}

/**
 * Merges loan changes into fresh loans by id.
 * A transition applies only when the fresh loan with that id has status `from`.
 * A "new" proposal applies only when fresh has no open loan for that role and pool.
 * Returns { loans, applied, skipped }.
 */
export function mergeLoanChanges(
	fresh: readonly Loan[],
	changes: readonly LoanChange[],
): { loans: Loan[]; applied: Loan[]; skipped: Loan[] } {
	const current = [...fresh];
	const applied: Loan[] = [];
	const skipped: Loan[] = [];

	for (const change of changes) {
		if (change.from === "new") {
			const hasOpen = current.some(
				loan => isOpen(loan) && loan.role === change.loan.role && loan.pool === change.loan.pool,
			);
			if (hasOpen) {
				skipped.push(change.loan);
			} else {
				current.push(change.loan);
				applied.push(change.loan);
			}
		} else {
			const index = current.findIndex(loan => loan.id === change.loan.id);
			if (index >= 0 && current[index].status === change.from) {
				current[index] = change.loan;
				applied.push(change.loan);
			} else {
				skipped.push(change.loan);
			}
		}
	}

	return { loans: current, applied, skipped };
}

/**
 * Writes changes found on the request path or at session start: never waits for
 * the lock (busy → `{ ok: false }`, the next request retries), re-reads the journal
 * inside it, merges by id and audits only what applied.
 */
export function commitLoanChanges(
	dataDir: string,
	now: number,
	changes: readonly LoanChange[],
	options?: LockOptions,
): { ok: true; applied: Loan[]; skipped: Loan[] } | { ok: false } {
	const attempt = tryLoansLock(
		dataDir,
		now,
		() => {
			const merged = mergeLoanChanges(readLoans(dataDir).loans, changes);
			if (merged.applied.length > 0) {
				writeLoans(dataDir, merged.loans);
				for (const loan of merged.applied) auditLoan(dataDir, now, loan);
			}
			return merged;
		},
		options,
	);
	return attempt.ok ? { ok: true, applied: attempt.result.applied, skipped: attempt.result.skipped } : { ok: false };
}

const CLOSED_STATUSES = new Set<LoanStatus>(["ended", "declined", "kept", "reverted"]);

/**
 * Checks whether a new proposal for this role and pool is blocked by cooldown
 * (15 min after the most recent closed loan) or by a user-declined loan waiting for reset.
 */
export function proposalBlock(
	loans: readonly Loan[],
	role: string,
	pool: string,
	now: number,
	policy: SwitchPolicy = SWITCH_DEFAULTS,
): string | undefined {
	const userDeclined = loans.find(
		loan =>
			loan.role === role &&
			loan.pool === pool &&
			loan.status === "declined" &&
			loan.decidedBy === "user" &&
			(loan.endsAt === null || now < loan.endsAt),
	);
	if (userDeclined) {
		const until = userDeclined.endsAt !== null ? ` (${clock(userDeclined.endsAt)})` : "";
		return `${role}: you chose to wait for the reset${until}`;
	}

	const closed = loans.filter(
		loan => loan.role === role && loan.pool === pool && CLOSED_STATUSES.has(loan.status),
	);
	if (closed.length === 0) return undefined;

	closed.sort((a, b) => {
		const timeA = (a.endedAt ?? a.decidedAt) ?? a.proposedAt;
		const timeB = (b.endedAt ?? b.decidedAt) ?? b.proposedAt;
		return timeB - timeA;
	});

	const mostRecent = closed[0];
	const closedAt = (mostRecent.endedAt ?? mostRecent.decidedAt) ?? mostRecent.proposedAt;
	const cooldownUntil = closedAt + policy.cooldownMs;
	if (now < cooldownUntil) {
		return `${role} cooldown until ${clock(cooldownUntil)}`;
	}

	return undefined;
}

/** One line for notices and `/balancer loans`. */
export function formatLoan(loan: Loan, now: number, policy: SwitchPolicy = SWITCH_DEFAULTS): string {
	let state: string;
	if (loan.status === "proposed") {
		const left = Math.max(0, Math.ceil((loan.proposedAt + policy.graceMs - now) / 60_000));
		state = loan.level === "auto" ? `proposed (auto: applies at the next launch or in ${left} min)` : "proposed (suggest: waits for you)";
	} else if (loan.status === "active") {
		state = `active (applied by ${loan.decidedBy ?? "user"})`;
	} else {
		state = loan.status;
	}
	const ends = loan.endsAt === null ? "ends when you end it" : `ends ${clock(loan.endsAt)}`;
	return `${loan.role}: ${loan.from} → ${loan.to} · ${state} · ${ends} · ${loan.why}`;
}
