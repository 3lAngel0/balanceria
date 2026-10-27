import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Which role spent each request. Subagents run in their own Pi sessions and
// the child process is not told its agent name, but Gentle's task store keeps
// one file per subagent launch with the agent and the child's session file.
// Joining history rows to that store at read time also names the roles of
// rows written before this module existed.
//
// The task file is written only when the task ends, so at routing time the
// child reads its agent from its own argv instead (agentNameFromArgv).

export const ORCHESTRATOR_ROLE = "orchestrator";
/** A child session whose task file is gone or unreadable: a subagent, agent unknown. */
export const UNKNOWN_SUBAGENT_ROLE = "subagent";

export const DEFAULT_AGENT_TASKS_DIR = join(homedir(), ".gentle-shell", "agent", "gentle-agents", "tasks");

export interface AgentTask {
	/** The child's Pi session id, the same id the history records. */
	session: string;
	agent: string;
	/** Short human label of the task, e.g. "verify login token (credentials)". */
	label: string | null;
	parentSession: string | null;
	/** The child's Pi session file, as the task store recorded it. */
	sessionPath: string | null;
}

const SESSION_FILE = /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export function sessionIdFromPath(path: unknown): string | undefined {
	if (typeof path !== "string") return undefined;
	return SESSION_FILE.exec(path)?.[1];
}

export function parseAgentTask(raw: unknown): AgentTask | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const task = (raw as { task?: unknown }).task;
	if (typeof task !== "object" || task === null) return undefined;
	const value = task as Record<string, unknown>;
	const session = sessionIdFromPath(value.sessionPath);
	if (!session || typeof value.agent !== "string" || value.agent === "") return undefined;
	return {
		session,
		agent: value.agent,
		label: typeof value.label === "string" ? value.label : null,
		parentSession: typeof value.parentSessionId === "string" ? value.parentSessionId : null,
		sessionPath: value.sessionPath as string,
	};
}

/** Child session id -> task, from Gentle's task files; unreadable files are skipped. */
export function readAgentTasks(dir: string = DEFAULT_AGENT_TASKS_DIR): Map<string, AgentTask> {
	const tasks = new Map<string, AgentTask>();
	let names: string[];
	try {
		names = readdirSync(dir).filter(name => name.endsWith(".json"));
	} catch {
		return tasks;
	}
	for (const name of names) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(join(dir, name), "utf8"));
		} catch {
			continue;
		}
		const task = parseAgentTask(parsed);
		if (task) tasks.set(task.session, task);
	}
	return tasks;
}

// Gentle passes long agent instructions as a file in a temporary directory
// named after the agent (gentle-pi lib/agents-runner.ts). This is Gentle's
// implementation detail, not a contract: when it changes, routing falls back
// to an unknown subagent and the read-time join still names the role.
const INSTRUCTIONS_FILE = /[\\/]gentle-pi-subagent-([A-Za-z0-9._-]{1,64})-[A-Za-z0-9]{6}[\\/]instructions\.md$/;

/** The agent name of a Gentle child process, from the instructions file in its argv. */
export function agentNameFromArgv(argv: readonly string[]): string | undefined {
	for (let i = 0; i < argv.length - 1; i++) {
		if (argv[i] !== "--append-system-prompt") continue;
		const name = INSTRUCTIONS_FILE.exec(argv[i + 1])?.[1];
		if (name) return name;
	}
	return undefined;
}

export interface RoutingRole {
	role: string;
	/** Where the role came from: the child's argv, or nothing known. */
	source: "argv" | "none";
}

/** The role of this process while it routes a request. */
export function routingRole(argv: readonly string[], child: boolean): RoutingRole {
	if (!child) return { role: ORCHESTRATOR_ROLE, source: "none" };
	const agent = agentNameFromArgv(argv);
	return agent ? { role: agent, source: "argv" } : { role: UNKNOWN_SUBAGENT_ROLE, source: "none" };
}

export function resolveRole(entry: { session: string; child?: boolean }, tasks: ReadonlyMap<string, AgentTask>): string {
	const task = tasks.get(entry.session);
	if (task) return task.agent;
	return entry.child ? UNKNOWN_SUBAGENT_ROLE : ORCHESTRATOR_ROLE;
}
