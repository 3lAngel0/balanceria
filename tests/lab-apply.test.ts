import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	applyDraft,
	createDraft,
	diffLab,
	formatApplyConfirm,
	hasUndo,
	LAB_APPLIED,
	LAB_BASE,
	LAB_POOLS,
	LAB_PROFILES,
	readDraft,
	undoApply,
	type LabPaths,
} from "../src/lab.ts";
import { replaceFileSafely } from "../src/profiles.ts";

const SAMPLE_POOLS = {
	pools: [
		{ id: "sonnet", name: "Sonnet", candidates: ["agy/sonnet", "bridge/sonnet"], strategy: "hybrid" },
		{ id: "opus", name: "Opus", candidates: ["agy/opus", "bridge/opus"] },
	],
};

const SAMPLE_PROFILES = {
	kind: "gentle-pi.agent_model_profiles",
	version: 1,
	profiles: {
		main: {
			orchestrator: { model: "pool/opus", thinking: "medium" },
			"gentle-ai-worker": { model: "pool/sonnet", thinking: "medium" },
			"gentle-ai-verify": { model: "pool/opus", thinking: "high" },
		},
	},
	active: "main",
};

function text(value: unknown): string {
	return `${JSON.stringify(value, null, 2)}\n`;
}

function setup() {
	const dir = mkdtempSync(join(tmpdir(), "lab-apply-test-"));
	const dataDir = join(dir, "data");
	const labDir = join(dataDir, "lab");
	mkdirSync(labDir, { recursive: true });
	const paths: LabPaths = {
		labDir,
		poolsPath: join(dir, "pools.json"),
		profilesPath: join(dir, "profiles.json"),
	};
	writeFileSync(paths.poolsPath, text(SAMPLE_POOLS));
	writeFileSync(paths.profilesPath, text(SAMPLE_PROFILES));
	return { dir, dataDir, paths, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const KNOWN_REGISTRY = new Set([
	"pool/opus",
	"pool/sonnet",
	"agy/sonnet",
	"bridge/sonnet",
	"agy/opus",
	"bridge/opus",
	"agy/flash",
	"custom/known-model",
]);

const hasModel = (provider: string, model: string) => KNOWN_REGISTRY.has(`${provider}/${model}`);

// -----------------------------------------------------------------------------
// Rule 1: replaceFileSafely
// -----------------------------------------------------------------------------

test("replaceFileSafely backs up, writes atomically with 0600, rotates own backups keeping 10", () => {
	const dir = mkdtempSync(join(tmpdir(), "replace-test-"));
	try {
		const file = join(dir, "pools.json");
		const original = text(SAMPLE_POOLS);
		writeFileSync(file, original);
		const updated = text({ ...SAMPLE_POOLS, pools: [] });
		const now = 1792440000000;

		const { backup, removed } = replaceFileSafely(file, updated, original, now);
		assert.ok(existsSync(backup));
		assert.match(backup, /pools\.json\.bak-\d{14}$/);
		assert.equal(readFileSync(backup, "utf8"), original);
		assert.equal(statSync(backup).mode & 0o777, 0o600);
		assert.equal(readFileSync(file, "utf8"), updated);
		assert.equal(statSync(file).mode & 0o777, 0o600);
		assert.deepEqual(removed, []);

		// Temp files must be cleaned up
		assert.deepEqual(readdirSync(dir).sort(), ["pools.json", backup.split("/").pop()].sort());
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("replaceFileSafely refuses when file is missing, writing nothing", () => {
	const dir = mkdtempSync(join(tmpdir(), "replace-test-"));
	try {
		const file = join(dir, "missing.json");
		assert.throws(() => replaceFileSafely(file, "{}", "", 1_000), /not found/);
		assert.deepEqual(readdirSync(dir), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("replaceFileSafely refuses when file content differs from expectedRaw, leaving file untouched", () => {
	const dir = mkdtempSync(join(tmpdir(), "replace-test-"));
	try {
		const file = join(dir, "pools.json");
		writeFileSync(file, "live-content");
		assert.throws(() => replaceFileSafely(file, "new-content", "expected-content", 1_000), /changed since it was read/);
		assert.equal(readFileSync(file, "utf8"), "live-content");
		assert.deepEqual(readdirSync(dir), ["pools.json"], "no backups or temp files created");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("replaceFileSafely keeps 10 own backups and leaves foreign backups untouched", () => {
	const dir = mkdtempSync(join(tmpdir(), "replace-test-"));
	try {
		const file = join(dir, "pools.json");
		writeFileSync(file, "content-0");
		const own = Array.from({ length: 12 }, (_, i) => `pools.json.bak-202610010000${String(i).padStart(2, "0")}`);
		const foreign = ["pools.json.bak-manual", "pools.json.bak-20261019"];
		for (const name of [...own, ...foreign]) writeFileSync(join(dir, name), "old");

		const { removed } = replaceFileSafely(file, "content-1", "content-0", 1792440000000);
		assert.deepEqual(removed.map(p => p.split("/").pop()), own.slice(0, 3));
		for (const f of foreign) assert.ok(existsSync(join(dir, f)), `foreign backup ${f} preserved`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// -----------------------------------------------------------------------------
// Rule 2: applyDraft refusals (writing NOTHING)
// -----------------------------------------------------------------------------

test("applyDraft refuses when there is no draft, writing nothing", () => {
	const { dir, dataDir, paths, cleanup } = setup();
	try {
		const poolsBefore = readFileSync(paths.poolsPath, "utf8");
		const profilesBefore = readFileSync(paths.profilesPath, "utf8");

		assert.throws(() => applyDraft({ paths, dataDir, hasModel }), /no lab draft/);
		assert.equal(readFileSync(paths.poolsPath, "utf8"), poolsBefore);
		assert.equal(readFileSync(paths.profilesPath, "utf8"), profilesBefore);
		assert.ok(!existsSync(join(paths.labDir, LAB_APPLIED)));
		assert.ok(!existsSync(join(dataDir, "audit.jsonl")));
	} finally {
		cleanup();
	}
});

test("applyDraft refuses when draft has issues, writing nothing", () => {
	const { dataDir, paths, cleanup } = setup();
	try {
		createDraft(paths, 1_000);
		// Corrupt pools.json in draft
		writeFileSync(join(paths.labDir, LAB_POOLS), "invalid-json");

		const poolsBefore = readFileSync(paths.poolsPath, "utf8");
		const profilesBefore = readFileSync(paths.profilesPath, "utf8");

		assert.throws(() => applyDraft({ paths, dataDir, hasModel }), /the draft has issues/);
		assert.equal(readFileSync(paths.poolsPath, "utf8"), poolsBefore);
		assert.equal(readFileSync(paths.profilesPath, "utf8"), profilesBefore);
		assert.ok(!existsSync(join(paths.labDir, LAB_APPLIED)));
		assert.ok(!existsSync(join(dataDir, "audit.jsonl")));
	} finally {
		cleanup();
	}
});

test("applyDraft refuses when draft has no changes, writing nothing", () => {
	const { dataDir, paths, cleanup } = setup();
	try {
		createDraft(paths, 1_000);
		// Draft is unchanged from live
		const poolsBefore = readFileSync(paths.poolsPath, "utf8");
		const profilesBefore = readFileSync(paths.profilesPath, "utf8");

		assert.throws(() => applyDraft({ paths, dataDir, hasModel }), /the draft has no changes/);
		assert.equal(readFileSync(paths.poolsPath, "utf8"), poolsBefore);
		assert.equal(readFileSync(paths.profilesPath, "utf8"), profilesBefore);
		assert.ok(!existsSync(join(paths.labDir, LAB_APPLIED)));
		assert.ok(!existsSync(join(dataDir, "audit.jsonl")));
	} finally {
		cleanup();
	}
});

test("applyDraft refuses when live pools.json changed since draft created, telling user to run /balancer lab new again", () => {
	const { dataDir, paths, cleanup } = setup();
	try {
		createDraft(paths, 1_000);
		// Make a change in draft pools
		const draftPools = {
			pools: [{ id: "sonnet", name: "Sonnet Edited", candidates: ["agy/sonnet", "bridge/sonnet"], strategy: "hybrid" }],
		};
		writeFileSync(join(paths.labDir, LAB_POOLS), text(draftPools));

		// Concurrently change live pools.json
		writeFileSync(paths.poolsPath, text({ ...SAMPLE_POOLS, pools: [] }));
		const poolsLive = readFileSync(paths.poolsPath, "utf8");
		const profilesLive = readFileSync(paths.profilesPath, "utf8");

		assert.throws(() => applyDraft({ paths, dataDir, hasModel }), /pools\.json changed since the draft was created; run \/balancer lab new again/);
		assert.equal(readFileSync(paths.poolsPath, "utf8"), poolsLive);
		assert.equal(readFileSync(paths.profilesPath, "utf8"), profilesLive);
		assert.ok(!existsSync(join(paths.labDir, LAB_APPLIED)));
		assert.ok(!existsSync(join(dataDir, "audit.jsonl")));
	} finally {
		cleanup();
	}
});

test("applyDraft refuses when live profiles.json changed since draft created, telling user to run /balancer lab new again", () => {
	const { dataDir, paths, cleanup } = setup();
	try {
		createDraft(paths, 1_000);
		// Make a change in draft profiles
		const draftProfiles = JSON.parse(JSON.stringify(SAMPLE_PROFILES));
		draftProfiles.profiles.main["gentle-ai-worker"].model = "agy/flash";
		writeFileSync(join(paths.labDir, LAB_PROFILES), text(draftProfiles));

		// Concurrently change live profiles.json
		writeFileSync(paths.profilesPath, text({ ...SAMPLE_PROFILES, active: "other" }));
		const poolsLive = readFileSync(paths.poolsPath, "utf8");
		const profilesLive = readFileSync(paths.profilesPath, "utf8");

		assert.throws(() => applyDraft({ paths, dataDir, hasModel }), /profiles\.json changed since the draft was created; run \/balancer lab new again/);
		assert.equal(readFileSync(paths.poolsPath, "utf8"), poolsLive);
		assert.equal(readFileSync(paths.profilesPath, "utf8"), profilesLive);
		assert.ok(!existsSync(join(paths.labDir, LAB_APPLIED)));
		assert.ok(!existsSync(join(dataDir, "audit.jsonl")));
	} finally {
		cleanup();
	}
});

test("applyDraft refuses when a draft pool candidate is not in current pools AND not in Pi registry", () => {
	const { dataDir, paths, cleanup } = setup();
	try {
		createDraft(paths, 1_000);
		const draftPools = {
			pools: [{ id: "sonnet", name: "Sonnet", candidates: ["agy/sonnet", "unknown-prov/unknown-mod"], strategy: "hybrid" }],
		};
		writeFileSync(join(paths.labDir, LAB_POOLS), text(draftPools));

		const poolsBefore = readFileSync(paths.poolsPath, "utf8");
		const profilesBefore = readFileSync(paths.profilesPath, "utf8");

		assert.throws(() => applyDraft({ paths, dataDir, hasModel }), /unknown-prov\/unknown-mod is not in Pi's model registry/);
		assert.equal(readFileSync(paths.poolsPath, "utf8"), poolsBefore);
		assert.equal(readFileSync(paths.profilesPath, "utf8"), profilesBefore);
		assert.ok(!existsSync(join(paths.labDir, LAB_APPLIED)));
		assert.ok(!existsSync(join(dataDir, "audit.jsonl")));
	} finally {
		cleanup();
	}
});

test("applyDraft refuses when a new or changed profile route model is not in Pi registry, BEFORE writing anything", () => {
	const { dataDir, paths, cleanup } = setup();
	try {
		createDraft(paths, 1_000);
		// Also change pools so we verify pools are NOT written if profiles validation fails
		const draftPools = {
			pools: [{ id: "sonnet", name: "Sonnet Valid Change", candidates: ["agy/sonnet", "agy/flash"], strategy: "hybrid" }],
		};
		writeFileSync(join(paths.labDir, LAB_POOLS), text(draftPools));

		const draftProfiles = JSON.parse(JSON.stringify(SAMPLE_PROFILES));
		draftProfiles.profiles.main["gentle-ai-worker"].model = "unknown-prov/unknown-model";
		writeFileSync(join(paths.labDir, LAB_PROFILES), text(draftProfiles));

		const poolsBefore = readFileSync(paths.poolsPath, "utf8");
		const profilesBefore = readFileSync(paths.profilesPath, "utf8");

		assert.throws(() => applyDraft({ paths, dataDir, hasModel }), /main\.gentle-ai-worker: unknown-prov\/unknown-model is not in Pi's model registry/);
		// Pools must not have been touched!
		assert.equal(readFileSync(paths.poolsPath, "utf8"), poolsBefore);
		assert.equal(readFileSync(paths.profilesPath, "utf8"), profilesBefore);
		assert.ok(!existsSync(join(paths.labDir, LAB_APPLIED)));
		assert.ok(!existsSync(join(dataDir, "audit.jsonl")));
	} finally {
		cleanup();
	}
});

// -----------------------------------------------------------------------------
// Rule 2: applyDraft success cases
// -----------------------------------------------------------------------------

test("applyDraft succeeds for pools-only change: writes only pools.json, creates applied.json and audit row, discards draft", () => {
	const { dir, dataDir, paths, cleanup } = setup();
	try {
		createDraft(paths, 1_000);
		const draftPools = {
			pools: [{ id: "sonnet", name: "Sonnet", candidates: ["agy/sonnet", "agy/flash"], strategy: "hybrid" }],
		};
		writeFileSync(join(paths.labDir, LAB_POOLS), text(draftPools));

		const profilesBefore = readFileSync(paths.profilesPath, "utf8");
		const now = 1792440000000;
		const result = applyDraft({ paths, dataDir, now, hasModel });

		// Exactly 1 file written (pools.json)
		assert.equal(result.files.length, 1);
		assert.equal(result.files[0].path, paths.poolsPath);
		assert.equal(readFileSync(paths.poolsPath, "utf8"), text(draftPools));
		assert.equal(statSync(paths.poolsPath).mode & 0o777, 0o600);
		assert.equal(statSync(result.files[0].backup).mode & 0o777, 0o600);
		assert.equal(readFileSync(result.files[0].backup, "utf8"), text(SAMPLE_POOLS));

		// profiles.json untouched, no backup
		assert.equal(readFileSync(paths.profilesPath, "utf8"), profilesBefore);
		const profileBackups = readdirSync(dir).filter(f => f.startsWith("profiles.json.bak-"));
		assert.equal(profileBackups.length, 0);

		// Draft discarded
		assert.ok(!existsSync(join(paths.labDir, LAB_BASE)));
		assert.ok(!existsSync(join(paths.labDir, LAB_POOLS)));

		// Journal applied.json exists with mode 0600
		const appliedPath = join(paths.labDir, LAB_APPLIED);
		assert.ok(existsSync(appliedPath));
		assert.equal(statSync(appliedPath).mode & 0o777, 0o600);
		const applied = JSON.parse(readFileSync(appliedPath, "utf8"));
		assert.deepEqual(applied, {
			ts: now,
			files: [{ path: paths.poolsPath, backup: result.files[0].backup, written: text(draftPools) }],
		});

		// Audit row in audit.jsonl with mode 0600
		const auditPath = join(dataDir, "audit.jsonl");
		assert.ok(existsSync(auditPath));
		assert.equal(statSync(auditPath).mode & 0o777, 0o600);
		const auditLines = readFileSync(auditPath, "utf8").trim().split("\n");
		assert.equal(auditLines.length, 1);
		assert.deepEqual(JSON.parse(auditLines[0]), {
			ts: now,
			action: "lab-apply",
			by: "pi",
			files: [{ path: paths.poolsPath, backup: result.files[0].backup }],
		});
	} finally {
		cleanup();
	}
});

test("applyDraft succeeds for profiles-only change: writes only profiles.json, creates applied.json and audit row, discards draft", () => {
	const { dir, dataDir, paths, cleanup } = setup();
	try {
		createDraft(paths, 1_000);
		const draftProfiles = JSON.parse(JSON.stringify(SAMPLE_PROFILES));
		draftProfiles.profiles.main["gentle-ai-worker"].model = "agy/flash";
		writeFileSync(join(paths.labDir, LAB_PROFILES), text(draftProfiles));

		const poolsBefore = readFileSync(paths.poolsPath, "utf8");
		const now = 1792440000000;
		const result = applyDraft({ paths, dataDir, now, hasModel });

		// Exactly 1 file written (profiles.json)
		assert.equal(result.files.length, 1);
		assert.equal(result.files[0].path, paths.profilesPath);
		assert.deepEqual(JSON.parse(readFileSync(paths.profilesPath, "utf8")), draftProfiles);
		assert.equal(statSync(paths.profilesPath).mode & 0o777, 0o600);
		assert.equal(statSync(result.files[0].backup).mode & 0o777, 0o600);
		assert.equal(readFileSync(result.files[0].backup, "utf8"), text(SAMPLE_PROFILES));

		// pools.json untouched, no backup
		assert.equal(readFileSync(paths.poolsPath, "utf8"), poolsBefore);
		const poolBackups = readdirSync(dir).filter(f => f.startsWith("pools.json.bak-"));
		assert.equal(poolBackups.length, 0);

		// Draft discarded
		assert.ok(!existsSync(join(paths.labDir, LAB_BASE)));

		// Journal applied.json exists
		const appliedPath = join(paths.labDir, LAB_APPLIED);
		assert.ok(existsSync(appliedPath));
	} finally {
		cleanup();
	}
});

test("applyDraft succeeds for both files: writes both with mode 0600 backups and journal", () => {
	const { dataDir, paths, cleanup } = setup();
	try {
		createDraft(paths, 1_000);
		const draftPools = {
			pools: [{ id: "sonnet", name: "Sonnet", candidates: ["agy/sonnet", "agy/flash"], strategy: "hybrid" }],
		};
		const draftProfiles = JSON.parse(JSON.stringify(SAMPLE_PROFILES));
		draftProfiles.profiles.main["gentle-ai-worker"].model = "agy/flash";
		writeFileSync(join(paths.labDir, LAB_POOLS), text(draftPools));
		writeFileSync(join(paths.labDir, LAB_PROFILES), text(draftProfiles));

		const now = 1792440000000;
		const result = applyDraft({ paths, dataDir, now, hasModel });

		assert.equal(result.files.length, 2);
		assert.equal(result.files[0].path, paths.profilesPath);
		assert.equal(result.files[1].path, paths.poolsPath);

		// Check both files written correctly
		assert.deepEqual(JSON.parse(readFileSync(paths.profilesPath, "utf8")), draftProfiles);
		assert.equal(readFileSync(paths.poolsPath, "utf8"), text(draftPools));

		// Check journal holds both
		const applied = JSON.parse(readFileSync(join(paths.labDir, LAB_APPLIED), "utf8"));
		assert.equal(applied.files.length, 2);

		// Audit holds both
		const auditLines = readFileSync(join(dataDir, "audit.jsonl"), "utf8").trim().split("\n");
		assert.equal(JSON.parse(auditLines[0]).files.length, 2);
	} finally {
		cleanup();
	}
});

test("applyDraft rollback: when pools.json write fails, profiles.json is restored from backup byte-identically", () => {
	const { dir, dataDir, paths, cleanup } = setup();
	try {
		createDraft(paths, 1_000);
		const draftPools = {
			pools: [{ id: "sonnet", name: "Sonnet", candidates: ["agy/sonnet", "agy/flash"], strategy: "hybrid" }],
		};
		const draftProfiles = JSON.parse(JSON.stringify(SAMPLE_PROFILES));
		draftProfiles.profiles.main["gentle-ai-worker"].model = "agy/flash";
		writeFileSync(join(paths.labDir, LAB_POOLS), text(draftPools));
		writeFileSync(join(paths.labDir, LAB_PROFILES), text(draftProfiles));

		const profilesBefore = readFileSync(paths.profilesPath, "utf8");
		const poolsBefore = readFileSync(paths.poolsPath, "utf8");

		// Make the pools directory read-only so backup creation fails during write 2
		// Or isolate pools.json in a separate subdir to make that dir read-only
		const poolsSubdir = join(dir, "pools-dir");
		mkdirSync(poolsSubdir);
		const poolsInSubdir = join(poolsSubdir, "pools.json");
		writeFileSync(poolsInSubdir, poolsBefore);
		const subPaths: LabPaths = { ...paths, poolsPath: poolsInSubdir };

		// Recreate draft with subPaths
		createDraft(subPaths, 1_000, { replace: true });
		writeFileSync(join(paths.labDir, LAB_POOLS), text(draftPools));
		writeFileSync(join(paths.labDir, LAB_PROFILES), text(draftProfiles));

		// Make poolsSubdir read-only
		chmodSync(poolsSubdir, 0o500);

		try {
			assert.throws(
				() => applyDraft({ paths: subPaths, dataDir, hasModel }),
				/restored profiles\.json from its backup/,
			);
		} finally {
			chmodSync(poolsSubdir, 0o700);
		}

		// Profiles file must be byte-identical to before!
		assert.equal(readFileSync(paths.profilesPath, "utf8"), profilesBefore);
		assert.equal(readFileSync(poolsInSubdir, "utf8"), poolsBefore);

		// No applied.json and no audit row
		assert.ok(!existsSync(join(paths.labDir, LAB_APPLIED)));
		assert.ok(!existsSync(join(dataDir, "audit.jsonl")));
	} finally {
		cleanup();
	}
});

// -----------------------------------------------------------------------------
// Rule 3: undoApply
// -----------------------------------------------------------------------------

test("undoApply refuses when there is no applied.json", () => {
	const { dataDir, paths, cleanup } = setup();
	try {
		assert.throws(() => undoApply({ labDir: paths.labDir, dataDir }), /nothing to undo/);
	} finally {
		cleanup();
	}
});

test("undoApply refuses when a live file changed after apply, leaving both files untouched", () => {
	const { dataDir, paths, cleanup } = setup();
	try {
		createDraft(paths, 1_000);
		const draftPools = {
			pools: [{ id: "sonnet", name: "Sonnet", candidates: ["agy/sonnet", "agy/flash"], strategy: "hybrid" }],
		};
		const draftProfiles = JSON.parse(JSON.stringify(SAMPLE_PROFILES));
		draftProfiles.profiles.main["gentle-ai-worker"].model = "agy/flash";
		writeFileSync(join(paths.labDir, LAB_POOLS), text(draftPools));
		writeFileSync(join(paths.labDir, LAB_PROFILES), text(draftProfiles));

		applyDraft({ paths, dataDir, hasModel });

		// Tamper with pools.json after apply
		writeFileSync(paths.poolsPath, "tampered-pools");

		const poolsAfterApply = readFileSync(paths.poolsPath, "utf8");
		const profilesAfterApply = readFileSync(paths.profilesPath, "utf8");

		assert.throws(
			() => undoApply({ labDir: paths.labDir, dataDir }),
			/refusing to undo: .*pools\.json changed since it was applied; nothing undone/,
		);

		// Both files remain untouched
		assert.equal(readFileSync(paths.poolsPath, "utf8"), poolsAfterApply);
		assert.equal(readFileSync(paths.profilesPath, "utf8"), profilesAfterApply);

		// applied.json still remains
		assert.ok(existsSync(join(paths.labDir, LAB_APPLIED)));
	} finally {
		cleanup();
	}
});

test("undoApply succeeds: restores exact previous bytes, audits lab-undo, and removes applied.json", () => {
	const { dataDir, paths, cleanup } = setup();
	try {
		const poolsOriginal = readFileSync(paths.poolsPath, "utf8");
		const profilesOriginal = readFileSync(paths.profilesPath, "utf8");

		createDraft(paths, 1_000);
		const draftPools = {
			pools: [{ id: "sonnet", name: "Sonnet", candidates: ["agy/sonnet", "agy/flash"], strategy: "hybrid" }],
		};
		const draftProfiles = JSON.parse(JSON.stringify(SAMPLE_PROFILES));
		draftProfiles.profiles.main["gentle-ai-worker"].model = "agy/flash";
		writeFileSync(join(paths.labDir, LAB_POOLS), text(draftPools));
		writeFileSync(join(paths.labDir, LAB_PROFILES), text(draftProfiles));

		const applyNow = 1792440000000;
		const applied = applyDraft({ paths, dataDir, now: applyNow, hasModel });

		assert.notEqual(readFileSync(paths.poolsPath, "utf8"), poolsOriginal);
		assert.notEqual(readFileSync(paths.profilesPath, "utf8"), profilesOriginal);

		const undoNow = 1792441000000;
		const undoResult = undoApply({ labDir: paths.labDir, dataDir, now: undoNow });

		// Exact bytes restored!
		assert.equal(readFileSync(paths.poolsPath, "utf8"), poolsOriginal);
		assert.equal(readFileSync(paths.profilesPath, "utf8"), profilesOriginal);

		// applied.json is removed
		assert.ok(!existsSync(join(paths.labDir, LAB_APPLIED)));
		assert.equal(hasUndo(paths.labDir), false);

		// Audit row appended for lab-undo
		const auditLines = readFileSync(join(dataDir, "audit.jsonl"), "utf8").trim().split("\n");
		assert.equal(auditLines.length, 2);
		const undoAudit = JSON.parse(auditLines[1]);
		// Each file names the apply backup it came back from and the new backup of the applied text.
		assert.deepEqual(
			undoResult.files.map(f => ({ path: f.path, restoredFrom: f.restoredFrom })),
			applied.files.map(f => ({ path: f.path, restoredFrom: f.backup })),
		);
		for (const [index, file] of undoResult.files.entries()) {
			assert.notEqual(file.backup, file.restoredFrom);
			assert.equal(readFileSync(file.backup, "utf8"), applied.files[index].written);
		}
		assert.deepEqual(undoAudit, {
			ts: undoNow,
			action: "lab-undo",
			by: "pi",
			files: undoResult.files.map(f => ({ path: f.path, restoredFrom: f.restoredFrom, backup: f.backup })),
		});

		// A second undo throws "nothing to undo"
		assert.throws(() => undoApply({ labDir: paths.labDir, dataDir }), /nothing to undo/);
	} finally {
		cleanup();
	}
});

// -----------------------------------------------------------------------------
// Rule 4: formatApplyConfirm
// -----------------------------------------------------------------------------

test("formatApplyConfirm formats the changes list and all 5 risk points", () => {
	const diff = {
		changes: ["pool sonnet: candidates + agy/flash", "profile main: gentle-ai-worker pool/sonnet → agy/flash"],
		issues: [],
		notes: [],
	};
	const text = formatApplyConfirm(diff);
	assert.ok(text.includes("Changes (2):"));
	assert.ok(text.includes("pool sonnet: candidates + agy/flash"));
	assert.ok(text.includes("profile main: gentle-ai-worker pool/sonnet → agy/flash"));
	// Check the 5 risks (a)-(e)
	assert.match(text, /silent quality loss/i);
	assert.match(text, /global effect/i);
	assert.match(text, /pools\.json takes effect from the next Pi start or \/reload/i);
	assert.match(text, /orchestrator entry only/i);
	assert.match(text, /backup of each file is kept and \/balancer lab undo restores it/i);
});

test("applyDraft applies a pools-only draft when profiles.json was unusable at draft time, never touching it", () => {
	const { dataDir, paths, cleanup } = setup();
	try {
		const unusable = text({ ...SAMPLE_PROFILES, version: 2 });
		writeFileSync(paths.profilesPath, unusable);
		createDraft(paths, 1_000);
		const draftPools = structuredClone(SAMPLE_POOLS);
		draftPools.pools[0].candidates.push("agy/flash");
		writeFileSync(join(paths.labDir, LAB_POOLS), text(draftPools));
		const result = applyDraft({ paths, dataDir, now: 2_000, hasModel });
		assert.deepEqual(result.files.map(file => file.path), [paths.poolsPath]);
		assert.equal(readFileSync(paths.poolsPath, "utf8"), text(draftPools));
		assert.equal(readFileSync(paths.profilesPath, "utf8"), unusable);
		assert.deepEqual(readdirSync(join(paths.profilesPath, "..")).filter(name => name.startsWith("profiles.json.bak-")), []);
	} finally {
		cleanup();
	}
});

test("applyDraft writes only files whose content changed, ignoring whitespace-only edits", () => {
	const { dataDir, paths, cleanup } = setup();
	try {
		createDraft(paths, 1_000);
		writeFileSync(join(paths.labDir, LAB_PROFILES), JSON.stringify(SAMPLE_PROFILES));
		const draftPools = structuredClone(SAMPLE_POOLS);
		draftPools.pools[1].candidates.reverse();
		writeFileSync(join(paths.labDir, LAB_POOLS), text(draftPools));
		const result = applyDraft({ paths, dataDir, now: 2_000, hasModel });
		assert.deepEqual(result.files.map(file => file.path), [paths.poolsPath]);
		assert.equal(readFileSync(paths.profilesPath, "utf8"), text(SAMPLE_PROFILES));
		assert.deepEqual(readdirSync(join(paths.profilesPath, "..")).filter(name => name.startsWith("profiles.json.bak-")), []);
	} finally {
		cleanup();
	}
});
