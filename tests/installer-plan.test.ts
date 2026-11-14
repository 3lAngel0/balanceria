import { test } from "node:test";
import assert from "node:assert/strict";
import type { DetectedProvider } from "../src/setup.ts";
import { ROLE_CATALOG } from "../src/setup-advisor.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRecommendedDraft, findRepairs, friendlyModel, installBlockers, nodeInstallFs, planUndo, settleInstallSnapshot, snapshotForInstall, suggestBackups, summaryByFile, summaryStory, targetLabel, undoInstall, withKeptBackups, type InstallFs } from "../src/installer-plan.ts";
import { setLang } from "../src/i18n/index.ts";
import { initStepper, setRole } from "../src/setup-stepper.ts";

const provider = (id: string, availableModels: string[], detected = true): DetectedProvider => ({
	id,
	label: id,
	kind: "subscription",
	detected,
	source: "test",
	availableModels,
});
const claude = provider("claude-bridge", ["claude-opus-5-5", "claude-sonnet-5-5"]);
const agy = provider("antigravity", ["claude-sonnet-5-5", "gemini-3-8-flash"]);

test("suggestBackups: one backup per model offered by 2+ subscriptions, the rest listed as single", () => {
	const { backups, single } = suggestBackups([claude, agy]);
	assert.equal(backups.length, 1);
	assert.equal(backups[0]!.id, "claude-sonnet-5-5");
	assert.deepEqual(backups[0]!.candidates, ["claude-bridge/claude-sonnet-5-5", "antigravity/claude-sonnet-5-5"]);
	assert.deepEqual(
		single.map(s => s.ref).sort(),
		["antigravity/gemini-3-8-flash", "claude-bridge/claude-opus-5-5"],
	);
});

test("suggestBackups: undetected subscriptions do not count, a single subscription yields no backups", () => {
	assert.deepEqual(suggestBackups([claude, provider("antigravity", ["claude-sonnet-5-5"], false)]).backups, []);
	assert.equal(suggestBackups([claude]).single.length, 2);
	assert.deepEqual(suggestBackups([]), { backups: [], single: [] });
});

test("buildRecommendedDraft: suggested backups plus every task assigned, nothing written yet", () => {
	const draft = buildRecommendedDraft({ detected: [claude, agy, provider("off", ["x"], false)] });
	assert.deepEqual(draft.enabled, ["claude-bridge", "antigravity"]);
	assert.deepEqual(draft.pools.map(p => p.id), ["claude-sonnet-5-5"]);
	for (const entry of ROLE_CATALOG) assert.ok(draft.roles[entry.role]?.model, `role ${entry.role} assigned`);
	assert.equal(draft.orchestratorMode, "organic");
});

test("buildRecommendedDraft keeps the current orchestrator mode", () => {
	assert.equal(buildRecommendedDraft({ detected: [claude], workflow: "full-delegation" }).orchestratorMode, "full-delegation");
});

test("findRepairs: tasks pointing to missing backups or models, with a proposed fix", () => {
	const current = {
		profiles: {
			active: "p",
			profiles: {
				p: {
					orchestrator: { model: "pool/gone" },
					"gentle-ai-worker": { model: "claude-bridge/old-model" },
					"gentle-ai-explore": { model: "pool/ok" },
					"gentle-ai-verify": { model: "(unassigned)" },
				},
			},
		},
	};
	const repairs = findRepairs(current, ["pool/ok", "claude-bridge/new"], { orchestrator: "pool/ok", "gentle-ai-worker": "claude-bridge/new" });
	assert.deepEqual(repairs, [
		{ role: "orchestrator", model: "pool/gone", reason: "missing-pool", fix: "pool/ok" },
		{ role: "gentle-ai-worker", model: "claude-bridge/old-model", reason: "missing-model", fix: "claude-bridge/new" },
	]);
});

test("findRepairs: nothing to repair when everything exists or there are no profiles", () => {
	assert.deepEqual(findRepairs({}, []), []);
	assert.deepEqual(findRepairs({ profiles: { active: "p", profiles: { p: { orchestrator: { model: "pool/ok" } } } } }, ["pool/ok"]), []);
});

