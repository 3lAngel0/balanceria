import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PROACTIVE_COMPACT_TOKENS, entriesToHistoryMessages, estimateHistoryTokens, shouldCompactProactively } from "../src/context-guard.ts";

test("the proactive compaction threshold defaults to 180k tokens", () => {
	assert.equal(DEFAULT_PROACTIVE_COMPACT_TOKENS, 180_000);
});

test("estimateHistoryTokens counts every message kind at four characters per token", () => {
	const messages = [
		{ role: "user", content: "a".repeat(400) },
		{ role: "user", content: [{ type: "text", text: "b".repeat(40) }, { type: "image", data: "x", mimeType: "image/png" }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "c".repeat(80) },
				{ type: "thinking", thinking: "d".repeat(40) },
				{ type: "toolCall", id: "1", name: "read", arguments: { path: "src/x.ts" } },
			],
		},
		{ role: "toolResult", toolCallId: "1", toolName: "read", content: [{ type: "text", text: "e".repeat(4000) }] },
		{ role: "bashExecution", command: "ls", output: "f".repeat(398) },
		{ role: "compactionSummary", summary: "g".repeat(800) },
	];
	const toolCallChars = "read".length + JSON.stringify({ path: "src/x.ts" }).length;
	const expected =
		100 + Math.ceil((40 + 4800) / 4) + Math.ceil((80 + 40 + toolCallChars) / 4) + 1000 + 100 + 200;
	assert.equal(estimateHistoryTokens(messages), expected);
});

test("estimateHistoryTokens ignores unknown messages and returns 0 for an empty history", () => {
	assert.equal(estimateHistoryTokens([]), 0);
	assert.equal(estimateHistoryTokens([{ role: "mystery", content: "x".repeat(400) }]), 0);
});

test("shouldCompactProactively fires at the threshold for pool and antigravity models only", () => {
	const base = { threshold: 180_000, compacting: false };
	assert.equal(shouldCompactProactively({ ...base, provider: "pool", estimatedTokens: 179_999 }), false);
	assert.equal(shouldCompactProactively({ ...base, provider: "pool", estimatedTokens: 180_000 }), true);
	assert.equal(shouldCompactProactively({ ...base, provider: "antigravity", estimatedTokens: 964_379 }), true);
	assert.equal(shouldCompactProactively({ ...base, provider: "claude-bridge", estimatedTokens: 964_379 }), false);
	assert.equal(shouldCompactProactively({ ...base, provider: undefined, estimatedTokens: 964_379 }), false);
});

test("entriesToHistoryMessages keeps what pi sends: messages, custom messages and summaries", () => {
	const entries = [
		{ type: "compaction", summary: "s".repeat(400), tokensBefore: 964_379 },
		{ type: "message", message: { role: "user", content: "u".repeat(40) } },
		{ type: "custom_message", customType: "note", content: "c".repeat(80) },
		{ type: "branch_summary", summary: "b".repeat(120) },
		{ type: "model_change", provider: "pool", modelId: "orchestrator" },
		{ type: "custom", customType: "gentle-pi.session-change/v1", data: { big: "x".repeat(10_000) } },
	];
	const messages = entriesToHistoryMessages(entries);
	assert.deepEqual(messages.map(message => message.role), ["compactionSummary", "user", "custom", "branchSummary"]);
	assert.equal(estimateHistoryTokens(messages), 100 + 10 + 20 + 30);
});

test("shouldCompactProactively never starts a second compaction while one runs", () => {
	assert.equal(shouldCompactProactively({ threshold: 180_000, compacting: true, provider: "pool", estimatedTokens: 500_000 }), false);
});
