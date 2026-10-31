// Pure view + input for the setup stepper overlay: draws `SetupStepperState` as plain lines and
// maps keys and pointer events to state changes. No TUI, no theme and no I/O, so it is testable on
// its own; `openSetupStepper` in extension.ts only adds the border, colors and the actual writes.
//
// Pointer events only reach overlays under pi-tui's `TuiAltScreen`; under `TuiMainScreen` the
// overlay stays keyboard-only and `stepperInput` never receives a mouse event (same limitation as
// the Control Center, see control-center-mouse.ts).

import { CONTENT_X, CONTENT_Y, emphasize, sameTarget, wheelOffset, type MouseTarget } from "./control-center-mouse.ts";
import { HELP_MIN_WIDTH, HELP_WIDTH, helpBox, helpMainWidth, helpVisible, type HelpContext } from "./help-panel.ts";
import { t } from "./i18n/index.ts";
import { pixelBar, pixelText, type ColorMode, type PixelColor } from "./pixel.ts";
import type { RoutingStrategy } from "./router.ts";
import { ROLE_CATALOG, THINKING_DEFAULT, buildAvailableModelTargets, displayModel, displayThinking } from "./setup-advisor.ts";
import {
	SETUP_STEPS,
	buildStepperDiff,
	discard,
	goBack,
	goNext,
	goTo,
	moveCandidate,
	setPoolStrategy,
	setRole,
	stepDescription,
	toggleCandidate,
	toggleProvider,
	validateStep,
	type SetupStep,
	type SetupStepperState,
	type StepperCurrent,
} from "./setup-stepper.ts";
import { box, sideBySide, table, wrap, wrapIndented } from "./tui-box.ts";

// Raw terminal sequences (legacy and kitty CSI-u); the view stays free of pi-tui so it runs in plain node tests.
const KEYS = {
	escape: ["\x1b", "\x1b[27u"],
	enter: ["\r", "\n", "\x1b[13u"],
	space: [" ", "\x1b[32u"],
	tab: ["\t", "\x1b[9u"],
	shiftTab: ["\x1b[Z", "\x1b[9;2u"],
	up: ["\x1b[A", "\x1bOA"],
	down: ["\x1b[B", "\x1bOB"],
	right: ["\x1b[C", "\x1bOC"],
	left: ["\x1b[D", "\x1bOD"],
} as const;
const is = (data: string, name: keyof typeof KEYS): boolean => (KEYS[name] as readonly string[]).includes(data);

export type StepperEffect = "none" | "save" | "discard" | "cancel";

export type StepperTone = "accent" | "dim" | "warn" | "ok";

/** Pi's `theme.fg` throws on names outside its palette, so the view's tones are mapped to real theme colors here. */
export function stepperThemeColor(tone: StepperTone): "accent" | "muted" | "warning" | "success" {
	return tone === "dim" ? "muted" : tone === "warn" ? "warning" : tone === "ok" ? "success" : "accent";
}

export type StepRow =
	| { kind: "provider"; id: string }
	| { kind: "pool"; poolId: string }
	| { kind: "candidate"; poolId: string; ref: string }
	| { kind: "role"; role: string };

export interface StepperHit {
	target: MouseTarget;
	/** Overlay-local row and half-open column range [start, end). */
	y: number;
	start: number;
	end: number;
}

/** The stepper state plus everything the view itself remembers between frames. */
export interface StepperScreen {
	stepper: SetupStepperState;
	/** What the confirm step diffs against; only read, never written here. */
	current: StepperCurrent;
	cursor: number;
	offset: number;
	/** Keep the cursor row inside the viewport on the next render (cleared by the wheel). */
	follow: boolean;
	hover?: MouseTarget;
	confirmDiscard: boolean;
	/** Explicit help toggle (`?`); undefined follows the width. */
	help?: boolean;
	/** Whether the last frame showed the Help box, so `?` knows which way to toggle. */
	helpOn?: boolean;
	/** Hit areas of the last rendered frame. */
	hits: readonly StepperHit[];
}

