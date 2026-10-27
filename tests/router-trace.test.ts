import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseCandidate, routeWithTrace, type Candidate, type RouteInput } from "../src/router.ts";
import { QuotaState } from "../src/state.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const HOUR = 3_600_000;
const CANDIDATES: Candidate[] = [
	{ provider: "antigravity", model: "claude-opus-5-5", quotaKey: "antigravity/claude" },
	{ provider: "claude-bridge", model: "claude-opus-5-5", quotaKey: "claude-bridge/claude" },
];

test("a continuation on an available provider is decided by sticky", () => {
	const state = new QuotaState();
	const { candidate, trace } = routeWithTrace({ reason: "continuation", previousProvider: "claude-bridge", candidates: CANDIDATES, state, now: NOW });
	assert.equal(candidate.provider, "claude-bridge");
	assert.equal(trace.decidedBy, "sticky");
	assert.deepEqual(trace.steps, [{ rule: "sticky", result: "chosen", why: "claude-bridge answered the previous turn and is available" }]);
});

test("sticky is skipped when the previous provider is spent, with the reopening time", () => {
	const state = new QuotaState();
	state.markExhausted("claude-bridge/claude", NOW + HOUR, "5h");
	const { candidate, trace } = routeWithTrace({ reason: "continuation", previousProvider: "claude-bridge", candidates: CANDIDATES, state, now: NOW });
	assert.equal(candidate.provider, "antigravity");
	assert.deepEqual(trace.steps[0], { rule: "sticky", result: "skipped", why: "claude-bridge/claude-opus-5-5 spent until 2026-10-16T13:00:00.000Z" });
});

test("sticky is skipped when the previous provider is not in the pool", () => {
	const state = new QuotaState();
	const { trace } = routeWithTrace({ reason: "retry", failedProvider: "openai", candidates: CANDIDATES, state, now: NOW });
	assert.deepEqual(trace.steps[0], { rule: "sticky", result: "skipped", why: "openai is not in this pool" });
});

test("sticky is skipped when a continuation has no previous provider", () => {
	const state = new QuotaState();
	const { trace } = routeWithTrace({ reason: "continuation", candidates: CANDIDATES, state, now: NOW });
	assert.deepEqual(trace.steps[0], { rule: "sticky", result: "skipped", why: "no previous provider" });
});

test("a user request has no sticky step and counts the available candidates", () => {
	const state = new QuotaState();
	state.markExhausted("antigravity/claude", NOW + HOUR, "weekly");
	const { trace } = routeWithTrace({ reason: "user", candidates: CANDIDATES, state, now: NOW });
	assert.equal(trace.steps[0].rule, "available");
	assert.deepEqual(trace.steps[0], { rule: "available", result: "1 of 2", why: "antigravity/claude-opus-5-5 spent until 2026-10-16T13:00:00.000Z" });
});

test("hybrid picks the highest remaining quota and explains the comparison", () => {
	const state = new QuotaState();
	state.setQuotaFraction("antigravity/claude", 0.3);
	state.setQuotaFraction("claude-bridge/claude", 0.62);
	const { candidate, trace } = routeWithTrace({ reason: "user", candidates: CANDIDATES, state, now: NOW });
	assert.equal(candidate.provider, "claude-bridge");
	assert.equal(trace.decidedBy, "highest-quota");
	assert.deepEqual(trace.steps[1], { rule: "pick", result: "chosen", why: "claude-bridge/claude-opus-5-5 0.62 > antigravity/claude-opus-5-5 0.30" });
});

test("highest-quota without quota data keeps the pool order and says so", () => {
	const state = new QuotaState();
	const { candidate, trace } = routeWithTrace({ reason: "user", candidates: CANDIDATES, state, now: NOW, strategy: "highest-quota" });
	assert.equal(candidate.provider, "antigravity");
	assert.equal(trace.decidedBy, "highest-quota");
	assert.deepEqual(trace.steps[1], { rule: "pick", result: "chosen", why: "antigravity/claude-opus-5-5 unknown = claude-bridge/claude-opus-5-5 unknown: first in pool order" });
});

