import { test } from "node:test";
import assert from "node:assert/strict";
import { setLang } from "../src/i18n/index.ts";
import { plain } from "../src/style.ts";
import type { DetectedProvider, PoolConfig } from "../src/setup.ts";
import { goNext, initStepper } from "../src/setup-stepper.ts";
import {
	hitStepper,
	initScreen,
	renderStepper,
	stepRows,
	stepperButtons,
	stepperInput,
	stepperThemeColor,
	type StepperEvent,
	type StepperScreen,
} from "../src/setup-stepper-view.ts";

setLang("en");

const provider = (id: string, found = true): DetectedProvider => ({ id, label: id, kind: "subscription", detected: found, source: "test", availableModels: found ? ["m"] : [] });
const pools = (): PoolConfig[] => [{ id: "sonnet", name: "Sonnet", candidates: ["a/s", "b/s"], strategy: "hybrid" }];
const fresh = (): StepperScreen => initScreen(initStepper([provider("a"), provider("b"), provider("c", false)], pools(), {}));
const ui = { width: 100, bodyRows: 10 };
const key = (data: string): StepperEvent => ({ type: "key", data });
const send = (screen: StepperScreen, ...events: StepperEvent[]) => events.reduce((acc, e) => stepperInput(acc.state, e), { state: screen, effect: "none" } as ReturnType<typeof stepperInput>);
/** Renders and stores the hit areas, as the overlay does after each frame. */
const framed = (screen: StepperScreen): StepperScreen => ({ ...screen, hits: renderStepper(screen, ui).hits });
const at = (screen: StepperScreen, pred: (t: ReturnType<typeof hitStepper>) => boolean) => framed(screen).hits.find(h => pred(h.target))!;
const click = (h: { start: number; y: number }): StepperEvent => ({ type: "mouse", kind: "click", x: h.start + 1, y: h.y });
const onStep = (step: "strategy" | "roles" | "confirm"): StepperScreen => {
	let screen = fresh();
	for (const _ of ["strategy", "roles", "confirm"].slice(0, ["strategy", "roles", "confirm"].indexOf(step) + 1)) screen = { ...screen, stepper: goNext(screen.stepper) };
	return screen;
};

test("breadcrumb shows all four steps, the current one first reachable, later ones not clickable", () => {
	const view = renderStepper(fresh(), ui);
	assert.match(view.lines[0], /1 Providers › 2 Strategy › 3 Roles › 4 Confirm/);
	assert.deepEqual(view.hits.filter(h => h.target.kind === "tab").map(h => (h.target as { tab: string }).tab), ["providers"]);
	const later = renderStepper(onStep("confirm"), ui);
	assert.equal(later.hits.filter(h => h.target.kind === "tab").length, 4);
});

test("unreached steps are painted dim, the current step accented", () => {
	const view = renderStepper(fresh(), { ...ui, paint: (tone, text) => `<${tone}>${text}</${tone}>` });
	assert.match(view.lines[0], /<accent>1 Providers<\/accent>.*<dim>2 Strategy<\/dim>/);
});

test("each step prints its description and its body", () => {
	assert.match(renderStepper(fresh(), ui).lines.join("\n"), /choose which of the detected providers[\s\S]*a\s+✓ enabled\s+test\s+\[x\][\s\S]*c\s+✗ not found\s+–\s+\[ \]/);
	const strategy = renderStepper(onStep("strategy"), ui).lines.join("\n");
	assert.match(strategy, /sonnet · strategy: hybrid[\s\S]*\[x\] 1\. a\/s[\s\S]*\[x\] 2\. b\/s/);
	const roles = renderStepper(onStep("roles"), ui).lines.join("\n");
	assert.match(roles, /orchestrator\s+\(unassigned\)\s+default/);
	// The hint wraps inside the box, so compare the text without borders or line breaks.
	assert.match(roles.replace(/[│\n]/g, " ").replace(/\s+/g, " "), /classic wizard: \/balancer setup classic/);
	assert.match(renderStepper(onStep("confirm"), ui).lines.join("\n"), /pools\.json/);
});

