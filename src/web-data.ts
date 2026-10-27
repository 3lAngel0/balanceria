import { closeSync, openSync, readSync } from "node:fs";
import type { CircuitBreakerStatus } from "./circuit-breaker.ts";
import type { RoleConsumer, SessionConsumer } from "./consumers.ts";
import type { HistoryEntry, RouteDecision } from "./history.ts";
import type { QuotaReport } from "./quota-report.ts";
import { resolveRole, type AgentTask } from "./roles.ts";
import type { Suggestion } from "./suggestions.ts";
import type { CurrentSession, UsageStats } from "./usage-panel.ts";

// What the live web report sends to the browser: the overview the page polls,
// and the detail of one session when it is clicked. Both are plain JSON built
// from the same history the HUD reads. Session file paths appear only in the
// detail, next to the command that resumes the session in a shell.

const HEADER_BYTES = 64 * 1024;
const DEFAULT_REQUEST_LIMIT = 200;
const DECISION_LIMIT = 50;

export interface WebSession extends SessionConsumer {
	/** A session file exists, so the page offers the shell command and "open in Pi". */
	canOpen: boolean;
	isCurrent: boolean;
}

export interface WebRole extends Omit<RoleConsumer, "sessions"> {
	sessions: WebSession[];
}

export interface WebReport {
	generatedAt: string;
	current?: CurrentSession;
	circuit?: CircuitBreakerStatus;
	totals: { tokens: number; cost: number; requests: number };
	providers: UsageStats["providers"];
	daily: UsageStats["daily"];
	quota: QuotaReport["current"];
	roles: WebRole[];
	suggestions: { rule: Suggestion["rule"]; title: string; session: string | null; alias: string | null }[];
	decisions: WebDecisions;
}

export type WebDecision = Omit<RouteDecision, "kind">;

/** Why pools chose their providers: counts over every decision, detail for the newest. */
export interface WebDecisions {
	total: number;
	byRule: { rule: string; count: number }[];
	byRole: { role: string; pool: string; chosen: string; count: number }[];
	/** Newest first, session ids shortened to 8 characters. */
	recent: WebDecision[];
	omitted: number;
}

export interface WebReportInput {
	now: number;
	stats: UsageStats;
	quota: QuotaReport;
	consumers: readonly RoleConsumer[];
	suggestions: readonly Suggestion[];
	sessionPaths: ReadonlyMap<string, string>;
	current?: CurrentSession;
	circuit?: CircuitBreakerStatus;
	routes?: readonly RouteDecision[];
}

export function buildWebReport(input: WebReportInput): WebReport {
	const providers = input.stats.providers;
	return {
		generatedAt: new Date(input.now).toISOString(),
		current: input.current,
		circuit: input.circuit,
		totals: {
			tokens: providers.reduce((sum, p) => sum + p.total, 0),
			cost: providers.reduce((sum, p) => sum + p.cost, 0),
			requests: providers.reduce((sum, p) => sum + p.requests, 0),
		},
		providers,
		daily: input.stats.daily,
		quota: input.quota.current,
		roles: input.consumers.map(role => ({
			...role,
			sessions: role.sessions.map(session => ({
				...session,
				canOpen: input.sessionPaths.has(session.session),
				isCurrent: session.session === input.current?.session,
			})),
		})),
		suggestions: input.suggestions.map(item => ({ rule: item.rule, title: item.title, session: item.target.session ?? null, alias: item.target.alias ?? null })),
		decisions: buildDecisions(input.routes ?? []),
	};
}

/** The sessions the overview links to (roles and suggestions), once each in order. */
export function snapshotSessionIds(report: Pick<WebReport, "roles" | "suggestions">): string[] {
	const ids = new Set<string>();
	for (const role of report.roles) for (const session of role.sessions) ids.add(session.session);
	for (const suggestion of report.suggestions) if (suggestion.session) ids.add(suggestion.session);
	return [...ids];
}

export function buildDecisions(routes: readonly RouteDecision[]): WebDecisions {
	const byRule = new Map<string, number>();
	const byRole = new Map<string, { role: string; pool: string; chosen: string; count: number }>();
	for (const route of routes) {
		byRule.set(route.decidedBy, (byRule.get(route.decidedBy) ?? 0) + 1);
		const key = `${route.role}\n${route.pool}\n${route.chosen}`;
		const entry = byRole.get(key) ?? { role: route.role, pool: route.pool, chosen: route.chosen, count: 0 };
		entry.count += 1;
		byRole.set(key, entry);
	}
	const newest = [...routes].sort((a, b) => b.ts - a.ts).slice(0, DECISION_LIMIT);
	return {
		total: routes.length,
		byRule: [...byRule].map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule)),
		byRole: [...byRole.values()].sort((a, b) => b.count - a.count || a.role.localeCompare(b.role) || a.pool.localeCompare(b.pool)),
		recent: newest.map(({ kind: _kind, ...rest }) => ({ ...rest, session: rest.session.slice(0, 8) })),
		omitted: routes.length - newest.length,
	};
}

export interface SessionTotals {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** input + cacheRead + cacheWrite: what the model was sent again. */
	contextResend: number;
	newOutput: number;
	total: number;
}

