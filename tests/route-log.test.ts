import { test } from "node:test";
import assert from "node:assert/strict";
import { DecisionChanges, routeDecision } from "../src/route-log.ts";
import { routeWithTrace, type Candidate } from "../src/router.ts";
import { QuotaState } from "../src/state.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const CANDIDATES: Candidate[] = [
	{ provider: "antigravity", model: "claude-opus-5-5", quotaKey: "antigravity/claude" },
	{ provider: "claude-bridge", model: "claude-opus-5-5", quotaKey: "claude-bridge/claude" },
];

test("routeDecision turns a routed choice and its trace into a history row", () => {
	const state = new QuotaState();
	state.setQuotaFraction("antigravity/claude", 0.3);
	state.setQuotaFraction("claude-bridge/claude", 0.62);
	const routed = routeWithTrace({ reason: "user", candidates: CANDIDATES, state, now: NOW });
	const row = routeDecision({
		ts: NOW, session: "s1", project: "balancingIa", pool: "claude-opus-5-5", reason: "user",
		role: { role: "gentle-ai-verify", source: "argv" }, contextTokens: 152_300, ...routed,
	});
	assert.deepEqual(row, {
		kind: "route", ts: NOW, session: "s1", project: "balancingIa", pool: "claude-opus-5-5",
		role: "gentle-ai-verify", roleSource: "argv", reason: "user", chosen: "claude-bridge/claude-opus-5-5",
		decidedBy: "highest-quota", steps: routed.trace.steps, candidates: routed.trace.candidates, contextTokens: 152_300,
	});
});

test("routeDecision keeps a switch cost when the route moved a session", () => {
	const state = new QuotaState();
	const routed = routeWithTrace({ reason: "continuation", previousProvider: "openai", candidates: CANDIDATES, state, now: NOW });
	const switchCost = {
		from: "openai", to: "antigravity/claude-opus-5-5", contextTokens: 40_000, stayTokens: 4_000, switchTokens: 50_000,
		stay: [], switch: [], advice: { action: "propose" as const, why: "x" },
	};
	const row = routeDecision({
		ts: NOW, session: "s1", project: "p", pool: "opus", reason: "continuation",
		role: { role: "orchestrator", source: "none" }, contextTokens: 40_000, ...routed, switchCost,
	});
	assert.deepEqual(row.switchCost, switchCost);
});

test("DecisionChanges reports the first decision of a pool and every change of provider or rule, not repeats", () => {
	const changes = new DecisionChanges();
	assert.equal(changes.changed("opus", "claude-bridge/claude-opus-5-5", "highest-quota"), true);
	assert.equal(changes.changed("opus", "claude-bridge/claude-opus-5-5", "highest-quota"), false);
	assert.equal(changes.changed("opus", "claude-bridge/claude-opus-5-5", "sticky"), true);
	assert.equal(changes.changed("opus", "claude-bridge/claude-opus-5-5", "sticky"), false);
	assert.equal(changes.changed("opus", "antigravity/claude-opus-5-5", "sticky"), true);
	assert.equal(changes.changed("flash", "antigravity/gemini-3-8-flash", "sticky"), true);
	assert.equal(changes.changed("opus", "antigravity/claude-opus-5-5", "sticky"), false);
});
