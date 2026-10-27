import { test } from "node:test";
import assert from "node:assert/strict";
import { turnBadge, turnTelemetry, statusLine } from "../src/panel.ts";
import { formatCard, transientFrame } from "../src/usage-panel.ts";
import { QuotaState } from "../src/state.ts";
import type { FoldedEvents } from "../src/events.ts";

test("turnTelemetry counts every token the turn moved, what was not read from cache, and how much the context grew", () => {
	// A claude-bridge turn: almost everything is a cache read.
	const usage = { input: 2, output: 369, cacheRead: 82_660, cacheWrite: 4_867 };
	assert.deepEqual(turnTelemetry(usage, 88_317, 85_591), { lastTurnTokens: 87_898, newTokens: 5_238, contextDelta: 2_726 });
	assert.deepEqual(turnTelemetry({ input: 1000 }, null, undefined), { lastTurnTokens: 1000, newTokens: 1000, contextDelta: undefined });
	assert.deepEqual(turnTelemetry({ output: 10 }, 5_000, null), { lastTurnTokens: 10, newTokens: 10, contextDelta: undefined });
});

test("turnBadge lights by the tokens the turn moved and says what was new and how the context changed", () => {
	assert.equal(turnBadge(undefined), undefined);
	assert.equal(turnBadge({ lastTurnTokens: 1200, newTokens: 1200 }), "🟢 turn 1.2k · new 1.2k");
	assert.equal(turnBadge({ lastTurnTokens: 49_999, newTokens: 300, contextDelta: 0 }), "🟢 turn 50.0k · new 300 · ctx +0");
	assert.equal(turnBadge({ lastTurnTokens: 87_898, newTokens: 5_238, contextDelta: 2_726 }), "🟡 turn 87.9k · new 5.2k · ctx +2.7k");
	assert.equal(turnBadge({ lastTurnTokens: 50_000, newTokens: 1 }), "🟡 turn 50.0k · new 1");
	assert.equal(turnBadge({ lastTurnTokens: 150_000, newTokens: 2_000, contextDelta: -120_000 }), "🔴 turn 150.0k · new 2.0k · ctx -120.0k");
	assert.equal(turnBadge({ lastTurnTokens: 300, newTokens: 300, isBalancer: true }), "🟢 turn 300 · new 300 [balancer]");
});

test("statusLine incorporates turn badge", () => {
	const folded: FoldedEvents = {
		state: new QuotaState(),
		tokens: new Map(),
		lastRoute: { pool: "claude-sonnet-5-5", provider: "claude-bridge", ts: 0 },
		lastAgyUsageAt: undefined,
	};
	const line = statusLine(folded, Date.now(), undefined, { lastTurnTokens: 1200, newTokens: 200, contextDelta: 150 });
	assert.match(line, /^⚖ sonnet→claude-bridge · 🟢 turn 1\.2k · new 200 · ctx \+150$/);
	assert.equal(statusLine({ ...folded, lastRoute: undefined }, Date.now()), "⚖ ai-balancer idle", "no turn yet, no badge");
});

test("formatCard frames text with Unicode box-drawing borders", () => {
	const card = formatCard("Active Pool", ["Candidate 1: agy", "Candidate 2: bridge"], 30);
	assert.match(card[0], /╭─ Active Pool/);
	assert.match(card[1], /│ Candidate 1: agy/);
	assert.match(card[card.length - 1], /╰─+╯/);
});

test("transientFrame cycles through braille spinners", () => {
	assert.equal(transientFrame(0), "⠋");
	assert.equal(transientFrame(1), "⠙");
	assert.equal(transientFrame(10), "⠋");
});
