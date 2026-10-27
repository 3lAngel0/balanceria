import { appendFileSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { BalancerEvent } from "./events.ts";
import type { CandidateState, DecidedBy, TraceStep } from "./router.ts";
import type { RouteSwitchCost } from "./switch-cost.ts";

// Per-request token history for the advanced usage panel, kept to compare
// subscriptions later. One append-only JSONL file per local day: concurrent
// sessions only ever append, and retention deletes whole past days, so no file
// that a session may still write is ever rewritten.

export const HISTORY_DIR = "history";
export const RETENTION_DAYS = 30;

export interface HistoryEntry {
	ts: number;
	/** Pi session id; subagents run in their own sessions. */
	session: string;
	/** Basename of the session's working directory. */
	project: string;
	provider: string;
	model: string;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Context size after the response, when Pi knows it. */
	contextTokens: number | null;
	contextWindow: number | null;
	/** True in a subagent process; absent in rows written before it was recorded. */
	child?: boolean;
	/** The session's human name, when it has one. */
	sessionName?: string | null;
}

/** One read of a subscription window, written whenever usage is fetched. */
export interface QuotaSample {
	kind: "quota";
	ts: number;
	session: string;
	limit: string;
	key?: string;
	window: string;
	windowSeconds: number;
	usedPercent: number;
	resetAt: number | null;
}

/** A request the provider rejected because the subscription quota was exhausted. */
export interface QuotaError {
	kind: "quota-error";
	ts: number;
	session: string;
	project: string;
	key: string;
	until: number | null;
}

/**
 * Why a pool chose a provider: written when a session's decision for a pool
 * changes (provider or deciding rule), not on every repeated sticky turn.
 */
export interface RouteDecision {
	kind: "route";
	ts: number;
	session: string;
	project: string;
	pool: string;
	/** Agent at routing time; `orchestrator` or `subagent` when unknown. */
	role: string;
	roleSource: "argv" | "none";
	/** Pi's input reason: user, continuation, retry or direct. */
	reason: string;
	/** "provider/model". */
	chosen: string;
	decidedBy: DecidedBy;
	steps: TraceStep[];
	candidates: CandidateState[];
	contextTokens: number | null;
	/** Present when a continuation or retry moved the session to another provider. */
	switchCost?: RouteSwitchCost;
}

export interface HistoryData {
	requests: HistoryEntry[];
	samples: QuotaSample[];
	errors: QuotaError[];
	routes: RouteDecision[];
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

export function dayKey(ts: number): string {
	const date = new Date(ts);
	const two = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** First local day kept: today and the 29 days before it. */
function oldestKeptDay(now: number, days: number): string {
	const date = new Date(now);
	date.setDate(date.getDate() - (days - 1));
	return dayKey(date.getTime());
}

export function appendHistory(dataDir: string, entry: HistoryEntry | QuotaSample | QuotaError | RouteDecision): void {
	const dir = join(dataDir, HISTORY_DIR);
	mkdirSync(dir, { recursive: true });
	appendFileSync(join(dir, `${dayKey(entry.ts)}.jsonl`), `${JSON.stringify(entry)}\n`);
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function isNumberOrNull(value: unknown): value is number | null {
	return value === null || isFiniteNumber(value);
}

function parseRecord(line: string): HistoryEntry | QuotaSample | QuotaError | RouteDecision | undefined {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	const allStrings = (keys: string[]) => keys.every(key => typeof value[key] === "string");
	const allNumbers = (keys: string[]) => keys.every(key => isFiniteNumber(value[key]));
	if (value.kind === undefined || value.kind === "request") {
		const valid =
			allStrings(["session", "project", "provider", "model"]) &&
			allNumbers(["ts", "input", "output", "cacheRead", "cacheWrite"]) &&
			isNumberOrNull(value.contextTokens) &&
			isNumberOrNull(value.contextWindow) &&
			(value.child === undefined || typeof value.child === "boolean") &&
			(value.sessionName === undefined || value.sessionName === null || typeof value.sessionName === "string");
		return valid ? (value as unknown as HistoryEntry) : undefined;
	}
	if (value.kind === "quota") {
		const valid =
			allStrings(["session", "limit", "window"]) &&
			allNumbers(["ts", "windowSeconds", "usedPercent"]) &&
			isNumberOrNull(value.resetAt) &&
			(value.key === undefined || typeof value.key === "string");
		return valid ? (value as unknown as QuotaSample) : undefined;
	}
	if (value.kind === "quota-error") {
		const valid = allStrings(["session", "project", "key"]) && isFiniteNumber(value.ts) && isNumberOrNull(value.until);
		return valid ? (value as unknown as QuotaError) : undefined;
	}
	if (value.kind === "route") {
		const valid =
			allStrings(["session", "project", "pool", "role", "roleSource", "reason", "chosen", "decidedBy"]) &&
			isFiniteNumber(value.ts) &&
			Array.isArray(value.steps) &&
			Array.isArray(value.candidates) &&
			isNumberOrNull(value.contextTokens);
		return valid ? (value as unknown as RouteDecision) : undefined;
	}
	return undefined;
}

function dayFiles(dataDir: string): string[] {
	try {
		return readdirSync(join(dataDir, HISTORY_DIR)).filter(name => DAY_FILE.test(name));
	} catch {
		return [];
	}
}

/** Records of the last `days` local days, oldest first; torn lines are skipped. */
export function readHistory(dataDir: string, now: number, days = RETENTION_DAYS): HistoryData {
	const oldest = oldestKeptDay(now, days);
	const data: HistoryData = { requests: [], samples: [], errors: [], routes: [] };
	for (const name of dayFiles(dataDir).sort()) {
		if (name.slice(0, 10) < oldest) continue;
		let raw: string;
		try {
			raw = readFileSync(join(dataDir, HISTORY_DIR, name), "utf8");
		} catch {
			continue;
		}
		for (const line of raw.split("\n")) {
			const record = line.trim() ? parseRecord(line) : undefined;
			if (!record) continue;
			if ("kind" in record && record.kind === "quota") data.samples.push(record);
			else if ("kind" in record && record.kind === "quota-error") data.errors.push(record);
			else if ("kind" in record && record.kind === "route") data.routes.push(record);
			else data.requests.push(record as HistoryEntry);
		}
	}
	const byTime = (a: { ts: number }, b: { ts: number }) => a.ts - b.ts;
	data.requests.sort(byTime);
	data.samples.sort(byTime);
	data.errors.sort(byTime);
	data.routes.sort(byTime);
	return data;
}

/** Deletes day files older than the retention window; returns their names. */
export function pruneHistory(dataDir: string, now: number, days = RETENTION_DAYS): string[] {
	const oldest = oldestKeptDay(now, days);
	const removed: string[] = [];
	for (const name of dayFiles(dataDir)) {
		if (name.slice(0, 10) >= oldest) continue;
		try {
			unlinkSync(join(dataDir, HISTORY_DIR, name));
			removed.push(name);
		} catch {
			// Another session pruned it first.
		}
	}
	return removed;
}

export const LEGACY_SESSION = "legacy";
export const LEGACY_PROJECT = "(before history)";

/**
 * Requests and quota errors from the shared event log that predate the
 * history files, so the panel covers the days before the history existed.
 * `cutoff` is the earliest history record (Infinity when there is none); only
 * events inside the retention window are kept.
 */
export function legacyRecords(events: readonly BalancerEvent[], cutoff: number, now: number, days = RETENTION_DAYS): { requests: HistoryEntry[]; errors: QuotaError[] } {
	const oldest = oldestKeptDay(now, days);
	const legacy: { requests: HistoryEntry[]; errors: QuotaError[] } = { requests: [], errors: [] };
	for (const event of events) {
		if (event.ts >= cutoff || dayKey(event.ts) < oldest) continue;
		if (event.type === "usage") {
			legacy.requests.push({
				ts: event.ts,
				session: LEGACY_SESSION,
				project: LEGACY_PROJECT,
				provider: event.provider,
				model: event.model,
				input: event.input,
				output: event.output,
				cacheRead: event.cacheRead,
				cacheWrite: event.cacheWrite,
				contextTokens: null,
				contextWindow: null,
			});
		} else if (event.type === "exhausted") {
			legacy.errors.push({ kind: "quota-error", ts: event.ts, session: LEGACY_SESSION, project: LEGACY_PROJECT, key: event.key, until: event.until ?? null });
		}
	}
	return legacy;
}
