import { test } from "node:test";
import assert from "node:assert/strict";
import type { HistoryEntry } from "../src/history.ts";
import type { AgentTask } from "../src/roles.ts";
import { topConsumers, withAliases } from "../src/consumers.ts";

const PARENT = "11111111-1111-1111-1111-111111111111";
const CHILD = "22222222-2222-2222-2222-222222222222";
const LOST_CHILD = "33333333-3333-3333-3333-333333333333";

function request(ts: number, session: string, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		ts,
		session,
		project: "web",
		provider: "claude-bridge",
		model: "claude-opus-5-5",
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		contextTokens: null,
		contextWindow: null,
		...overrides,
	};
}

const TASKS = new Map<string, AgentTask>([[CHILD, { session: CHILD, agent: "gentle-ai-verify", label: "verify login token", parentSession: PARENT, sessionPath: null }]]);

test("splits context resend (input + cache read + cache write) from new output", () => {
	const result = topConsumers([request(1, PARENT, { input: 10, cacheRead: 100, cacheWrite: 5, output: 7 })], TASKS);
	assert.equal(result.length, 1);
	const role = result[0];
	assert.deepEqual(
		{ role: role.role, requests: role.requests, contextResend: role.contextResend, newOutput: role.newOutput, total: role.total },
		{ role: "orchestrator", requests: 1, contextResend: 115, newOutput: 7, total: 122 },
	);
	assert.deepEqual(
		{ contextResend: role.sessions[0].contextResend, newOutput: role.sessions[0].newOutput, total: role.sessions[0].total },
		{ contextResend: 115, newOutput: 7, total: 122 },
	);
});

test("groups by role, biggest first, and drills down into sessions biggest first", () => {
	const other = "44444444-4444-4444-4444-444444444444";
	const result = topConsumers(
		[
			request(1, PARENT, { input: 50 }),
			request(2, other, { input: 80 }),
			request(3, CHILD, { input: 200, child: true }),
			request(4, LOST_CHILD, { input: 10, child: true }),
		],
		TASKS,
	);
	assert.deepEqual(
		result.map(role => [role.role, role.total]),
		[
			["gentle-ai-verify", 200],
			["orchestrator", 130],
			["subagent", 10],
		],
	);
	assert.deepEqual(
		result[1].sessions.map(session => [session.session, session.total]),
		[
			[other, 80],
			[PARENT, 50],
		],
	);
});

test("a session alias is its latest name, else the subagent task label, else null", () => {
	const named = "55555555-5555-5555-5555-555555555555";
	const result = topConsumers(
		[
			request(1, named, { input: 1, sessionName: "old name" }),
			request(2, named, { input: 1, sessionName: "login refactor" }),
			request(3, named, { input: 1, sessionName: null }),
			request(4, CHILD, { input: 1, child: true }),
			request(5, PARENT, { input: 1 }),
		],
		TASKS,
	);
	const alias = new Map(result.flatMap(role => role.sessions).map(session => [session.session, session.alias]));
	assert.equal(alias.get(named), "login refactor");
	assert.equal(alias.get(CHILD), "verify login token");
	assert.equal(alias.get(PARENT), null);
});

test("each session keeps its project, parent session, providers and activity span", () => {
	const result = topConsumers(
		[request(10, CHILD, { input: 1, child: true }), request(30, CHILD, { input: 1, child: true, provider: "antigravity", project: "web" })],
		TASKS,
	);
	const session = result[0].sessions[0];
	assert.deepEqual(
		{ project: session.project, parentSession: session.parentSession, providers: session.providers, firstTs: session.firstTs, lastTs: session.lastTs, requests: session.requests },
		{ project: "web", parentSession: PARENT, providers: ["claude-bridge", "antigravity"], firstTs: 10, lastTs: 30, requests: 2 },
	);
	const orchestrator = topConsumers([request(1, PARENT, { input: 1 })], TASKS)[0].sessions[0];
	assert.equal(orchestrator.parentSession, null);
});

test("no requests gives no roles", () => {
	assert.deepEqual(topConsumers([], TASKS), []);
});

test("withAliases fills a missing alias for the top sessions of each role and keeps existing ones", () => {
	const named = "55555555-5555-5555-5555-555555555555";
	const roles = topConsumers(
		[request(1, named, { input: 300, sessionName: "login refactor" }), request(2, PARENT, { input: 200 }), request(3, LOST_CHILD, { input: 100, child: true })],
		TASKS,
	);
	const asked: string[] = [];
	const result = withAliases(roles, 2, id => {
		asked.push(id);
		return `first message of ${id.slice(0, 2)}`;
	});
	assert.deepEqual(asked, [PARENT, LOST_CHILD]);
	const alias = new Map(result.flatMap(role => role.sessions).map(session => [session.session, session.alias]));
	assert.equal(alias.get(named), "login refactor");
	assert.equal(alias.get(PARENT), "first message of 11");
	assert.equal(alias.get(LOST_CHILD), "first message of 33");
	assert.equal(roles.flatMap(role => role.sessions).find(session => session.session === PARENT)?.alias, null);
	const limited = withAliases(roles, 1, () => "x");
	assert.equal(limited.flatMap(role => role.sessions).find(session => session.session === LOST_CHILD)?.alias, "x");
	assert.equal(limited[0].sessions.length, roles[0].sessions.length);
});