test("summaryByFile groups plain-language lines per file and says which files change", () => {
	const draft = buildRecommendedDraft({ detected: [claude, agy] });
	const groups = summaryByFile(draft, {});
	assert.deepEqual(groups.map(g => g.file), ["integrations.json", "pools.json", "profiles.json"]);
	assert.ok(groups.every(g => g.changed));
	const pools = groups.find(g => g.file === "pools.json")!;
	assert.ok(pools.lines.some(l => l.includes("Claude Sonnet 5.5") && l.includes("claude-bridge") && !l.includes("claude-sonnet-5-5")));
	assert.ok(groups.find(g => g.file === "profiles.json")!.lines.length >= ROLE_CATALOG.length);
	assert.ok(groups.every(g => !/^installer\./.test(g.lines.join("\n"))));
});

test("summaryByFile marks an untouched profiles.json as unchanged", () => {
	const draft = initStepper([claude], [], {});
	const profiles = summaryByFile(draft, {}).find(g => g.file === "profiles.json")!;
	assert.equal(profiles.changed, false);
});

test("planUndo maps each .bak to the file it restores and ignores anything else", () => {
	assert.deepEqual(planUndo(["/a/pools.json.bak", "/a/integrations.json.bak", "/a/notes.txt"]), [
		{ file: "/a/pools.json", backup: "/a/pools.json.bak" },
		{ file: "/a/integrations.json", backup: "/a/integrations.json.bak" },
	]);
	assert.deepEqual(planUndo([]), []);
});

setLang("en");

test("friendlyModel: capitalizes words and joins adjacent numbers with a dot", () => {
	assert.equal(friendlyModel("claude-sonnet-5-5"), "Claude Sonnet 5.5");
	assert.equal(friendlyModel("claude-opus-5-5"), "Claude Opus 5.5");
	assert.equal(friendlyModel("gemini-3-8-flash"), "Gemini 3.8 Flash");
	assert.equal(friendlyModel("gemini-4-argon"), "Gemini 4 Argon");
	assert.equal(friendlyModel("old-model"), "Old Model");
});

test("targetLabel: backups and direct models in plain words, never ids", () => {
	const providers = [{ id: "antigravity", label: "Google AI Pro" }];
	assert.equal(targetLabel("pool/claude-sonnet-5-5"), "Backup Claude Sonnet 5.5");
	assert.equal(targetLabel("antigravity/gemini-3-8-flash", providers), "Gemini 3.8 Flash · Google AI Pro");
	assert.equal(targetLabel("antigravity/gemini-3-8-flash"), "Gemini 3.8 Flash · antigravity");
	setLang("es");
	try {
		assert.equal(targetLabel("pool/claude-sonnet-5-5"), "Respaldo Claude Sonnet 5.5");
	} finally {
		setLang("en");
	}
});

// --- S24: a backup a saved profile still uses is never dropped ---

const savedProfiles = {
	active: "balanceador_default",
	profiles: { balanceador_default: { orchestrator: { model: "pool/orchestrator" } }, other: { "gentle-ai-worker": { model: "pool/legacy" } } },
};
const savedPools = {
	pools: [
		{ id: "orchestrator", name: "orchestrator", candidates: ["claude-bridge/claude-sonnet-5-5"], strategy: "hybrid", rules: [] },
		{ id: "legacy", name: "legacy", candidates: ["antigravity/gemini-3-8-flash"], strategy: "hybrid" },
		{ id: "unused", name: "unused", candidates: ["antigravity/gemini-3-8-flash"], strategy: "hybrid" },
	],
};

test("withKeptBackups: a pool used by any role of any saved profile stays, with the tasks that use it", () => {
	const draft = initStepper([claude, agy], suggestBackups([claude, agy]).backups, savedProfiles.profiles.balanceador_default);
	const { draft: kept, kept: list } = withKeptBackups(draft, { pools: savedPools, profiles: savedProfiles });
	assert.deepEqual(kept.pools.map(p => p.id), ["claude-sonnet-5-5", "orchestrator", "legacy"]);
	assert.deepEqual(list.map(k => [k.id, k.roles]), [["orchestrator", ["orchestrator"]], ["legacy", ["gentle-ai-worker"]]]);
	assert.equal(kept.pools[1]!.strategy, "hybrid");
});

