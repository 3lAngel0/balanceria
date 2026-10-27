import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	deleteSessionToTrash,
	listTrash,
	pruneTrash,
	restoreSessionFromTrash,
	compactSession,
	cancelSession,
	type LiveSessionManager,
	type SessionActionContext,
} from "../src/actions.ts";

function createScratch(): { dir: string; cleanup: () => void } {
	const dir = join(tmpdir(), `panel-actions-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return {
		dir,
		cleanup: () => {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// Cleaned by OS
			}
		},
	};
}

test("deleteSessionToTrash moves session file to data/trash/<YYYY-MM-DD>/<project>/<session>.jsonl", () => {
	const { dir, cleanup } = createScratch();
	try {
		const root = join(dir, "sessions");
		const dataDir = join(dir, "data");
		const projectDir = join(root, "my-project");
		mkdirSync(projectDir, { recursive: true });
		const sessionFile = join(projectDir, "2026-10-25T12-00-00_test-session.jsonl");
		writeFileSync(sessionFile, '{"header":true}\n{"msg":"hello"}\n', "utf8");

		const now = new Date("2026-10-25T18:00:00Z").getTime();
		const result = deleteSessionToTrash({ root, dataDir, sessionId: "test-session", now });

		assert.equal(result.ok, true);
		assert.equal(existsSync(sessionFile), false, "original file should be moved");
		const trashPath = join(dataDir, "trash", "2026-10-25", "my-project", "2026-10-25T12-00-00_test-session.jsonl");
		assert.equal(existsSync(trashPath), true, "file should exist in trash");
		assert.equal(readFileSync(trashPath, "utf8"), '{"header":true}\n{"msg":"hello"}\n');
	} finally {
		cleanup();
	}
});

test("listTrash returns all trashed sessions sorted newest first", () => {
	const { dir, cleanup } = createScratch();
	try {
		const dataDir = join(dir, "data");
		const trashProject = join(dataDir, "trash", "2026-10-24", "proj-a");
		mkdirSync(trashProject, { recursive: true });
		writeFileSync(join(trashProject, "2026-10-24T10-00-00_s1.jsonl"), '{"header":true}\n', "utf8");

		const trashProject2 = join(dataDir, "trash", "2026-10-25", "proj-b");
		mkdirSync(trashProject2, { recursive: true });
		writeFileSync(join(trashProject2, "2026-10-25T12-00-00_s2.jsonl"), '{"header":true}\n', "utf8");

		const items = listTrash(dataDir);
		assert.equal(items.length, 2);
		assert.equal(items[0]!.sessionId, "s2");
		assert.equal(items[0]!.project, "proj-b");
		assert.equal(items[0]!.date, "2026-10-25");
		assert.equal(items[1]!.sessionId, "s1");
		assert.equal(items[1]!.project, "proj-a");
		assert.equal(items[1]!.date, "2026-10-24");
	} finally {
		cleanup();
	}
});

test("restoreSessionFromTrash moves session back to the project folder", () => {
	const { dir, cleanup } = createScratch();
	try {
		const root = join(dir, "sessions");
		const dataDir = join(dir, "data");
		const trashProject = join(dataDir, "trash", "2026-10-25", "proj-restore");
		mkdirSync(trashProject, { recursive: true });
		const filename = "2026-10-25T12-00-00_s-restore.jsonl";
		const trashFile = join(trashProject, filename);
		writeFileSync(trashFile, '{"header":true,"content":"restored"}\n', "utf8");

		const result = restoreSessionFromTrash({ root, dataDir, trashRelativePath: `2026-10-25/proj-restore/${filename}` });
		assert.equal(result.ok, true);
		assert.equal(existsSync(trashFile), false, "trash file should be moved");
		const restoredPath = join(root, "proj-restore", filename);
		assert.equal(existsSync(restoredPath), true, "restored file should exist in project folder");
		assert.equal(readFileSync(restoredPath, "utf8"), '{"header":true,"content":"restored"}\n');
	} finally {
		cleanup();
	}
});

test("pruneTrash deletes trash date folders older than 10 days", () => {
	const { dir, cleanup } = createScratch();
	try {
		const dataDir = join(dir, "data");
		const trash = join(dataDir, "trash");
		const oldDay = join(trash, "2026-10-10", "proj");
		const freshDay = join(trash, "2026-10-20", "proj");
		mkdirSync(oldDay, { recursive: true });
		mkdirSync(freshDay, { recursive: true });
		writeFileSync(join(oldDay, "old.jsonl"), "old", "utf8");
		writeFileSync(join(freshDay, "fresh.jsonl"), "fresh", "utf8");

		// now = 2026-10-25: 2026-10-10 is 15 days old (> 10 days), 2026-10-20 is 5 days old (<= 10 days)
		const now = new Date("2026-10-25T12:00:00Z").getTime();
		const pruned = pruneTrash(dataDir, now, 10);

		assert.equal(pruned.length, 1);
		assert.equal(pruned[0], "2026-10-10");
		assert.equal(existsSync(join(trash, "2026-10-10")), false);
		assert.equal(existsSync(join(trash, "2026-10-20")), true);
	} finally {
		cleanup();
	}
});

test("compactSession calls rpcRunner when provided", async () => {
	let calledPath = "";
	const res = await compactSession({
		sessionPath: "/path/to/session.jsonl",
		rpcRunner: async path => {
			calledPath = path;
			return { ok: true, message: "compacted" };
		},
	});
	assert.equal(res.ok, true);
	assert.equal(calledPath, "/path/to/session.jsonl");
});

test("cancelSession cancels running live session or reports not running", async () => {
	let cancelledId = "";
	const mockManager: LiveSessionManager = {
		isLive: id => id === "live-123",
		cancel: async id => {
			cancelledId = id;
			return true;
		},
	};

	const liveRes = await cancelSession("live-123", mockManager);
	assert.equal(liveRes.ok, true);
	assert.equal(cancelledId, "live-123");

	const offlineRes = await cancelSession("offline-456", mockManager);
	assert.equal(offlineRes.ok, false);
	assert.equal(offlineRes.message, "session is not running");

	const noManagerRes = await cancelSession("any-789");
	assert.equal(noManagerRes.ok, false);
	assert.equal(noManagerRes.message, "session is not running");
});
