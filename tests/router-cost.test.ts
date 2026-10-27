import { test } from "node:test";
import assert from "node:assert/strict";
import { failoverAlternative, routeWithTrace, type Candidate, type RuleBlock } from "../src/router.ts";
import { parsePrices } from "../src/prices.ts";
import { QuotaState } from "../src/state.ts";
import { validatePoolsConfig } from "../src/config-schema.ts";
import { parsePools } from "../src/pools.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const OPUS: Candidate = { provider: "claude-bridge", model: "claude-opus-5-5", quotaKey: "claude-bridge/claude" };
const SONNET: Candidate = { provider: "claude-bridge", model: "claude-sonnet-5-5", quotaKey: "claude-bridge/claude" };
const ARGON: Candidate = { provider: "antigravity", model: "gemini-4-argon", quotaKey: "antigravity/gemini-4-argon" };
const FLASH: Candidate = { provider: "antigravity", model: "gemini-3-8-flash", quotaKey: "antigravity/gemini-3-8-flash" };
const PRICES = parsePrices({
	models: {
		"claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		"claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
		"gemini-4-argon": { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2 },
		"gemini-3.8-flash": { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 },
	},
});
const CHEAPEST: RuleBlock[] = [{ rule: "sticky" }, { rule: "pick", mode: "lowest-cost" }];
const pick = (mode: "lowest-cost" | "highest-quota"): RuleBlock[] => [{ rule: "sticky" }, { rule: "pick", mode }];

function name(candidate: Candidate): string {
	return `${candidate.provider}/${candidate.model}`;
}

test("lowest-cost chooses the cheaper model even when the dearer one has far more quota", () => {
	const state = new QuotaState();
	state.setQuotaFraction(OPUS.quotaKey, 1, undefined, NOW);
	state.setQuotaFraction(ARGON.quotaKey, 0.25, undefined, NOW);
	const { candidate, trace } = routeWithTrace({ reason: "user", candidates: [OPUS, SONNET, ARGON], rules: CHEAPEST, prices: PRICES, state, now: NOW });
	assert.notEqual(candidate.model, "claude-opus-5-5");
	assert.equal(trace.decidedBy, "lowest-cost");
});

test("lowest-cost ranks by input plus output rate", () => {
	const { candidate } = routeWithTrace({ reason: "user", candidates: [OPUS, SONNET, FLASH], rules: CHEAPEST, prices: PRICES, state: new QuotaState(), now: NOW });
	assert.equal(name(candidate), "antigravity/gemini-3-8-flash");
});

test("lowest-cost settles equal costs by highest remaining quota", () => {
	const state = new QuotaState();
	state.setQuotaFraction(SONNET.quotaKey, 0.2, undefined, NOW);
	state.setQuotaFraction(ARGON.quotaKey, 0.9, undefined, NOW);
	const { candidate } = routeWithTrace({ reason: "user", candidates: [SONNET, ARGON], rules: CHEAPEST, prices: PRICES, state, now: NOW });
	assert.equal(name(candidate), "antigravity/gemini-4-argon");
});

test("lowest-cost never chooses a spent window", () => {
	const state = new QuotaState();
	state.markExhausted(FLASH.quotaKey, NOW + 3_600_000, "weekly");
	const { candidate } = routeWithTrace({ reason: "user", candidates: [OPUS, FLASH, SONNET], rules: CHEAPEST, prices: PRICES, state, now: NOW });
	assert.equal(name(candidate), "claude-bridge/claude-sonnet-5-5");
});

test("lowest-cost keeps sticky continuations, which protect the prompt cache", () => {
	const { candidate, trace } = routeWithTrace({
		reason: "continuation",
		previousProvider: "claude-bridge",
		previousModel: "claude-opus-5-5",
		candidates: [ARGON, OPUS],
		rules: CHEAPEST,
		prices: PRICES,
		state: new QuotaState(),
		now: NOW,
	});
	assert.equal(name(candidate), "claude-bridge/claude-opus-5-5");
	assert.equal(trace.decidedBy, "sticky");
});

test("lowest-cost without a price table or with an unpriced candidate falls back to highest quota", () => {
	const state = new QuotaState();
	state.setQuotaFraction(OPUS.quotaKey, 0.9, undefined, NOW);
	state.setQuotaFraction(ARGON.quotaKey, 0.3, undefined, NOW);
	const noTable = routeWithTrace({ reason: "user", candidates: [ARGON, OPUS], rules: CHEAPEST, state, now: NOW });
	assert.equal(name(noTable.candidate), "claude-bridge/claude-opus-5-5");
	assert.equal(noTable.trace.decidedBy, "highest-quota");
	const unpriced: Candidate = { provider: "openai", model: "mystery", quotaKey: "openai/mystery" };
	const partial = routeWithTrace({ reason: "user", candidates: [unpriced, ARGON], rules: CHEAPEST, prices: PRICES, state, now: NOW });
	assert.equal(partial.trace.decidedBy, "highest-quota");
});