export interface SessionDetail {
	session: string;
	alias: string | null;
	project: string | null;
	role: string;
	parentSession: string | null;
	path: string | null;
	cwd: string | null;
	canOpen: boolean;
	isCurrent: boolean;
	totals: SessionTotals;
	firstTs: number | null;
	lastTs: number | null;
	models: { provider: string; model: string; requests: number; total: number }[];
	children: { session: string; agent: string; label: string | null; requests: number; total: number }[];
	/** Newest first, at most `requestLimit`. */
	requests: Pick<HistoryEntry, "ts" | "provider" | "model" | "input" | "output" | "cacheRead" | "cacheWrite" | "contextTokens" | "contextWindow">[];
	omittedRequests: number;
	/** Shell command that resumes the session, when its file is known. */
	resume: string | null;
}

export interface SessionDetailInput {
	id: string;
	requests: readonly HistoryEntry[];
	tasks: ReadonlyMap<string, AgentTask>;
	path: string | null;
	cwd: string | null;
	alias: string | null;
	currentSession?: string;
	requestLimit?: number;
}

const tokensOf = (entry: HistoryEntry) => entry.input + entry.cacheRead + entry.cacheWrite + entry.output;

function totalsOf(entries: readonly HistoryEntry[]): SessionTotals {
	const totals: SessionTotals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextResend: 0, newOutput: 0, total: 0 };
	for (const entry of entries) {
		totals.requests += 1;
		totals.input += entry.input;
		totals.output += entry.output;
		totals.cacheRead += entry.cacheRead;
		totals.cacheWrite += entry.cacheWrite;
		totals.contextResend += entry.input + entry.cacheRead + entry.cacheWrite;
		totals.newOutput += entry.output;
		totals.total += tokensOf(entry);
	}
	return totals;
}

/** Undefined when the history has no request of this session and no file is known. */
export function buildSessionDetail(input: SessionDetailInput): SessionDetail | undefined {
	const own = input.requests.filter(entry => entry.session === input.id).sort((a, b) => a.ts - b.ts);
	if (own.length === 0 && !input.path) return undefined;
	const task = input.tasks.get(input.id);
	const named = [...own].reverse().find(entry => entry.sessionName)?.sessionName ?? null;

	const models = new Map<string, { provider: string; model: string; requests: number; total: number }>();
	for (const entry of own) {
		const key = `${entry.provider}\u0000${entry.model}`;
		const row = models.get(key) ?? { provider: entry.provider, model: entry.model, requests: 0, total: 0 };
		row.requests += 1;
		row.total += tokensOf(entry);
		models.set(key, row);
	}

	const children: SessionDetail["children"] = [];
	for (const child of input.tasks.values()) {
		if (child.parentSession !== input.id) continue;
		const totals = totalsOf(input.requests.filter(entry => entry.session === child.session));
		children.push({ session: child.session, agent: child.agent, label: child.label, requests: totals.requests, total: totals.total });
	}
	children.sort((a, b) => b.total - a.total);

	const limit = input.requestLimit ?? DEFAULT_REQUEST_LIMIT;
	const newest = own.slice(-limit).reverse();
	return {
		session: input.id,
		alias: input.alias ?? named ?? task?.label ?? null,
		project: own[0]?.project ?? null,
		role: resolveRole(own[0] ?? { session: input.id }, input.tasks),
		parentSession: task?.parentSession ?? null,
		path: input.path,
		cwd: input.cwd,
		canOpen: input.path !== null,
		isCurrent: input.id === input.currentSession,
		totals: totalsOf(own),
		firstTs: own[0]?.ts ?? null,
		lastTs: own.at(-1)?.ts ?? null,
		models: [...models.values()].sort((a, b) => b.total - a.total),
		children,
		requests: newest.map(({ ts, provider, model, input: tokensIn, output, cacheRead, cacheWrite, contextTokens, contextWindow }) => ({ ts, provider, model, input: tokensIn, output, cacheRead, cacheWrite, contextTokens, contextWindow })),
		omittedRequests: own.length - newest.length,
		resume: resumeCommand(input.cwd, input.path),
	};
}

function shellQuote(text: string): string {
	return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Pi looks the session up in the current project first, so the command enters its directory. */
export function resumeCommand(cwd: string | null, path: string | null): string | null {
	if (!path) return null;
	const resume = `gentle-shell --session ${shellQuote(path)}`;
	return cwd ? `cd ${shellQuote(cwd)} && ${resume}` : resume;
}

/** The `cwd` of the session header, the first line Pi writes; null when unreadable. */
export function readSessionCwd(path: string): string | null {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return null;
	}
	try {
		const buffer = Buffer.alloc(HEADER_BYTES);
		const read = readSync(fd, buffer, 0, HEADER_BYTES, 0);
		const line = buffer.subarray(0, read).toString("utf8").split("\n", 1)[0] ?? "";
		const header = JSON.parse(line) as { type?: unknown; cwd?: unknown };
		return header.type === "session" && typeof header.cwd === "string" ? header.cwd : null;
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}
