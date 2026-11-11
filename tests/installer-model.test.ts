import { test } from "node:test";
import assert from "node:assert/strict";
import type { DetectedProvider } from "../src/setup.ts";
import { ROLE_CATALOG } from "../src/setup-advisor.ts";
import { setLang } from "../src/i18n/index.ts";
import { installerMessages } from "../src/i18n/messages/installer.ts";
import { friendlyModel } from "../src/installer-plan.ts";
import {
	INSTALLER_STEPS,
	initInstaller,
	installerInput,
	installerScreen,
	withAdvisorReport,
	withInstallProgress,
	withInstallResult,
	withScanResult,
	withError,
	withAnalysisError,
	type InstallerAction,
	type InstallerEffect,
	type InstallerScreen,
	type InstallerState,
} from "../src/installer-model.ts";

setLang("en");

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
const both = [claude, agy];

const act = (state: InstallerState, ...actions: InstallerAction[]): { state: InstallerState; effects: InstallerEffect[] } => {
	const effects: InstallerEffect[] = [];
	for (const action of actions) {
		const r = installerInput(state, action);
		state = r.state;
		if (r.effect) effects.push(r.effect);
	}
	return { state, effects };
};
const next: InstallerAction = { type: "next" };
const press = (id: string): InstallerAction => ({ type: "button", id: id as never });
const ids = (s: InstallerScreen) => s.sidebar.map(i => i.id);
const button = (s: InstallerScreen, id: string) => s.buttons.find(b => b.id === id);
const fresh = () => initInstaller({ detected: both });
/** Custom install walked to the given step. */
const customAt = (step: string): InstallerState => {
	let s = act(fresh(), next, { type: "select", index: 1 }, next).state; // welcome -> type(custom) -> scan
	s = withScanResult(s, { found: both });
	while (s.step !== step) s = act(s, next).state;
	return s;
};
const members = (s: InstallerState) => installerScreen(s).diagram!.members;

test("INSTALLER_STEPS are the ten steps in order", () => {
	assert.deepEqual([...INSTALLER_STEPS], ["welcome", "type", "scan", "subscriptions", "backups", "tasks", "main-agent", "summary", "installing", "done"]);
});

test("initInstaller starts on welcome with Recomendada and a clean state", () => {
	const s = fresh();
	assert.equal(s.step, "welcome");
	assert.equal(s.installType, "recommended");
	assert.equal(s.existing, undefined);
	assert.equal(s.cancelled, false);
	assert.equal(s.finished, false);
	assert.deepEqual(s.backups, []);
});

test("welcome explains in plain words: time, nothing changes until the end", () => {
	const screen = installerScreen(fresh());
	assert.equal(screen.stepNumber, 1);
	const text = [...screen.body, JSON.stringify(screen.control)].join(" ");
	assert.match(text, /minutes/);
	assert.match(text, /Nothing changes until the end/);
	assert.equal(button(screen, "back")!.enabled, false);
	assert.equal(button(screen, "next")!.primary, true);
	assert.deepEqual(screen.buttons.slice(0, 3).map(b => b.id), ["back", "next", "cancel"]);
});

test("sidebar of Recomendada skips backups, tasks and main agent but visits the subscriptions", () => {
	const screen = installerScreen(fresh());
	assert.deepEqual(ids(screen), ["welcome", "type", "scan", "subscriptions", "summary", "installing", "done"]);
	assert.equal(screen.stepCount, 7);
	assert.deepEqual(screen.sidebar.map(i => i.status), ["current", "pending", "pending", "pending", "pending", "pending", "pending"]);
});

test("sidebar of Personalizada visits every step and marks done / current / pending", () => {
	const s = customAt("backups");
	const screen = installerScreen(s);
	assert.deepEqual(ids(screen), [...INSTALLER_STEPS]);
	assert.equal(screen.stepCount, 10);
	assert.equal(screen.stepNumber, 5);
	assert.deepEqual(screen.sidebar.map(i => i.status).slice(0, 6), ["done", "done", "done", "done", "current", "pending"]);
});

test("next, back and cancel navigate; back stops at welcome; cancel exits", () => {
	let s = act(fresh(), next).state;
	assert.equal(s.step, "type");
	assert.equal(act(s, { type: "back" }).state.step, "welcome");
	assert.equal(act(fresh(), { type: "back" }).state.step, "welcome");
	const c = act(s, { type: "cancel" });
	assert.equal(c.state.cancelled, true);
	assert.deepEqual(c.effects, ["exit"]);
	// buttons behave like the actions
	assert.equal(act(fresh(), press("next")).state.step, "type");
});

test("type step: Recomendada is preselected and the three types are explained", () => {
	const screen = installerScreen(act(fresh(), next).state);
	assert.equal(screen.control.kind, "choice");
	if (screen.control.kind !== "choice") return;
	assert.equal(screen.control.selected, 0);
	assert.equal(screen.control.items.length, 3);
	assert.equal(screen.control.items[0]!.recommended, true);
	assert.ok(screen.control.items.every(i => i.label && i.description));
});

test("Recomendada: next asks for a scan; the result builds the full draft and next jumps to the summary", () => {
	const r = act(fresh(), next, next);
	assert.deepEqual(r.effects, ["scan"]);
	assert.equal(r.state.step, "scan");
	assert.equal(act(r.state, next).state.step, "scan"); // cannot pass before the scan finished
	const scanned = withScanResult(r.state, { found: both });
	const screen = installerScreen(scanned);
	assert.equal(screen.control.kind, "progress");
	if (screen.control.kind === "progress") assert.deepEqual(screen.control.items.map(i => i.status), ["done", "done"]);
	assert.equal(act(scanned, next).state.step, "subscriptions");
	const summary = act(scanned, next, next).state;
	assert.equal(summary.step, "summary");
	assert.deepEqual(summary.draft.pools.map(p => p.id), ["claude-sonnet-5-5"]);
	for (const entry of ROLE_CATALOG) assert.ok(summary.draft.roles[entry.role]?.model);
});

