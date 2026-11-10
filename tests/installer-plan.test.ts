import { test } from "node:test";
import assert from "node:assert/strict";
import type { DetectedProvider } from "../src/setup.ts";
import { ROLE_CATALOG } from "../src/setup-advisor.ts";
import { buildRecommendedDraft, findRepairs, planUndo, suggestBackups, summaryByFile } from "../src/installer-plan.ts";
import { initStepper } from "../src/setup-stepper.ts";

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
	assert.ok(pools.lines.some(l => l.includes("claude-sonnet-5-5") && l.includes("claude-bridge")));
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