test("buttons: only Discard on the first step, Save only on a valid confirm step", () => {
	const enabled = (screen: StepperScreen) => stepperButtons(screen.stepper).filter(b => b.enabled).map(b => b.id);
	assert.deepEqual(enabled(fresh()), ["next", "discard"]);
	assert.deepEqual(enabled(onStep("strategy")), ["back", "next", "discard"]);
	assert.deepEqual(enabled(onStep("confirm")), ["back", "save", "discard"]);
	const line = renderStepper(fresh(), ui).lines.find(l => l.includes("[ Discard ]"))!;
	assert.match(line, /\[ Back \] \[ Next \] \[ Save \] \[ Discard \]/);
});

test("disabled buttons are not hit-testable, enabled ones are", () => {
	const view = renderStepper(fresh(), ui);
	const ids = view.hits.filter(h => h.target.kind === "button").map(h => (h.target as { id: string }).id);
	assert.deepEqual(ids, ["next", "discard"]);
	const next = view.hits.find(h => h.target.kind === "button" && h.target.id === "next")!;
	assert.deepEqual(hitStepper(view.hits, next.start, next.y), { kind: "button", id: "next" });
	assert.equal(hitStepper(view.hits, next.end, next.y), undefined);
});

test("body rows carry hit areas that follow the viewport offset", () => {
	const rows = renderStepper(fresh(), ui).hits.filter(h => h.target.kind === "row");
	assert.equal(rows.length, 3);
	assert.equal(rows[1].y, rows[0].y + 1);
	assert.equal(rows[0].start, 4, "after the content margin and the box border");
	// The table header and its rule are the first two body lines, so offset 2 starts on the first row.
	const scrolled = renderStepper({ ...fresh(), offset: 2 }, { ...ui, bodyRows: 2 });
	assert.equal(scrolled.offset, 2);
	assert.equal(scrolled.hits.filter(h => h.target.kind === "row").length, 2);
});

test("keys: rows move, space toggles a provider, an undetected one is refused", () => {
	let r = send(fresh(), key("j"), key(" "));
	assert.equal(r.state.cursor, 1);
	assert.deepEqual(r.state.stepper.enabled, ["a"]);
	assert.equal(r.state.stepper.dirty, true);
	r = send(r.state, key("j"), key("\r"));
	assert.deepEqual(r.state.stepper.enabled, ["a"]);
	assert.equal(send(fresh(), key("k")).state.cursor, 0);
});

test("keys: right/l/tab go next, left/h/shift+tab go back, validation blocks next", () => {
	assert.equal(send(fresh(), key("l")).state.stepper.step, "strategy");
	assert.equal(send(fresh(), key("\t")).state.stepper.step, "strategy");
	assert.equal(send(fresh(), key("\x1b[C"), key("\x1b[D")).state.stepper.step, "providers");
	assert.equal(send(fresh(), key("l"), key("h")).state.stepper.step, "providers");
	assert.equal(send(fresh(), key("l"), key("\x1b[Z")).state.stepper.step, "providers");
	const none = send(fresh(), key(" "), key("j"), key(" "), key("l"));
	assert.equal(none.state.stepper.step, "providers");
	assert.ok((none.state.stepper.messages.providers ?? []).length > 0);
});

test("strategy step: enter cycles the pool strategy, space toggles and u/d moves a candidate", () => {
	const base = onStep("strategy");
	assert.equal(send(base, key("\r")).state.stepper.pools[0].strategy, "waterfall");
	const moved = send(base, key("j"), key("d"));
	assert.deepEqual(moved.state.stepper.pools[0].candidates, ["b/s", "a/s"]);
	assert.deepEqual(send(base, key("j"), key("j"), key(" ")).state.stepper.pools[0].candidates, ["a/s"]);
	assert.deepEqual(send(base, key("j"), key("j"), key(" "), key(" ")).state.stepper.pools[0].candidates, ["a/s", "b/s"]);
});