test("scan without subscriptions shows an error with what to do; Reintentar scans again", () => {
	const scanning = act(fresh(), next, next).state;
	const failed = withScanResult(scanning, { found: [provider("x", [], false)] });
	const screen = installerScreen(failed);
	assert.equal(screen.control.kind, "message");
	if (screen.control.kind === "message") {
		assert.equal(screen.control.tone, "error");
		assert.match(screen.control.hint ?? "", /sign in/i);
	}
	assert.equal(button(screen, "next")!.enabled, false);
	assert.equal(button(screen, "retry")!.enabled, true);
	const again = act(failed, press("retry"));
	assert.deepEqual(again.effects, ["scan"]);
	assert.equal(installerScreen(again.state).control.kind, "progress");
	const withError = withScanResult(scanning, { error: "boom" });
	assert.equal(withError.scan.status, "error");
});

test("Avanzada asks the renderer to open the technical stepper", () => {
	const r = act(fresh(), next, { type: "select", index: 2 }, next);
	assert.equal(r.state.installType, "advanced");
	assert.deepEqual(r.effects, ["advanced"]);
	assert.deepEqual(ids(installerScreen(r.state)), ["welcome", "type"]);
});

test("subscriptions: checklist with models and the own-limit note; none left blocks next", () => {
	let s = customAt("subscriptions");
	const screen = installerScreen(s);
	assert.equal(screen.control.kind, "checklist");
	if (screen.control.kind !== "checklist") return;
	assert.equal(screen.control.items.length, 2);
	assert.ok(screen.control.items.every(i => i.checked && i.detail.includes("own usage limit")));
	assert.ok(screen.control.items[0]!.detail.includes("Claude Opus 5.5"));
	s = act(s, { type: "toggle", index: 0 }, { type: "toggle", index: 1 }).state;
	assert.equal(act(s, next).state.step, "subscriptions");
	assert.ok(installerScreen(act(s, next).state).body.length > 0);
	assert.equal(act(act(s, { type: "toggle", index: 0 }).state, next).state.step, "backups");
});

test("backups: suggestion for the shared model, diagram with order and states, single-subscription models need no backup", () => {
	const screen = installerScreen(customAt("backups"));
	assert.equal(screen.control.kind, "checklist");
	assert.deepEqual(
		screen.diagram!.members.map(m => [m.order, m.state]),
		[
			[1, "active"],
			[2, "standby"],
		],
	);
	assert.equal(screen.diagram!.backup, "Claude Sonnet 5.5");
	assert.ok(screen.diagram!.agent);
	assert.ok(screen.body.some(l => l.includes("Claude Opus 5.5") && l.includes("needs no backup")));
	assert.equal(button(screen, "create-backup")!.enabled, true);
});

test("backups: toggling a member changes the diagram", () => {
	const s = customAt("backups");
	const before = members(s).length;
	const after = act(s, { type: "toggle", index: 1 }).state;
	assert.equal(members(after).length, before - 1);
	assert.equal(members(act(after, { type: "toggle", index: 1 }).state).length, before);
});

test("backups: a single subscription has nothing to back up", () => {
	let s = act(initInstaller({ detected: [claude] }), next, { type: "select", index: 1 }, next).state;
	s = withScanResult(s, { found: [claude] });
	while (s.step !== "backups") s = act(s, next).state;
	const screen = installerScreen(s);
	assert.equal(screen.diagram, undefined);
	assert.ok(screen.body.some(l => l.includes("needs no backup")));
});

test("create-backup sub-wizard: template -> subscriptions (with cost warning) -> order -> how to choose", () => {
	const flashy = provider("antigravity", ["claude-sonnet-5-5", "gemini-3-8-flash"]);
	let s = act(initInstaller({ detected: [claude, flashy] }), next, { type: "select", index: 1 }, next).state;
	s = withScanResult(s, { found: [claude, flashy] });
	while (s.step !== "backups") s = act(s, next).state;
	const open = act(s, press("create-backup")).state;
	let screen = installerScreen(open);
	assert.equal(open.wizard?.phase, "template");
	assert.equal(screen.control.kind, "choice");
	assert.equal(screen.step, "backups");
	// choose the opus template -> members preselected
	if (screen.control.kind !== "choice") return;
	const index = screen.control.items.findIndex(i => i.id === "claude-opus-5-5");
	assert.ok(index >= 0);
	let w = act(open, { type: "select", index }, next).state;
	assert.equal(w.wizard?.phase, "members");
	screen = installerScreen(w);
	assert.equal(screen.control.kind, "checklist");
	// select every model: flash + claude together raises the existing cost warning
	if (screen.control.kind !== "checklist") return;
	const all = screen.control.items.map((_, i) => i);
	for (const i of all) if (!(installerScreen(w).control as { items: { checked: boolean }[] }).items[i]!.checked) w = act(w, { type: "toggle", index: i }).state;
	const warned = installerScreen(w).control as { items: { warning?: string }[] };
	assert.ok(warned.items.some(i => i.warning?.includes("Claude Opus 5.5")));
	w = act(w, next).state;
	assert.equal(w.wizard?.phase, "order");
	const firstBefore = members(w)[0]!.label;
	w = act(w, { type: "move", delta: 1 }).state; // reorders the item at the cursor
	assert.notEqual(members(w)[0]!.label, firstBefore);
	w = act(w, next).state;
	assert.equal(w.wizard?.phase, "strategy");
	screen = installerScreen(w);
	assert.equal(screen.control.kind, "choice");
	if (screen.control.kind === "choice") assert.ok(screen.control.items.every(i => i.description.length > 0));
	w = act(w, { type: "select", index: 1 }, next).state;
	assert.equal(w.wizard, undefined);
	const created = w.draft.pools.find(p => p.id === "claude-opus-5-5")!;
	assert.ok(created);
	assert.equal(created.strategy, "waterfall");
	assert.equal(created.candidates.length, all.length);
});

