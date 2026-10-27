import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseCandidate, type Candidate } from "../src/router.ts";
import { QuotaState } from "../src/state.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const CANDIDATES: Candidate[] = [
	{ provider: "antigravity", model: "claude-opus-5-5", quotaKey: "antigravity/claude" },
	{ provider: "claude-bridge", model: "claude-opus-5-5", quotaKey: "claude-bridge/claude" },
];

test("user requests take the first available candidate in order", () => {
	const state = new QuotaState();
	assert.equal(chooseCandidate({ reason: "user", candidates: CANDIDATES, state, now: NOW }).provider, "antigravity");
});

test("user requests skip an exhausted candidate", () => {
	const state = new QuotaState();
	state.markExhausted("antigravity/claude", NOW + 3_600_000, "weekly");
	assert.equal(chooseCandidate({ reason: "user", candidates: CANDIDATES, state, now: NOW }).provider, "claude-bridge");
});

test("continuations stay on the previous provider while it is available", () => {
	const state = new QuotaState();
	const choice = chooseCandidate({ reason: "continuation", previousProvider: "claude-bridge", candidates: CANDIDATES, state, now: NOW });
	assert.equal(choice.provider, "claude-bridge");
});

test("retries move off a provider that was just marked exhausted", () => {
	const state = new QuotaState();
	state.markExhausted("antigravity/claude", NOW + 3_600_000, "weekly");
	const choice = chooseCandidate({ reason: "retry", failedProvider: "antigravity", candidates: CANDIDATES, state, now: NOW });
	assert.equal(choice.provider, "claude-bridge");
});

test("retries for transient errors stay on the failed provider", () => {
	const state = new QuotaState();
	const choice = chooseCandidate({ reason: "retry", failedProvider: "antigravity", candidates: CANDIDATES, state, now: NOW });
	assert.equal(choice.provider, "antigravity");
});

test("when every candidate is exhausted the soonest to reset is chosen", () => {
	const state = new QuotaState();
	state.markExhausted("antigravity/claude", NOW + 7 * 86_400_000, "weekly");
	state.markExhausted("claude-bridge/claude", NOW + 3_600_000, "5h");
	const choice = chooseCandidate({ reason: "user", candidates: CANDIDATES, state, now: NOW });
	assert.equal(choice.provider, "claude-bridge");
});

test("hybrid strategy routes new session turns to the candidate with highest remaining quota", () => {
	const state = new QuotaState();
	state.setQuotaFraction("antigravity/claude", 0.20);
	state.setQuotaFraction("claude-bridge/claude", 0.85);

	const choice = chooseCandidate({
		reason: "user",
		candidates: CANDIDATES,
		state,
		now: NOW,
		strategy: "hybrid",
	});
	assert.equal(choice.provider, "claude-bridge");
});

test("hybrid strategy maintains session stickiness even if another candidate has more quota", () => {
	const state = new QuotaState();
	state.setQuotaFraction("antigravity/claude", 0.20);
	state.setQuotaFraction("claude-bridge/claude", 0.85);

	const choice = chooseCandidate({
		reason: "continuation",
		previousProvider: "antigravity",
		candidates: CANDIDATES,
		state,
		now: NOW,
		strategy: "hybrid",
	});
	assert.equal(choice.provider, "antigravity");
});

test("waterfall strategy strictly enforces candidate order regardless of quota fraction", () => {
	const state = new QuotaState();
	state.setQuotaFraction("antigravity/claude", 0.20);
	state.setQuotaFraction("claude-bridge/claude", 0.85);

	const choice = chooseCandidate({
		reason: "user",
		candidates: CANDIDATES,
		state,
		now: NOW,
		strategy: "waterfall",
	});
	assert.equal(choice.provider, "antigravity");
});