test("withKeptBackups: reassigning every role that uses the pool lets it go; a pool the draft already has is not duplicated", () => {
	const draft = initStepper([claude, agy], [{ id: "orchestrator", candidates: ["claude-bridge/claude-sonnet-5-5"] }], { orchestrator: { model: "pool/orchestrator" } });
	assert.equal(withKeptBackups(draft, { pools: savedPools, profiles: savedProfiles }).draft.pools.filter(p => p.id === "orchestrator").length, 1);
	const moved = setRole(initStepper([claude, agy], [], {}), "orchestrator", "claude-bridge/claude-opus-5-5");
	const result = withKeptBackups(moved, { pools: savedPools, profiles: { active: "balanceador_default", profiles: { balanceador_default: { orchestrator: { model: "pool/orchestrator" } } } } });
	assert.deepEqual(result.kept, []);
	assert.deepEqual(result.draft.pools, []);
});

test("summaryStory and summaryByFile say a kept backup stays because a task uses it", () => {
	const draft = initStepper([claude, agy], [], savedProfiles.profiles.balanceador_default);
	const current = { pools: savedPools, profiles: savedProfiles };
	const story = summaryStory(draft, current);
	assert.match(story.narrative, /Backup Main agent \(orchestrator\) is kept.*Main agent \(orchestrator\)/);
	assert.ok(story.detail.includes("Backup Legacy stays because these tasks use it: Writing code."));
	const pools = summaryByFile(draft, current).find(g => g.file === "pools.json")!;
	assert.ok(pools.lines.some(l => /stays because/.test(l)));
	assert.ok(!story.narrative.includes("installer."));
});

// --- S25: one copy per install, never overwritten, undo exact ---

const memFs = (files: Record<string, string>): InstallFs & { files: Record<string, string> } => ({
	files,
	exists: p => p in files,
	copy: (a, b) => void (files[b] = files[a]!),
	remove: p => void delete files[p],
});

test("planUndo maps .bak-installer-* names (with or without a suffix) back to their file", () => {
	assert.deepEqual(planUndo(["/a/pools.json.bak-installer-20260101120000", "/a/profiles.json.bak-installer-20260101120000-2", "/a/x.bak-installer-bad"]), [
		{ file: "/a/pools.json", backup: "/a/pools.json.bak-installer-20260101120000" },
		{ file: "/a/profiles.json", backup: "/a/profiles.json.bak-installer-20260101120000-2" },
	]);
});

test("snapshotForInstall: copies existing files with a timestamp and never overwrites a copy", () => {
	const fs = memFs({ "/r/pools.json": "v1", "/r/integrations.json": "i1" });
	const now = new Date(2026, 0, 2, 3, 4, 5);
	const first = snapshotForInstall(["/r/pools.json", "/r/integrations.json", "/r/profiles.json"], fs, now);
	assert.deepEqual(first.backups, ["/r/pools.json.bak-installer-20260102030405", "/r/integrations.json.bak-installer-20260102030405"]);
	assert.deepEqual(first.created, ["/r/profiles.json"]);
	fs.files["/r/pools.json"] = "v2";
	const second = snapshotForInstall(["/r/pools.json"], fs, now);
	assert.deepEqual(second.backups, ["/r/pools.json.bak-installer-20260102030405-2"]);
	assert.equal(fs.files[first.backups[0]!], "v1");
	assert.equal(fs.files[second.backups[0]!], "v2");
});

test("undoInstall restores the state before that install and removes files the install created", () => {
	const fs = memFs({ "/r/pools.json": "v1" });
	const now = new Date(2026, 0, 2, 3, 4, 5);
	const one = snapshotForInstall(["/r/pools.json", "/r/profiles.json"], fs, now);
	fs.files["/r/pools.json"] = "v2";
	fs.files["/r/profiles.json"] = "p1";
	const two = snapshotForInstall(["/r/pools.json", "/r/profiles.json"], fs, now);
	assert.deepEqual(two.created, []);
	fs.files["/r/pools.json"] = "v3";
	undoInstall(two, fs);
	assert.deepEqual([fs.files["/r/pools.json"], fs.files["/r/profiles.json"]], ["v2", "p1"]);
	undoInstall(one, fs);
	assert.equal(fs.files["/r/pools.json"], "v1");
	assert.equal("/r/profiles.json" in fs.files, false);
	assert.ok(Object.keys(fs.files).some(f => f.includes(".bak-installer-")), "old copies are never deleted");
});