test("sub-wizard: back steps out phase by phase and cancel closes it without changes", () => {
	const s = customAt("backups");
	const poolsBefore = s.draft.pools.length;
	const open = act(s, press("create-backup"), { type: "select", index: 0 }, next).state;
	assert.equal(open.wizard?.phase, "members");
	assert.equal(act(open, { type: "back" }).state.wizard?.phase, "template");
	assert.equal(act(open, { type: "back" }, { type: "back" }).state.wizard, undefined);
	const closed = act(open, { type: "cancel" }).state;
	assert.equal(closed.wizard, undefined);
	assert.equal(closed.cancelled, false);
	assert.equal(closed.draft.pools.length, poolsBefore);
});

test("tasks: every task has a plain name, what it does, how much it uses and a recommendation", () => {
	const screen = installerScreen(customAt("tasks"));
	assert.equal(screen.control.kind, "checklist");
	if (screen.control.kind !== "checklist") return;
	assert.equal(screen.control.items.length, ROLE_CATALOG.length);
	assert.ok(screen.control.items.every(i => i.label && !i.label.includes("gentle-ai") && /Uses|uses/.test(i.detail) && /Recommended/.test(i.detail)));
	assert.equal(button(screen, "assign-recommended")!.enabled, true);
	assert.equal(button(screen, "deep-analysis")!.enabled, true);
	assert.match(button(screen, "deep-analysis")!.label, /uses quota|costs/i);
});

test("tasks: every row shows the current model and the recommendation in plain names", () => {
	let s = customAt("tasks");
	const rows = () => (installerScreen(s).control as { items: { detail: string; assigned?: string }[] }).items;
	assert.ok(rows().every(i => i.detail.includes("Now: not assigned · Recommended: ")));
	assert.ok(rows().every(i => i.assigned === "not assigned"));
	s = act(s, press("assign-recommended")).state;
	assert.ok(rows().every(i => !i.detail.includes("not assigned")));
	assert.ok(rows().every(i => i.assigned && i.assigned !== "not assigned"));
});

test("tasks: Space uses the recommendation even when the task already has another model", () => {
	let s = customAt("tasks");
	const rec = act(s, press("assign-recommended")).state.draft.roles.orchestrator!.model;
	s = { ...s, draft: { ...s.draft, roles: { ...s.draft.roles, orchestrator: { model: "claude-bridge/claude-opus-5-5" } } } };
	assert.notEqual(s.draft.roles.orchestrator!.model, rec);
	s = act(s, { type: "toggle", index: 0 }).state;
	assert.equal(s.draft.roles.orchestrator!.model, rec);
});

test("tasks: open shows a picker with the backups first, then the direct models; the recommended one is tagged", () => {
	const s = act(customAt("tasks"), { type: "open", index: 0 }).state;
	const screen = installerScreen(s);
	assert.equal(screen.control.kind, "choice");
	if (screen.control.kind !== "choice") return;
	const ids = screen.control.items.map(i => i.id);
	assert.deepEqual(ids, ["pool/claude-sonnet-5-5", "claude-bridge/claude-opus-5-5", "claude-bridge/claude-sonnet-5-5", "antigravity/claude-sonnet-5-5", "antigravity/gemini-3-8-flash"]);
	assert.equal(screen.control.items[0]!.label, "Backup Claude Sonnet 5.5");
	assert.match(screen.control.items[0]!.description, /never stops if one subscription runs out/i);
	assert.equal(screen.control.items[4]!.label, "Gemini 3.8 Flash · antigravity");
	const rec = act(customAt("tasks"), press("assign-recommended")).state.draft.roles.orchestrator!.model;
	assert.deepEqual(screen.control.items.filter(i => i.recommended).map(i => i.id), [rec]);
	assert.ok(screen.body.join(" ").includes("Coordinating the work"));
	assert.deepEqual(screen.buttons.map(b => b.id), ["back", "assign-task", "cancel"]);
});

test("tasks picker: Enter assigns the highlighted model; back and cancel close it without changes", () => {
	const open = act(customAt("tasks"), { type: "open", index: 1 }).state;
	const picked = act(open, { type: "select", index: 0 }, press("assign-task")).state;
	assert.equal(picked.taskPicker, undefined);
	assert.equal(picked.draft.roles["gentle-ai-explore"]!.model, "pool/claude-sonnet-5-5");
	assert.equal(installerScreen(picked).control.kind, "checklist");
	assert.equal(installerScreen(picked).cursor, 1);
	for (const close of [{ type: "back" }, { type: "cancel" }, press("back"), press("cancel")] as InstallerAction[]) {
		const r = act(open, { type: "select", index: 2 }, close);
		assert.equal(r.state.taskPicker, undefined);
		assert.equal(r.state.cancelled, false);
		assert.deepEqual(r.state.draft.roles, {});
		assert.equal(r.state.step, "tasks");
	}
	assert.equal(act(open, next).state.taskPicker !== undefined, true);
	assert.equal(act(customAt("tasks"), { type: "open", index: 99 }).state.taskPicker, undefined);
});

test("backups: the usage-limit note appears once in the body, not on every member line", () => {
	const screen = installerScreen(customAt("backups"));
	assert.equal(screen.body.filter(l => /usage limit/.test(l)).length, 1);
	if (screen.control.kind !== "checklist") return assert.fail("checklist");
	assert.ok(screen.control.items.length >= 2);
	assert.ok(screen.control.items.every(i => !/usage limit/.test(i.detail)));
	assert.deepEqual(screen.control.items.map(i => i.label), ["Claude Sonnet 5.5: claude-bridge", "Claude Sonnet 5.5: antigravity"]);
});

test("friendlyModel is exported by the model too", () => {
	assert.equal(friendlyModel("gemini-3-8-flash"), "Gemini 3.8 Flash");
});

