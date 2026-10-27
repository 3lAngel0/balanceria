import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDraft } from "../../../src/lab.ts";
import { readLabView, saveLabPools, type LabPanelPaths } from "../src/lab.ts";

const LIVE = {
	pools: [
		{ id: "opus", name: "Opus", candidates: ["agy/opus", "claude-bridge/opus"], strategy: "hybrid" },
	],
};
const RULES = [{ rule: "sticky" }, { rule: "prefer-for-role", role: "gentle-ai-verify", candidate: "claude-bridge/opus" }, { rule: "pick", mode: "highest-quota" }];

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function setup(withDraft = true): { dir: string; paths: LabPanelPaths } {
	const dir = mkdtempSync(join(tmpdir(), "panel-lab-"));
	const paths = { labDir: join(dir, "lab"), poolsPath: join(dir, "pools.json") };
	writeFileSync(paths.poolsPath, `${JSON.stringify(LIVE, null, 2)}\n`);
	if (withDraft) createDraft({ ...paths, profilesPath: join(dir, "profiles.json") }, 1000);
	return { dir, paths };
}

const draftText = (paths: LabPanelPaths) => readFileSync(join(paths.labDir, "pools.json"), "utf8");

test("with no draft the view says so", () => {
	const { dir, paths } = setup(false);
	try {
		assert.deepEqual(readLabView(paths), { draft: null });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a fresh draft shows its pools, no issues, no changes, and the version of its text", () => {
	const { dir, paths } = setup();
	try {
		assert.deepEqual(readLabView(paths), { draft: { createdAt: 1000, pools: LIVE, issues: [], changes: [], version: sha(draftText(paths)) } });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an edited draft lists its changes against the live pools.json, an invalid one its issues", () => {
	const { dir, paths } = setup();
	try {
		writeFileSync(join(paths.labDir, "pools.json"), JSON.stringify({ pools: [{ ...LIVE.pools[0], rules: RULES }] }));
		const view = readLabView(paths);
		assert.ok("draft" in view && view.draft);
		assert.deepEqual(view.draft.changes, [`pool opus: rules (default) → ${JSON.stringify(RULES)}`]);
		assert.deepEqual(view.draft.issues, []);
		writeFileSync(join(paths.labDir, "pools.json"), JSON.stringify({ pools: [{ ...LIVE.pools[0], rules: [{ rule: "sticky" }] }] }));
		const bad = readLabView(paths);
		assert.ok("draft" in bad && bad.draft);
		assert.deepEqual(bad.draft.issues, ["pools.json pools[0].rules: Rules must end with exactly one 'pick' block"]);
		writeFileSync(join(paths.labDir, "pools.json"), "{nope");
		const unreadable = readLabView(paths);
		assert.ok("draft" in unreadable && unreadable.draft);
		assert.equal(unreadable.draft.pools, null);
		assert.match(unreadable.draft.issues[0]!, /^pools\.json: not readable JSON/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an unreadable base.json or live pools.json is an error, never a throw", () => {
	const { dir, paths } = setup();
	try {
		writeFileSync(join(paths.labDir, "base.json"), "{nope");
		const broken = readLabView(paths);
		assert.ok("error" in broken);
		assert.match(broken.error, /base\.json is unreadable/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
	const other = setup();
	try {
		rmSync(other.paths.poolsPath);
		const missing = readLabView(other.paths);
		assert.ok("error" in missing);
		assert.match(missing.error, /^cannot read pools\.json: /);
	} finally {
		rmSync(other.dir, { recursive: true, force: true });
	}
});

test("saving writes only the draft pools.json, 0600, and answers the new view", () => {
	const { dir, paths } = setup();
	try {
		const base = readFileSync(join(paths.labDir, "base.json"), "utf8");
		const live = readFileSync(paths.poolsPath, "utf8");
		const next = { pools: [{ ...LIVE.pools[0], rules: RULES }] };
		const result = saveLabPools(paths, { version: sha(draftText(paths)), pools: next });
		const text = `${JSON.stringify(next, null, 2)}\n`;
		assert.equal(draftText(paths), text);
		assert.equal(statSync(join(paths.labDir, "pools.json")).mode & 0o777, 0o600);
		assert.deepEqual(result, {
			status: 200,
			body: { ok: true, draft: { createdAt: 1000, pools: next, issues: [], changes: [`pool opus: rules (default) → ${JSON.stringify(RULES)}`], version: sha(text) } },
		});
		assert.equal(readFileSync(join(paths.labDir, "base.json"), "utf8"), base);
		assert.equal(readFileSync(paths.poolsPath, "utf8"), live);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a refused save writes nothing: no draft, a stale version, invalid pools, a bad body", () => {
	const none = setup(false);
	try {
		assert.deepEqual(saveLabPools(none.paths, { version: "x", pools: LIVE }), { status: 409, body: { ok: false, message: "start a draft with /balancer lab new in Pi" } });
	} finally {
		rmSync(none.dir, { recursive: true, force: true });
	}
	const { dir, paths } = setup();
	try {
		const before = draftText(paths);
		const version = sha(before);
		assert.deepEqual(saveLabPools(paths, { version: sha("older"), pools: LIVE }), { status: 409, body: { ok: false, message: "the draft changed; reload" } });
		assert.deepEqual(saveLabPools(paths, { version, pools: { pools: [{ ...LIVE.pools[0], rules: [{ rule: "sticky" }], strategy: "nope" }] } }), {
			status: 400,
			body: { ok: false, message: "pools[0].strategy: Field 'strategy' if provided must be 'hybrid', 'waterfall' or 'highest-quota'; pools[0].rules: Rules must end with exactly one 'pick' block" },
		});
		for (const body of [null, [], "x", { pools: LIVE }, { version: 1, pools: LIVE }, { version }]) {
			assert.deepEqual(saveLabPools(paths, body), { status: 400, body: { ok: false, message: "send {version, pools}" } });
		}
		assert.equal(draftText(paths), before);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
