import { test } from "node:test";
import assert from "node:assert/strict";
import type { HistoryEntry, QuotaError } from "../src/history.ts";
import type { AgentTask } from "../src/roles.ts";
import type { PriceTable } from "../src/prices.ts";
import type { WindowConsumption } from "../src/consumption.ts";
import { QUALITY_NOTE, suggestOptimizations, type SuggestionInput } from "../src/suggestions.ts";

const HOUR = 3_600_000;
const NOW = new Date(2026, 9, 19, 12).getTime();
const K = 1000;

// Rates in USD per million tokens.
const PRICES: PriceTable = {
	models: {
		big: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		small: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1 },
	},
	subscriptions: {},
};

function request(ts: number, session: string, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return { ts, session, project: "web", provider: "claude-bridge", model: "big", input: 0, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: null, contextWindow: null, ...overrides };
}

function input(overrides: Partial<SuggestionInput>): SuggestionInput {
	return { requests: [], tasks: new Map(), windows: [], prices: PRICES, now: NOW, ...overrides };
}

function verifyTask(session: string): [string, AgentTask] {
	return [session, { session, agent: "gentle-ai-verify", label: `verify ${session}`, parentSession: "parent" }];
}

test("large-context: five requests at or over 120k flag the session with the excess as a lower-bound saving", () => {
	const requests = [100, 120, 130, 150, 170, 200].map((size, index) => request(index, "long", { cacheRead: size * K, sessionName: "login refactor" }));
	const [suggestion] = suggestOptimizations(input({ requests }));
	assert.equal(suggestion.rule, "large-context");
	assert.deepEqual(suggestion.target, { session: "long", alias: "login refactor", role: "orchestrator" });
	// Excess over 120k: 0 + 10 + 30 + 50 + 80 = 170k tokens, priced at the 0.2 cache-read rate.
	assert.equal(suggestion.saving.tokens, 170 * K);
	assert.equal(suggestion.saving.usd, (170 * K * 0.2) / 1e6);
	assert.equal(suggestion.saving.quotaPercent, null);
	assert.deepEqual(suggestion.evidence, ["5 of 6 requests sent at least 120k tokens of context", "peak context 200.0k tokens", "170.0k tokens re-sent above 120k"]);
});

test("large-context: four large requests are not enough", () => {
	const requests = [130, 150, 170, 200].map((size, index) => request(index, "long", { cacheRead: size * K }));
	assert.deepEqual(suggestOptimizations(input({ requests })), []);
});

test("provider-switch: a model change that rewrites at least 100k tokens without cache is flagged", () => {
	const requests = [
		request(1, "s", { cacheWrite: 10 * K }),
		request(2, "s", { cacheRead: 10 * K }),
		request(3, "s", { provider: "antigravity", model: "small", input: 20 * K, cacheWrite: 90 * K }),
		request(4, "s", { provider: "antigravity", model: "small", cacheRead: 110 * K }),
	];
	const [suggestion] = suggestOptimizations(input({ requests }));
	assert.equal(suggestion.rule, "provider-switch");
	assert.equal(suggestion.saving.tokens, 110 * K);
	// Priced on the new model: what writing cost above reading it from cache.
	assert.equal(suggestion.saving.usd, (20 * K * (1 - 0.1) + 90 * K * (1 - 0.1)) / 1e6);
	assert.deepEqual(suggestion.evidence, [
		"1 provider or model switch inside the session",
		"110.0k tokens re-sent without cache after switching",
		"failover after an exhausted quota also switches; those switches are expected",
	]);
});

test("provider-switch: under 100k rewritten tokens is noise", () => {
	const requests = [request(1, "s", { cacheWrite: 10 * K }), request(2, "s", { provider: "antigravity", model: "small", cacheWrite: 99 * K })];
	assert.deepEqual(suggestOptimizations(input({ requests })), []);
});

test("expensive-role: a subagent role with small outputs on a model 2x pricier than one already used gets a USD saving", () => {
	const sessions = ["v1", "v2", "v3"];
	const requests = [
		...sessions.map((session, index) => request(index, session, { child: true, input: 10 * K, output: 2 * K })),
		request(9, "orchestrator-session", { model: "small", input: 1 * K }),
	];
	const suggestion = suggestOptimizations(input({ requests, tasks: new Map(sessions.map(verifyTask)) })).find(item => item.rule === "expensive-role")!;
	assert.deepEqual(suggestion.target, { role: "gentle-ai-verify", model: "big", cheaperModel: "small" });
	// Each session: big = 10k*4 + 2k*20 = 0.08 USD, small = 10k*1 + 2k*5 = 0.02 USD.
	assert.equal(suggestion.saving.usd?.toFixed(6), (3 * (0.08 - 0.02)).toFixed(6));
	assert.equal(suggestion.saving.tokens, null);
	assert.deepEqual(suggestion.evidence, [
		"3 sessions with a median output of 2.0k tokens",
		"API-equivalent cost on big: $0.24",
		"same tokens on small, already used here: $0.06",
	]);
});

