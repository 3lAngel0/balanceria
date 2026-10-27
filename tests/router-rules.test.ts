import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultRules, routeWithTrace, type Candidate, type RuleBlock } from "../src/router.ts";
import { QuotaState } from "../src/state.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const HOUR = 3_600_000;
const CANDIDATES: Candidate[] = [
	{ provider: "antigravity", model: "claude-sonnet-5-5", quotaKey: "antigravity/claude" },
	{ provider: "claude-bridge", model: "claude-sonnet-5-5", quotaKey: "claude-bridge/claude" },
	{ provider: "antigravity", model: "gemini-3-8-flash", quotaKey: "antigravity/gemini-3-8-flash" },
];
const WORKER_TO_FLASH: RuleBlock[] = [
	{ rule: "sticky" },
	{ rule: "prefer-for-role", role: "gentle-ai-worker", candidate: "antigravity/gemini-3-8-flash" },
	{ rule: "pick", mode: "highest-quota" },
];

test("the default list of each strategy is sticky then its pick", () => {
	assert.deepEqual(defaultRules("hybrid"), [{ rule: "sticky" }, { rule: "pick", mode: "highest-quota" }]);
	assert.deepEqual(defaultRules("highest-quota"), [{ rule: "sticky" }, { rule: "pick", mode: "highest-quota" }]);
	assert.deepEqual(defaultRules("waterfall"), [{ rule: "sticky" }, { rule: "pick", mode: "first" }]);
	assert.deepEqual(defaultRules(undefined), defaultRules("hybrid"));
});

test("prefer-for-role chooses its candidate for that role on a new turn", () => {
	const state = new QuotaState();
	// The rule wins even over a candidate with far more quota left.
	state.setQuotaFraction("claude-bridge/claude", 0.9, undefined, NOW);
	const { candidate, trace } = routeWithTrace({ reason: "user", role: "gentle-ai-worker", rules: WORKER_TO_FLASH, candidates: CANDIDATES, state, now: NOW });
	assert.equal(`${candidate.provider}/${candidate.model}`, "antigravity/gemini-3-8-flash");
	assert.equal(trace.decidedBy, "prefer-for-role");
	assert.deepEqual(trace.steps, [
		{ rule: "available", result: "3 of 3", why: "no window is spent" },
		{ rule: "prefer-for-role", result: "chosen", why: "role gentle-ai-worker prefers antigravity/gemini-3-8-flash" },
	]);
});

test("prefer-for-role is skipped for another role and the pick decides", () => {
	const state = new QuotaState();
	const { candidate, trace } = routeWithTrace({ reason: "user", role: "orchestrator", rules: WORKER_TO_FLASH, candidates: CANDIDATES, state, now: NOW });
	assert.equal(candidate.provider, "antigravity");
	assert.equal(candidate.model, "claude-sonnet-5-5");
	assert.equal(trace.decidedBy, "highest-quota");
	assert.deepEqual(trace.steps[1], { rule: "prefer-for-role", result: "skipped", why: "role is orchestrator, not gentle-ai-worker" });
});

test("prefer-for-role is skipped when the role is unknown", () => {
	const state = new QuotaState();
	const { trace } = routeWithTrace({ reason: "user", rules: WORKER_TO_FLASH, candidates: CANDIDATES, state, now: NOW });
	assert.deepEqual(trace.steps[1], { rule: "prefer-for-role", result: "skipped", why: "role is unknown, not gentle-ai-worker" });
});

test("prefer-for-role never picks a spent window", () => {
	const state = new QuotaState();
	state.markExhausted("antigravity/gemini-3-8-flash", NOW + HOUR, "5h");
	const { candidate, trace } = routeWithTrace({ reason: "user", role: "gentle-ai-worker", rules: WORKER_TO_FLASH, candidates: CANDIDATES, state, now: NOW });
	assert.equal(candidate.model, "claude-sonnet-5-5");
	assert.equal(trace.decidedBy, "highest-quota");
	assert.deepEqual(trace.steps[1], { rule: "prefer-for-role", result: "skipped", why: "antigravity/gemini-3-8-flash spent until 2026-10-16T13:00:00.000Z" });
});