test("waterfall picks the first available candidate in pool order", () => {
	const state = new QuotaState();
	state.setQuotaFraction("claude-bridge/claude", 0.9);
	const { candidate, trace } = routeWithTrace({ reason: "user", candidates: CANDIDATES, state, now: NOW, strategy: "waterfall" });
	assert.equal(candidate.provider, "antigravity");
	assert.equal(trace.decidedBy, "waterfall");
	assert.deepEqual(trace.steps[1], { rule: "pick", result: "chosen", why: "first available in pool order" });
});

test("a direct request takes the first available candidate", () => {
	const state = new QuotaState();
	state.setQuotaFraction("claude-bridge/claude", 0.9);
	const { candidate, trace } = routeWithTrace({ reason: "direct", candidates: CANDIDATES, state, now: NOW });
	assert.equal(candidate.provider, "antigravity");
	assert.equal(trace.decidedBy, "direct");
	assert.deepEqual(trace.steps[1], { rule: "pick", result: "chosen", why: "direct request: first available in pool order" });
});

test("when every window is spent the fallback picks the one that reopens first", () => {
	const state = new QuotaState();
	state.markExhausted("antigravity/claude", NOW + 3 * HOUR, "weekly");
	state.markExhausted("claude-bridge/claude", NOW + HOUR, "5h");
	const { candidate, trace } = routeWithTrace({ reason: "user", candidates: CANDIDATES, state, now: NOW });
	assert.equal(candidate.provider, "claude-bridge");
	assert.equal(trace.decidedBy, "fallback");
	assert.deepEqual(trace.steps, [
		{ rule: "available", result: "0 of 2", why: "antigravity/claude-opus-5-5 spent until 2026-10-16T15:00:00.000Z; claude-bridge/claude-opus-5-5 spent until 2026-10-16T13:00:00.000Z" },
		{ rule: "fallback", result: "chosen", why: "every window is spent; claude-bridge/claude-opus-5-5 reopens first at 2026-10-16T13:00:00.000Z" },
	]);
});

test("the trace records the state of every candidate", () => {
	const state = new QuotaState();
	state.markExhausted("antigravity/claude", NOW + HOUR, "weekly");
	state.setQuotaFraction("claude-bridge/claude", 0.62);
	const { trace } = routeWithTrace({ reason: "user", candidates: CANDIDATES, state, now: NOW });
	assert.deepEqual(trace.candidates, [
		{ provider: "antigravity", quotaKey: "antigravity/claude", available: false, remaining: 0, availableAt: NOW + HOUR },
		{ provider: "claude-bridge", quotaKey: "claude-bridge/claude", available: true, remaining: 0.62 },
	]);
});

test("chooseCandidate returns the same candidate as the trace in every scenario", () => {
	const scenarios: Array<[string, (state: QuotaState) => void, Omit<RouteInput, "state" | "candidates" | "now">]> = [
		["user", () => {}, { reason: "user" }],
		["spent first", s => s.markExhausted("antigravity/claude", NOW + HOUR, "weekly"), { reason: "user" }],
		["quota", s => { s.setQuotaFraction("antigravity/claude", 0.1); s.setQuotaFraction("claude-bridge/claude", 0.5); }, { reason: "user" }],
		["continuation", () => {}, { reason: "continuation", previousProvider: "claude-bridge" }],
		["retry spent", s => s.markExhausted("antigravity/claude", NOW + HOUR, "weekly"), { reason: "retry", failedProvider: "antigravity" }],
		["waterfall", s => s.setQuotaFraction("claude-bridge/claude", 0.9), { reason: "user", strategy: "waterfall" }],
		["direct", s => s.setQuotaFraction("claude-bridge/claude", 0.9), { reason: "direct" }],
		["all spent", s => { s.markExhausted("antigravity/claude", NOW + 2 * HOUR, "weekly"); s.markExhausted("claude-bridge/claude", NOW + HOUR, "5h"); }, { reason: "user" }],
	];
	for (const [name, setup, rest] of scenarios) {
		const state = new QuotaState();
		setup(state);
		const input = { ...rest, candidates: CANDIDATES, state, now: NOW } as RouteInput;
		assert.deepEqual(chooseCandidate(input), routeWithTrace(input).candidate, name);
	}
});

test("an empty pool still throws", () => {
	assert.throws(() => routeWithTrace({ reason: "user", candidates: [], state: new QuotaState(), now: NOW }), /at least one candidate/);
});
