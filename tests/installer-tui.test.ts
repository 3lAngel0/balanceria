import { test } from "node:test";
import assert from "node:assert/strict";
import type { DetectedProvider } from "../src/setup.ts";
import { setLang } from "../src/i18n/index.ts";
import { installerMessages } from "../src/i18n/messages/installer.ts";
import { cellWidth } from "../src/tui-box.ts";
import type { ColorMode } from "../src/pixel.ts";
import {
	initInstaller,
	installerInput,
	installerScreen,
	withError,
	withInstallResult,
	withScanResult,
	INSTALLER_STEPS,
	type InstallerAction,
	type InstallerScreen,
	type InstallerState,
} from "../src/installer-model.ts";
import { canonicalKey, hitInstaller, installerKey, renderDiagram, renderInstaller } from "../src/installer-tui.ts";

setLang("en");

const provider = (id: string, availableModels: string[]): DetectedProvider => ({ id, label: id, kind: "subscription", detected: true, source: "test", availableModels });
const both = [provider("claude-bridge", ["claude-opus-5-5", "claude-sonnet-5-5"]), provider("antigravity", ["claude-sonnet-5-5", "gemini-3-8-flash"])];
const MODES: ColorMode[] = ["truecolor", "ansi", "none"];
const WIDTHS = [60, 80, 90, 120, 140];
const strip = (s: string) => s.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\uE000[\uE010-\uE01F]|\uE001/g, "");
/** Width in cells; an OSC 8 hyperlink wrapper takes none. */
const vw = (line: string) => cellWidth(line.replace(/\x1b\]8;;[^\x1b]*\x1b\\/g, ""));
const text = (lines: string[]) => lines.map(strip).join("\n");

const step = (state: InstallerState, ...actions: InstallerAction[]) => actions.reduce((s, a) => installerInput(s, a).state, state);
const next: InstallerAction = { type: "next" };

/** Every screen of a full Recommended run. */
function recommendedRun(): InstallerState[] {
	const states: InstallerState[] = [];
	let s = initInstaller({ detected: both });
	states.push(s); // welcome
	s = step(s, next);
	states.push(s); // type
	s = step(s, next);
	states.push(s); // scan (scanning)
	s = withScanResult(s, { found: both });
	states.push(s); // scan (done)
	s = step(s, next);
	states.push(s); // subscriptions
	s = step(s, next);
	states.push(s); // summary
	s = step(s, next);
	states.push(s); // installing
	s = withInstallResult(s, { ok: true, written: ["pools.json"], backups: ["/x/pools.json.bak"] });
	states.push(s); // done
	return states;
}

/** Every step of a Custom run, with the backup sub-wizard too. */
function customRun(): InstallerState[] {
	const states: InstallerState[] = [];
	let s = step(initInstaller({ detected: both }), next, { type: "select", index: 1 }, next);
	s = withScanResult(s, { found: both });
	while (s.step !== "summary") {
		states.push(s);
		s = step(s, next);
	}
	states.push(step(states[states.length - 2]!, { type: "button", id: "create-backup" }));
	states.push(s);
	return states;
}

test("every line has exactly the requested width at 60/80/120 columns in all color modes", () => {
	for (const state of [...recommendedRun(), ...customRun()]) {
		const screen = installerScreen(state);
		for (const mode of MODES) {
			for (const width of WIDTHS) {
				const view = renderInstaller(screen, { width, mode });
				assert.ok(view.lines.length > 0);
				for (const line of view.lines) assert.equal(vw(line), width, `${screen.step} ${mode} ${width}: ${JSON.stringify(strip(line))}`);
			}
		}
	}
});