test("roles step: enter cycles the model through available targets, t cycles thinking", () => {
	const base = onStep("roles");
	const first = send(base, key("\r"));
	assert.equal(first.state.stepper.roles.orchestrator.model, "pool/sonnet");
	assert.equal(send(first.state, key("\r")).state.stepper.roles.orchestrator.model, "a/s");
	assert.equal(send(base, key("t")).state.stepper.roles.orchestrator, undefined);
	const thinking = send(first.state, key("t")).state.stepper.roles.orchestrator.thinking;
	assert.equal(thinking, "low");
});

test("save is only available on a valid confirm step", () => {
	assert.equal(send(fresh(), key("s")).effect, "none");
	const confirm = onStep("confirm");
	assert.equal(send(confirm, key("s")).effect, "save");
	const invalid = { ...confirm, stepper: { ...confirm.stepper, enabled: [] } };
	assert.equal(send(invalid, key("s")).effect, "none");
	const button = at(confirm, t => t?.kind === "button" && t.id === "save");
	assert.equal(send(framed(confirm), click(button)).effect, "save");
});

test("escape cancels when clean; when dirty it asks first and only y cancels", () => {
	assert.equal(send(fresh(), key("\x1b")).effect, "cancel");
	const asked = send(fresh(), key(" "), key("\x1b"));
	assert.equal(asked.effect, "none");
	assert.equal(asked.state.confirmDiscard, true);
	assert.match(renderStepper(asked.state, ui).lines.join("\n"), /Discard your changes/);
	assert.equal(send(asked.state, key("y")).effect, "cancel");
	const kept = send(asked.state, key("n"));
	assert.equal(kept.effect, "none");
	assert.equal(kept.state.confirmDiscard, false);
	assert.equal(kept.state.stepper.dirty, true);
});

test("the Discard button restores the baseline and reports the discard effect", () => {
	const edited = send(fresh(), key(" "));
	const r = send(framed(edited.state), click(at(edited.state, t => t?.kind === "button" && t.id === "discard")));
	assert.equal(r.effect, "discard");
	assert.equal(r.state.stepper.dirty, false);
	assert.deepEqual(r.state.stepper.enabled, ["a", "b"]);
});

test("clicks: breadcrumb jumps to a reached step, row click selects, second click acts, buttons run", () => {
	const confirm = framed(onStep("confirm"));
	assert.equal(send(confirm, click(at(confirm, t => t?.kind === "tab" && t.tab === "providers"))).state.stepper.step, "providers");
	const screen = framed(fresh());
	const second = at(screen, t => t?.kind === "row" && t.index === 1);
	const selected = send(screen, click(second));
	assert.equal(selected.state.cursor, 1);
	assert.equal(selected.state.stepper.dirty, false);
	const acted = send(framed(selected.state), click(second));
	assert.deepEqual(acted.state.stepper.enabled, ["a"]);
	const next = at(screen, t => t?.kind === "button" && t.id === "next");
	assert.equal(send(screen, click(next)).state.stepper.step, "strategy");
});

test("hover changes state only when the target changes; misses and unrelated clicks do nothing", () => {
	const screen = framed(fresh());
	const row = at(screen, t => t?.kind === "row" && t.index === 0);
	const move = (x: number, y: number): StepperEvent => ({ type: "mouse", kind: "move", x, y });
	const over = stepperInput(screen, move(row.start, row.y));
	assert.deepEqual(over.state.hover, { kind: "row", index: 0 });
	assert.notEqual(over.state, screen);
	assert.equal(stepperInput(over.state, move(row.start + 1, row.y)).state, over.state);
	assert.equal(stepperInput(over.state, move(0, 0)).state.hover, undefined);
	assert.equal(stepperInput(screen, { type: "mouse", kind: "click", x: 0, y: 0 }).state, screen);
});

test("wheel scrolls the body and stops following the cursor", () => {
	const r = stepperInput({ ...fresh(), follow: true }, { type: "mouse", kind: "wheel", x: 5, y: 5, wheelDelta: 1 });
	assert.equal(r.state.offset, 3);
	assert.equal(r.state.follow, false);
	assert.equal(stepperInput(fresh(), { type: "mouse", kind: "wheel", x: 5, y: 5 }).state.offset, 0);
});

test("stepRows lists no rows on confirm and one per detected provider on providers", () => {
	assert.equal(stepRows(onStep("confirm").stepper).length, 0);
	assert.equal(stepRows(fresh().stepper).length, 3);
});

