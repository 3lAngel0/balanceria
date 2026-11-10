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
	withInstallResult,
	withScanResult,
	INSTALLER_STEPS,
	type InstallerAction,
	type InstallerScreen,
	type InstallerState,
} from "../src/installer-model.ts";
import { hitInstaller, installerKey, renderDiagram, renderInstaller } from "../src/installer-tui.ts";

setLang("en");

const provider = (id: string, availableModels: string[]): DetectedProvider => ({ id, label: id, kind: "subscription", detected: true, source: "test", availableModels });
const both = [provider("claude-bridge", ["claude-opus-5-5", "claude-sonnet-5-5"]), provider("antigravity", ["claude-sonnet-5-5", "gemini-3-8-flash"])];
const MODES: ColorMode[] = ["truecolor", "ansi", "none"];
const WIDTHS = [60, 80, 120];
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\uE000[\uE010-\uE01F]|\uE001/g, "");
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
				for (const line of view.lines) assert.equal(cellWidth(line), width, `${screen.step} ${mode} ${width}: ${JSON.stringify(strip(line))}`);
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

test("the help box toggles and shows text, technical name and file", () => {
	const screen = installerScreen(recommendedRun()[1]!);
	const closed = text(renderInstaller(screen, { width: 100, mode: "none" }).lines);
	assert.doesNotMatch(closed, /Technical name/);
	const open = text(renderInstaller({ ...screen, helpOpen: true }, { width: 100, mode: "none" }).lines);
	assert.ok(open.includes(screen.help.text.slice(0, 30)));
	assert.ok(open.includes(screen.help.technicalName));
	assert.ok(open.includes(screen.help.file));
	assert.match(open, /Technical name/);
	for (const l of renderInstaller({ ...screen, helpOpen: true }, { width: 60, mode: "ansi" }).lines) assert.equal(cellWidth(l), 60);
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
	const labelY = view.lines.findIndex(l => strip(l).includes("[ ] Coordinating the work"));
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
		const out = text(renderInstaller({ ...screen, helpOpen: false }, { width: 120, mode: "none" }).lines);
		assert.doesNotMatch(out, /(claude|gemini)-[a-z0-9-]*\d|(claude-bridge|antigravity)\/|pool\//, screen.step);
	}
});
