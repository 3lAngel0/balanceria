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

test("sidebar of Recomendada skips subscriptions, backups, tasks and main agent", () => {
	const screen = installerScreen(fresh());
	assert.deepEqual(ids(screen), ["welcome", "type", "scan", "summary", "installing", "done"]);
	assert.equal(screen.stepCount, 6);
	assert.deepEqual(screen.sidebar.map(i => i.status), ["current", "pending", "pending", "pending", "pending", "pending"]);
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
	const summary = act(scanned, next).state;
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
	const rows = () => (installerScreen(s).control as { items: { detail: string }[] }).items;
	assert.ok(rows().every(i => i.detail.includes("Now: not assigned · Recommended: ")));
	s = act(s, press("assign-recommended")).state;
	assert.ok(rows().every(i => !i.detail.includes("not assigned")));
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
	s = act(s, next).state;
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
	let s = act(withScanResult(act(fresh(), next, next).state, { found: both }), next, next).state;
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
	let s = act(withScanResult(act(fresh(), next, next).state, { found: both }), next, next).state;
	s = withInstallResult(s, { ok: false, written: [], backups: [], error: "disk full" });
	assert.equal(s.step, "installing");
	const screen = installerScreen(s);
	assert.ok(screen.body.join(" ").includes("disk full"));
	assert.equal(button(screen, "retry")!.enabled, true);
	assert.deepEqual(act(s, press("retry")).effects, ["install"]);
});

test("undo is disabled when the install made no backups", () => {
	let s = act(withScanResult(act(fresh(), next, next).state, { found: both }), next, next).state;
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

test("Empezar de cero rebuilds the recommended draft and ignores what was there", () => {
	let s = act(installed(), { type: "select", index: 2 }, next).state;
	assert.deepEqual(installerScreen(s).sidebar.map(i => i.id), ["welcome", "scan", "summary", "installing", "done"]);
	s = withScanResult(s, { found: both });
	assert.equal(s.draft.roles.orchestrator?.model !== "pool/gone", true);
	assert.equal(act(s, next).state.step, "summary");
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