export function initScreen(stepper: SetupStepperState, current: StepperCurrent = {}): StepperScreen {
	return { stepper, current, cursor: 0, offset: 0, follow: false, confirmDiscard: false, hits: [] };
}

export type StepperEvent =
	| { type: "key"; data: string }
	| { type: "mouse"; kind: "click" | "move" | "wheel"; x: number; y: number; wheelDelta?: number };

export interface StepperUi {
	width: number;
	/** Rows of the scrollable body viewport. */
	bodyRows: number;
	paint?: (tone: StepperTone, text: string) => string;
	/** How much color the terminal gets; plain text when omitted. Colors never change the text or the click areas. */
	mode?: ColorMode;
	/** Animation frame and whether it may move. */
	frame?: number;
	animate?: boolean;
}

export interface StepperView {
	lines: string[];
	hits: StepperHit[];
	/** The offset actually used, after clamping and following the cursor. */
	offset: number;
	helpOn: boolean;
}

const THINKING_LEVELS = ["low", "medium", "high"] as const;
const STRATEGIES: readonly RoutingStrategy[] = ["hybrid", "waterfall", "highest-quota"];

const enabledProviders = (s: SetupStepperState) => s.detected.filter(p => s.enabled.includes(p.id));

/** The selectable rows of the current step, in display order. */
export function stepRows(s: SetupStepperState): StepRow[] {
	switch (s.step) {
		case "providers":
			return s.detected.map(p => ({ kind: "provider", id: p.id }));
		case "strategy":
			return s.pools.flatMap((pool): StepRow[] => {
				const known = new Set(s.baseline.pools.find(p => p.id === pool.id)?.candidates ?? []);
				const refs = [...pool.candidates, ...[...known].filter(ref => !pool.candidates.includes(ref))];
				return [{ kind: "pool", poolId: pool.id }, ...refs.map((ref): StepRow => ({ kind: "candidate", poolId: pool.id, ref }))];
			});
		case "roles":
			return ROLE_CATALOG.map(entry => ({ kind: "role", role: entry.role }));
		case "confirm":
			return [];
	}
}

const THINKING_COLOR: Record<string, PixelColor> = { low: "steel", medium: "gold", high: "xp" };

/** Table cells of a provider or role row; `mode` only adds color to the same text. */
const rowCells = (s: SetupStepperState, row: StepRow, mode: ColorMode = "none"): string[] => {
	if (row.kind === "provider") {
		const p = s.detected.find(d => d.id === row.id)!;
		const on = s.enabled.includes(p.id);
		const state = !p.detected ? t("setup.stepper.provider.missing") : on ? t("setup.stepper.provider.found") : t("setup.stepper.provider.off");
		const color: PixelColor = !p.detected ? "bad" : on ? "hp" : "slate";
		return [p.label, pixelText(color, `${p.detected ? "✓" : "✗"} ${state}`, mode), p.detected ? p.source : "–", on ? "[x]" : "[ ]"];
	}
	if (row.kind === "role") {
		const route = s.roles[row.role];
		const model = displayModel(route?.model ?? "(unassigned)");
		const level = route?.thinking ?? THINKING_DEFAULT;
		const modelColor: PixelColor | undefined = route?.model === undefined ? "slate" : route.model.startsWith("pool/") ? "sky" : undefined;
		return [
			row.role,
			modelColor ? pixelText(modelColor, model, mode) : model,
			pixelText(THINKING_COLOR[level] ?? "slate", displayThinking(level), mode),
		];
	}
	return [];
};

/** Plain text of a pool or candidate row (the strategy step is a tree, not a table). */
const rowText = (s: SetupStepperState, row: StepRow): string => {
	switch (row.kind) {
		case "pool": {
			const pool = s.pools.find(p => p.id === row.poolId)!;
			return t("setup.stepper.poolLine", { pool: pool.id, strategy: pool.strategy });
		}
		case "candidate": {
			const position = s.pools.find(p => p.id === row.poolId)!.candidates.indexOf(row.ref);
			return `  [${position >= 0 ? "x" : " "}] ${position >= 0 ? `${position + 1}. ` : "   "}${row.ref}`;
		}
		default:
			return rowCells(s, row).join("  ");
	}
};

