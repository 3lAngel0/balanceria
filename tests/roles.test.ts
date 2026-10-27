import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentNameFromArgv, parseAgentTask, readAgentTasks, resolveRole, routingRole, sessionIdFromPath, ORCHESTRATOR_ROLE, UNKNOWN_SUBAGENT_ROLE } from "../src/roles.ts";

const CHILD = "01a1523f-5686-743f-964c-58537e80b88b";
const PARENT = "01a1510a-8e84-75aa-a1fe-c3d9560786c3";

function taskFile(overrides: Record<string, unknown> = {}) {
	return {
		task: {
			id: "mvepijmv-7-etur",
			agent: "gentle-ai-verify",
			label: "verify login token (credentials)",
			parentSessionId: PARENT,
			cwd: "/home/dev/projects/my-web",
			sessionPath: `/home/dev/.gentle-shell/agent/gentle-agents/sessions/2026-10-19T03-40-45-062Z_${CHILD}.jsonl`,
			...overrides,
		},
		thread: [],
	};
}

test("sessionIdFromPath takes the session id at the end of a Pi session file name", () => {
	assert.equal(sessionIdFromPath(`/x/2026-10-19T03-40-45-062Z_${CHILD}.jsonl`), CHILD);
	assert.equal(sessionIdFromPath("/x/notes.jsonl"), undefined);
	assert.equal(sessionIdFromPath(null), undefined);
});

test("parseAgentTask keeps the agent, label and parent of a task with a session file", () => {
	assert.deepEqual(parseAgentTask(taskFile()), {
		session: CHILD,
		agent: "gentle-ai-verify",
		label: "verify login token (credentials)",
		parentSession: PARENT,
		sessionPath: `/home/dev/.gentle-shell/agent/gentle-agents/sessions/2026-10-19T03-40-45-062Z_${CHILD}.jsonl`,
	});
	assert.deepEqual(parseAgentTask(taskFile({ label: 7, parentSessionId: undefined })), {
		session: CHILD,
		agent: "gentle-ai-verify",
		label: null,
		parentSession: null,
		sessionPath: `/home/dev/.gentle-shell/agent/gentle-agents/sessions/2026-10-19T03-40-45-062Z_${CHILD}.jsonl`,
	});
});

test("parseAgentTask rejects tasks without an agent or a session file", () => {
	assert.equal(parseAgentTask(taskFile({ sessionPath: null })), undefined);
	assert.equal(parseAgentTask(taskFile({ agent: "" })), undefined);
	assert.equal(parseAgentTask({ thread: [] }), undefined);
	assert.equal(parseAgentTask("nope"), undefined);
});

test("readAgentTasks maps child sessions to their tasks and skips unreadable files", () => {
	const dir = mkdtempSync(join(tmpdir(), "balancer-tasks-"));
	writeFileSync(join(dir, "a.json"), JSON.stringify(taskFile()));
	writeFileSync(join(dir, "b.json"), "{\"task\":");
	writeFileSync(join(dir, "c.json"), JSON.stringify(taskFile({ sessionPath: null })));
	writeFileSync(join(dir, "notes.txt"), JSON.stringify(taskFile({ agent: "ignored" })));
	const tasks = readAgentTasks(dir);
	assert.deepEqual([...tasks.keys()], [CHILD]);
	assert.equal(tasks.get(CHILD)?.agent, "gentle-ai-verify");
	assert.equal(readAgentTasks(join(dir, "missing")).size, 0);
});

test("resolveRole names the agent of a known child, never guesses an unknown one, and defaults to the orchestrator", () => {
	const tasks = new Map([[CHILD, { session: CHILD, agent: "gentle-ai-verify", label: null, parentSession: PARENT, sessionPath: null }]]);
	assert.equal(resolveRole({ session: CHILD }, tasks), "gentle-ai-verify");
	assert.equal(resolveRole({ session: CHILD, child: true }, tasks), "gentle-ai-verify");
	assert.equal(resolveRole({ session: "other", child: true }, tasks), UNKNOWN_SUBAGENT_ROLE);
	assert.equal(resolveRole({ session: PARENT }, tasks), ORCHESTRATOR_ROLE);
	assert.equal(resolveRole({ session: PARENT, child: false }, tasks), ORCHESTRATOR_ROLE);
	assert.equal(UNKNOWN_SUBAGENT_ROLE, "subagent");
	assert.equal(ORCHESTRATOR_ROLE, "orchestrator");
});

test("agentNameFromArgv reads the agent from the instructions file Gentle passes to a child", () => {
	const argv = ["node", "pi", "--mode", "rpc", "--append-system-prompt", "/tmp/gentle-pi-subagent-gentle-ai-verify-aB3x9Z/instructions.md", "--model", "pool/opus"];
	assert.equal(agentNameFromArgv(argv), "gentle-ai-verify");
	assert.equal(agentNameFromArgv(["pi", "--append-system-prompt", "C:\\Temp\\gentle-pi-subagent-worker-Zz0000\\instructions.md"]), "worker");
});

test("agentNameFromArgv knows nothing from inline instructions, a missing flag or a path under another flag", () => {
	assert.equal(agentNameFromArgv(["pi", "--append-system-prompt", "You are a reviewer."]), undefined);
	assert.equal(agentNameFromArgv(["pi", "--mode", "rpc"]), undefined);
	assert.equal(agentNameFromArgv(["pi", "--append-system-prompt"]), undefined);
	assert.equal(agentNameFromArgv(["pi", "--session", "/tmp/gentle-pi-subagent-worker-Zz0000/instructions.md"]), undefined);
});

test("routingRole names a child by its argv agent, else as an unknown subagent, and the parent as the orchestrator", () => {
	const argv = ["pi", "--append-system-prompt", "/tmp/gentle-pi-subagent-gentle-ai-explore-q1w2e3/instructions.md"];
	assert.deepEqual(routingRole(argv, true), { role: "gentle-ai-explore", source: "argv" });
	assert.deepEqual(routingRole(["pi"], true), { role: UNKNOWN_SUBAGENT_ROLE, source: "none" });
	assert.deepEqual(routingRole(["pi"], false), { role: ORCHESTRATOR_ROLE, source: "none" });
});
