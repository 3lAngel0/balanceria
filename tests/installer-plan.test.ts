import { test } from "node:test";
import assert from "node:assert/strict";
import type { DetectedProvider } from "../src/setup.ts";
import { ROLE_CATALOG } from "../src/setup-advisor.ts";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRecommendedDraft, findRepairs, friendlyModel, installBlockers, nodeInstallFs, planUndo, snapshotForInstall, suggestBackups, summaryByFile, summaryStory, targetLabel, undoInstall, withKeptBackups, type InstallFs } from "../src/installer-plan.ts";
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
	assert.match(story.narrative, /Backup Main agent is kept.*Coordinating the work/);
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
	assert.match(installBlockers(off, current)[0]!, /Legacy.*Coordinating the work/);
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