export function stepperButtons(s: SetupStepperState): { id: string; label: string; enabled: boolean }[] {
	const index = SETUP_STEPS.indexOf(s.step);
	const canSave = s.step === "confirm" && validateStep(s, "confirm").length === 0;
	return [
		{ id: "back", label: t("setup.stepper.btn.back"), enabled: index > 0 },
		{ id: "next", label: t("setup.stepper.btn.next"), enabled: index < SETUP_STEPS.length - 1 },
		{ id: "save", label: t("setup.stepper.btn.save"), enabled: canSave },
		{ id: "discard", label: t("setup.stepper.btn.discard"), enabled: true },
	];
}

export function renderStepper(screen: StepperScreen, ui: StepperUi): StepperView {
	const s = screen.stepper;
	const paint = ui.paint ?? ((_tone, text) => text);
	const inner = Math.max(20, ui.width - CONTENT_X * 2);
	const helpOn = helpVisible(screen.help, inner);
	const side = helpOn && inner >= HELP_MIN_WIDTH;
	const left = helpMainWidth(inner, helpOn);
	const edge = (text: string) => paint("dim", text);
	const mode: ColorMode = ui.mode ?? "none";
	const boxInner = left - 4;
	const hits: StepperHit[] = [];
	const hot = (target: MouseTarget, text: string) => (sameTarget(target, screen.hover) ? emphasize(text, "hover") : text);
	const lines: string[] = [];
	const hit = (target: MouseTarget, start: number, length: number) =>
		hits.push({ target, y: CONTENT_Y + lines.length, start: CONTENT_X + start, end: CONTENT_X + start + length });

	// Breadcrumb: current step highlighted, unreached steps dim and not clickable.
	let column = 0;
	const crumbs = SETUP_STEPS.map((step, i) => {
		const label = `${i + 1} ${t(`setup.stepper.step.${step}`)}`;
		const reachable = i <= s.reached;
		if (reachable) hit({ kind: "tab", tab: step }, column, label.length);
		column += label.length + 3;
		return step === s.step ? paint("accent", hot({ kind: "tab", tab: step }, label)) : reachable ? hot({ kind: "tab", tab: step }, label) : paint("dim", label);
	});
	const stepNumber = SETUP_STEPS.indexOf(s.step) + 1;
	const stepBar = pixelBar(stepNumber / SETUP_STEPS.length, 8, { mode, frame: ui.frame, animate: ui.animate });
	lines.push(`${crumbs.join(" › ")}  ${stepBar} ${stepNumber}/${SETUP_STEPS.length}`);
	lines.push(...wrap(t(stepDescription(s.step)), left).map(line => paint("dim", line)), "");

	// Body: scrollable; remember which content line each selectable row occupies.
	const body: string[] = [];
	const rowLines: number[] = [];
	const rows = stepRows(s);
	const errors = s.step === "confirm" ? validateStep(s, "confirm") : (s.messages[s.step] ?? []);
	for (const message of errors) body.push(...wrapIndented(`! ${message}`, boxInner).map(line => paint("warn", line)));
	const diffColor = (line: string): PixelColor | undefined => {
		const mark = line.trimStart()[0];
		if (mark === "+") return "hp";
		if (mark === "~") return "gold";
		if (mark === "-") return "bad";
		return /Unchanged/.test(line) ? "steel" : line.endsWith(":") ? "sky" : undefined;
	};
	if (s.step === "confirm") {
		for (const raw of buildStepperDiff(s, screen.current).lines) {
			for (const line of wrapIndented(raw, boxInner)) {
				const color = diffColor(raw);
				body.push(color ? pixelText(color, line, mode) : line);
			}
		}
	}
	if (s.step === "roles") body.push(...wrap(t("setup.stepper.rolesHint"), boxInner).map(line => paint("dim", line)));
	const headers = s.step === "providers" ? ["provider", "status", "source", "enabled"] : s.step === "roles" ? ["role", "model", "thinking"] : [];
	const grid =
		headers.length > 0
			? table(headers.map(key => t(`setup.col.${key}`)), rows.map(row => rowCells(s, row, mode)), boxInner, { prefixes: rows.map((_row, i) => (i === screen.cursor ? "› " : "  ")), head: text => paint("accent", text) })
			: undefined;
	if (grid) body.push(grid[0]!, grid[1]!);
	rows.forEach((row, index) => {
		rowLines.push(body.length);
		const selected = index === screen.cursor;
		const target: MouseTarget = { kind: "row", index };
		const out = grid ? grid[index + 2]! : `${selected ? "›" : " "} ${rowText(s, row)}`;
		body.push(selected ? paint("accent", hot(target, out)) : hot(target, out));
	});

	const viewport = Math.max(1, ui.bodyRows);
	const maxOffset = Math.max(0, body.length - viewport);
	let offset = Math.min(Math.max(0, screen.offset), maxOffset);
	const cursorLine = rowLines[screen.cursor];
	if (screen.follow && cursorLine !== undefined) {
		if (cursorLine < offset) offset = cursorLine;
		else if (cursorLine >= offset + viewport) offset = cursorLine - viewport + 1;
		offset = Math.min(offset, maxOffset);
	}
	// The body sits in a titled box: a row's hit starts after the left border, one line below the top edge.
	const boxStart = lines.length;
	const shown: string[] = [];
	for (let i = 0; i < viewport; i++) {
		const rowIndex = rowLines.indexOf(offset + i);
		if (rowIndex >= 0) hits.push({ target: { kind: "row", index: rowIndex }, y: CONTENT_Y + boxStart + 1 + i, start: CONTENT_X + 2, end: CONTENT_X + 2 + boxInner });
		shown.push(body[offset + i] ?? "");
	}
	lines.push(...box(s.step === "confirm" ? t("setup.stepper.box.changes") : t(`setup.stepper.step.${s.step}`), shown, left, edge));

	if (screen.confirmDiscard) lines.push(paint("warn", t("setup.stepper.confirmDiscard")));
	else {
		let x = 0;
		const cells = stepperButtons(s).map(button => {
			const text = `[ ${button.label} ]`;
			if (button.enabled) hit({ kind: "button", id: button.id }, x, text.length);
			x += text.length + 1;
			const color: PixelColor | undefined = button.id === "save" ? "hp" : button.id === "discard" ? "bad" : undefined;
			return button.enabled ? hot({ kind: "button", id: button.id }, color ? pixelText(color, text, mode) : text) : paint("dim", text);
		});
		lines.push(cells.join(" "));
	}
	lines.push(...wrap(t("setup.stepper.hint"), left).map(line => paint("dim", line)));

	if (!helpOn) return { lines, hits, offset, helpOn };
	const poolId = (rows[screen.cursor] as { poolId?: string } | undefined)?.poolId;
	const context: HelpContext = { kind: "step", step: s.step, strategy: s.step === "strategy" ? s.pools.find(p => p.id === poolId)?.strategy : undefined };
	const out = side ? sideBySide(lines, helpBox(context, HELP_WIDTH, edge), left, HELP_WIDTH, 1) : [...lines, "", ...helpBox(context, inner, edge)];
	return { lines: out, hits, offset, helpOn };
}