test("expensive-role: the orchestrator, fewer than 3 sessions or larger outputs are not flagged", () => {
	const cheap = request(9, "other", { model: "small", input: 1 * K });
	const twoSessions = ["v1", "v2"].map((session, index) => request(index, session, { child: true, input: 10 * K, output: 1 * K }));
	const bigOutputs = ["v1", "v2", "v3"].map((session, index) => request(index, session, { child: true, input: 10 * K, output: 3 * K }));
	const orchestrator = ["o1", "o2", "o3"].map((session, index) => request(index, session, { input: 10 * K, output: 1 * K }));
	const tasks = new Map(["v1", "v2", "v3"].map(verifyTask));
	for (const requests of [twoSessions, bigOutputs, orchestrator]) {
		assert.deepEqual(suggestOptimizations(input({ requests: [...requests, cheap], tasks })), []);
	}
});

function window(key: string, usedPercent: number, resetAt: number, pace: WindowConsumption["pace"]): WindowConsumption {
	return { key, window: "week", usedPercent, resetAt, sampledAt: NOW, pace };
}

test("idle-quota: a window ending at least half unused while another fills before reset", () => {
	const filling = window("antigravity/gemini-4-argon", 84, NOW + 48 * HOUR, { percentPerHour: 5, fullAt: NOW + 3 * HOUR, fillsBeforeReset: true });
	const idle = window("claude-bridge/claude", 20, NOW + 10 * HOUR, { percentPerHour: 2, fullAt: NOW + 40 * HOUR, fillsBeforeReset: false });
	const [suggestion] = suggestOptimizations(input({ windows: [filling, idle] }));
	assert.equal(suggestion.rule, "idle-quota");
	assert.deepEqual(suggestion.target, { quotaKey: "claude-bridge/claude", window: "week" });
	// 20% now + 2%/h for 10h = 40% at reset, so 60% expires unused.
	assert.equal(suggestion.saving.quotaPercent, 60);
	assert.deepEqual(suggestion.evidence, [
		"claude-bridge/claude week: 20% used, about 40% at reset in 10h",
		"antigravity/gemini-4-argon week fills before its reset",
	]);
});

test("idle-quota: nothing when no other window fills, or the idle one ends over half used", () => {
	const filling = window("antigravity/gemini-4-argon", 84, NOW + 48 * HOUR, { percentPerHour: 5, fullAt: NOW + 3 * HOUR, fillsBeforeReset: true });
	const calm = window("antigravity/gemini-4-argon", 30, NOW + 48 * HOUR, null);
	const idle = window("claude-bridge/claude", 20, NOW + 10 * HOUR, null);
	const busy = window("claude-bridge/claude", 20, NOW + 10 * HOUR, { percentPerHour: 4, fullAt: NOW + 20 * HOUR, fillsBeforeReset: false });
	assert.deepEqual(suggestOptimizations(input({ windows: [calm, idle] })), []);
	assert.deepEqual(suggestOptimizations(input({ windows: [filling, busy] })), []);
});

test("every suggestion says quality is not measured and none has an action", () => {
	const requests = [130, 150, 170, 200, 220].map((size, index) => request(index, "long", { cacheRead: size * K }));
	const suggestions = suggestOptimizations(input({ requests }));
	assert.ok(suggestions.length > 0);
	for (const suggestion of suggestions) {
		assert.equal(suggestion.quality, QUALITY_NOTE);
		assert.ok(!("apply" in suggestion));
	}
	assert.match(QUALITY_NOTE, /quality is not measured/i);
});

test("a session without a name or task label is named by resolveAlias, called only for suggested sessions", () => {
	const big = [130, 140, 150, 160, 170].map((size, index) => request(index, "unnamed", { cacheRead: size * K }));
	const asked: string[] = [];
	const resolveAlias = (session: string) => {
		asked.push(session);
		return session === "unnamed" ? "fix the login form" : null;
	};
	const [suggestion] = suggestOptimizations(input({ requests: [...big, request(9, "quiet")], resolveAlias }));
	assert.equal(suggestion.title, 'Compact or split "fix the login form"');
	assert.equal(suggestion.target.alias, "fix the login form");
	assert.deepEqual(asked, ["unnamed"]);
});

