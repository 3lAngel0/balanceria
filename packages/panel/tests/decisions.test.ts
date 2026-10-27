import test from "node:test";
import assert from "node:assert/strict";
import type { Decision } from "../ui/api.ts";
import { ALL, decisionFilters, filterDecisions, remainingText, switchCostText } from "../ui/decisions.ts";

function decision(ts: number, pool: string, role: string, decidedBy: string): Decision {
	return {
		ts, session: "01234567", project: "shop", pool, role, roleSource: "argv", reason: "user",
		chosen: "agy/opus", decidedBy, steps: [], candidates: [], contextTokens: null,
	};
}

const recent = [
	decision(3, "opus", "gentle-ai-verify", "sticky"),
	decision(2, "sonnet", "orchestrator", "highest-quota"),
	decision(1, "opus", "orchestrator", "fallback"),
];

test("the filters offer each pool, role and rule of the decisions once, sorted", () => {
	assert.deepEqual(decisionFilters(recent), {
		pool: ["opus", "sonnet"],
		role: ["gentle-ai-verify", "orchestrator"],
		rule: ["fallback", "highest-quota", "sticky"],
	});
	assert.deepEqual(decisionFilters([]), { pool: [], role: [], rule: [] });
});

test("filterDecisions keeps the decisions matching every chosen filter, in order; ALL matches anything", () => {
	const all = { pool: ALL, role: ALL, rule: ALL };
	assert.deepEqual(filterDecisions(recent, all), recent);
	assert.deepEqual(filterDecisions(recent, { ...all, pool: "opus" }).map(d => d.ts), [3, 1]);
	assert.deepEqual(filterDecisions(recent, { ...all, pool: "opus", role: "orchestrator" }).map(d => d.ts), [1]);
	assert.deepEqual(filterDecisions(recent, { ...all, rule: "highest-quota" }).map(d => d.ts), [2]);
	assert.deepEqual(filterDecisions(recent, { ...all, rule: "loan" }), []);
});

test("remainingText shows a candidate's quota as a whole percent, or a dash when unknown", () => {
	assert.equal(remainingText(0.625), "63%");
	assert.equal(remainingText(0), "0%");
	assert.equal(remainingText(undefined), "–");
});

test("switchCostText says what staying and moving cost, per window when calibrated", () => {
	const cost = {
		from: "agy/opus", to: "claude-bridge/opus", contextTokens: 80_000,
		stayTokens: 8_000, switchTokens: 100_000,
		stay: [{ key: "agy/opus", window: "week", percent: 0.4 }],
		switch: [{ key: "claude-bridge/claude", window: "5h", percent: null }],
		advice: { action: "propose" as const, why: "context over 30k" },
	};
	assert.equal(
		switchCostText(cost),
		"moved from agy/opus: staying 8,000 weighted tokens (agy/opus week 0.40%) · moving 100,000 (claude-bridge/claude 5h not calibrated) · advice: propose — context over 30k",
	);
	assert.equal(switchCostText({ ...cost, stay: [], switch: [] }), "moved from agy/opus: staying 8,000 weighted tokens · moving 100,000 · advice: propose — context over 30k");
});