export function hitStepper(hits: readonly StepperHit[], x: number, y: number): MouseTarget | undefined {
	return hits.find(h => h.y === y && x >= h.start && x < h.end)?.target;
}

const cycle = <T>(items: readonly T[], current: T | undefined): T => items[(items.indexOf(current as T) + 1) % items.length]!;

/** Enter/Space/click-on-selected: toggle or cycle whatever the selected row holds. */
function activate(s: SetupStepperState, row: StepRow | undefined): SetupStepperState {
	if (!row) return s;
	switch (row.kind) {
		case "provider":
			return s.detected.find(p => p.id === row.id)?.detected ? toggleProvider(s, row.id) : s;
		case "pool":
			return setPoolStrategy(s, row.poolId, cycle(STRATEGIES, s.pools.find(p => p.id === row.poolId)?.strategy));
		case "candidate":
			return toggleCandidate(s, row.poolId, row.ref);
		case "role": {
			const targets = buildAvailableModelTargets(enabledProviders(s), s.pools);
			if (targets.length === 0) return s;
			return setRole(s, row.role, cycle(targets, s.roles[row.role]?.model), s.roles[row.role]?.thinking);
		}
	}
}

const cycleThinking = (s: SetupStepperState, role: string): SetupStepperState => {
	const route = s.roles[role];
	if (!route) return s;
	return setRole(s, role, route.model, cycle(THINKING_LEVELS, route.thinking as (typeof THINKING_LEVELS)[number] | undefined));
};