test("sticky before prefer-for-role keeps the provider of the turn", () => {
	const state = new QuotaState();
	const { candidate, trace } = routeWithTrace({ reason: "continuation", previousProvider: "claude-bridge", role: "gentle-ai-worker", rules: WORKER_TO_FLASH, candidates: CANDIDATES, state, now: NOW });
	assert.equal(candidate.provider, "claude-bridge");
	assert.equal(trace.decidedBy, "sticky");
});

test("prefer-for-role before sticky moves a continuation to the preferred candidate", () => {
	const state = new QuotaState();
	const rules: RuleBlock[] = [WORKER_TO_FLASH[1], { rule: "sticky" }, { rule: "pick", mode: "first" }];
	const { candidate, trace } = routeWithTrace({ reason: "continuation", previousProvider: "claude-bridge", role: "gentle-ai-worker", rules, candidates: CANDIDATES, state, now: NOW });
	assert.equal(candidate.model, "gemini-3-8-flash");
	assert.equal(trace.decidedBy, "prefer-for-role");
});

test("a pick with mode first behaves as waterfall", () => {
	const state = new QuotaState();
	state.markExhausted("antigravity/claude", NOW + HOUR, "5h");
	const { candidate, trace } = routeWithTrace({ reason: "user", rules: [{ rule: "pick", mode: "first" }], candidates: CANDIDATES, state, now: NOW });
	assert.equal(candidate.provider, "claude-bridge");
	assert.equal(trace.decidedBy, "waterfall");
});

test("rules that choose nothing end in the fallback", () => {
	const state = new QuotaState();
	for (const c of CANDIDATES) state.markExhausted(c.quotaKey, NOW + HOUR, "5h");
	state.markExhausted("claude-bridge/claude", NOW + HOUR / 2, "5h");
	const { candidate, trace } = routeWithTrace({ reason: "user", role: "gentle-ai-worker", rules: WORKER_TO_FLASH, candidates: CANDIDATES, state, now: NOW });
	assert.equal(candidate.provider, "claude-bridge");
	assert.equal(trace.decidedBy, "fallback");
	assert.deepEqual(trace.steps.map(step => step.rule), ["available", "prefer-for-role", "fallback"]);
});

test("explicit default rules give the same trace as the strategy", () => {
	for (const strategy of ["hybrid", "waterfall", "highest-quota"] as const) {
		for (const reason of ["user", "continuation", "retry", "direct"] as const) {
			const state = new QuotaState();
			state.markExhausted("antigravity/claude", NOW + HOUR, "5h");
			const input = { reason, previousProvider: "antigravity", failedProvider: "antigravity", candidates: CANDIDATES, state, now: NOW };
			assert.deepEqual(routeWithTrace({ ...input, rules: defaultRules(strategy) }), routeWithTrace({ ...input, strategy }));
		}
	}
});

test("sticky matches the previous model, not only its provider", () => {
	const state = new QuotaState();
	// Flash answered the previous turn; the first antigravity candidate is a different model.
	const { candidate, trace } = routeWithTrace({
		reason: "continuation",
		previousProvider: "antigravity",
		previousModel: "gemini-3-8-flash",
		candidates: CANDIDATES,
		state,
		now: NOW,
	});
	assert.equal(`${candidate.provider}/${candidate.model}`, "antigravity/gemini-3-8-flash");
	assert.equal(trace.decidedBy, "sticky");
});

test("sticky on retry matches the failed model, not only its provider", () => {
	const state = new QuotaState();
	const { candidate } = routeWithTrace({
		reason: "retry",
		failedProvider: "antigravity",
		failedModel: "gemini-3-8-flash",
		candidates: CANDIDATES,
		state,
		now: NOW,
	});
	assert.equal(`${candidate.provider}/${candidate.model}`, "antigravity/gemini-3-8-flash");
});

test("sticky falls back to the provider when the previous model is unknown to the pool", () => {
	const state = new QuotaState();
	const { candidate } = routeWithTrace({
		reason: "continuation",
		previousProvider: "claude-bridge",
		previousModel: "claude-opus-5-5",
		candidates: CANDIDATES,
		state,
		now: NOW,
	});
	assert.equal(candidate.provider, "claude-bridge");
});
