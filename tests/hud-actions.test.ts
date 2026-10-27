import { test } from "node:test";
import assert from "node:assert/strict";
import { runHudChoice, type HudActionContext } from "../src/hud-actions.ts";

/** A fake command context that records every session operation in order. */
function fakeContext(file: string, leaf: string | null = "leaf-1", calls: string[] = []): HudActionContext & { calls: string[] } {
	const ctx: HudActionContext & { calls: string[] } = {
		calls,
		sessionManager: { getSessionFile: () => file, getLeafId: () => leaf },
		waitForIdle: async () => {
			calls.push(`idle ${file}`);
		},
		switchSession: async (path, options) => {
			calls.push(`switch ${path}`);
			await options?.withSession?.(fakeContext(path, leaf, calls));
			return { cancelled: false };
		},
		fork: async (entryId, options) => {
			calls.push(`fork ${file} at ${entryId} ${options?.position}`);
			await options?.withSession?.(fakeContext(`${file}.fork`, leaf, calls));
			return { cancelled: false };
		},
		compact: options => {
			calls.push(`compact ${file}`);
			options?.onComplete?.({ summary: "s", firstKeptEntryId: "e", tokensBefore: 693_000, estimatedTokensAfter: 21_000 });
		},
		ui: {
			notify: (message, level) => {
				calls.push(`${level ?? "info"}: ${message}`);
			},
		},
	};
	return ctx;
}

test("open switches to the chosen session", async () => {
	const ctx = fakeContext("/s/here.jsonl");
	await runHudChoice(ctx, { kind: "open", path: "/s/other.jsonl", label: "other" });
	assert.deepEqual(ctx.calls, ["switch /s/other.jsonl"]);
});

test("compact on another session: switch to it, wait until idle, then compact it there", async () => {
	const ctx = fakeContext("/s/here.jsonl");
	await runHudChoice(ctx, { kind: "compact", path: "/s/other.jsonl", label: "fix login" });
	assert.deepEqual(ctx.calls, [
		"idle /s/here.jsonl",
		"switch /s/other.jsonl",
		"idle /s/other.jsonl",
		'info: compacting "fix login": one request summarizes its history',
		"compact /s/other.jsonl",
		'info: "fix login" compacted: 693.0k → 21.0k tokens of context per turn',
	]);
});

test("compact on the current session compacts it without switching", async () => {
	const ctx = fakeContext("/s/here.jsonl");
	await runHudChoice(ctx, { kind: "compact", path: "/s/here.jsonl", label: "this one" });
	assert.deepEqual(ctx.calls.filter(call => call.startsWith("switch") || call.startsWith("compact")), ["compact /s/here.jsonl"]);
});

test("fresh: switch to the session, fork it at its leaf, and compact only the fork", async () => {
	const ctx = fakeContext("/s/here.jsonl");
	await runHudChoice(ctx, { kind: "fresh", path: "/s/other.jsonl", label: "fix login" });
	assert.deepEqual(ctx.calls, [
		"idle /s/here.jsonl",
		"switch /s/other.jsonl",
		"fork /s/other.jsonl at leaf-1 at",
		"idle /s/other.jsonl.fork",
		'info: compacting "fix login": one request summarizes its history',
		"compact /s/other.jsonl.fork",
		'info: "fix login" continues in a new session: 693.0k → 21.0k tokens of context per turn; the original session is untouched',
	]);
});

test("fresh on a session with no entries says so and does not fork", async () => {
	const ctx = fakeContext("/s/here.jsonl", null);
	await runHudChoice(ctx, { kind: "fresh", path: "/s/here.jsonl", label: "empty" });
	assert.deepEqual(ctx.calls, ["idle /s/here.jsonl", 'warning: "empty" has no messages to summarize yet']);
});

test("a failed compaction is reported as an error", async () => {
	const ctx = fakeContext("/s/here.jsonl");
	ctx.compact = options => options?.onError?.(new Error("model unavailable"));
	await runHudChoice(ctx, { kind: "compact", path: "/s/here.jsonl", label: "x" });
	assert.equal(ctx.calls.at(-1), 'error: compacting "x" failed: model unavailable');
});

test("a cancelled switch stops before compacting", async () => {
	const ctx = fakeContext("/s/here.jsonl");
	ctx.switchSession = async path => {
		ctx.calls.push(`switch ${path}`);
		return { cancelled: true };
	};
	await runHudChoice(ctx, { kind: "compact", path: "/s/other.jsonl", label: "x" });
	assert.deepEqual(ctx.calls, ["idle /s/here.jsonl", "switch /s/other.jsonl"]);
});