type Result = { state: StepperScreen; effect: StepperEffect };

function runButton(screen: StepperScreen, id: string): Result {
	const s = screen.stepper;
	if (!stepperButtons(s).find(b => b.id === id)?.enabled) return { state: screen, effect: "none" };
	switch (id) {
		case "back":
			return { state: { ...screen, stepper: goBack(s), cursor: 0, offset: 0 }, effect: "none" };
		case "next": {
			const next = goNext(s);
			return { state: { ...screen, stepper: next, ...(next.step !== s.step ? { cursor: 0, offset: 0 } : {}) }, effect: "none" };
		}
		case "save":
			return { state: screen, effect: "save" };
		default:
			return { state: { ...screen, stepper: discard(s), cursor: 0, offset: 0 }, effect: "discard" };
	}
}

export function stepperInput(screen: StepperScreen, event: StepperEvent): Result {
	const none = (state: StepperScreen = screen): Result => ({ state, effect: "none" });
	const s = screen.stepper;
	const rows = stepRows(s);
	const select = (cursor: number) => none({ ...screen, cursor: Math.min(Math.max(0, cursor), Math.max(0, rows.length - 1)), follow: true });
	const edit = (next: SetupStepperState) => none({ ...screen, stepper: next, follow: true });

	if (event.type === "key") {
		const key = event.data;
		if (screen.confirmDiscard) return key === "y" ? { state: screen, effect: "cancel" } : none({ ...screen, confirmDiscard: false });
		if (key === "?") return none({ ...screen, help: !(screen.helpOn ?? false) });
		if (is(key, "escape")) return s.dirty ? none({ ...screen, confirmDiscard: true }) : { state: screen, effect: "cancel" };
		if (is(key, "right") || key === "l" || is(key, "tab")) return runButton(screen, "next");
		if (is(key, "left") || key === "h" || is(key, "shiftTab")) return runButton(screen, "back");
		if (is(key, "down") || key === "j") return select(screen.cursor + 1);
		if (is(key, "up") || key === "k") return select(screen.cursor - 1);
		if (key === "s") return runButton(screen, "save");
		const row = rows[screen.cursor];
		if (is(key, "enter") || is(key, "space")) return edit(activate(s, row));
		if ((key === "u" || key === "d") && row?.kind === "candidate") {
			const index = s.pools.find(p => p.id === row.poolId)!.candidates.indexOf(row.ref);
			return edit(moveCandidate(s, row.poolId, index, key === "u" ? -1 : 1));
		}
		if (key === "t" && row?.kind === "role") return edit(cycleThinking(s, row.role));
		return none();
	}

	if (event.kind === "wheel") return event.wheelDelta ? none({ ...screen, offset: wheelOffset(screen.offset, event.wheelDelta), follow: false }) : none();
	const target = hitStepper(screen.hits, event.x, event.y);
	if (event.kind === "move") return sameTarget(target, screen.hover) ? none() : none({ ...screen, hover: target });
	if (!target || screen.confirmDiscard) return none();
	if (target.kind === "tab") return none({ ...screen, stepper: goTo(s, target.tab as SetupStep), cursor: 0, offset: 0 });
	if (target.kind === "button") return runButton(screen, target.id);
	if (target.index === screen.cursor) return edit(activate(s, rows[target.index]));
	return select(target.index);
}
