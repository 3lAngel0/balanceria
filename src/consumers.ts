import type { HistoryEntry } from "./history.ts";
import { resolveRole, type AgentTask } from "./roles.ts";

// What spends the most, for the HUD: tokens per role (orchestrator, each
// subagent type), and inside each role the sessions that spent them.
//
// Every request re-sends its whole context, so tokens are split in two:
// - contextResend = input + cacheRead + cacheWrite: everything sent to the
//   model, which grows with the conversation length;
// - newOutput = output: what the model generated.
// A large contextResend with little newOutput points at long sessions that
// should be compacted or split, not at heavy work.

export interface ConsumerTotals {
	requests: number;
	contextResend: number;
	newOutput: number;
	total: number;
}

export interface SessionConsumer extends ConsumerTotals {
	session: string;
	/** Latest session name, else the subagent task label, else null. */
	alias: string | null;
	project: string;
	/** The session that launched this subagent; null for top-level sessions. */
	parentSession: string | null;
	providers: string[];
	firstTs: number;
	lastTs: number;
}

export interface RoleConsumer extends ConsumerTotals {
	role: string;
	/** Biggest total first. */
	sessions: SessionConsumer[];
}

function add(totals: ConsumerTotals, request: HistoryEntry): void {
	const resend = request.input + request.cacheRead + request.cacheWrite;
	totals.requests += 1;
	totals.contextResend += resend;
	totals.newOutput += request.output;
	totals.total += resend + request.output;
}

const byTotal = <T extends ConsumerTotals>(a: T, b: T) => b.total - a.total;

/** Roles biggest first, each with its sessions biggest first. */
export function topConsumers(requests: readonly HistoryEntry[], tasks: ReadonlyMap<string, AgentTask>): RoleConsumer[] {
	const roles = new Map<string, RoleConsumer>();
	const sessions = new Map<string, SessionConsumer>();
	const namedAt = new Map<string, number>();

	for (const request of requests) {
		const role = resolveRole(request, tasks);
		let roleConsumer = roles.get(role);
		if (!roleConsumer) {
			roleConsumer = { role, requests: 0, contextResend: 0, newOutput: 0, total: 0, sessions: [] };
			roles.set(role, roleConsumer);
		}
		add(roleConsumer, request);

		let session = sessions.get(request.session);
		if (!session) {
			const task = tasks.get(request.session);
			session = {
				session: request.session,
				alias: task?.label ?? null,
				project: request.project,
				parentSession: task?.parentSession ?? null,
				providers: [],
				firstTs: request.ts,
				lastTs: request.ts,
				requests: 0,
				contextResend: 0,
				newOutput: 0,
				total: 0,
			};
			sessions.set(request.session, session);
			roleConsumer.sessions.push(session);
		}
		add(session, request);
		if (!session.providers.includes(request.provider)) session.providers.push(request.provider);
		session.firstTs = Math.min(session.firstTs, request.ts);
		session.lastTs = Math.max(session.lastTs, request.ts);
		if (request.sessionName && request.ts >= (namedAt.get(request.session) ?? -Infinity)) {
			session.alias = request.sessionName;
			namedAt.set(request.session, request.ts);
		}
	}

	for (const role of roles.values()) role.sessions.sort(byTotal);
	return [...roles.values()].sort((a, b) => byTotal(a, b) || a.role.localeCompare(b.role));
}

/**
 * Fills the alias of the first `limit` sessions of each role that still have
 * none, using `resolve(session, task)`; returns new objects.
 */
export function withAliases(roles: readonly RoleConsumer[], limit: number, resolve: (session: string) => string | null): RoleConsumer[] {
	return roles.map(role => ({
		...role,
		sessions: role.sessions.map((session, index) => (index < limit && session.alias === null ? { ...session, alias: resolve(session.session) } : session)),
	}));
}
