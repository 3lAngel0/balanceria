import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSessionDetail, buildWebReport, readSessionCwd, resumeCommand } from "../src/web-data.ts";
import type { HistoryEntry, RouteDecision } from "../src/history.ts";
import type { AgentTask } from "../src/roles.ts";
import type { RoleConsumer } from "../src/consumers.ts";
import type { UsageStats } from "../src/usage-panel.ts";

function request(overrides: Partial<HistoryEntry>): HistoryEntry {
	return {
		ts: 1_000,
		session: "s1",
		project: "proj",
		provider: "claude",
		model: "opus",
		input: 10,
		output: 5,
		cacheRead: 100,
		cacheWrite: 20,
		contextTokens: 130,
		contextWindow: 1000,
		...overrides,
	};
}

function task(overrides: Partial<AgentTask>): AgentTask {
	return { session: "child", agent: "gentle-ai-worker", label: "write tests", parentSession: "s1", sessionPath: null, ...overrides };
}

const stats: UsageStats = {
	providers: [
		{ provider: "claude", requests: 3, input: 30, output: 15, cacheRead: 300, cacheWrite: 60, total: 405, cost: 1.5, unpriced: 0 },
		{ provider: "agy", requests: 1, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, cost: 0.25, unpriced: 0 },
	],
	sessions: [],
	hourly: new Array(24).fill(0),
	daily: [],
	subscriptions: {},
	pricesAsOf: undefined,
};

const roles: RoleConsumer[] = [
	{
		role: "orchestrator",
		requests: 3,
		contextResend: 390,
		newOutput: 15,
		total: 405,
		sessions: [
			{ session: "s1", alias: "fix login", project: "proj", parentSession: null, providers: ["claude"], firstTs: 1, lastTs: 3, requests: 2, contextResend: 260, newOutput: 10, total: 270 },
			{ session: "gone", alias: null, project: "proj", parentSession: null, providers: ["claude"], firstTs: 1, lastTs: 1, requests: 1, contextResend: 130, newOutput: 5, total: 135 },
		],
	},
];

test("the web report totals providers and marks which sessions can be opened and which is current", () => {
	const report = buildWebReport({
		now: Date.UTC(2026, 9, 21, 12),
		stats,
		quota: { current: [{ limit: "claude", window: "5h", usedPercent: 40, resetAt: null, ts: 5, stale: false }], series: [], fills: [] },
		consumers: roles,
		suggestions: [{ rule: "large-context", title: "Compact fix login", target: { session: "s1", alias: "fix login" }, evidence: ["e"], saving: { tokens: 1 } as never, quality: "q" }],
		sessionPaths: new Map([["s1", "/sessions/s1.jsonl"]]),
		current: { session: "s1", model: "opus", contextTokens: 130, contextWindow: 1000 },
	});

	assert.equal(report.generatedAt, "2026-10-21T12:00:00.000Z");
	assert.deepEqual(report.totals, { tokens: 420, cost: 1.75, requests: 4 });
	assert.deepEqual(report.quota, [{ limit: "claude", window: "5h", usedPercent: 40, resetAt: null, ts: 5, stale: false }]);
	assert.equal(report.roles.length, 1);
	assert.deepEqual(
		report.roles[0]!.sessions.map(s => [s.session, s.canOpen, s.isCurrent]),
		[
			["s1", true, true],
			["gone", false, false],
		],
	);
	assert.deepEqual(report.suggestions, [{ rule: "large-context", title: "Compact fix login", session: "s1", alias: "fix login" }]);
	// File paths stay out of the overview; only the detail names them.
	assert.doesNotMatch(JSON.stringify(report), /\/sessions\/s1\.jsonl/);
});

test("the session detail sums the session's requests, splits them by model and lists its subagents", () => {
	const requests = [
		request({ ts: 1_000, model: "opus" }),
		request({ ts: 2_000, model: "sonnet", input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }),
		request({ ts: 3_000, model: "opus" }),
		request({ ts: 2_500, session: "child", child: true, output: 50 }),
		request({ ts: 2_600, session: "other" }),
	];
	const detail = buildSessionDetail({
		id: "s1",
		requests,
		tasks: new Map([["child", task({})]]),
		path: "/sessions/s1.jsonl",
		cwd: "/home/u/proj",
		alias: "fix login",
		currentSession: "s1",
	});

	assert.ok(detail);
	assert.equal(detail.session, "s1");
	assert.equal(detail.alias, "fix login");
	assert.equal(detail.role, "orchestrator");
	assert.equal(detail.isCurrent, true);
	assert.equal(detail.canOpen, true);
	assert.deepEqual(detail.totals, { requests: 3, input: 21, output: 12, cacheRead: 203, cacheWrite: 44, contextResend: 268, newOutput: 12, total: 280 });
	assert.equal(detail.firstTs, 1_000);
	assert.equal(detail.lastTs, 3_000);
	assert.deepEqual(detail.models, [
		{ provider: "claude", model: "opus", requests: 2, total: 270 },
		{ provider: "claude", model: "sonnet", requests: 1, total: 10 },
	]);
	assert.deepEqual(detail.children, [{ session: "child", agent: "gentle-ai-worker", label: "write tests", requests: 1, total: 180 }]);
	assert.deepEqual(
		detail.requests.map(r => r.ts),
		[3_000, 2_000, 1_000],
	);
	assert.equal(detail.omittedRequests, 0);
	assert.equal(detail.resume, "cd '/home/u/proj' && gentle-shell --session '/sessions/s1.jsonl'");
});

