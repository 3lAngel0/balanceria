import { test } from "node:test";
import assert from "node:assert/strict";
import { routeWithTrace, type Candidate, type RuleBlock } from "../src/router.ts";
import { QuotaState } from "../src/state.ts";
import { validatePoolsConfig } from "../src/config-schema.ts";
import { parsePools } from "../src/pools.ts";
import { carryRules } from "../src/setup.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const SONNET: Candidate = { provider: "claude-bridge", model: "claude-sonnet-5-5", quotaKey: "claude-bridge/claude" };
const ARGON: Candidate = { provider: "antigravity", model: "gemini-4-argon", quotaKey: "antigravity/gemini-4-argon" };
const FLASH: Candidate = { provider: "antigravity", model: "gemini-3-8-flash", quotaKey: "antigravity/gemini-3-8-flash" };
const CANDIDATES = [SONNET, ARGON, FLASH];
const BIG_TO_ARGON: RuleBlock[] = [
	{ rule: "sticky" },
	{ rule: "prefer-for-context", minTokens: 60_000, candidate: "antigravity/gemini-4-argon" },
	{ rule: "pick", mode: "highest-quota" },
];
const name = (candidate: Candidate) => `${candidate.provider}/${candidate.model}`;
const route = (rules: RuleBlock[], extra: object = {}, state = new QuotaState()) =>
	routeWithTrace({ reason: "user", candidates: CANDIDATES, rules, state, now: NOW, ...extra });

test("prefer-for-context chooses its candidate once the context reaches minTokens", () => {
	const state = new QuotaState();
	state.setQuotaFraction(SONNET.quotaKey, 0.9, undefined, NOW);
	const { candidate, trace } = route(BIG_TO_ARGON, { contextTokens: 80_000 }, state);
	assert.equal(name(candidate), "antigravity/gemini-4-argon");
	assert.equal(trace.decidedBy, "prefer-for-context");
	assert.match(trace.steps.at(-1)!.why, /80000/);
});

test("prefer-for-context steps aside below minTokens, above maxTokens, or when the size is unknown", () => {
	const state = new QuotaState();
	state.setQuotaFraction(SONNET.quotaKey, 0.9, undefined, NOW);
	for (const extra of [{ contextTokens: 10_000 }, { contextTokens: null }, {}]) {
		const { candidate, trace } = route(BIG_TO_ARGON, extra, state);
		assert.equal(trace.decidedBy, "highest-quota");
		assert.equal(name(candidate), "claude-bridge/claude-sonnet-5-5");
	}
	const small: RuleBlock[] = [{ rule: "prefer-for-context", maxTokens: 20_000, candidate: "antigravity/gemini-3-8-flash" }, { rule: "pick", mode: "highest-quota" }];
	assert.equal(name(route(small, { contextTokens: 5_000 }, state).candidate), "antigravity/gemini-3-8-flash");
	assert.equal(name(route(small, { contextTokens: 20_000 }, state).candidate), "claude-bridge/claude-sonnet-5-5", "maxTokens is exclusive");
});

test("prefer-for-context skips a spent candidate and lets the next block decide", () => {
	const state = new QuotaState();
	state.markExhausted(ARGON.quotaKey, NOW + 3_600_000, "weekly");
	const { candidate, trace } = route(BIG_TO_ARGON, { contextTokens: 80_000 }, state);
	assert.notEqual(name(candidate), "antigravity/gemini-4-argon");
	assert.match(trace.steps.find(step => step.rule === "prefer-for-context")!.why, /spent/);
});

test("sticky still wins over prefer-for-context on a continuation", () => {
	const { candidate, trace } = route(BIG_TO_ARGON, { reason: "continuation", previousProvider: "claude-bridge", previousModel: "claude-sonnet-5-5", contextTokens: 80_000 });
	assert.equal(name(candidate), "claude-bridge/claude-sonnet-5-5");
	assert.equal(trace.decidedBy, "sticky");
});

test("pool rules validate prefer-for-context bounds and candidate", () => {
	const base = { id: "p", name: "P", candidates: CANDIDATES.map(name) };
	const issues = (block: unknown) => validatePoolsConfig({ pools: [{ ...base, rules: [block, { rule: "pick", mode: "highest-quota" }] }] }).issues.map(issue => issue.message);
	assert.deepEqual(issues({ rule: "prefer-for-context", minTokens: 60000, candidate: name(ARGON) }), []);
	assert.deepEqual(parsePools({ pools: [{ ...base, rules: BIG_TO_ARGON }] })[0].rules, BIG_TO_ARGON);
	assert.ok(issues({ rule: "prefer-for-context", candidate: name(ARGON) }).some(message => /minTokens or maxTokens/.test(message)));
	assert.ok(issues({ rule: "prefer-for-context", minTokens: -1, candidate: name(ARGON) }).some(message => /minTokens/.test(message)));
	assert.ok(issues({ rule: "prefer-for-context", minTokens: 5, maxTokens: 5, candidate: name(ARGON) }).some(message => /less than maxTokens/.test(message)));
	assert.ok(issues({ rule: "prefer-for-context", minTokens: 5, candidate: "openai/gpt-6" }).some(message => /not in this pool/.test(message)));
});

test("a regenerated pool drops prefer-for-context when its candidate left", () => {
	const pool = { id: "p", name: "P", candidates: [name(SONNET), name(FLASH)], strategy: "hybrid" as const };
	const { rules, notes } = carryRules(BIG_TO_ARGON, pool);
	assert.deepEqual(rules, [{ rule: "sticky" }, { rule: "pick", mode: "highest-quota" }]);
	assert.match(notes[0], /prefer-for-context/);
});
