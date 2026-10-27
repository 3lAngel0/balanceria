import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyQuotaError, failoverErrorMessage } from "../src/quota-errors.ts";
import { parseAgyUsage, agyGroupForModel } from "../src/agy-usage.ts";
import { QuotaState } from "../src/state.ts";

const AGY_REPORT = {
	command: {
		data: {
			groups: [
				{
					name: "Gemini Models",
					buckets: [
						{ id: "gemini-weekly", window: "weekly", remaining_fraction: 1, reset_time: "2026-10-23T16:42:38Z" },
						{ id: "gemini-5h", window: "5h", remaining_fraction: 0.4, reset_time: "2026-10-16T21:42:38Z" },
					],
				},
				{
					name: "Claude and GPT models",
					buckets: [
						{ id: "3p-weekly", window: "weekly", remaining_fraction: 0, reset_time: "2026-10-23T05:37:32Z" },
						{ id: "3p-5h", window: "5h", disabled: true, remaining_fraction: 0 },
					],
				},
				{
					name: "Gemini 4 Argon",
					buckets: [{ id: "gemini-argon-wtu-weekly", window: "weekly", remaining_fraction: 1, reset_time: "2026-10-23T16:42:38Z" }],
				},
			],
		},
	},
};

test("classifyQuotaError recognizes the agy weekly limit", () => {
	const result = classifyQuotaError("You have hit your weekly limit, it refreshes in 6 days, 12 hours.");
	assert.deepEqual(result, { exhausted: true });
});

test("classifyQuotaError recognizes the real agy quota error and its reset delay", () => {
	// Verbatim errorMessage observed from antigravity on 2026-10-16 (pi --mode json).
	const result = classifyQuotaError(
		"Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 154h55m28s.",
	);
	assert.deepEqual(result, { exhausted: true, resetInMs: ((154 * 60 + 55) * 60 + 28) * 1000 });
});

test("classifyQuotaError parses partial reset delays", () => {
	assert.deepEqual(classifyQuotaError("Individual quota reached. Resets in 42m."), { exhausted: true, resetInMs: 42 * 60_000 });
	assert.deepEqual(classifyQuotaError("Individual quota reached. Resets in 3h."), { exhausted: true, resetInMs: 3 * 3_600_000 });
});

test("classifyQuotaError recognizes the claude-bridge quota message", () => {
	const result = classifyQuotaError("Claude quota exceeded — rate limit (five_hour) — resets 6:30:00 PM: You're out of extra usage");
	assert.deepEqual(result, { exhausted: true });
});

test("classifyQuotaError recognizes bridge and agy stalls and timeouts", () => {
	const stall1 = classifyQuotaError("Error: agy stalled for 5m with no output");
	assert.deepEqual(stall1, { exhausted: true, resetInMs: 180000, isStall: true });

	const stall2 = classifyQuotaError("Warning: Antigravity stalled with no output; the turn was stopped");
	assert.deepEqual(stall2, { exhausted: true, resetInMs: 180000, isStall: true });

	const timeout = classifyQuotaError("Warning: Bridge tool call failed: read (escalated bridge call timed out after 30 minutes)");
	assert.deepEqual(timeout, { exhausted: true, resetInMs: 180000, isStall: true });
});

test("classifyQuotaError ignores transient and unrelated errors", () => {
	assert.equal(classifyQuotaError("529 overloaded"), undefined);
	assert.equal(classifyQuotaError("fetch failed"), undefined);
	assert.equal(classifyQuotaError(undefined), undefined);
});

test("failoverErrorMessage is retryable for Pi and avoids its non-retryable words", () => {
	// Mirrors pi-ai 1.2 utils/retry.js: retryable needs a RETRYABLE pattern and no NON_RETRYABLE one.
	const nonRetryable = /GoUsageLimitError|FreeUsageLimitError|Monthly usage limit reached|available balance|insufficient_quota|out of budget|quota exceeded|billing|subscription_sharing_usage_limit_exceeded/i;
	const message = failoverErrorMessage("antigravity");
	assert.match(message, /rate.?limit/i);
	assert.match(message, /429/);
	assert.doesNotMatch(message, nonRetryable);
	assert.equal(classifyQuotaError(message), undefined, "a rewritten message must not be re-classified as exhaustion");

	const stallMessage = failoverErrorMessage("antigravity", true);
	assert.match(stallMessage, /rate.?limit/i);
	assert.match(stallMessage, /stalled with no output/i);
	assert.equal(classifyQuotaError(stallMessage), undefined);
});

test("agyGroupForModel maps model ids to quota groups", () => {
	assert.equal(agyGroupForModel("claude-opus-5-5"), "Claude and GPT models");
	assert.equal(agyGroupForModel("claude-sonnet-5-5"), "Claude and GPT models");
	assert.equal(agyGroupForModel("gemini-4-argon"), "Gemini 4 Argon");
	assert.equal(agyGroupForModel("gemini-3-8-flash"), "Gemini Models");
});

test("parseAgyUsage takes the lowest enabled bucket per group and its reset", () => {
	const groups = parseAgyUsage(AGY_REPORT);
	assert.deepEqual(groups.get("Claude and GPT models"), {
		remainingFraction: 0,
		resetAt: Date.parse("2026-10-23T05:37:32Z"),
	});
	assert.deepEqual(groups.get("Gemini Models"), {
		remainingFraction: 0.4,
		resetAt: Date.parse("2026-10-16T21:42:38Z"),
	});
	assert.deepEqual(groups.get("Gemini 4 Argon"), {
		remainingFraction: 1,
		resetAt: Date.parse("2026-10-23T16:42:38Z"),
	});
});

test("parseAgyUsage returns an empty map for malformed input", () => {
	assert.equal(parseAgyUsage(null).size, 0);
	assert.equal(parseAgyUsage({ command: { data: { groups: "x" } } }).size, 0);
});

test("QuotaState treats an exhausted key as unavailable until its reset", () => {
	const state = new QuotaState();
	const now = Date.parse("2026-10-16T12:00:00Z");
	state.markExhausted("antigravity/claude", now + 60_000, "agy weekly limit");
	assert.equal(state.isAvailable("antigravity/claude", now), false);
	assert.equal(state.isAvailable("antigravity/claude", now + 60_001), true);
	assert.equal(state.isAvailable("claude-bridge/claude", now), true);
});

test("QuotaState uses a default cooldown when no reset is known", () => {
	const state = new QuotaState({ defaultCooldownMs: 30 * 60_000 });
	const now = Date.parse("2026-10-16T12:00:00Z");
	state.markExhausted("claude-bridge/claude", undefined, "claude quota", now);
	assert.equal(state.isAvailable("claude-bridge/claude", now + 29 * 60_000), false);
	assert.equal(state.isAvailable("claude-bridge/claude", now + 31 * 60_000), true);
});

test("QuotaState applies agy usage: an empty group is exhausted until reset, a refilled one is available", () => {
	const state = new QuotaState();
	const now = Date.parse("2026-10-16T12:00:00Z");
	state.applyAgyUsage(parseAgyUsage(AGY_REPORT), now);
	assert.equal(state.isAvailable("antigravity/claude", now), false);
	assert.equal(state.isAvailable("antigravity/gemini-4-argon", now), true);
	state.applyAgyUsage(new Map([["Claude and GPT models", { remainingFraction: 0.8, resetAt: undefined }]]), now);
	assert.equal(state.isAvailable("antigravity/claude", now), true);
});