test("no color mode emits no escape sequences or tone marks", () => {
	for (const state of customRun()) {
		const out = renderInstaller(installerScreen(state), { width: 80, mode: "none" }).lines.join("\n");
		assert.equal(out, strip(out));
	}
	const colored = renderInstaller(installerScreen(customRun()[0]!), { width: 80, mode: "truecolor" }).lines.join("\n");
	assert.match(colored, /\x1b\[38;2;/);
});

test("every step of both runs renders its title, control and buttons", () => {
	for (const state of [...recommendedRun(), ...customRun()]) {
		const screen = installerScreen(state);
		const out = text(renderInstaller(screen, { width: 100, mode: "none" }).lines);
		assert.ok(out.includes(screen.title.slice(0, 40)), `${screen.step} title`);
		for (const b of screen.buttons) assert.ok(out.includes(b.label), `${screen.step} button ${b.id}`);
		if (screen.control.kind === "choice") for (const i of screen.control.items) assert.ok(out.includes(i.label), `${screen.step} ${i.id}`);
		if (screen.control.kind === "checklist") for (const i of screen.control.items) assert.ok(out.includes(i.label.slice(0, 20)), `${screen.step} ${i.id}`);
		if (screen.control.kind === "progress") for (const i of screen.control.items) assert.ok(out.includes(i.label), `${screen.step} ${i.label}`);
		if (screen.control.kind === "summary") for (const g of screen.control.groups) assert.ok(out.includes(g.file), `${screen.step} ${g.file}`);
		assert.ok(out.includes(screen.body[0]!.slice(0, 30)), `${screen.step} body`);
	}
});

test("the type step marks the selected radio and does not repeat the Recommended tag on the Recommended option", () => {
	const out = text(renderInstaller(installerScreen(recommendedRun()[1]!), { width: 90, mode: "none" }).lines);
	assert.match(out, /\(●\) Recommended\s*$/m);
	assert.doesNotMatch(out, /\[Recommended\]/);
	assert.match(out, /\( \) Custom/);
});

test("a recommended choice whose label differs keeps its Recommended tag", () => {
	const screen = installerScreen(recommendedRun()[1]!);
	const control = screen.control as Extract<InstallerScreen["control"], { kind: "choice" }>;
	const tagged = { ...screen, control: { ...control, items: control.items.map((item, i) => (i === 1 ? { ...item, recommended: true } : item)) } } as InstallerScreen;
	assert.match(text(renderInstaller(tagged, { width: 90, mode: "none" }).lines), /Custom\s+\[Recommended\]/);
});

test("the sidebar shows done, current and pending; below 70 columns it collapses to Step N of M", () => {
	const screen = installerScreen(recommendedRun()[2]!);
	const wide = text(renderInstaller(screen, { width: 100, mode: "none" }).lines);
	assert.match(wide, /✓ Welcome/);
	assert.match(wide, /● Finding subscriptions/);
	assert.match(wide, /○ Summary/);
	const narrow = text(renderInstaller(screen, { width: 60, mode: "none" }).lines);
	assert.match(narrow, /Step 3 of 7/);
	assert.doesNotMatch(narrow, /○ Summary/);
	assert.doesNotMatch(wide, /Step 3 of 7/);
});

test("checklists show details and warnings; progress shows a check per item", () => {
	const subs = customRun().find(s => s.step === "subscriptions")!;
	const out = text(renderInstaller(installerScreen(subs), { width: 100, mode: "none" }).lines);
	assert.match(out, /\[x\] claude-bridge/);
	assert.match(out, /own usage/);
	const scan = text(renderInstaller(installerScreen(recommendedRun()[3]!), { width: 100, mode: "none" }).lines);
	assert.match(scan, /✓ claude-bridge/);
	const warn = { ...installerScreen(subs), control: { kind: "checklist" as const, items: [{ id: "a", label: "A", detail: "d", checked: true, warning: "Costs a lot" }] } };
	assert.match(text(renderInstaller(warn, { width: 80, mode: "none" }).lines), /⚠ Costs a lot/);
});

test("the summary groups lines by file and the error message is shown", () => {
	const out = text(renderInstaller(installerScreen(recommendedRun()[5]!), { width: 100, mode: "none" }).lines);
	for (const file of ["integrations.json", "pools.json", "profiles.json"]) assert.ok(out.includes(file));
	const failed = withScanResult(step(initInstaller({ detected: both }), next, next), { error: "boom" });
	assert.match(text(renderInstaller(installerScreen(failed), { width: 80, mode: "none" }).lines), /boom/);
});

test("the diagram draws the agent, the backup and the members in order, and fits the width", () => {
	const diagram = { agent: "Your agent", backup: "Claude Sonnet", members: [{ label: "Google AI Pro", order: 1, state: "active" as const }, { label: "Claude Pro", order: 2, state: "standby" as const }] };
	const lines = renderDiagram(diagram, 80);
	assert.equal(lines.length, 2);
	assert.match(lines[0]!, /^Your agent ──▶ \[ Claude Sonnet \] ┬─▶ 1\. Google AI Pro\s+✓ in use$/);
	assert.match(lines[1]!, /└─▶ 2\. Claude Pro\s+if 1 runs out$/);
	assert.equal(lines[0]!.indexOf("┬"), lines[1]!.indexOf("└"));
	for (const width of [30, 40, 60, 120]) for (const l of renderDiagram(diagram, width)) assert.ok(cellWidth(l) <= width, `${width}: ${l}`);
	// order is reflected
	const swapped = renderDiagram({ ...diagram, members: [diagram.members[1]!, diagram.members[0]!].map((m, i) => ({ ...m, order: i + 1, state: i === 0 ? ("active" as const) : ("standby" as const) })) }, 80);
	assert.match(swapped[0]!, /1\. Claude Pro/);
	assert.match(swapped[1]!, /2\. Google AI Pro/);
	assert.equal(renderDiagram({ ...diagram, members: [] }, 80).length, 1);
	assert.equal(renderDiagram({ ...diagram, members: [diagram.members[0]!] }, 80)[0]!.includes("──▶ 1."), true);
});

test("the backups screen embeds the diagram", () => {
	const backups = customRun().find(s => s.step === "backups")!;
	const out = text(renderInstaller(installerScreen(backups), { width: 120, mode: "none" }).lines);
	assert.match(out, /Your agent ──▶ \[ /);
	assert.match(out, /✓ in use/);
});

test("the help panel is shown without pressing ? and ? hides it; it shows text, technical name and file", () => {
	const screen = installerScreen(recommendedRun()[1]!);
	const shown = text(renderInstaller(screen, { width: 100, mode: "none" }).lines);
	assert.match(shown, /Technical name/);
	// the technical name and file are those of the option under the cursor when there is one
	const about = screen.help.focus ?? screen.help;
	assert.ok(shown.includes(about.technicalName));
	assert.ok(shown.includes(about.file));
	assert.ok(shown.includes(screen.help.purpose.slice(0, 20)));
	const hidden = text(renderInstaller({ ...screen, helpOpen: true }, { width: 100, mode: "none" }).lines);
	assert.doesNotMatch(hidden, /Technical name/);
	for (const l of renderInstaller(screen, { width: 60, mode: "ansi" }).lines) assert.equal(cellWidth(l), 60);
});

test("buttons wrap in narrow widths and the focused one is marked", () => {
	const tasks = customRun().find(s => s.step === "tasks")!;
	const screen = installerScreen(tasks);
	const view = renderInstaller(screen, { width: 60, mode: "none", focus: 1 });
	const out = text(view.lines);
	assert.match(out, /▸\[\*Next ▶\*\]/);
	for (const b of screen.buttons) assert.ok(out.includes(b.label));
	assert.match(text(renderInstaller(screen, { width: 100, mode: "none" }).lines), /\[ ◀ Back \]/);
});

test("rows limit keeps the cursor row visible", () => {
	const tasks = step(customRun().find(s => s.step === "tasks")!, { type: "move", delta: 6 });
	const screen = installerScreen(tasks);
	const view = renderInstaller(screen, { width: 100, mode: "none", rows: 18 });
	assert.ok(view.lines.length <= 18, String(view.lines.length));
	assert.ok(text(view.lines).includes(screen.control.kind === "checklist" ? screen.control.items[screen.cursor]!.label : ""));
});

const K = { up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", tab: "\t", back: "\x1b[Z" };

test("keys map to the model actions", () => {
	const checklist = installerScreen(customRun().find(s => s.step === "subscriptions")!);
	const key = (data: string, screen: InstallerScreen = checklist, focus?: number) => installerKey(screen, focus, data);
	assert.deepEqual(key(K.down).actions, [{ type: "move", delta: 1 }]);
	assert.deepEqual(key("j").actions, [{ type: "move", delta: 1 }]);
	assert.deepEqual(key(K.up).actions, [{ type: "move", delta: -1 }]);
	assert.deepEqual(key("k").actions, [{ type: "move", delta: -1 }]);
	assert.deepEqual(key(" ").actions, [{ type: "toggle", index: checklist.cursor }]);
	assert.deepEqual(key("\r").actions, [{ type: "button", id: "next" }]);
	assert.deepEqual(key(K.left).actions, [{ type: "back" }]);
	assert.deepEqual(key("\x7f").actions, [{ type: "back" }]);
	assert.deepEqual(key(K.right).actions, [{ type: "next" }]);
	assert.deepEqual(key("?").actions, [{ type: "help" }]);
	assert.deepEqual(key("\x1b").actions, [{ type: "cancel" }]);
	assert.deepEqual(key("z").actions, []);
	// Enter on a choice selects the focused card first
	const choice = installerScreen(recommendedRun()[1]!);
	assert.deepEqual(key("\r", choice).actions, [{ type: "select", index: choice.cursor }, { type: "button", id: "next" }]);
	assert.deepEqual(key(" ", choice).actions, [{ type: "select", index: choice.cursor }]);
});

test("Tab and Shift+Tab move the button focus; Enter activates the focused button", () => {
	const screen = installerScreen(recommendedRun()[1]!);
	const enabled = screen.buttons.map((b, i) => (b.enabled ? i : -1)).filter(i => i >= 0);
	let r = installerKey(screen, undefined, K.tab);
	assert.equal(r.focus, enabled[0]);
	assert.deepEqual(r.actions, []);
	r = installerKey(screen, enabled[0], K.tab);
	assert.equal(r.focus, enabled[1]);
	r = installerKey(screen, enabled[0], K.back);
	assert.equal(r.focus, enabled[enabled.length - 1]);
	r = installerKey(screen, enabled[enabled.length - 1], K.tab);
	assert.equal(r.focus, enabled[0]);
	const cancel = screen.buttons.findIndex(b => b.id === "cancel");
	assert.deepEqual(installerKey(screen, cancel, "\r").actions, [{ type: "button", id: "cancel" }]);
	// moving in the list drops the button focus
	assert.equal(installerKey(screen, cancel, K.down).focus, undefined);
});

test("keys on a full run reach Done", () => {
	let s = initInstaller({ detected: both });
	const press = (data: string) => {
		const screen = installerScreen(s);
		let focus: number | undefined;
		for (const action of installerKey(screen, focus, data).actions) s = installerInput(s, action).state;
	};
	press("\r"); // welcome -> type
	press("\r"); // type -> scan
	s = withScanResult(s, { found: both });
	press("\r"); // -> subscriptions
	assert.equal(s.step, "subscriptions");
	press("\r"); // -> summary
	assert.equal(s.step, "summary");
	press("\r"); // install
	assert.equal(s.step, "installing");
});

test("mouse clicks on rows and buttons map to the same actions", () => {
	const check = (state: InstallerState) => {
		const screen = installerScreen(state);
		const view = renderInstaller(screen, { width: 100, mode: "none" });
		return { screen, view };
	};
	const { screen, view } = check(recommendedRun()[1]!);
	const lineOf = (needle: string) => view.lines.findIndex(l => strip(l).includes(needle));
	const custom = lineOf("( ) Custom");
	assert.ok(custom >= 0);
	assert.deepEqual(hitInstaller(view.hits, strip(view.lines[custom]!).indexOf("Custom"), custom), { type: "select", index: 1 });
	const row = strip(view.lines.find(l => strip(l).includes("[ ◀ Back ]") || strip(l).includes("[ Next ▶ ]")) ?? "");
	const y = view.lines.findIndex(l => strip(l).includes("Next ▶"));
	assert.deepEqual(hitInstaller(view.hits, row.indexOf("Next ▶"), y), { type: "button", id: "next" });
	assert.deepEqual(hitInstaller(view.hits, row.indexOf("Cancel"), y), { type: "button", id: "cancel" });
	assert.equal(hitInstaller(view.hits, 0, 0), undefined);
	assert.ok(screen.buttons.length > 0);
	// checklist rows toggle
	const subs = customRun().find(s => s.step === "subscriptions")!;
	const v2 = renderInstaller(installerScreen(subs), { width: 100, mode: "none" });
	const y2 = v2.lines.findIndex(l => strip(l).includes("[x] claude-bridge"));
	assert.deepEqual(hitInstaller(v2.hits, strip(v2.lines[y2]!).indexOf("claude-bridge"), y2), { type: "toggle", index: 0 });
	// disabled buttons are not clickable
	const welcome = renderInstaller(installerScreen(recommendedRun()[0]!), { width: 100, mode: "none" });
	const wy = welcome.lines.findIndex(l => strip(l).includes("Next ▶"));
	assert.equal(hitInstaller(welcome.hits, strip(welcome.lines[wy]!).indexOf("Back"), wy), undefined);
});

test("hits stay valid when the sidebar collapses", () => {
	const view = renderInstaller(installerScreen(recommendedRun()[1]!), { width: 60, mode: "none" });
	const y = view.lines.findIndex(l => strip(l).includes("Next ▶"));
	assert.deepEqual(hitInstaller(view.hits, strip(view.lines[y]!).indexOf("Next ▶"), y), { type: "button", id: "next" });
});

test("all tui chrome keys exist in en and es", () => {
	for (const lang of ["en", "es"] as const) {
		for (const key of ["installer.tui.stepOf", "installer.tui.recommended", "installer.tui.keys", "installer.tui.helpTitle", "installer.tui.helpName", "installer.tui.helpFile", "installer.tui.diagram.active", "installer.tui.diagram.standby"]) {
			assert.ok((installerMessages[lang] as Record<string, string>)[key], `${lang} ${key}`);
		}
	}
	assert.equal(INSTALLER_STEPS.length, 10);
});

test("the tasks picker renders at the exact width, tags the recommendation and maps keys and clicks", () => {
	const tasks = customRun().find(s => s.step === "tasks")!;
	const open = step(tasks, { type: "open", index: 0 });
	const screen = installerScreen(open);
	for (const mode of MODES) {
		for (const width of WIDTHS) for (const line of renderInstaller(screen, { width, mode }).lines) assert.equal(cellWidth(line), width);
	}
	const out = text(renderInstaller(screen, { width: 100, mode: "none" }).lines);
	assert.match(out, /Backup Claude Sonnet 5\.5/);
	assert.match(out, /\[Recommended\]/);
	// the task list: Enter opens the picker, a click on the detail opens it too, a click on the label ticks it
	const list = installerScreen(tasks);
	assert.deepEqual(installerKey(list, undefined, "\r").actions, [{ type: "open", index: list.cursor }]);
	assert.deepEqual(installerKey(list, undefined, " ").actions, [{ type: "toggle", index: list.cursor }]);
	const view = renderInstaller(list, { width: 100, mode: "none" });
	const labelY = view.lines.findIndex(l => strip(l).includes("[ ] Main agent (orchestrator)"));
	assert.ok(labelY >= 0);
	const x = strip(view.lines[labelY]!).indexOf("[ ]");
	assert.deepEqual(hitInstaller(view.hits, x, labelY), { type: "toggle", index: 0 });
	assert.deepEqual(hitInstaller(view.hits, x, labelY + 1), { type: "open", index: 0 });
	// inside the picker Enter assigns (select + primary), Esc closes
	assert.deepEqual(installerKey(screen, undefined, "\r").actions, [{ type: "select", index: screen.cursor }, { type: "button", id: "assign-task" }]);
	assert.deepEqual(installerKey(screen, undefined, "\x1b").actions, [{ type: "cancel" }]);
	// other checklists keep Enter = Next
	const subs = installerScreen(customRun().find(s => s.step === "subscriptions")!);
	assert.deepEqual(installerKey(subs, undefined, "\r").actions, [{ type: "button", id: "next" }]);
});

test("no screen text of the Recommended and Custom runs shows a raw model id or ref", () => {
	for (const state of [...recommendedRun(), ...customRun()]) {
		const screen = installerScreen(state);
		const out = text(renderInstaller({ ...screen, helpOpen: true }, { width: 120, mode: "none" }).lines);
		assert.doesNotMatch(out, /(claude|gemini)-[a-z0-9-]*\d|(claude-bridge|antigravity)\/|pool\//, screen.step);
	}
});

// ---------------------------------------------------------------------------------------------
// Round 2 (T6): help panel, notice, shortcuts, keys, welcome, errors, summary, pending, mascot
// ---------------------------------------------------------------------------------------------

const NOW = 6000;
const legacyCurrent = {
	pools: { pools: [{ id: "legacy", name: "legacy", candidates: ["antigravity/gemini-3-8-flash"], strategy: "hybrid" }] },
	profiles: { active: "p", profiles: { p: { "legacy-role": { model: "pool/legacy" } } } },
};
const blockedSummary = (): InstallerState => {
	let s = withScanResult(step(initInstaller({ detected: both, current: legacyCurrent, installed: false }), next, next), { found: both });
	s = step(s, next, next);
	return { ...s, draft: { ...s.draft, enabled: ["claude-bridge"] } };
};
const tasksState = () => customRun().find(s => s.step === "tasks")!;
const backupsState = () => customRun().find(s => s.step === "backups")!;
const modelRef = "claude-bridge/claude-opus-5-5";
const pending = (): InstallerState => ({ ...tasksState(), analysis: { status: "running", startedAt: 1000, model: modelRef } });
const confirmed = (): InstallerState => ({ ...tasksState(), analysis: { status: "done", durationMs: 4200, tokens: 900, exact: false, model: modelRef } });
const installFailed = (): InstallerState => withInstallResult(step(recommendedRun()[5]!, next), { ok: false, written: [], backups: ["/x/pools.json.bak"], error: "disk full" });
const scanFailed = (): InstallerState => withScanResult(step(initInstaller({ detected: both }), next, next), { found: [] });
const generic = (): InstallerState => withError(recommendedRun()[4]!, "server down");
const draw = (state: InstallerState, width: number, mode: ColorMode, extra: object = {}) =>
	renderInstaller(installerScreen(state), { width, mode, frame: 3, animate: true, now: NOW, ...extra });

const ROUND2: [string, () => InstallerState][] = [
	["welcome", () => recommendedRun()[0]!],
	["backups", backupsState],
	["tasks pending", pending],
	["tasks confirmation", confirmed],
	["summary blocked", blockedSummary],
	["scan error", scanFailed],
	["install error", installFailed],
	["generic error", generic],
	["installing", () => recommendedRun()[6]!],
	["done", () => recommendedRun()[7]!],
];

test("round 2 screens keep the exact width at 60/90/120/140 in every color mode, animated or not", () => {
	for (const [name, make] of ROUND2) {
		for (const mode of MODES) {
			for (const width of [60, 90, 120, 140]) {
				for (const animate of [true, false]) {
					const view = draw(make(), width, mode, { animate });
					for (const line of view.lines) assert.equal(vw(line), width, `${name} ${mode} ${width}: ${JSON.stringify(strip(line))}`);
				}
			}
		}
	}
});

test("help panel: at >=110 columns it sits to the right of the content, at 90 below it, below 70 below too; ? hides it", () => {
	const subs = customRun().find(s => s.step === "subscriptions")!;
	const screen = installerScreen(subs);
	const focus = screen.help.focus!;
	for (const width of [110, 140]) {
		const lines = renderInstaller(screen, { width, mode: "none" }).lines.map(strip);
		const title = lines.findIndex(l => l.includes("What is this?"));
		assert.ok(title >= 0 && title < 4, `${width} panel starts at the top`);
		assert.ok(lines[title]!.indexOf("What is this?") >= width / 2, `${width} panel is on the right`);
		const joined = lines.join("\n");
		for (const needle of [focus.technicalName, focus.file, screen.help.purpose.slice(0, 15)]) assert.ok(joined.includes(needle.slice(0, 15)), `${width} ${needle}`);
		assert.match(joined, /What it is/);
		assert.match(joined, /What happens/);
		// the claude-bridge row and the panel share rows: it is a column, not a block below
		assert.ok(lines.some(l => l.includes("[x] claude-bridge") && l.lastIndexOf("│") > 40));
	}
	for (const width of [90, 60]) {
		const lines = renderInstaller(screen, { width, mode: "none" }).lines.map(strip);
		const title = lines.findIndex(l => l.includes("What is this?"));
		const buttons = lines.findIndex(l => l.includes("Next ▶"));
		assert.ok(title > buttons, `${width}: help below the content`);
		assert.ok(lines.some(l => l.includes(focus.technicalName)), `${width} technical name`);
	}
	assert.doesNotMatch(text(renderInstaller({ ...screen, helpOpen: true }, { width: 140, mode: "none" }).lines), /What is this\?/);
});

test("the notice about closing the setup is drawn above the buttons on every screen before Install", () => {
	for (const state of [...recommendedRun(), ...customRun()]) {
		const screen = installerScreen(state);
		for (const width of [60, 90, 140]) {
			const lines = renderInstaller(screen, { width, mode: "none" }).lines.map(strip);
			const flat = lines.join("\n").replace(/\s+/g, " ");
			if (!screen.notice) {
				assert.ok(!flat.includes("nothing is applied"), `${screen.step} has no notice`);
				continue;
			}
			if (width === 60) assert.ok(flat.includes(screen.notice), `${screen.step} notice`);
			const at = lines.findIndex(l => l.includes("If you close the setup"));
			const buttons = lines.findIndex(l => l.includes("[ Cancel ]"));
			assert.ok(at >= 0 && at < buttons, `${screen.step} ${width} notice above the buttons`);
		}
	}
});

test("shortcuts are drawn as a key hint line and every enabled letter maps to its action", () => {
	for (const make of [backupsState, tasksState]) {
		const screen = installerScreen(make());
		assert.ok(screen.shortcuts.length >= 3);
		const out = text(renderInstaller(screen, { width: 140, mode: "none" }).lines);
		for (const hint of screen.shortcuts) {
			const { key: raw, label, action, enabled } = hint;
			const shown = raw === " " ? "Space" : raw === "enter" ? "Enter" : raw;
			assert.match(out, new RegExp(`${shown} +${label.replace(/[()]/g, "\\$&")}`), `${screen.step} shows "${shown} ${label}"`);
			if (enabled && raw !== "enter" && raw !== " ") assert.deepEqual(installerKey(screen, undefined, raw).actions, [action], `${screen.step} ${raw}`);
		}
	}
	assert.match(text(renderInstaller(installerScreen(tasksState()), { width: 140, mode: "none" }).lines), /d +Deep analysis/);
});

test("the backups step is keyboard driven: tick, change how to choose, create a backup; u/j reorder the focused member", () => {
	let s = backupsState();
	const press = (data: string) => {
		for (const action of installerKey(installerScreen(s), undefined, canonicalKey(data)).actions) s = installerInput(s, action).state;
	};
	const pool = () => installerScreen(s).backupDetail!;
	const beforeMethod = pool().method;
	press("s");
	assert.notEqual(pool().method, beforeMethod);
	assert.equal(s.backupsTouched, true);
	const ticked = s.draft.pools.map(p => p.candidates.join());
	press(" ");
	assert.notDeepEqual(s.draft.pools.map(p => p.candidates.join()), ticked);
	// find a member that can move down, then move it with j and back with u
	s = backupsState();
	const shortcuts = () => installerScreen(s).shortcuts;
	let guard = 0;
	while (!shortcuts().find(h => h["key"] === "j")!.enabled && guard++ < 20) press("\x1b[B");
	assert.ok(shortcuts().find(h => h["key"] === "j")!.enabled, "a member can move down");
	const order = () => s.draft.pools.map(p => p.candidates.join());
	const before = order();
	press("j");
	assert.notDeepEqual(order(), before);
	press("u");
	assert.deepEqual(order(), before);
	press("c");
	assert.ok(s.wizard, "c opens the new backup wizard");
});

test("a disabled shortcut falls back to the plain key: j still moves down when no member can move", () => {
	const screen = installerScreen(tasksState());
	assert.deepEqual(installerKey(screen, undefined, "j").actions, [{ type: "move", delta: 1 }]);
	assert.deepEqual(installerKey(screen, undefined, "a").actions, [{ type: "button", id: "assign-recommended" }]);
	assert.deepEqual(installerKey(screen, undefined, "A").actions, [{ type: "button", id: "assign-recommended" }]);
});

test("S12: Space in kitty, CSI-u, lock-modifier and modifyOtherKeys encodings toggles a subscription exactly once, through the canonicalization extension.ts uses", () => {
	const subs = customRun().find(s => s.step === "subscriptions")!;
	const run = (raw: string) => {
		let s = subs;
		for (const action of installerKey(installerScreen(s), undefined, canonicalKey(raw)).actions) s = installerInput(s, action).state;
		return s.draft.enabled.length;
	};
	const all = subs.draft.enabled.length;
	for (const raw of [" ", "\x1b[32u", "\x1b[32;1u", "\x1b[32;1:1u", "\x1b[32;1:2u", "\x1b[32;65u", "\x1b[32;129u", "\x1b[27;1;32~"]) assert.equal(run(raw), all - 1, JSON.stringify(raw));
	// a key release never acts (the press already did)
	for (const raw of ["\x1b[32;1:3u", "\x1b[13;1:3u", "\x1b[1;1:3B"]) assert.equal(canonicalKey(raw), "", JSON.stringify(raw));
	assert.equal(run("\x1b[32;1:3u"), all);
});

test("S12: Enter, arrows, Tab and printable letters in CSI-u / modifyOtherKeys encodings reach the same actions as the legacy ones", () => {
	assert.equal(canonicalKey("\x1b[13u"), "\r");
	assert.equal(canonicalKey("\x1b[13;1:1u"), "\r");
	assert.equal(canonicalKey("\x1b[27;1;13~"), "\r");
	assert.equal(canonicalKey("\x1b[27u"), "\x1b");
	assert.equal(canonicalKey("\x1b[9u"), "\t");
	assert.equal(canonicalKey("\x1b[9;2u"), "\x1b[Z");
	assert.equal(canonicalKey("\x1b[127u"), "\x7f");
	assert.equal(canonicalKey("\x1b[1;1A"), "\x1b[A");
	assert.equal(canonicalKey("\x1b[1;1:2B"), "\x1b[B");
	assert.equal(canonicalKey("\x1b[106u"), "j");
	assert.equal(canonicalKey("\x1b[63u"), "?");
	assert.equal(canonicalKey("\x1b[100;2u"), "D");
	assert.equal(canonicalKey("\x1b[27;1;117~"), "u");
	// legacy bytes and unknown sequences pass through unchanged
	for (const raw of [" ", "\r", "\x1b[A", "j", "\x1b[5~", "\x1b[99;5u"]) assert.equal(canonicalKey(raw), raw);
});

test("welcome: glossary, what the installer does and the star link (OSC 8 with color, plain URL without)", () => {
	const screen = installerScreen(recommendedRun()[0]!);
	assert.ok(screen.welcome);
	for (const width of [60, 90, 140]) {
		const out = text(renderInstaller(screen, { width, mode: "none" }).lines);
		assert.ok(out.includes(screen.welcome!.definitionsTitle));
		for (const d of screen.welcome!.definitions) assert.ok(out.includes(d.term), `${width} ${d.term}`);
		assert.ok(out.includes(screen.welcome!.willDoTitle));
		assert.ok(out.includes(screen.welcome!.star.url), `${width} url`);
	}
	for (const mode of ["truecolor", "ansi"] as const) {
		const raw = renderInstaller(screen, { width: 100, mode }).lines.join("\n");
		assert.ok(raw.includes(`\x1b]8;;${screen.welcome!.star.url}\x1b\\`), `${mode} hyperlink`);
	}
	assert.ok(!renderInstaller(screen, { width: 100, mode: "none" }).lines.join("\n").includes("\x1b]8"));
});

test("error screens: red-bordered box with what happened, what to do and the buttons; install failure offers Undo", () => {
	for (const [make, buttons] of [[scanFailed, ["Retry", "Back"]], [installFailed, ["Retry", "Undo"]], [generic, ["Retry", "Back"]]] as const) {
		const screen = installerScreen(make());
		assert.ok(screen.error);
		const out = text(renderInstaller(screen, { width: 100, mode: "none" }).lines);
		assert.ok(out.includes("╭") && out.includes(screen.error!.title.slice(0, 20)));
		assert.ok(out.replace(/\s+/g, " ").includes(screen.error!.what.slice(0, 25)));
		for (const b of buttons) assert.ok(out.includes(b), b);
		const red = renderInstaller(screen, { width: 100, mode: "truecolor" }).lines.find(l => strip(l).includes("╭"));
		assert.match(red!, /38;2;228;59;68m[^\x1b]*╭/);
	}
	assert.ok(installerScreen(installFailed()).buttons.some(b => b.id === "undo"));
});

test("summary: narrative, review sentence, indented detail and closing line; blocked warnings in the warning color", () => {
	const screen = installerScreen(blockedSummary());
	const out = text(renderInstaller(screen, { width: 140, mode: "none" }).lines).replace(/\s+/g, " ");
	assert.ok(out.includes(screen.summary!.narrative.slice(0, 40)));
	assert.ok(out.includes(screen.summary!.review.slice(0, 40)));
	assert.ok(out.includes(screen.summary!.closing.slice(0, 40)));
	const flat = renderInstaller(screen, { width: 90, mode: "none" }).lines.map(strip);
	const review = flat.findIndex(l => l.includes("So you can review"));
	const closing = flat.findIndex(l => l.includes("If you agree"));
	assert.ok(review >= 0 && closing > review);
	const bullets = flat.flatMap((l, i) => (l.includes("•") ? [i] : []));
	assert.ok(bullets.length >= screen.summary!.detail.length - 1);
	assert.ok(bullets[0]! > review && bullets[bullets.length - 1]! < closing, "detail sits between the review sentence and the closing");
	const gold = renderInstaller(screen, { width: 100, mode: "truecolor" }).lines.filter(l => /Legacy/.test(strip(l)) && /254;174;52/.test(l));
	assert.ok(gold.length > 0, "blocked warning is gold");
});

test("pending deep analysis: spinner, elapsed seconds and an indeterminate bar; the button is disabled; reduced motion freezes it", () => {
	const screen = installerScreen(pending());
	assert.ok(screen.pending);
	const out = text(draw(pending(), 100, "none").lines);
	assert.ok(out.includes(screen.pending!.label.slice(0, 20)));
	assert.match(out, /5 s/);
	assert.match(out, /▰/);
	assert.match(out, /▱/);
	assert.match(out, /[▖▘▝▗]/);
	assert.match(out, /\( Deep analysis/);
	const frames = new Set([0, 1, 2, 3, 4, 5].map(frame => draw(pending(), 100, "none", { frame }).lines.join("\n")));
	assert.ok(frames.size > 1, "animated");
	const still = new Set([0, 1, 2, 3, 4, 5].map(frame => draw(pending(), 100, "none", { frame, animate: false }).lines.join("\n")));
	assert.equal(still.size, 1, "frozen");
	// d does nothing while it runs
	assert.deepEqual(installerKey(screen, undefined, "d").actions, []);
});

test("confirmation: shown in a success line after the analysis", () => {
	const screen = installerScreen(confirmed());
	assert.ok(screen.confirmation);
	const out = text(draw(confirmed(), 140, "none").lines).replace(/\s+/g, " ");
	assert.ok(out.includes(`✓ ${screen.confirmation}`.slice(0, 40)));
	const green = draw(confirmed(), 140, "truecolor").lines.find(l => strip(l).includes("✓ ") && strip(l).includes(screen.confirmation!.slice(0, 12)));
	assert.match(green!, /56;183;100/);
});

test("how to choose: the backups step lists the methods of the focused backup with the current one marked", () => {
	const screen = installerScreen(backupsState());
	assert.ok(screen.backupDetail);
	const out = text(renderInstaller(screen, { width: 140, mode: "none" }).lines);
	for (const m of screen.backupDetail!.methods) assert.ok(out.includes(m.label), m.label);
	assert.match(out, /\(●\) /);
});

test("the mascot sits in its own block on welcome, installing and done: never beside wrapped text", () => {
	for (const [state, pose] of [[recommendedRun()[0]!, "idle"], [recommendedRun()[6]!, "working"], [recommendedRun()[7]!, "happy"]] as const) {
		for (const width of [60, 90]) {
			const lines = renderInstaller(installerScreen(state), { width, mode: "none", animate: false }).lines.map(strip);
			const at = lines.findIndex(l => l.includes(".-----'-----."));
			assert.ok(at >= 0, `${pose} ${width}`);
			const own = lines.slice(at - 1, at + 4).map(l => l.slice(width >= 70 ? 27 : 0).trim());
			for (const row of own) assert.ok(row === "" || /^[\s|_/\\().,'^on-]+$/.test(row), `${pose} ${width}: ${JSON.stringify(row)}`);
		}
	}
	const other = renderInstaller(installerScreen(customRun().find(s => s.step === "subscriptions")!), { width: 90, mode: "none" }).lines.map(strip);
	assert.ok(!other.some(l => l.includes(".-----'-----.")), "no mascot on the other steps");
});

test("round 2 i18n keys exist in en and es", () => {
	for (const lang of ["en", "es"] as const) {
		for (const name of ["help.what", "help.purpose", "help.if", "shortcuts", "key.space", "key.enter", "method.title", "pending.elapsed"]) {
			assert.ok((installerMessages[lang] as Record<string, string>)[`installer.tui.${name}`], `${lang} ${name}`);
		}
	}
});

test("only the focused button is filled; the primary one is not blue at rest", () => {
	const screen = installerScreen(customRun().find(s => s.step === "tasks")!);
	const line = (focus: number | undefined, label: string) =>
		renderInstaller(screen, { width: 140, mode: "truecolor", focus }).lines.find(l => strip(l).includes(label))!;
	const next = screen.buttons.findIndex(b => b.id === "next");
	const back = screen.buttons.findIndex(b => b.id === "back");
	assert.doesNotMatch(line(undefined, "Next ▶"), /\x1b\[48;2;/);
	assert.match(line(next, "Next ▶"), /\x1b\[48;2;[^m]*m Next ▶ /);
	const backFocused = line(back, "◀ Back");
	assert.match(backFocused, /\x1b\[48;2;[^m]*m ◀ Back /);
	assert.doesNotMatch(backFocused, /\x1b\[48;2;[^m]*m Next ▶ /);
	assert.match(text(renderInstaller(screen, { width: 100, mode: "none" }).lines), /\[ Next ▶ \]/);
});

test("S7: the terminal reaches Automatic loans with the A key and a button, and draws both levels at every width", () => {
	const backups = customRun().find(s => s.step === "backups")!;
	const screen = installerScreen(backups);
	assert.deepEqual(installerKey(screen, undefined, "a").actions, [{ type: "button", id: "loans" }]);
	for (const width of WIDTHS) {
		const lines = renderInstaller(screen, { width, mode: "none" }).lines;
		assert.match(text(lines), /Automatic loans/);
		for (const line of lines) assert.ok(vw(line) <= width, `${width}: ${strip(line)}`);
	}
	const list = step(backups, { type: "button", id: "loans" });
	const open = step(list, { type: "open", index: 0 });
	for (const state of [list, open]) {
		for (const width of WIDTHS) {
			const lines = renderInstaller(installerScreen(state), { width, mode: "none" }).lines;
			assert.match(text(lines), /Automatic loans/);
			for (const line of lines) assert.ok(vw(line) <= width, `${width}: ${strip(line)}`);
		}
	}
	// In the list, Enter opens the highlighted backup; in its targets, Enter chooses and goes back to the list.
	assert.deepEqual(installerKey(installerScreen(list), undefined, "\r").actions, [{ type: "open", index: 0 }]);
});

// ---------------------------------------------------------------------------------------------
// Layout: shortcut grid and split button groups
// ---------------------------------------------------------------------------------------------

const NAV = ["back", "next", "cancel"];
const plainLines = (view: { lines: string[] }) => view.lines.map(strip);
const shownKey = (k: string) => (k === " " ? "Space" : k === "enter" ? "Enter" : k);

/** The boxed shortcut block of the content column (sidebar and separator cut off): top border to bottom border. */
function shortcutBox(width: number) {
	const screen = installerScreen(backupsState());
	const lines = plainLines(renderInstaller({ ...screen, helpOpen: true }, { width, mode: "none" })).map(l => l.replace(/^.*? │ /, "").trimEnd());
	const top = lines.findIndex(l => l.startsWith("╭─ Keys here "));
	assert.ok(top >= 0, "box title in the top border");
	const bottom = lines.findIndex((l, i) => i > top && l.startsWith("╰"));
	assert.ok(bottom > top, "bottom border");
	return { screen, lines: lines.slice(top, bottom + 1) };
}

test("the backups shortcuts sit in a rounded box titled in its top border, one aligned grid inside", () => {
	for (const width of [100, 170]) {
		const { screen, lines } = shortcutBox(width);
		const full = vw(lines[0]!);
		assert.ok(lines[0]!.startsWith("╭─ Keys here ─") && lines[0]!.endsWith("╮"));
		assert.ok(full <= width, "never wider than the terminal");
		assert.equal(lines.at(-1), `╰${"─".repeat(full - 2)}╯`);
		const body = lines.slice(1, -1);
		for (const l of body) {
			assert.ok(l.startsWith("│ ") && l.endsWith(" │"), `framed: ${l}`);
			assert.equal(vw(l), full, "right border in the same column");
		}
		const offsets = new Set<number>();
		for (const { label } of screen.shortcuts) {
			const row = body.find(r => r.includes(label));
			assert.ok(row, `${label} placed`);
			offsets.add(row!.indexOf(label));
		}
		if (width === 170) {
			assert.ok(body.length >= 2 && body.length < screen.shortcuts.length, "several columns inside the box");
			assert.ok(offsets.size >= 2 && offsets.size <= 3, `labels align into columns, got ${[...offsets]}`);
			const { key: k1, label: l1 } = screen.shortcuts[0]!;
			const { key: k2, label: l2 } = screen.shortcuts[1]!;
			assert.equal(body[0]!.indexOf(l1), body[1]!.indexOf(l2), "labels in one column start together");
			assert.ok(body[0]!.includes(shownKey(k1)) && body[1]!.includes(shownKey(k2)), "column-major");
		} else {
			assert.equal(body.length, screen.shortcuts.length, "one aligned column at a narrow width");
			assert.equal(offsets.size, 1);
		}
		assert.ok(!lines.some(l => l.trim() === "Keys here:"), "no separate prefix line");
	}
	const screen = installerScreen(backupsState());
	assert.ok(plainLines(renderInstaller(screen, { width: 100, mode: "none" })).every(l => vw(l) <= 100));
});

test("action buttons and navigation buttons are on different rows", () => {
	const screen = installerScreen(backupsState());
	const lines = plainLines(renderInstaller(screen, { width: 100, mode: "none" }));
	const rowOf = (s: string) => lines.findIndex(l => l.includes(s));
	const nav = rowOf("[ Next ▶ ]");
	assert.ok(nav >= 0);
	for (const word of ["[ ◀ Back ]", "[ Next ▶ ]", "[ Cancel ]"]) assert.equal(rowOf(word), nav);
	const actions = screen.buttons.filter(b => !NAV.includes(b.id));
	assert.ok(actions.length > 0);
	assert.equal((lines[nav]!.match(/\[/g) ?? []).length, 3, "three navigation buttons only");
	for (const b of actions) {
		const r = lines.findIndex(l => l.includes(`[ ${b.label} ]`) || l.includes(`( ${b.label} )`));
		assert.ok(r >= 0 && r < nav, `${b.id} above the navigation row`);
	}
});

test("every button still triggers its id when clicked and keeps its focus marker", () => {
	for (const state of [backupsState(), tasksState(), recommendedRun()[1]!]) {
		const screen = installerScreen(state);
		const view = renderInstaller(screen, { width: 100, mode: "none" });
		const lines = plainLines(view);
		screen.buttons.forEach((b, i) => {
			const labelled = b.id === "back" ? `◀ ${b.label}` : b.id === "next" ? `${b.label} ▶` : b.label;
			if (b.enabled) {
				const y = lines.findIndex(l => l.includes(`[ ${labelled} ]`));
				assert.ok(y >= 0, `${b.id} drawn`);
				assert.deepEqual(hitInstaller(view.hits, lines[y]!.indexOf(labelled), y), { type: "button", id: b.id });
			}
			const focused = plainLines(renderInstaller(screen, { width: 100, mode: "none", focus: i }));
			assert.ok(focused.some(x => x.includes("▸") && x.includes(b.label)), `focus on ${b.id}`);
		});
	}
});

test("a screen with only navigation buttons keeps a single button row", () => {
	const screen = installerScreen(recommendedRun()[1]!);
	assert.ok(screen.buttons.every(b => NAV.includes(b.id)));
	const rows = plainLines(renderInstaller(screen, { width: 100, mode: "none" })).filter(l => l.includes("Cancel") && l.includes("["));
	assert.equal(rows.length, 1);
	assert.ok(rows[0]!.includes("Back") && rows[0]!.includes("Next ▶"));
});