test("a subagent's detail names its role and parent", () => {
	const detail = buildSessionDetail({ id: "child", requests: [request({ session: "child", child: true })], tasks: new Map([["child", task({})]]), path: null, cwd: null, alias: null });
	assert.ok(detail);
	assert.equal(detail.role, "gentle-ai-worker");
	assert.equal(detail.parentSession, "s1");
	assert.equal(detail.alias, "write tests");
	assert.equal(detail.canOpen, false);
	assert.equal(detail.resume, null);
	assert.equal(detail.isCurrent, false);
});

test("the request list keeps the newest ones and says how many it left out", () => {
	const requests = Array.from({ length: 7 }, (_, i) => request({ ts: i }));
	const detail = buildSessionDetail({ id: "s1", requests, tasks: new Map(), path: null, cwd: null, alias: null, requestLimit: 3 });
	assert.ok(detail);
	assert.deepEqual(
		detail.requests.map(r => r.ts),
		[6, 5, 4],
	);
	assert.equal(detail.omittedRequests, 4);
	assert.equal(detail.totals.requests, 7);
});

test("an unknown session without requests or file has no detail; one with only a file still has", () => {
	assert.equal(buildSessionDetail({ id: "nope", requests: [request({})], tasks: new Map(), path: null, cwd: null, alias: null }), undefined);
	const fileOnly = buildSessionDetail({ id: "old", requests: [], tasks: new Map(), path: "/s/old.jsonl", cwd: "/p", alias: "old one" });
	assert.ok(fileOnly);
	assert.equal(fileOnly.totals.requests, 0);
	assert.equal(fileOnly.canOpen, true);
});

test("the resume command quotes paths for the shell", () => {
	assert.equal(resumeCommand("/home/u/it's here", "/s/a b.jsonl"), "cd '/home/u/it'\\''s here' && gentle-shell --session '/s/a b.jsonl'");
	assert.equal(resumeCommand(null, "/s/a.jsonl"), "gentle-shell --session '/s/a.jsonl'");
	assert.equal(resumeCommand("/p", null), null);
});

test("the session cwd comes from the header line of the session file", () => {
	const dir = mkdtempSync(join(tmpdir(), "web-data-"));
	const file = join(dir, "s.jsonl");
	writeFileSync(file, `${JSON.stringify({ type: "session", version: 3, id: "s", cwd: "/home/u/proj" })}\n${JSON.stringify({ type: "message" })}\n`);
	assert.equal(readSessionCwd(file), "/home/u/proj");
	const bad = join(dir, "bad.jsonl");
	writeFileSync(bad, "not json\n");
	assert.equal(readSessionCwd(bad), null);
	assert.equal(readSessionCwd(join(dir, "missing.jsonl")), null);
});

function decision(ts: number, overrides: Partial<RouteDecision> = {}): RouteDecision {
	return {
		kind: "route", ts, session: "0123456789abcdef", project: "proj", pool: "opus", role: "gentle-ai-verify", roleSource: "argv",
		reason: "user", chosen: "claude-bridge/opus", decidedBy: "highest-quota",
		steps: [{ rule: "available", result: "2 of 2", why: "no window is spent" }, { rule: "pick", result: "chosen", why: "claude-bridge/opus 0.62 > agy/opus 0.30" }],
		candidates: [{ provider: "claude-bridge", quotaKey: "claude-bridge/claude", available: true, remaining: 0.62 }],
		contextTokens: 1200,
		...overrides,
	};
}

const reportInput = {
	now: Date.UTC(2026, 9, 21, 12),
	stats,
	quota: { current: [], series: [], fills: [] },
	consumers: [],
	suggestions: [],
	sessionPaths: new Map<string, string>(),
};

test("the web report explains routing decisions: rule counts, role to provider, and the newest decisions first", () => {
	const routes = [
		decision(1),
		decision(2, { decidedBy: "sticky", reason: "continuation" }),
		decision(3, { role: "orchestrator", roleSource: "none", chosen: "agy/opus", decidedBy: "fallback" }),
		decision(4),
	];
	const { decisions } = buildWebReport({ ...reportInput, routes });
	assert.equal(decisions.total, 4);
	assert.deepEqual(decisions.byRule, [
		{ rule: "highest-quota", count: 2 },
		{ rule: "fallback", count: 1 },
		{ rule: "sticky", count: 1 },
	]);
	assert.deepEqual(decisions.byRole, [
		{ role: "gentle-ai-verify", pool: "opus", chosen: "claude-bridge/opus", count: 3 },
		{ role: "orchestrator", pool: "opus", chosen: "agy/opus", count: 1 },
	]);
	assert.deepEqual(decisions.recent.map(d => d.ts), [4, 3, 2, 1]);
	assert.deepEqual(decisions.recent[0], {
		ts: 4, project: "proj", session: "01234567", role: "gentle-ai-verify", roleSource: "argv", reason: "user", pool: "opus",
		chosen: "claude-bridge/opus", decidedBy: "highest-quota", steps: decision(4).steps, candidates: decision(4).candidates, contextTokens: 1200,
	});
	assert.equal(decisions.omitted, 0);
});

test("the decisions list keeps the 50 newest and counts the rest, while the counts cover every decision", () => {
	const routes = Array.from({ length: 60 }, (_, i) => decision(i + 1));
	const { decisions } = buildWebReport({ ...reportInput, routes });
	assert.equal(decisions.recent.length, 50);
	assert.equal(decisions.recent[0]!.ts, 60);
	assert.equal(decisions.recent[49]!.ts, 11);
	assert.equal(decisions.omitted, 10);
	assert.deepEqual(decisions.byRule, [{ rule: "highest-quota", count: 60 }]);
});

test("without route decisions the section is empty", () => {
	assert.deepEqual(buildWebReport(reportInput).decisions, { total: 0, byRule: [], byRole: [], recent: [], omitted: 0 });
});
