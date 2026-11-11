import { test } from "node:test";
import assert from "node:assert/strict";
import { routeWithTrace, type Candidate } from "../src/router.ts";
import { parseLastResort, parsePools } from "../src/pools.ts";
import { QuotaState } from "../src/state.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const CANDIDATES: Candidate[] = [
	{ provider: "antigravity", model: "claude-opus-5-5", quotaKey: "antigravity/claude" },
	{ provider: "claude-bridge", model: "claude-opus-5-5", quotaKey: "claude-bridge/claude" },
];
const FLASH: Candidate = { provider: "antigravity", model: "gemini-3-8-flash", quotaKey: "antigravity/gemini-flash" };

function spentState(): QuotaState {
	const state = new QuotaState();
	state.markExhausted("antigravity/claude", NOW + 3_600_000, "weekly");
	state.markExhausted("claude-bridge/claude", NOW + 7_200_000, "weekly");
	return state;
}

test("a spent pool routes to the last-resort model when it can answer", () => {
	const routed = routeWithTrace({ reason: "user", candidates: CANDIDATES, state: spentState(), now: NOW, lastResort: FLASH });
	assert.deepEqual(routed.candidate, FLASH);
	assert.equal(routed.trace.decidedBy, "last-resort");
});

test("the last-resort model is ignored while a pool candidate can answer", () => {
	const state = new QuotaState();
	state.markExhausted("antigravity/claude", NOW + 3_600_000, "weekly");
	const routed = routeWithTrace({ reason: "user", candidates: CANDIDATES, state, now: NOW, lastResort: FLASH });
	assert.equal(routed.candidate.provider, "claude-bridge");
	assert.notEqual(routed.trace.decidedBy, "last-resort");
});

test("a spent last-resort model keeps the reopens-first fallback", () => {
	const state = spentState();
	state.markExhausted("antigravity/gemini-flash", NOW + 600_000, "5h");
	const routed = routeWithTrace({ reason: "user", candidates: CANDIDATES, state, now: NOW, lastResort: FLASH });
	assert.equal(routed.candidate.quotaKey, "antigravity/claude");
	assert.equal(routed.trace.decidedBy, "fallback");
});

test("without a last-resort model a spent pool keeps the reopens-first fallback", () => {
	const routed = routeWithTrace({ reason: "user", candidates: CANDIDATES, state: spentState(), now: NOW });
	assert.equal(routed.candidate.quotaKey, "antigravity/claude");
	assert.equal(routed.trace.decidedBy, "fallback");
});

test("parseLastResort reads a provider/model ref and rejects anything else", () => {
	assert.deepEqual(parseLastResort({ lastResort: "antigravity/gemini-3-8-flash", pools: [] }), { provider: "antigravity", model: "gemini-3-8-flash", quotaKey: parseLastResort({ lastResort: "antigravity/gemini-3-8-flash" })!.quotaKey });
	assert.equal(parseLastResort({ lastResort: "pool/orchestrator" }), undefined);
	assert.equal(parseLastResort({ lastResort: "no-slash" }), undefined);
	assert.equal(parseLastResort({ lastResort: 3 }), undefined);
	assert.equal(parseLastResort({ pools: [] }), undefined);
});

test("pools still parse when pools.json has a lastResort field", () => {
	const pools = parsePools({ lastResort: "antigravity/gemini-3-8-flash", pools: [{ id: "p", candidates: ["antigravity/claude-opus-5-5"] }] });
	assert.equal(pools.length, 1);
});