test("snapshotForInstall and undoInstall work on a real temp dir", () => {
	const dir = mkdtempSync(join(tmpdir(), "installer-snap-"));
	try {
		writeFileSync(join(dir, "pools.json"), "before");
		const snap = snapshotForInstall([join(dir, "pools.json"), join(dir, "new.json")], nodeInstallFs, new Date(2026, 5, 1, 0, 0, 0));
		writeFileSync(join(dir, "pools.json"), "after");
		writeFileSync(join(dir, "new.json"), "created");
		undoInstall(snap, nodeInstallFs);
		assert.equal(readFileSync(join(dir, "pools.json"), "utf8"), "before");
		assert.equal(existsSync(join(dir, "new.json")), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("withKeptBackups reports a used backup whose subscriptions are all off as blocked; installBlockers explains it", () => {
	const draft = initStepper([claude, agy], [], {});
	const off = { ...draft, enabled: ["claude-bridge"] };
	const current = { pools: savedPools, profiles: { active: "balanceador_default", profiles: { balanceador_default: { orchestrator: { model: "pool/legacy" } } } } };
	const result = withKeptBackups(off, current);
	assert.deepEqual(result.blocked.map(b => [b.id, b.roles]), [["legacy", ["orchestrator"]]]);
	assert.deepEqual(result.kept, []);
	assert.equal(installBlockers(off, current).length, 1);
	assert.match(installBlockers(off, current)[0]!, /Legacy.*Main agent \(orchestrator\)/);
	assert.deepEqual(installBlockers({ ...off, enabled: ["claude-bridge", "antigravity"] }, current), []);
});

test("bakLine describes the real copy name pattern in en and es", () => {
	const line = summaryByFile(initStepper([claude, agy], suggestBackups([claude, agy]).backups, {}), {}).find(g => g.file === "pools.json")!.lines.at(-1)!;
	assert.equal(line, "A copy of pools.json is saved first as pools.json.bak-installer-<date and time>.");
	setLang("es");
	try {
		const es = summaryByFile(initStepper([claude, agy], suggestBackups([claude, agy]).backups, {}), {}).find(g => g.file === "pools.json")!.lines.at(-1)!;
		assert.equal(es, "Antes se guarda una copia de pools.json como pools.json.bak-installer-<fecha y hora>.");
	} finally {
		setLang("en");
	}
});

// -- T3 (S1): last-resort model through the writers -----------------------------------------------

import { applyStepper, setLastResort, buildStepperDiff, type StepperCurrent } from "../src/setup-stepper.ts";
import { writeConfigSafely } from "../src/setup.ts";

const FLASH_REF = "antigravity/gemini-3-8-flash";
const withTempRoot = (current: StepperCurrent | undefined, run: (root: string) => void) => {
	const root = mkdtempSync(join(tmpdir(), "last-resort-"));
	try {
		if (current?.pools) writeFileSync(join(root, "pools.json"), JSON.stringify(current.pools));
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
};
const install = (root: string, draft: ReturnType<typeof buildRecommendedDraft>, current: StepperCurrent) =>
	applyStepper(draft, { root, current, profilesPath: join(root, "profiles.json"), writeConfig: writeConfigSafely, writeProfiles: () => {} });
const writtenPools = (root: string) => JSON.parse(readFileSync(join(root, "pools.json"), "utf8"));

test("S1: Install writes lastResort at the top level of pools.json", () => {
	withTempRoot(undefined, root => {
		const draft = setLastResort(buildRecommendedDraft({ detected: [claude, agy] }), FLASH_REF);
		assert.equal(install(root, draft, {}).ok, true);
		const doc = writtenPools(root);
		assert.equal(doc.lastResort, FLASH_REF);
		assert.ok(Array.isArray(doc.pools));
	});
});

test("S1: choosing None removes an existing lastResort from pools.json", () => {
	const current: StepperCurrent = { pools: { lastResort: FLASH_REF, pools: [{ id: "claude-sonnet-5-5", candidates: ["claude-bridge/claude-sonnet-5-5", "antigravity/claude-sonnet-5-5"] }] } };
	withTempRoot(current, root => {
		const draft = setLastResort(buildRecommendedDraft({ detected: [claude, agy] }), undefined);
		assert.equal(install(root, draft, current).ok, true);
		assert.equal("lastResort" in writtenPools(root), false);
	});
});

test("S1: a lastResort in the draft is dropped when its subscription is disabled, and a changed lastResort counts as a pools.json change", () => {
	const draft = setLastResort(buildRecommendedDraft({ detected: [claude, agy] }), FLASH_REF);
	const off = { ...draft, enabled: ["claude-bridge"] };
	withTempRoot(undefined, root => {
		install(root, off, {});
		assert.equal("lastResort" in writtenPools(root), false);
	});
	const current: StepperCurrent = { pools: { pools: [{ id: "claude-sonnet-5-5", candidates: ["claude-bridge/claude-sonnet-5-5", "antigravity/claude-sonnet-5-5"], strategy: "hybrid" }] } };
	const same = buildRecommendedDraft({ detected: [claude, agy] });
	assert.equal(buildStepperDiff(same, current).writes.pools, false);
	const diff = buildStepperDiff(setLastResort(same, FLASH_REF), current);
	assert.equal(diff.writes.pools, true);
	assert.match(diff.lines.join("\n"), /last-resort model: none → antigravity\/gemini-3-8-flash/);
});

const INTEGRATIONS = [{ provider: "claude-bridge", kind: "subscription", label: "Claude Pro (claude-bridge)" }];

test("S1: writers that do not manage lastResort preserve it (bare pool list, panel edits)", () => {
	const current: StepperCurrent = { pools: { lastResort: FLASH_REF, pools: [{ id: "p", candidates: ["claude-bridge/claude-sonnet-5-5"] }] } };
	withTempRoot(current, root => {
		writeConfigSafely(root, { integrations: INTEGRATIONS, pools: [{ id: "p", candidates: ["claude-bridge/claude-opus-5-5"] }] });
		const doc = writtenPools(root);
		assert.equal(doc.lastResort, FLASH_REF);
		assert.deepEqual(doc.pools[0].candidates, ["claude-bridge/claude-opus-5-5"]);
		writeConfigSafely(root, { integrations: INTEGRATIONS, pools: doc.pools, lastResort: null });
		assert.equal("lastResort" in writtenPools(root), false);
	});
});

test("the orchestrator backup and role are named Main agent (orchestrator); the technical id is untouched", async () => {
	const { backupName, roleName } = await import("../src/installer-plan.ts");
	assert.equal(backupName({ id: "orchestrator" }), "Main agent (orchestrator)");
	assert.equal(roleName("orchestrator"), "Main agent (orchestrator)");
	assert.equal(targetLabel("pool/orchestrator", []), "Backup Main agent (orchestrator)");
});

// -- T9 (S7): automatic loans through the writers ---------------------------------------------------

import { mkdirSync } from "node:fs";
import { INSTALLER_GRANT_PREFIX, addGrant, loadPermissions } from "../src/permissions.ts";
import { installerSnapshotFiles } from "../src/installer-plan.ts";
import { setLoan } from "../src/setup-stepper.ts";

const OPENAI_REF = "antigravity/gemini-3-8-flash";
const NOW = Date.parse("2026-11-11T12:00:00Z");
const POOL_ID = "claude-sonnet-5-5";
const loanDraft = (to: string | null = OPENAI_REF) => {
	let draft = buildRecommendedDraft({ detected: [claude, agy] });
	draft = setRole(draft, "orchestrator", `pool/${POOL_ID}`);
	draft = setRole(draft, "gentle-ai-verify", `pool/${POOL_ID}`);
	return setLoan(draft, POOL_ID, to ?? undefined);
};
const loanCurrent = (extra: Partial<StepperCurrent> = {}): StepperCurrent => ({ profiles: { active: "bal", profiles: { bal: {} } }, grants: [], ...extra });
const withLoanRoot = (run: (root: string, dataDir: string) => void) => {
	const root = mkdtempSync(join(tmpdir(), "loans-"));
	const dataDir = join(root, "data");
	try {
		run(root, dataDir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
};
const installLoans = (root: string, dataDir: string, draft: ReturnType<typeof loanDraft>, current: StepperCurrent) =>
	applyStepper(draft, { root, dataDir, now: NOW, current, profilesPath: join(root, "profiles.json"), writeConfig: writeConfigSafely, writeProfiles: () => {} });

test("S7: Install writes an auto grant from the backup to the chosen model for every task that uses the backup", () => {
	withLoanRoot((root, dataDir) => {
		const result = installLoans(root, dataDir, loanDraft(), loanCurrent());
		assert.equal(result.ok, true);
		assert.equal(result.grantsError, undefined);
		assert.ok(result.written.includes(join(dataDir, "permissions.json")));
		const { grants } = loadPermissions(dataDir);
		assert.equal(grants.length, 1);
		const grant = grants[0]!;
		assert.ok(grant.id.startsWith(`${INSTALLER_GRANT_PREFIX}-`));
		assert.equal(grant.level, "auto");
		assert.deepEqual(grant.profiles, ["bal"]);
		const users = Object.entries(loanDraft().roles).filter(([, route]) => route.model === `pool/${POOL_ID}`).map(([role]) => role).sort();
		assert.ok(users.includes("orchestrator") && users.includes("gentle-ai-verify"));
		assert.deepEqual([...grant.roles].sort(), users);
		assert.deepEqual(grant.models, [`pool/${POOL_ID}`, OPENAI_REF]);
		assert.ok(grant.expiresAt > NOW);
	});
});

test("S7: grants the installer does not manage are preserved; installing again with the same loan changes nothing, None revokes only its own", () => {
	withLoanRoot((root, dataDir) => {
		const mine = addGrant(dataDir, { level: "suggest", profiles: ["x"], roles: ["r"], models: ["pool/a", "p/m"], expiresAt: NOW + 1e9 }, NOW);
		const current = loanCurrent({ grants: loadPermissions(dataDir).grants });
		installLoans(root, dataDir, loanDraft(), current);
		const after = readFileSync(join(dataDir, "permissions.json"), "utf8");
		assert.equal(loadPermissions(dataDir).grants.length, 2);
		const again = installLoans(root, dataDir, loanDraft(), loanCurrent({ grants: loadPermissions(dataDir).grants }));
		assert.equal(readFileSync(join(dataDir, "permissions.json"), "utf8"), after, "same loan: file untouched");
		assert.equal(again.written.includes(join(dataDir, "permissions.json")), false);
		const gone = installLoans(root, dataDir, loanDraft(null), loanCurrent({ grants: loadPermissions(dataDir).grants }));
		assert.equal(gone.grantsError, undefined);
		const left = loadPermissions(dataDir).grants;
		assert.deepEqual(left.map(g => g.id), [mine.id]);
	});
});

test("S7: a host that did not read the grants never revokes; a loan for a backup no task uses writes nothing", () => {
	withLoanRoot((root, dataDir) => {
		installLoans(root, dataDir, loanDraft(), loanCurrent());
		const before = readFileSync(join(dataDir, "permissions.json"), "utf8");
		const { grants: _unread, ...unread } = loanCurrent();
		installLoans(root, dataDir, loanDraft(null), unread);
		assert.equal(readFileSync(join(dataDir, "permissions.json"), "utf8"), before);
	});
	withLoanRoot((root, dataDir) => {
		const unused = setLoan(buildRecommendedDraft({ detected: [claude, agy], roles: {} }), POOL_ID, OPENAI_REF);
		const bare = { ...unused, roles: {} };
		installLoans(root, dataDir, bare, loanCurrent());
		assert.equal(existsSync(join(dataDir, "permissions.json")), false);
	});
});

test("S7: an unusable permissions.json is reported as grantsError and the rest of the install still happens", () => {
	withLoanRoot((root, dataDir) => {
		mkdirSync(dataDir, { recursive: true });
		writeFileSync(join(dataDir, "permissions.json"), "not json");
		const result = installLoans(root, dataDir, loanDraft(), loanCurrent());
		assert.equal(result.ok, true);
		assert.match(result.grantsError ?? "", /permissions\.json/);
		assert.equal(readFileSync(join(dataDir, "permissions.json"), "utf8"), "not json");
		assert.ok(existsSync(join(root, "pools.json")));
	});
});

test("S7: the install snapshot covers permissions.json like pools.json, and Undo restores or removes it", () => {
	withLoanRoot((root, dataDir) => {
		assert.deepEqual(installerSnapshotFiles(root, dataDir, join(root, "profiles.json")).map(f => f.slice(root.length + 1)), ["pools.json", "integrations.json", "profiles.json", join("data", "permissions.json")]);
		const files = installerSnapshotFiles(root, dataDir, join(root, "profiles.json"));
		const snapshot = snapshotForInstall(files, nodeInstallFs, new Date(2026, 10, 11, 12, 0, 0));
		installLoans(root, dataDir, loanDraft(), loanCurrent());
		assert.ok(existsSync(join(dataDir, "permissions.json")));
		assert.ok(snapshot.created.includes(join(dataDir, "permissions.json")));
		undoInstall(snapshot, nodeInstallFs);
		assert.equal(existsSync(join(dataDir, "permissions.json")), false);
	});
});

test("settleInstallSnapshot: a failed install that wrote nothing discards its copies and records no backups", () => {
	const fs = memFs({ "/r/pools.json": "v1", "/r/integrations.json": "i1" });
	const snapshot = snapshotForInstall(["/r/pools.json", "/r/integrations.json", "/r/profiles.json"], fs, new Date(2026, 0, 2, 3, 4, 5));
	assert.equal(Object.keys(fs.files).length, 4);
	const settled = settleInstallSnapshot(snapshot, { ok: false, written: [] }, fs);
	assert.equal(settled.keep, false);
	assert.deepEqual(settled.backups, []);
	assert.deepEqual(fs.files, { "/r/pools.json": "v1", "/r/integrations.json": "i1" });
});

test("settleInstallSnapshot: a failed install that wrote something keeps its copies so Undo can restore", () => {
	const fs = memFs({ "/r/pools.json": "v1" });
	const snapshot = snapshotForInstall(["/r/pools.json"], fs, new Date(2026, 0, 2, 3, 4, 5));
	const settled = settleInstallSnapshot(snapshot, { ok: false, written: ["/r/pools.json"] }, fs);
	assert.equal(settled.keep, true);
	assert.deepEqual(settled.backups, snapshot.backups);
	assert.equal(snapshot.backups.length, 1);
	assert.ok(snapshot.backups[0]! in fs.files);
});

test("settleInstallSnapshot: a successful install keeps its snapshot", () => {
	const fs = memFs({ "/r/pools.json": "v1" });
	const snapshot = snapshotForInstall(["/r/pools.json"], fs);
	const settled = settleInstallSnapshot(snapshot, { ok: true, written: [] }, fs);
	assert.equal(settled.keep, true);
	assert.deepEqual(settled.backups, snapshot.backups);
	assert.ok(snapshot.backups[0]! in fs.files);
});

test("suggestBackups: canonicalizes -acp and -cli variants across providers, prefers -acp, and excludes claude-fable", () => {
	const claudeWithFable = provider("claude-bridge", ["claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5"]);
	const agyFork = provider("antigravity", ["claude-fable-5-2-cli", "claude-sonnet-5-5-cli", "gemini-4-argon-cli", "gemini-4-argon-acp"]);
	const { backups } = suggestBackups([claudeWithFable, agyFork]);
	assert.deepEqual(backups.map(b => b.id), ["claude-sonnet-5-5"]);
	assert.deepEqual(backups[0]!.candidates, ["claude-bridge/claude-sonnet-5-5", "antigravity/claude-sonnet-5-5-cli"]);
});