test("S7: no screen text of any step shows a raw model id or provider/model ref (help excluded)", () => {
	const recommended = (): InstallerState[] => {
		let s = act(fresh(), next).state;
		const out = [fresh(), s];
		s = withScanResult(act(s, next).state, { found: both });
		out.push(s);
		s = act(s, next).state;
		out.push(s, act(s, press("install")).state);
		out.push(withInstallResult(act(s, press("install")).state, { ok: true, written: [], backups: ["/a/b.bak"] }));
		return out;
	};
	const custom: InstallerState[] = [];
	let walk = withScanResult(act(fresh(), next, { type: "select", index: 1 }, next).state, { found: both });
	while (walk.step !== "done") {
		custom.push(walk);
		if (walk.step === "tasks") {
			custom.push(act(walk, { type: "open", index: 0 }).state, act(walk, press("deep-analysis")).state, act(walk, press("assign-recommended")).state);
		}
		if (walk.step === "backups") {
			let w = act(walk, press("create-backup")).state;
			for (let i = 0; i < 4; i++) {
				custom.push(w);
				w = act(w, next).state;
			}
		}
		walk = act(walk, next).state;
		if (walk.step === "installing") break;
	}
	const repair = initInstaller({
		detected: both,
		current: { pools: { pools: [] }, profiles: { active: "p", profiles: { p: { orchestrator: { model: "pool/gone" }, "gentle-ai-worker": { model: "claude-bridge/old-model" } } } } },
		installed: true,
	});
	custom.push(act(repair, { type: "select", index: 1 }, next).state);
	for (const s of [...recommended(), ...custom]) {
		const { help: _h, sidebar: _s, ...rest } = installerScreen(s);
		const text = JSON.stringify(rest, (key, value) => (key === "id" ? undefined : value)); // ids are for the host, not shown
		assert.doesNotMatch(text, /(claude|gemini)-[a-z0-9-]*\d|(claude-bridge|antigravity)\/|pool\/|old-model/, `${s.step}: ${text.slice(0, 300)}`);
	}
});

test("tasks: assign-recommended fills the draft without any effect", () => {
	const s = customAt("tasks");
	assert.deepEqual(s.draft.roles, {});
	const r = act(s, press("assign-recommended"));
	assert.deepEqual(r.effects, []);
	for (const entry of ROLE_CATALOG) assert.ok(r.state.draft.roles[entry.role]?.model);
});