// Pi's theme.fg throws "Unknown theme color" for names outside its palette, which crashed the overlay on Esc.
const PI_THEME_COLORS = new Set(["accent", "muted", "warning", "success", "error", "border", "dim", "text"]);

test("every tone the stepper paints maps to a real Pi theme color, including the Esc discard prompt", () => {
	const tones = new Set<string>();
	const paint = (tone: "accent" | "dim" | "warn" | "ok", text: string) => (tones.add(tone), text);
	const edited = onStep("confirm");
	const dirty = send({ ...edited, stepper: { ...edited.stepper, dirty: true } }, key("\x1b")).state;
	assert.equal(dirty.confirmDiscard, true);
	renderStepper(dirty, { ...ui, paint });
	renderStepper(fresh(), { ...ui, paint });
	assert.ok(tones.has("warn"), "the discard prompt is painted as a warning");
	for (const tone of tones) assert.ok(PI_THEME_COLORS.has(stepperThemeColor(tone as "accent" | "dim" | "warn" | "ok")), `${tone} -> ${stepperThemeColor(tone as "warn")}`);
	assert.equal(stepperThemeColor("warn"), "warning");
	assert.equal(stepperThemeColor("ok"), "success");
});

const wideUi = { width: 112, bodyRows: 10 };
const narrowUi = { width: 90, bodyRows: 10 };
const textOf = (screen: StepperScreen, size = wideUi) => renderStepper(screen, size).lines.join("\n");

test("every step body is a titled box and providers and roles render as tables", () => {
	assert.match(textOf(fresh()), /╭─ Providers/);
	assert.match(textOf(fresh()), /Provider\s+Status\s+Source\s+On/);
	assert.match(textOf(onStep("roles")), /╭─ Roles/);
	assert.match(textOf(onStep("roles")), /Role\s+Model\s+Thinking/);
	assert.match(textOf(onStep("strategy")), /╭─ Strategy/);
	assert.match(textOf(onStep("confirm")), /╭─ Changes to write/);
});

test("the Help box sits on the right of a wide overlay and stacks below a narrow one", () => {
	const wide = renderStepper(fresh(), wideUi);
	assert.equal(wide.helpOn, true);
	assert.ok(wide.lines.some(line => /╭─ Help ─+╮$/.test(line)), "Help top border on the right edge");
	const narrow = renderStepper(fresh(), narrowUi);
	assert.equal(narrow.helpOn, false, "help is off by default on narrow overlays");
	assert.ok(!narrow.lines.some(line => line.includes("Help")));
});

test("? toggles the Help box in both directions and shows the text of the current step", () => {
	const narrow = fresh();
	const shown = send({ ...narrow, helpOn: renderStepper(narrow, narrowUi).helpOn }, key("?")).state;
	const stacked = renderStepper(shown, narrowUi);
	assert.equal(stacked.helpOn, true);
	assert.match(stacked.lines.join("\n"), /Providers are the subscriptions/);
	const hidden = send({ ...shown, helpOn: stacked.helpOn }, key("?")).state;
	assert.equal(renderStepper(hidden, narrowUi).helpOn, false);
	const wide = fresh();
	const off = send({ ...wide, helpOn: renderStepper(wide, wideUi).helpOn }, key("?")).state;
	assert.equal(renderStepper(off, wideUi).helpOn, false);
});

test("boxing the body keeps every mouse hit aligned with the row it was drawn on", () => {
	for (const size of [wideUi, narrowUi]) {
		let screen = onStep("roles");
		const view = renderStepper(screen, size);
		screen = { ...screen, hits: view.hits };
		const lines = view.lines.map(plain);
		for (const hit of view.hits.filter(h => h.target.kind === "row")) {
			const line = lines[hit.y - 1]!;
			assert.match(line, /^│ [› ] /, `row hit at y=${hit.y} lands on a boxed table row: ${line}`);
			assert.ok(hit.start >= 2 && hit.end <= size.width, "hit stays inside the frame");
		}
		assert.ok(view.hits.some(h => h.target.kind === "row"));
	}
});