test("highest-quota ignores prices, as before", () => {
	const state = new QuotaState();
	state.setQuotaFraction(OPUS.quotaKey, 0.9, undefined, NOW);
	state.setQuotaFraction(ARGON.quotaKey, 0.3, undefined, NOW);
	const withPrices = routeWithTrace({ reason: "user", candidates: [ARGON, OPUS], rules: pick("highest-quota"), prices: PRICES, state, now: NOW });
	const without = routeWithTrace({ reason: "user", candidates: [ARGON, OPUS], rules: pick("highest-quota"), state, now: NOW });
	assert.equal(name(withPrices.candidate), "claude-bridge/claude-opus-5-5");
	assert.deepEqual(withPrices.trace, without.trace);
});

test("pool rules accept the lowest-cost pick mode", () => {
	const config = { pools: [{ id: "orchestrator", name: "Orchestrator", candidates: ["antigravity/gemini-4-argon", "claude-bridge/claude-sonnet-5-5"], rules: CHEAPEST }] };
	assert.deepEqual(validatePoolsConfig(config).issues, []);
	assert.deepEqual(parsePools(config)[0].rules, CHEAPEST);
});

const AGY_OPUS: Candidate = { provider: "antigravity", model: "claude-opus-5-5", quotaKey: "antigravity/claude" };

test("a retry after a failed Opus does not climb back to Opus while a cheaper candidate is available", () => {
	const state = new QuotaState();
	state.markExhausted(AGY_OPUS.quotaKey, NOW + 3_600_000, "weekly");
	state.setQuotaFraction(OPUS.quotaKey, 0.9, undefined, NOW);
	state.setQuotaFraction(ARGON.quotaKey, 0.2, undefined, NOW);
	const { candidate, trace } = routeWithTrace({
		reason: "retry",
		failedProvider: "antigravity",
		failedModel: "claude-opus-5-5",
		candidates: [AGY_OPUS, OPUS, ARGON],
		rules: pick("highest-quota"),
		prices: PRICES,
		state,
		now: NOW,
	});
	assert.equal(name(candidate), "antigravity/gemini-4-argon");
	assert.equal(trace.decidedBy, "highest-quota");
});

test("a retry keeps the quota pick when nothing is cheaper than the failed model, or prices are missing", () => {
	const state = new QuotaState();
	state.markExhausted(AGY_OPUS.quotaKey, NOW + 3_600_000, "weekly");
	state.setQuotaFraction(OPUS.quotaKey, 0.9, undefined, NOW);
	const input = { reason: "retry" as const, failedProvider: "antigravity", failedModel: "claude-opus-5-5", rules: pick("highest-quota"), state, now: NOW };
	assert.equal(name(routeWithTrace({ ...input, candidates: [AGY_OPUS, OPUS], prices: PRICES }).candidate), "claude-bridge/claude-opus-5-5");
	state.setQuotaFraction(ARGON.quotaKey, 0.2, undefined, NOW);
	assert.equal(name(routeWithTrace({ ...input, candidates: [AGY_OPUS, OPUS, ARGON] }).candidate), "claude-bridge/claude-opus-5-5");
});

test("only retries are steered down: a new turn still picks by quota", () => {
	const state = new QuotaState();
	state.setQuotaFraction(OPUS.quotaKey, 0.9, undefined, NOW);
	state.setQuotaFraction(ARGON.quotaKey, 0.2, undefined, NOW);
	const { candidate } = routeWithTrace({ reason: "user", candidates: [ARGON, OPUS], rules: pick("highest-quota"), prices: PRICES, state, now: NOW });
	assert.equal(name(candidate), "claude-bridge/claude-opus-5-5");
});

test("failoverAlternative finds another spend window even on the same provider", () => {
	const state = new QuotaState();
	state.markExhausted(AGY_OPUS.quotaKey, NOW + 3_600_000, "weekly");
	state.markExhausted(OPUS.quotaKey, NOW + 3_600_000, "5h");
	// Argon shares the failed provider but not its window: it is a real way out.
	assert.equal(failoverAlternative([AGY_OPUS, OPUS, ARGON], AGY_OPUS.quotaKey, state, NOW), ARGON);
	state.markExhausted(ARGON.quotaKey, NOW + 3_600_000, "weekly");
	assert.equal(failoverAlternative([AGY_OPUS, OPUS, ARGON], AGY_OPUS.quotaKey, state, NOW), undefined);
});

test("a retry after a mid-priced model is decided by quota, not steered down", () => {
	const state = new QuotaState();
	state.markExhausted(SONNET.quotaKey, NOW + 3_600_000, "5h");
	state.setQuotaFraction(ARGON.quotaKey, 0.9, undefined, NOW);
	state.setQuotaFraction(FLASH.quotaKey, 0.2, undefined, NOW);
	const { candidate } = routeWithTrace({
		reason: "retry",
		failedProvider: "claude-bridge",
		failedModel: "claude-sonnet-5-5",
		candidates: [SONNET, FLASH, ARGON],
		rules: pick("highest-quota"),
		prices: PRICES,
		state,
		now: NOW,
	});
	assert.equal(name(candidate), "antigravity/gemini-4-argon", "most quota wins; Flash is cheaper but has less");
});
