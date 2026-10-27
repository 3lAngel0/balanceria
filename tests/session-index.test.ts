import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clipAlias, createSessionIndex, findSessionFile, readFirstUserMessage } from "../src/session-index.ts";

const ID = "01a1510a-8e84-75aa-a1fe-c3d9560786c3";
const OTHER = "02b2620b-9f95-86bb-b2ff-d4ea671897d4";

function line(entry: unknown): string {
	return JSON.stringify(entry);
}

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "balancer-sessions-"));
	mkdirSync(join(root, "--proj-a--"));
	mkdirSync(join(root, "--proj-b--"));
	return root;
}

function write(root: string, dir: string, id: string, lines: string[]): string {
	const path = join(root, dir, `2026-10-19T03-40-45-062Z_${id}.jsonl`);
	writeFileSync(path, `${lines.join("\n")}\n`);
	return path;
}

const HEADER = line({ type: "session", id: ID });

test("findSessionFile locates a session file by id across cwd directories", () => {
	const root = fixture();
	try {
		write(root, "--proj-a--", OTHER, [HEADER]);
		const path = write(root, "--proj-b--", ID, [HEADER]);
		assert.equal(findSessionFile(root, ID), path);
		assert.equal(findSessionFile(root, "ffffffff-0000-0000-0000-000000000000"), null);
		assert.equal(findSessionFile(join(root, "missing"), ID), null);
	} finally {
		rmSync(root, { recursive: true });
	}
});

test("readFirstUserMessage takes the first user message, string or text parts, skipping other entries", () => {
	const root = fixture();
	try {
		const asString = write(root, "--proj-a--", ID, [
			HEADER,
			line({ type: "message", message: { role: "assistant", content: "hello" } }),
			line({ type: "message", message: { role: "user", content: "fix the login flow" } }),
			line({ type: "message", message: { role: "user", content: "second" } }),
		]);
		assert.equal(readFirstUserMessage(asString), "fix the login flow");
		const asParts = write(root, "--proj-a--", OTHER, [
			HEADER,
			line({ type: "message", message: { role: "user", content: [{ type: "image" }, { type: "text", text: "part one" }, { type: "text", text: "part two" }] } }),
		]);
		assert.equal(readFirstUserMessage(asParts), "part one part two");
	} finally {
		rmSync(root, { recursive: true });
	}
});

test("readFirstUserMessage returns null for a missing file, no user message, garbage lines or one past 512 KB", () => {
	const root = fixture();
	try {
		assert.equal(readFirstUserMessage(join(root, "nope.jsonl")), null);
		const none = write(root, "--proj-a--", ID, [HEADER, "not json", line({ type: "message", message: { role: "assistant", content: "x" } })]);
		assert.equal(readFirstUserMessage(none), null);
		const big = write(root, "--proj-a--", OTHER, [HEADER, line({ type: "message", message: { role: "assistant", content: "x".repeat(600_000) } }), line({ type: "message", message: { role: "user", content: "too late" } })]);
		assert.equal(readFirstUserMessage(big), null);
	} finally {
		rmSync(root, { recursive: true });
	}
});

test("readFirstUserMessage finds a user message that follows Pi's ~100 KB system prompt", () => {
	const root = fixture();
	try {
		const path = write(root, "--proj-a--", ID, [HEADER, line({ type: "message", message: { role: "system", content: "s".repeat(130_000) } }), line({ type: "message", message: { role: "user", content: "después ñandú" } })]);
		assert.equal(readFirstUserMessage(path), "después ñandú");
	} finally {
		rmSync(root, { recursive: true });
	}
});

test("clipAlias collapses whitespace to one line and clips to 40 characters with an ellipsis", () => {
	assert.equal(clipAlias("  fix\n the\t login   flow "), "fix the login flow");
	const clipped = clipAlias("a".repeat(100));
	assert.equal(clipped.length, 40);
	assert.ok(clipped.endsWith("…"));
	assert.equal(clipAlias("b".repeat(40)), "b".repeat(40));
});

test("the index returns path and alias, prefers a hinted path, caches the first message and never throws", () => {
	const root = fixture();
	try {
		const path = write(root, "--proj-a--", ID, [HEADER, line({ type: "message", message: { role: "user", content: "fix the login flow" } })]);
		const index = createSessionIndex(root);
		assert.deepEqual(index.lookup(ID), { path, firstMessage: "fix the login flow" });
		rmSync(path);
		assert.deepEqual(index.lookup(ID), { path, firstMessage: "fix the login flow" });
		assert.deepEqual(index.lookup(OTHER), { path: null, firstMessage: null });
		const hinted = write(root, "--proj-b--", OTHER, [HEADER, line({ type: "message", message: { role: "user", content: "hinted" } })]);
		assert.deepEqual(createSessionIndex(join(root, "missing")).lookup(OTHER, hinted), { path: hinted, firstMessage: "hinted" });
		assert.deepEqual(createSessionIndex(root).lookup(OTHER, join(root, "gone.jsonl")), { path: hinted, firstMessage: "hinted" });
	} finally {
		rmSync(root, { recursive: true });
	}
});