test("tasks: deep analysis lists the tasks, asks which model to use, then asks the host", () => {
	let s = act(customAt("tasks"), press("deep-analysis")).state;
	const screen = installerScreen(s);
	assert.equal(screen.control.kind, "choice");
	assert.ok(screen.body.join(" ").includes("Reading files"));
	assert.equal(button(screen, "deep-analysis")!.enabled, false);
	s = act(s, { type: "select", index: 0 }).state;
	const r = act(s, press("deep-analysis"));
	assert.equal(r.effects.length, 1);
	const effect = r.effects[0] as { type: string; model: string };
	assert.equal(effect.type, "deep-analysis");
	assert.match(effect.model, /\//);
	const report = {
		source: "heuristic" as const,
		estimatedTokens: 0,
		summary: "ok",
		recommendations: [{ role: "orchestrator", category: "orchestrate" as const, purpose: "", recommendedModel: "claude-bridge/claude-opus-5-5", thinking: "high" as const, reason: "" }],
	};
	const done = withAdvisorReport(r.state, report);
	assert.equal(done.draft.roles.orchestrator?.model, "claude-bridge/claude-opus-5-5");
	assert.equal(installerScreen(done).control.kind, "checklist");
});

test("main agent: works alone (organic) or hands everything out (full-delegation)", () => {
	let s = customAt("main-agent");
	const screen = installerScreen(s);
	assert.equal(screen.control.kind, "choice");
	if (screen.control.kind !== "choice") return;
	assert.equal(screen.control.selected, 0);
	assert.equal(screen.control.items[0]!.recommended, true);
	s = act(s, { type: "select", index: 1 }).state;
	assert.equal(s.draft.orchestratorMode, "full-delegation");
	assert.equal(act(s, { type: "select", index: 0 }).state.draft.orchestratorMode, "organic");
});

test("summary groups changes by file, mentions the .bak copy; install starts the progress", () => {
	let s = withScanResult(act(fresh(), next, next).state, { found: both });
	s = act(s, next, next).state;
	const screen = installerScreen(s);
	assert.equal(screen.control.kind, "summary");
	if (screen.control.kind !== "summary") return;
	assert.deepEqual(screen.control.groups.map(g => g.file), ["integrations.json", "pools.json", "profiles.json"]);
	assert.ok([...screen.body, ...screen.control.groups.flatMap(g => g.lines)].join("\n").includes(".bak"));
	assert.equal(button(screen, "install")!.primary, true);
	assert.equal(button(screen, "next"), undefined);
	const r = act(s, press("install"));
	assert.deepEqual(r.effects, ["install"]);
	assert.equal(r.state.step, "installing");
	const progress = installerScreen(r.state).control;
	assert.equal(progress.kind, "progress");
	if (progress.kind === "progress") assert.ok(progress.items.every(i => i.status === "pending"));
});

test("installing: progress updates, success stores the backups and shows Listo with panel / exit / undo", () => {
	let s = act(withScanResult(act(fresh(), next, next).state, { found: both }), next, next, next).state;
	assert.equal(s.step, "installing");
	s = withInstallProgress(s, "copies", "done");
	const c = installerScreen(s).control;
	if (c.kind === "progress") assert.equal(c.items[0]!.status, "done");
	assert.equal(button(installerScreen(s), "undo"), undefined);
	s = withInstallResult(s, { ok: true, written: ["/a/pools.json"], backups: ["/a/pools.json.bak"] });
	assert.equal(s.step, "done");
	assert.equal(s.finished, true);
	assert.deepEqual(s.backups, ["/a/pools.json.bak"]);
	const done = installerScreen(s);
	assert.deepEqual(done.buttons.map(b => b.id), ["open-panel", "exit", "undo"]);
	assert.equal(button(done, "undo")!.enabled, true);
	assert.deepEqual(act(s, press("open-panel")).effects, ["open-panel"]);
	assert.deepEqual(act(s, press("exit")).effects, ["exit"]);
	assert.deepEqual(act(s, press("undo")).effects, ["undo"]);
});

test("installing: a failed install keeps the screen with the error and offers retry", () => {
	let s = act(withScanResult(act(fresh(), next, next).state, { found: both }), next, next, next).state;
	s = withInstallResult(s, { ok: false, written: [], backups: [], error: "disk full" });
	assert.equal(s.step, "installing");
	const screen = installerScreen(s);
	assert.ok(screen.body.join(" ").includes("disk full"));
	assert.equal(button(screen, "retry")!.enabled, true);
	assert.deepEqual(act(s, press("retry")).effects, ["install"]);
});

test("undo is disabled when the install made no backups", () => {
	let s = act(withScanResult(act(fresh(), next, next).state, { found: both }), next, next, next).state;
	s = withInstallResult(s, { ok: true, written: [], backups: [] });
	assert.equal(button(installerScreen(s), "undo")!.enabled, false);
});

const existingCurrent = {
	pools: { pools: [{ id: "claude-sonnet-5-5", name: "Sonnet", candidates: ["claude-bridge/claude-sonnet-5-5", "antigravity/claude-sonnet-5-5"], strategy: "hybrid" }] },
	profiles: {
		active: "p",
		profiles: { p: { orchestrator: { model: "pool/gone" }, "gentle-ai-worker": { model: "pool/claude-sonnet-5-5" } } },
	},
};
const installed = () => initInstaller({ detected: both, current: existingCurrent, installed: true });

test("existing install: welcome offers Modificar / Reparar / Empezar de cero", () => {
	const s = installed();
	assert.deepEqual(s.existing, { mode: "modify" });
	const screen = installerScreen(s);
	assert.equal(screen.control.kind, "choice");
	if (screen.control.kind !== "choice") return;
	assert.equal(screen.control.items.length, 3);
	assert.deepEqual(screen.control.items.map(i => i.id), ["modify", "repair", "fresh"]);
	assert.equal(act(s, { type: "select", index: 2 }).state.existing?.mode, "fresh");
});

test("Modificar is Personalizada with the current config loaded", () => {
	let s = act(installed(), next).state;
	assert.equal(s.installType, "custom");
	assert.equal(s.step, "scan");
	s = withScanResult(s, { found: both });
	assert.deepEqual(s.draft.pools.map(p => p.id), ["claude-sonnet-5-5"]);
	assert.equal(s.draft.roles["gentle-ai-worker"]?.model, "pool/claude-sonnet-5-5");
	assert.deepEqual(ids(installerScreen(s)), ["welcome", "scan", "subscriptions", "backups", "tasks", "main-agent", "summary", "installing", "done"]);
});

test("Empezar de cero rebuilds the clean draft and walks through subscriptions, backups and tasks", () => {
	let s = act(installed(), { type: "select", index: 2 }, next).state;
	assert.deepEqual(installerScreen(s).sidebar.map(i => i.id), ["welcome", "scan", "subscriptions", "backups", "tasks", "main-agent", "summary", "installing", "done"]);
	s = withScanResult(s, { found: both });
	assert.equal(s.draft.roles.orchestrator?.model !== "pool/gone", true);
	assert.equal(act(s, next).state.step, "subscriptions");
});

test("Reparar lists tasks pointing at missing backups, applies the fixes and goes to the summary", () => {
	let s = act(installed(), { type: "select", index: 1 }, next).state;
	assert.equal(s.step, "tasks");
	const screen = installerScreen(s);
	assert.equal(screen.control.kind, "checklist");
	if (screen.control.kind !== "checklist") return;
	assert.equal(screen.control.items.length, 1);
	assert.ok(screen.control.items[0]!.checked);
	assert.deepEqual(ids(screen), ["welcome", "tasks", "summary", "installing", "done"]);
	s = act(s, next).state;
	assert.equal(s.step, "summary");
	assert.notEqual(s.draft.roles.orchestrator?.model, "pool/gone");
	// unchecking a repair leaves the task as it was
	let kept = act(installed(), { type: "select", index: 1 }, next, { type: "toggle", index: 0 }, next).state;
	assert.equal(kept.draft.roles.orchestrator?.model, "pool/gone");
});

test("Reparar with nothing broken says so", () => {
	const ok = initInstaller({ detected: both, current: { ...existingCurrent, profiles: { active: "p", profiles: { p: { orchestrator: { model: "pool/claude-sonnet-5-5" } } } } }, installed: true });
	const screen = installerScreen(act(ok, { type: "select", index: 1 }, next).state);
	assert.equal(screen.control.kind, "message");
});

test("help explains the screen with its technical name and file", () => {
	const screen = installerScreen(customAt("backups"));
	assert.equal(screen.help.technicalName, "pool");
	assert.equal(screen.help.file, "pools.json");
	assert.ok(screen.help.text.length > 0);
	assert.equal(screen.helpOpen, false);
	assert.equal(installerScreen(act(customAt("backups"), { type: "help" }).state).helpOpen, true);
});

test("move and select keep the cursor inside the list", () => {
	let s = customAt("subscriptions");
	s = act(s, { type: "move", delta: 5 }).state;
	assert.equal(installerScreen(s).cursor, 1);
	s = act(s, { type: "move", delta: -5 }).state;
	assert.equal(installerScreen(s).cursor, 0);
});

test("plain vocabulary: no technical names outside help, in any step", () => {
	const states: InstallerState[] = [fresh(), act(fresh(), next).state];
	for (const step of ["subscriptions", "backups", "tasks", "main-agent"]) states.push(customAt(step));
	states.push(act(customAt("backups"), press("create-backup")).state);
	states.push(act(customAt("tasks"), press("deep-analysis")).state);
	let sum = customAt("summary");
	states.push(sum, act(sum, press("install")).state);
	states.push(withInstallResult(act(sum, press("install")).state, { ok: true, written: [], backups: ["/a/b.bak"] }));
	for (const s of states) {
		const screen = installerScreen(s);
		const { help: _help, sidebar: _sidebar, ...rest } = screen;
		const text = JSON.stringify(rest).replace(/[\w-]+\.json(\.bak)?/g, "<file>"); // file names are shown as they are
		assert.doesNotMatch(text, /\b(pools?|providers?|roles?|strateg(y|ies)|orchestratorMode)\b/i, `${s.step}: ${text.slice(0, 200)}`);
		assert.doesNotMatch(text, /installer\./, `${s.step}: leaked i18n key`);
	}
});

test("every installer. key exists in en and es with the same placeholders", () => {
	const enKeys = Object.keys(installerMessages.en).sort();
	const esKeys = Object.keys(installerMessages.es).sort();
	assert.deepEqual(esKeys, enKeys);
	assert.ok(enKeys.length > 40);
	const placeholders = (text: string) => (text.match(/\{(\w+)\}/g) ?? []).sort();
	for (const key of enKeys) {
		assert.ok(key.startsWith("installer."), key);
		assert.deepEqual(placeholders((installerMessages.es as Record<string, string>)[key]!), placeholders((installerMessages.en as Record<string, string>)[key]!), key);
	}
});

test("the installer renders in Spanish with no English key left behind", () => {
	setLang("es");
	try {
		const screen = installerScreen(customAt("tasks"));
		assert.doesNotMatch(JSON.stringify(screen), /installer\./);
		assert.match(screen.title, /[áéíóúñ]|tareas/i);
	} finally {
		setLang("en");
	}
});

// ---------------------------------------------------------------------------------------------
// Round 2 (T5): close notice, subscriptions, backups actions, detailed help, welcome, errors, summary, deep analysis
// ---------------------------------------------------------------------------------------------

const inLang = <T>(lang: "en" | "es", run: () => T): T => {
	setLang(lang);
	try {
		return run();
	} finally {
		setLang("en");
	}
};
const shortcut = (s: InstallerScreen, key: string) => s.shortcuts.find(sc => sc.key === key);

test("S11: every screen before Install says that closing the setup applies nothing; installing and done do not", () => {
	for (const lang of ["en", "es"] as const) {
		inLang(lang, () => {
			const phrase = lang === "en" ? /close the setup, nothing is applied/i : /si cerr[aá]s el setup no se aplica nada/i;
			for (const step of ["subscriptions", "backups", "tasks", "main-agent", "summary"]) assert.match(installerScreen(customAt(step)).notice ?? "", phrase, `${lang} ${step}`);
			assert.match(installerScreen(fresh()).notice ?? "", phrase);
			assert.match(installerScreen(act(fresh(), next).state).notice ?? "", phrase);
			const installing = act(customAt("summary"), press("install")).state;
			assert.equal(installerScreen(installing).notice, undefined);
			const done = withInstallResult(installing, { ok: true, written: [], backups: [] });
			assert.equal(installerScreen(done).notice, undefined);
		});
	}
});

test("S12: Recommended visits the subscriptions step preselected and lets every subscription be toggled", () => {
	let s = withScanResult(act(fresh(), next, next).state, { found: both });
	s = act(s, next).state;
	assert.equal(s.step, "subscriptions");
	assert.deepEqual(ids(installerScreen(s)), ["welcome", "type", "scan", "subscriptions", "summary", "installing", "done"]);
	const control = installerScreen(s).control;
	assert.equal(control.kind, "checklist");
	if (control.kind !== "checklist") return;
	assert.deepEqual(control.items.map(i => i.checked), [true, true]);
	for (let index = 0; index < control.items.length; index++) {
		const off = act(s, { type: "toggle", index }).state;
		const c = installerScreen(off).control;
		if (c.kind === "checklist") assert.equal(c.items[index]!.checked, false, `item ${index}`);
		assert.equal(installerScreen(act(off, { type: "toggle", index }).state).control.kind, "checklist");
	}
	// Leaving with one subscription rebuilds the recommended setup for it alone.
	const solo = act(s, { type: "toggle", index: 1 }, next).state;
	assert.equal(solo.step, "summary");
	assert.deepEqual(solo.draft.enabled, ["claude-bridge"]);
	assert.equal(solo.draft.pools.length, 0);
	// Going back still lists both subscriptions.
	const back = act(solo, { type: "back" }).state;
	const list = installerScreen(back).control;
	assert.equal(list.kind === "checklist" && list.items.length, 2);
});

test("S13: backups can toggle, move up/down, change the way to choose and create a backup, all through actions", () => {
	const s = customAt("backups");
	const screen = installerScreen(s);
	assert.deepEqual(screen.shortcuts.map(sc => sc.key), [" ", "u", "j", "s", "c"]);
	assert.ok(screen.shortcuts.every(sc => sc.label.length > 0));
	const first = screen.control.kind === "checklist" ? screen.control.items[0]!.label : "";
	// move down: the first member goes second and the cursor follows it
	const moved = act(s, shortcut(screen, "j")!.action).state;
	assert.deepEqual(moved.draft.pools[0]!.candidates, ["antigravity/claude-sonnet-5-5", "claude-bridge/claude-sonnet-5-5"]);
	const after = installerScreen(moved);
	assert.equal(after.cursor, 1);
	assert.ok(after.control.kind === "checklist" && after.control.items[1]!.label === first);
	// and back up
	assert.deepEqual(act(moved, shortcut(after, "u")!.action).state.draft.pools[0]!.candidates, ["claude-bridge/claude-sonnet-5-5", "antigravity/claude-sonnet-5-5"]);
	// moving the first up is a no-op, never an error
	assert.deepEqual(act(s, shortcut(screen, "u")!.action).state.draft.pools[0]!.candidates, s.draft.pools[0]!.candidates);
	// the way to choose cycles through the three options, each explained
	assert.ok(screen.backupDetail && screen.backupDetail.methods.length === 3);
	assert.ok(screen.backupDetail!.methods.every(o => o.description.length > 20));
	assert.equal(screen.backupDetail!.method, "hybrid");
	const waterfall = act(s, shortcut(screen, "s")!.action).state;
	assert.equal(waterfall.draft.pools[0]!.strategy, "waterfall");
	assert.equal(installerScreen(waterfall).backupDetail!.method, "waterfall");
	assert.equal(act(waterfall, press("cycle-method"), press("cycle-method")).state.draft.pools[0]!.strategy, "hybrid");
	// toggle a member
	const toggled = act(s, shortcut(screen, " ")!.action).state;
	assert.deepEqual(toggled.draft.pools[0]!.candidates, ["antigravity/claude-sonnet-5-5"]);
	// create
	const wizard = act(s, shortcut(screen, "c")!.action).state;
	assert.equal(installerScreen(wizard).title, installerMessages.en["installer.wizard.template.title"]);
});

test("S14: the help is detailed per step and changes with the option under the cursor", () => {
	const type0 = installerScreen(act(fresh(), next).state);
	const f0 = type0.help.focus!;
	assert.ok(type0.help.text.length > 60 && type0.help.purpose.length > 20);
	for (const part of [f0.label, f0.what, f0.purpose, f0.ifPicked, f0.technicalName, f0.file]) assert.ok(part.length > 0);
	const type1 = installerScreen(act(fresh(), next, { type: "select", index: 1 }).state);
	assert.notEqual(type1.help.focus!.what, f0.what);
	assert.notEqual(type1.help.focus!.label, f0.label);
	const subs = (index: number) => installerScreen(act(customAt("subscriptions"), { type: "select", index }).state).help.focus!;
	assert.notEqual(subs(0).label, subs(1).label);
	const tasks = (index: number) => installerScreen(act(customAt("tasks"), { type: "select", index }).state).help.focus!;
	assert.notEqual(tasks(0).what, tasks(1).what);
	assert.equal(tasks(0).file, "profiles.json");
	assert.equal(installerScreen(customAt("backups")).help.focus!.file, "pools.json");
	assert.equal(installerScreen(customAt("summary")).help.focus, undefined);
	inLang("es", () => assert.doesNotMatch(JSON.stringify(installerScreen(act(fresh(), next).state).help), /installer\./));
});

test("S15: the welcome explains the product, defines the concepts and links the GitHub star", () => {
	for (const lang of ["en", "es"] as const) {
		inLang(lang, () => {
			const w = installerScreen(fresh()).welcome!;
			assert.equal(w.definitions.length, 5);
			assert.ok(w.definitions.every(d => d.term.length > 0 && d.text.length > 20));
			assert.ok(w.willDo.length >= 3);
			assert.equal(w.star.url, "https://github.com/3lAngel0/balanceria");
			assert.match(w.star.text, lang === "en" ? /star/i : /estrella/i);
			assert.equal(installerScreen(customAt("subscriptions")).welcome, undefined);
		});
	}
});

test("S16: a failed scan shows what happened, what to do, and retry / back", () => {
	let s = act(fresh(), next, next).state;
	s = withScanResult(s, { error: "boom" });
	const screen = installerScreen(s);
	assert.ok(screen.error && screen.error.what.includes("boom") && screen.error.todo.length > 0 && screen.error.title.length > 0);
	assert.equal(button(screen, "retry")!.enabled, true);
	assert.equal(button(screen, "back")!.enabled, true);
	const r = act(s, press("retry"));
	assert.deepEqual(r.effects, ["scan"]);
	assert.equal(installerScreen(r.state).error, undefined);
	assert.ok(installerScreen(withScanResult(act(fresh(), next, next).state, { found: [] })).error!.what.length > 0);
});

test("S16: a failed install after writing offers retry, back to the summary and undo", () => {
	const installing = act(customAt("summary"), press("install")).state;
	const failed = withInstallResult(installing, { ok: false, written: ["/a/pools.json"], backups: ["/a/pools.json.bak"], error: "disk full" });
	const screen = installerScreen(failed);
	assert.ok(screen.error?.what.includes("disk full"));
	assert.equal(button(screen, "retry")!.enabled, true);
	assert.equal(button(screen, "back")!.enabled, true);
	assert.equal(button(screen, "undo")!.enabled, true);
	assert.deepEqual(act(failed, press("undo")).effects, ["undo"]);
	assert.equal(act(failed, press("back")).state.step, "summary");
	assert.deepEqual(act(failed, press("retry")).effects, ["install"]);
	// nothing written: no undo
	const clean = withInstallResult(installing, { ok: false, written: [], backups: [], error: "nope" });
	assert.equal(button(installerScreen(clean), "undo"), undefined);
	assert.equal(installerScreen(clean).control.kind, "progress");
});

test("S16: withError shows a generic error with retry and back, and both clear it", () => {
	const s = withError(customAt("backups"), "could not reach the server");
	const screen = installerScreen(s);
	assert.ok(screen.error?.what.includes("could not reach the server"));
	assert.deepEqual(screen.buttons.map(b => b.id), ["retry", "back"]);
	assert.equal(installerScreen(act(s, press("retry")).state).error, undefined);
	const back = act(s, press("back")).state;
	assert.equal(installerScreen(back).error, undefined);
	assert.equal(back.step, "backups");
});

test("S18: the summary has the human narrative, the review line, the detail and the closing, in en and es", () => {
	const s = act(customAt("tasks"), press("assign-recommended"), next, next).state;
	assert.equal(s.step, "summary");
	const en = installerScreen(s).summary!;
	assert.match(en.narrative, /balance the load/i);
	assert.ok(en.narrative.includes("claude-bridge") && en.narrative.includes("antigravity"));
	assert.ok(en.narrative.includes("Claude Sonnet 5.5"));
	assert.match(en.narrative, /Mixed/);
	assert.equal(en.review, "So you can review it, here is a summary of the configuration you selected:");
	assert.equal(en.closing, "If you agree, press Enter to install, or cancel, or go back using the menus.");
	const detail = en.detail.join("\n");
	for (const part of ["claude-bridge, antigravity", "Claude Sonnet 5.5", "Reading files", "Works on its own", "pools.json", ".bak"]) assert.ok(detail.includes(part), part);
	assert.match(detail, /1\. .*2\. /);
	inLang("es", () => {
		const es = installerScreen(s).summary!;
		assert.match(es.narrative, /^Vas a balancear la carga entre estos proveedores/);
		assert.match(es.narrative, /estrategia/);
		assert.equal(es.review, "Para que puedas revisarlo te dejo un resumen de la configuración que seleccionaste:");
		assert.equal(es.closing, "Si estás de acuerdo apretá Enter o cancelalo, o volvé atrás con los menús.");
		assert.doesNotMatch(JSON.stringify(es), /installer\./);
	});
	assert.equal(installerScreen(customAt("tasks")).summary, undefined);
});

const deepOpen = () => act(customAt("tasks"), shortcut(installerScreen(customAt("tasks")), "d")!.action).state;
const deepRunning = () => act(act(deepOpen(), { type: "select", index: 0 }).state, press("deep-analysis"));

test("S22: deep analysis is reachable in the tasks step through the `d` shortcut", () => {
	const screen = installerScreen(customAt("tasks"));
	assert.equal(shortcut(screen, "d")!.enabled, true);
	assert.deepEqual(shortcut(screen, "d")!.action, { type: "button", id: "deep-analysis" });
	assert.equal(installerScreen(deepOpen()).control.kind, "choice");
});

test("S20: while a deep analysis runs the screen is pending and a second request is ignored", () => {
	const first = deepRunning();
	assert.equal((first.effects[0] as { type: string }).type, "deep-analysis");
	const screen = installerScreen(first.state);
	assert.equal(screen.pending?.kind, "deep-analysis");
	assert.equal(typeof screen.pending?.startedAt, "number");
	assert.ok(screen.pending!.label.length > 0);
	assert.equal(button(screen, "deep-analysis")!.enabled, false);
	const second = act(first.state, press("deep-analysis"), press("deep-analysis"));
	assert.deepEqual(second.effects, []);
	assert.deepEqual(installerScreen(second.state).pending, screen.pending);
});

test("S21: the finished analysis confirms duration, tokens and subscription; estimates are marked approximate", () => {
	const running = deepRunning().state;
	const report = { source: "ai+heuristic", estimatedTokens: 1234, tokensExact: true, summary: "ok", recommendations: [] } as never;
	const done = withAdvisorReport(running, report, { durationMs: 12_340 });
	const screen = installerScreen(done);
	assert.equal(screen.pending, undefined);
	assert.equal(screen.confirmation, "Consulted in 12.3 s, used 1234 tokens of subscription claude-bridge");
	assert.equal(screen.analysis?.durationMs, 12_340);
	assert.equal(screen.analysis?.tokens, 1234);
	assert.equal(screen.analysis?.exact, true);
	assert.equal(screen.analysis?.subscription, "claude-bridge");
	const approx = installerScreen(withAdvisorReport(running, { ...(report as object), tokensExact: false } as never, { durationMs: 2000 }));
	assert.equal(approx.confirmation, "Consulted in 2.0 s, used ~1234 tokens of subscription claude-bridge");
	inLang("es", () => assert.equal(installerScreen(done).confirmation, "Consultado: tardó 12.3 s, gastó 1234 tokens de la suscripción claude-bridge"));
});

test("S16/S21: a failed or timed out analysis shows an error with retry (same model) and back, and frees the button", () => {
	const running = deepRunning().state;
	const failed = withAnalysisError(running, "timed out after 180 s");
	const screen = installerScreen(failed);
	assert.equal(screen.pending, undefined);
	assert.ok(screen.error?.what.includes("timed out after 180 s"));
	const retry = act(failed, press("retry"));
	assert.equal((retry.effects[0] as { type: string; model: string }).model, (running.deepAnalysis as { model: string }).model);
	assert.equal(installerScreen(retry.state).pending?.kind, "deep-analysis");
	const back = act(failed, press("back")).state;
	assert.equal(installerScreen(back).error, undefined);
	assert.equal(back.step, "tasks");
});

// --- S24: a kept backup that cannot be written blocks Install ---

const legacyCurrent = {
	pools: { pools: [{ id: "legacy", name: "legacy", candidates: ["antigravity/gemini-3-8-flash"], strategy: "hybrid" }] },
	profiles: { active: "p", profiles: { p: { "legacy-role": { model: "pool/legacy" } } } },
};
const summaryWith = (enabled: string[]): InstallerState => {
	let s = withScanResult(act(initInstaller({ detected: both, current: legacyCurrent, installed: false }), next, next).state, { found: both });
	s = act(s, next, next).state;
	return { ...s, draft: { ...s.draft, enabled } };
};

test("summary: a backup tasks still use whose subscriptions are all off warns, names the tasks and disables Install", () => {
	const s = summaryWith(["claude-bridge"]);
	const screen = installerScreen(s);
	assert.equal(screen.step, "summary");
	assert.equal(button(screen, "install")!.enabled, false);
	assert.ok(screen.body.some(l => /Legacy/.test(l) && /legacy-role/.test(l) && /Turn one of its subscriptions back on/.test(l)), screen.body.join("\n"));
	assert.ok(screen.summary!.detail.some(l => /Legacy/.test(l) && /legacy-role/.test(l)));
	assert.match(screen.summary!.narrative, /Legacy/);
	const r = act(s, press("install"));
	assert.deepEqual(r.effects, []);
	assert.equal(r.state.step, "summary");
	const enter = act(s, next); // Enter on the summary is Install
	assert.deepEqual(enter.effects, []);
	assert.equal(enter.state.step, "summary");
	assert.ok(enter.state.notice?.some(l => /Legacy/.test(l)));
	assert.ok(installerScreen(enter.state).body.some(l => /Legacy/.test(l)));
	assert.equal(installerScreen(enter.state).body.filter(l => /Legacy/.test(l)).length, 1);
});

test("summary: re-enabling a subscription of that backup, or reassigning its tasks, enables Install again", () => {
	assert.equal(button(installerScreen(summaryWith(["claude-bridge", "antigravity"])), "install")!.enabled, true);
	const s = summaryWith(["claude-bridge"]);
	const moved = { ...s, draft: { ...s.draft, roles: { ...s.draft.roles, "legacy-role": { model: "claude-bridge/claude-opus-5-5" } } } };
	assert.equal(button(installerScreen(moved), "install")!.enabled, true);
	assert.deepEqual(act(moved, press("install")).effects, ["install"]);
});