test("a session name still wins over resolveAlias", () => {
	const requests = [130, 140, 150, 160, 170].map((size, index) => request(index, "named", { cacheRead: size * K, sessionName: "login refactor" }));
	const [suggestion] = suggestOptimizations(input({ requests, resolveAlias: () => "first message" }));
	assert.equal(suggestion.title, 'Compact or split "login refactor"');
});

const ARGON = "antigravity/gemini-4-argon";
const POOLS = [
	{ id: "claude-opus-5-5", candidates: [{ quotaKey: "claude-bridge/claude" }, { quotaKey: ARGON }] },
	{ id: "orchestrator", candidates: [{ quotaKey: ARGON }] },
];

function quotaError(ts: number, session: string, key: string, until: number | null): QuotaError {
	return { kind: "quota-error", ts, session, project: "web", key, until };
}

test("pool-bypass: a session that hit a quota the balancer already knew was spent names the pools that would have avoided it", () => {
	const errors = [
		quotaError(NOW - 72 * HOUR, "earlier", ARGON, NOW + 80 * HOUR),
		quotaError(NOW - 2 * HOUR, "child", ARGON, NOW + 78 * HOUR),
	];
	const suggestions = suggestOptimizations(input({ errors, pools: POOLS, tasks: new Map([verifyTask("child")]) }));
	assert.equal(suggestions.length, 1);
	const [suggestion] = suggestions;
	assert.equal(suggestion.rule, "pool-bypass");
	assert.equal(suggestion.title, `gentle-ai-verify called ${ARGON} directly while it was spent`);
	assert.deepEqual(suggestion.target, { session: "child", alias: "verify child", role: "gentle-ai-verify", quotaKey: ARGON });
	assert.deepEqual(suggestion.evidence, [
		`${ARGON} was known spent for 3d before this call and reopens 3d after it`,
		"the call named the model itself, so the balancer never got to choose",
		"pool/claude-opus-5-5 or pool/orchestrator would have routed around it",
	]);
	assert.deepEqual(suggestion.saving, { tokens: null, usd: null, quotaPercent: null });
	assert.equal(suggestion.quality, QUALITY_NOTE);
});

test("pool-bypass: one suggestion per role and quota, pointing at its latest session", () => {
	const errors = [
		quotaError(NOW - 10 * HOUR, "first", ARGON, NOW + 50 * HOUR),
		quotaError(NOW - 5 * HOUR, "a", ARGON, NOW + 50 * HOUR),
		quotaError(NOW - 1 * HOUR, "b", ARGON, NOW + 50 * HOUR),
	];
	const suggestions = suggestOptimizations(input({ errors, pools: POOLS, tasks: new Map([verifyTask("a"), verifyTask("b")]) }));
	assert.deepEqual(suggestions.map(item => [item.target.role, item.target.session]), [["gentle-ai-verify", "b"]]);
});

test("pool-bypass: not flagged for the first hit, an exhaustion that had already reopened, or a quota in no pool", () => {
	const first = [quotaError(NOW - HOUR, "child", ARGON, NOW + 70 * HOUR)];
	const reopened = [quotaError(NOW - 50 * HOUR, "earlier", ARGON, NOW - 10 * HOUR), quotaError(NOW - HOUR, "child", ARGON, NOW + 70 * HOUR)];
	const unknownReset = [quotaError(NOW - 50 * HOUR, "earlier", ARGON, null), quotaError(NOW - HOUR, "child", ARGON, NOW + 70 * HOUR)];
	const noPool = [quotaError(NOW - 50 * HOUR, "earlier", "kimi/k2", NOW + 10 * HOUR), quotaError(NOW - HOUR, "child", "kimi/k2", NOW + 10 * HOUR)];
	for (const errors of [first, reopened, unknownReset, noPool]) {
		assert.deepEqual(suggestOptimizations(input({ errors, pools: POOLS, tasks: new Map([verifyTask("child")]) })), []);
	}
});

test("pool-bypass: without errors or pools no suggestion is made", () => {
	const errors = [quotaError(NOW - 50 * HOUR, "earlier", ARGON, NOW + 10 * HOUR), quotaError(NOW - HOUR, "child", ARGON, NOW + 10 * HOUR)];
	assert.deepEqual(suggestOptimizations(input({ errors })), []);
	assert.deepEqual(suggestOptimizations(input({ pools: POOLS })), []);
});
