// The installer in the browser. The model (`installer-model.ts`) lives on the server: this module holds the one active session
// (state + the host that runs its effects), validates the actions the page sends, and serves the page that draws `installerScreen(state)`.
// The terminal installer runs on the same session, so both channels run identical effects.

import { t } from "./i18n/index.ts";
import {
	initInstaller,
	installerInput,
	installerScreen,
	withAdvisorReport,
	withAnalysisError,
	withError,
	withInstallProgress,
	withInstallResult,
	withScanResult,
	INSTALL_PROGRESS_STEPS,
	type ButtonId,
	type InstallerAction,
	type InstallerEffect,
	type InstallerInit,
	type InstallerScreen,
	type InstallerState,
} from "./installer-model.ts";
import { withKeptBackups } from "./installer-plan.ts";
import type { AdvisorReport } from "./setup-advisor.ts";
import type { SetupStepperState, StepperCurrent } from "./setup-stepper.ts";
import type { DetectedProvider, PoolConfig } from "./setup.ts";

export type InstallerOutcome = "panel" | "advanced" | "exit";

/** A failed install may still report what it wrote or copied, so the screen can offer Undo. */
export type InstallResult = { ok: true; written: string[]; backups: string[]; profilesError?: string } | { ok: false; error: string; written?: string[]; backups?: string[] };

/** What the host (Pi, or a test) does for the model's effects. */
export interface InstallerHostDeps {
	detect(): DetectedProvider[];
	install(draft: SetupStepperState, current: StepperCurrent): InstallResult;
	/** Restores the `.bak` files and returns how many; throws when it cannot. */
	undo(backups: string[]): number;
	deepAnalysis(providers: DetectedProvider[], pools: PoolConfig[], model: string): Promise<AdvisorReport>;
	notify(message: string, level: "info" | "warning" | "error"): void;
	/** After an install or an undo changed the files. */
	changed?(): void;
}

export interface InstallerSession {
	readonly state: InstallerState;
	/** True while a scan, an install or a deep analysis is still running. */
	readonly pending: boolean;
	readonly outcome: InstallerOutcome | undefined;
	screen(): InstallerScreen;
	act(action: InstallerAction): void;
	onChange(listener: () => void): void;
	onEnd(listener: (outcome: InstallerOutcome) => void): void;
	/** Stops further effects; a running one finishes without touching the state. */
	close(): void;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createInstallerSession(init: InstallerInit, deps: InstallerHostDeps): InstallerSession {
	let state = initInstaller(init);
	let closed = false;
	let jobs = 0;
	/** One deep analysis at a time: a second request never reaches the CLI (it would spend tokens twice). */
	let analysing = false;
	let outcome: InstallerOutcome | undefined;
	const changeListeners: (() => void)[] = [];
	const endListeners: ((outcome: InstallerOutcome) => void)[] = [];
	const changed = () => {
		if (!closed) for (const listener of changeListeners) listener();
	};
	const end = (value: InstallerOutcome) => {
		if (outcome !== undefined) return;
		outcome = value;
		for (const listener of endListeners) listener(value);
	};
	const later = (job: () => void) => {
		jobs += 1;
		setTimeout(() => {
			try {
				if (!closed) job();
			} catch (error) {
				deps.notify(`ai-balancer: ${message(error)}`, "error");
				state = withError(state, message(error));
			} finally {
				jobs -= 1;
				changed();
			}
		}, 0);
	};
	const install = () => {
		state = withInstallProgress(state, "copies", "running");
		later(() => {
			let result: InstallResult;
			try {
				result = deps.install(withKeptBackups(state.draft, state.current).draft, state.current);
			} catch (error) {
				result = { ok: false, error: message(error) };
			}
			if (!result.ok) {
				state = withInstallResult(state, { ok: false, written: result.written ?? [], backups: result.backups ?? [], error: result.error });
				return;
			}
			for (const id of INSTALL_PROGRESS_STEPS) state = withInstallProgress(state, id, "done");
			if (result.profilesError) deps.notify(`ai-balancer: ${t("setup.stepper.profilesFailed", { error: result.profilesError })}`, "warning");
			state = withInstallResult(state, { ok: true, written: result.written, backups: result.backups });
			deps.changed?.();
		});
	};
	const undo = () => {
		try {
			const count = deps.undo(state.backups);
			deps.notify(`ai-balancer: ${t("installer.tui.undone", { count })}`, "info");
			deps.changed?.();
		} catch (error) {
			deps.notify(`ai-balancer: ${t("installer.tui.undoFailed", { error: message(error) })}`, "error");
		}
	};
	const run = (effect: InstallerEffect) => {
		if (effect === "scan") {
			later(() => {
				try {
					state = withScanResult(state, { found: deps.detect() });
				} catch (error) {
					state = withScanResult(state, { error: message(error) });
				}
			});
		} else if (effect === "install") install();
		else if (effect === "undo") undo();
		else if (effect === "open-panel") end("panel");
		else if (effect === "advanced") end("advanced");
		else if (effect === "exit") end("exit");
		else {
			if (analysing) return;
			analysing = true;
			deps.notify(`ai-balancer: ${t("installer.tui.deepRunning")}`, "info");
			const providers = state.draft.detected.filter(p => p.detected && state.draft.enabled.includes(p.id));
			const startedAt = Date.now();
			jobs += 1;
			// `deepAnalysis` may throw synchronously or reject; both end in the error screen and free the button.
			Promise.resolve()
				.then(() => deps.deepAnalysis(providers, state.draft.pools, effect.model))
				.then(report => {
					if (closed) return;
					state = report.error ? withAnalysisError(state, report.error) : withAdvisorReport(state, report, { durationMs: Date.now() - startedAt });
				})
				.catch(error => {
					deps.notify(`ai-balancer: ${message(error)}`, "warning");
					if (!closed) state = withAnalysisError(state, message(error));
				})
				.finally(() => {
					analysing = false;
					jobs -= 1;
					changed();
				});
		}
	};
	return {
		get state() {
			return state;
		},
		get pending() {
			return jobs > 0;
		},
		get outcome() {
			return outcome;
		},
		screen: () => installerScreen(state),
		act(action) {
			if (closed || outcome !== undefined) return;
			const result = installerInput(state, action);
			state = result.state;
			if (result.effect) run(result.effect);
			changed();
		},
		onChange: listener => void changeListeners.push(listener),
		onEnd: listener => void endListeners.push(listener),
		close() {
			closed = true;
		},
	};
}

// ---------------------------------------------------------------------------------------------
// The active session: the routes exist only while one is registered
// ---------------------------------------------------------------------------------------------

// The server outlives extension reloads, so the registry lives on globalThis like the server does.
const ACTIVE = Symbol.for("ai-balancer.web-installer");
type Holder = { [ACTIVE]?: InstallerSession };
const holder = globalThis as Holder;

export const activeInstallerSession = (): InstallerSession | undefined => holder[ACTIVE];

export function setInstallerSession(session: InstallerSession | undefined): void {
	if (session) holder[ACTIVE] = session;
	else delete holder[ACTIVE];
}

// ---------------------------------------------------------------------------------------------
// Actions from the page
// ---------------------------------------------------------------------------------------------

const BUTTONS: Record<ButtonId, true> = {
	back: true,
	next: true,
	cancel: true,
	retry: true,
	install: true,
	"open-panel": true,
	exit: true,
	undo: true,
	"assign-recommended": true,
	"assign-task": true,
	"deep-analysis": true,
	"create-backup": true,
	"move-up": true,
	"move-down": true,
	"cycle-method": true,
};
const MAX_INDEX = 10_000;
const MAX_MOVE = 100;

const isIndex = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_INDEX;

/** The model action a page sent, or undefined when it is not exactly one of the model's actions. */
export function parseInstallerAction(value: unknown): InstallerAction | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const body = value as Record<string, unknown>;
	const keys = Object.keys(body).sort().join(",");
	switch (body.type) {
		case "next":
		case "back":
		case "cancel":
		case "help":
			return keys === "type" ? { type: body.type } : undefined;
		case "move":
			return keys === "delta,type" && typeof body.delta === "number" && Number.isInteger(body.delta) && Math.abs(body.delta) <= MAX_MOVE ? { type: "move", delta: body.delta } : undefined;
		case "toggle":
		case "select":
		case "open":
			return keys === "index,type" && isIndex(body.index) ? { type: body.type, index: body.index } : undefined;
		case "button":
			return keys === "id,type" && typeof body.id === "string" && Object.hasOwn(BUTTONS, body.id) ? { type: "button", id: body.id as ButtonId } : undefined;
		default:
			return undefined;
	}
}

/** What GET and POST /api/installer answer: the screen of the model plus the page's own words. */
export function installerView(session: InstallerSession): Record<string, unknown> {
	const screen = session.screen();
	return {
		screen,
		pending: session.pending,
		finished: session.outcome !== undefined,
		outcome: session.outcome,
		text: {
			title: t("installer.web.page.title"),
			steps: t("installer.web.page.steps"),
			stepOf: t("installer.tui.stepOf", { n: screen.stepNumber, total: screen.stepCount }),
			recommended: t("installer.tui.recommended"),
			help: t("installer.tui.helpTitle"),
			helpName: t("installer.tui.helpName", { name: screen.help.technicalName }),
			helpFile: t("installer.tui.helpFile", { file: screen.help.file }),
			change: t("installer.web.page.change"),
			working: t("installer.web.page.working"),
			diagram: t("installer.web.page.diagram"),
			closed: t("installer.web.page.closed"),
			advanced: t("installer.web.page.advanced"),
			panel: t("installer.web.page.panel"),
			error: t("installer.web.page.error", { error: "{error}" }),
			members: (screen.diagram?.members ?? []).map(m => (m.state === "active" ? `✓ ${t("installer.tui.diagram.active")}` : t("installer.tui.diagram.standby", { n: m.order - 1 }))),
		},
	};
}

// ---------------------------------------------------------------------------------------------
// The page. The server's CSP allows only same-origin script and style: no inline code, every node is built with textContent.
// ---------------------------------------------------------------------------------------------

export function installerPageHtml(): string {
	return `<!DOCTYPE html>
<html>
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${t("installer.web.page.title")}</title>
	<link rel="stylesheet" href="/installer.css">
	<script src="/installer.js" defer></script>
</head>
<body>
	<div id="app" aria-live="polite">${t("installer.web.page.loading")}</div>
</body>
</html>
`;
}

export function installerPageStyle(): string {
	return `:root {
	--bg-deep: #0e0c15;
	--bg-card: #181425;
	--bg-card-alt: #26213b;
	--border-dark: #3f3f74;
	--border-light: #5b6ee1;
	--text-main: #f4f4f4;
	--text-dim: #8b9bb4;
	--accent-ok: #38b764;
	--accent-gold: #f4b41b;
	--accent-bad: #ff6b81;
	--accent-sky: #73eff7;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg-deep); color: var(--text-main); font: 16px/1.5 ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; }
#app { max-width: 1040px; margin: 0 auto; padding: 24px 16px; }
.shell { display: grid; grid-template-columns: 220px 1fr; gap: 24px; }
@media (max-width: 720px) { .shell { grid-template-columns: 1fr; } .steps { display: none; } }
.steps { list-style: none; margin: 0; padding: 0; }
.steps li { padding: 6px 8px; color: var(--text-dim); }
.steps li.current { color: var(--accent-sky); font-weight: bold; border-left: 4px solid var(--accent-sky); }
.steps li.done { color: var(--text-main); }
.stepof { color: var(--text-dim); margin: 0; }
h1 { margin: 4px 0 12px; font-size: 1.5rem; color: var(--accent-sky); }
h2 { font-size: 1rem; margin: 12px 0 4px; color: var(--accent-sky); }
.main { background: var(--bg-card); border: 2px solid var(--border-dark); padding: 20px; }
.card { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; margin: 8px 0; background: var(--bg-card-alt); border: 2px solid var(--border-dark); cursor: pointer; }
.card.selected, .card.checked { border-color: var(--border-light); border-width: 4px; padding: 8px 10px; }
.card.cursor { outline: 2px dotted var(--text-dim); outline-offset: 2px; }
.card .what { display: block; font-weight: bold; }
.card .desc { display: block; color: var(--text-dim); }
.card .warn { display: block; color: var(--accent-gold); }
.tag { color: var(--accent-gold); font-weight: normal; }
.row { display: flex; gap: 8px; align-items: stretch; }
.row .card { flex: 1; }
input[type=radio], input[type=checkbox] { width: 20px; height: 20px; margin-top: 3px; accent-color: var(--border-light); }
.progress { list-style: none; padding: 0; margin: 8px 0; }
.progress li { padding: 4px 0; }
.message { padding: 10px 12px; border: 2px solid var(--border-dark); }
.message.error { border-color: var(--accent-bad); color: var(--accent-bad); }
.message .hint { color: var(--text-dim); display: block; }
.help { margin: 12px 0; padding: 10px 12px; border: 2px dashed var(--border-light); }
.help .dim { color: var(--text-dim); display: block; }
.buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
button { font: inherit; color: var(--text-main); background: var(--bg-card-alt); border: 2px solid var(--border-dark); padding: 8px 14px; cursor: pointer; }
button.primary { background: var(--accent-sky); color: var(--bg-deep); border-color: var(--accent-sky); font-weight: bold; }
button:disabled { color: var(--text-dim); border-style: dashed; cursor: not-allowed; }
button:focus-visible, input:focus-visible { outline: 3px solid var(--accent-gold); outline-offset: 2px; }
svg.diagram { max-width: 100%; height: auto; margin: 12px 0; }
.node { fill: var(--bg-card-alt); stroke: var(--border-light); stroke-width: 2; }
.node.active { stroke: var(--accent-ok); stroke-width: 4; }
.node.standby { stroke-dasharray: 6 4; }
.edge { stroke: var(--text-dim); stroke-width: 2; fill: none; }
.node-text { fill: var(--text-main); font: 14px ui-monospace, Menlo, Consolas, monospace; }
.node-sub { fill: var(--text-dim); font: 12px ui-monospace, Menlo, Consolas, monospace; }
`;
}

export function installerPageScript(): string {
	return `"use strict";
(() => {
	const app = document.getElementById("app");
	const SVG = "http://www.w3.org/2000/svg";
	let view = null;
	let timer = null;
	let queue = Promise.resolve();

	function el(tag, props, ...kids) {
		const node = document.createElement(tag);
		for (const [key, value] of Object.entries(props || {})) {
			if (value === undefined || value === false) continue;
			if (key === "text") node.textContent = value;
			else if (key === "class") node.className = value;
			else node.setAttribute(key, value === true ? "" : String(value));
		}
		for (const kid of kids) if (kid) node.append(kid);
		return node;
	}
	function svg(tag, attrs, text) {
		const node = document.createElementNS(SVG, tag);
		for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
		if (text !== undefined) node.textContent = text;
		return node;
	}

	// Actions go one after the other, so a key that sends two (choose, then continue) keeps its order.
	function post(action) {
		queue = queue.then(() => request("POST", action));
		return queue;
	}
	async function request(method, action) {
		try {
			const res = await fetch("/api/installer", {
				method,
				credentials: "same-origin",
				headers: method === "POST" ? { "content-type": "application/json" } : {},
				body: method === "POST" ? JSON.stringify(action) : undefined,
			});
			if (!res.ok && res.status !== 409) throw new Error("HTTP " + res.status);
			const next = await res.json();
			if (next.screen) show(next);
		} catch (error) {
			const text = view ? view.text.error : "{error}";
			app.replaceChildren(el("p", { class: "message error", role: "alert", text: text.replace("{error}", String(error.message || error)) }));
		}
	}

	function schedule() {
		clearTimeout(timer);
		if (view && view.pending && !view.finished) timer = setTimeout(() => request("GET"), 600);
	}

	function show(next) {
		const active = document.activeElement;
		const kept = active && active.dataset ? { index: active.dataset.index, button: active.dataset.button } : {};
		view = next;
		document.title = view.text.title;
		if (view.finished) {
			finish();
			return;
		}
		app.replaceChildren(draw());
		const target = kept.index !== undefined ? app.querySelector('input[data-index="' + view.screen.cursor + '"]') : kept.button ? app.querySelector('[data-button="' + kept.button + '"]') : null;
		if (target) target.focus();
		schedule();
	}

	function finish() {
		clearTimeout(timer);
		const { outcome, text } = view;
		if (outcome === "panel") {
			app.replaceChildren(el("p", { class: "message", text: text.panel }));
			location.assign("/");
			return;
		}
		app.replaceChildren(el("p", { class: "message", role: "status", text: outcome === "advanced" ? text.advanced : text.closed }));
	}

	function draw() {
		const { screen, text } = view;
		const steps = el("ol", { class: "steps", "aria-label": text.steps });
		for (const item of screen.sidebar) {
			const mark = item.status === "done" ? "✓" : item.status === "current" ? "●" : "○";
			steps.append(el("li", { class: item.status, "aria-current": item.status === "current" ? "step" : false, text: mark + " " + item.label }));
		}
		const main = el("main", { class: "main" });
		main.append(el("p", { class: "stepof", text: text.stepOf }), el("h1", { text: screen.title }));
		for (const line of screen.body) main.append(el("p", { text: line }));
		main.append(control(screen.control, screen.cursor));
		if (screen.diagram) main.append(diagram(screen.diagram));
		if (screen.helpOpen) {
			main.append(el("section", { class: "help", "aria-label": text.help }, el("p", { text: screen.help.text }), el("span", { class: "dim", text: text.helpName }), el("span", { class: "dim", text: text.helpFile })));
		}
		main.append(buttons(screen));
		return el("div", { class: "shell" }, el("nav", {}, steps), main);
	}

	function control(c, cursor) {
		if (c.kind === "choice") {
			const group = el("div", { role: "radiogroup" });
			c.items.forEach((item, i) => {
				const input = el("input", { type: "radio", name: "choice", "data-index": i, checked: i === c.selected });
				input.addEventListener("click", () => post({ type: "select", index: i }));
				const what = el("span", { class: "what", text: item.label });
				if (item.recommended && item.label !== view.text.recommended) what.append(el("span", { class: "tag", text: " [" + view.text.recommended + "]" }));
				const label = el("label", { class: "card" + (i === c.selected ? " selected" : "") + (i === cursor ? " cursor" : "") }, input, el("span", {}, what, item.description ? el("span", { class: "desc", text: item.description }) : null));
				group.append(label);
			});
			return group;
		}
		if (c.kind === "checklist") {
			const list = el("div", { role: "group" });
			c.items.forEach((item, i) => {
				const input = el("input", { type: "checkbox", "data-index": i, checked: item.checked });
				input.addEventListener("click", () => post({ type: "toggle", index: i }));
				const body = el("span", {}, el("span", { class: "what", text: item.label }));
				if (item.detail) body.append(el("span", { class: "desc", text: item.detail }));
				if (item.warning) body.append(el("span", { class: "warn", text: "⚠ " + item.warning }));
				const label = el("label", { class: "card" + (item.checked ? " checked" : "") + (i === cursor ? " cursor" : "") }, input, body);
				const row = el("div", { class: "row" }, label);
				if (c.openable) {
					const open = el("button", { type: "button", text: view.text.change, "data-open": i });
					open.addEventListener("click", () => post({ type: "open", index: i }));
					row.append(open);
				}
				list.append(row);
			});
			return list;
		}
		if (c.kind === "progress") {
			const icon = { done: "✓", running: "◐", pending: "○", error: "✗" };
			const list = el("ul", { class: "progress" });
			for (const item of c.items) list.append(el("li", { text: icon[item.status] + " " + item.label }));
			return list;
		}
		if (c.kind === "summary") {
			const box = el("div", { class: "summary" });
			for (const group of c.groups) {
				box.append(el("h2", { text: group.file }));
				const list = el("ul");
				for (const line of group.lines) list.append(el("li", { text: line }));
				box.append(list);
			}
			return box;
		}
		const box = el("p", { class: "message " + c.tone, role: c.tone === "error" ? "alert" : false, text: c.text });
		if (c.hint) box.append(el("span", { class: "hint", text: c.hint }));
		return box;
	}

	function diagram(d) {
		const rows = Math.max(1, d.members.length);
		const height = 20 + rows * 54;
		const middle = height / 2;
		const root = svg("svg", { class: "diagram", viewBox: "0 0 800 " + height, width: 800, height, role: "img", "aria-label": view.text.diagram });
		root.append(svg("title", {}, view.text.diagram));
		const node = (x, y, w, cls, label, sub) => {
			root.append(svg("rect", { class: "node " + cls, x, y: y - 22, width: w, height: 44, rx: 4 }));
			root.append(svg("text", { class: "node-text", x: x + 10, y: sub ? y - 2 : y + 5 }, label));
			if (sub) root.append(svg("text", { class: "node-sub", x: x + 10, y: y + 14 }, sub));
		};
		node(8, middle, 130, "agent", d.agent);
		node(190, middle, 150, "backup", d.backup);
		root.append(svg("path", { class: "edge", d: "M138 " + middle + " H190" }));
		d.members.forEach((m, i) => {
			const y = 10 + 27 + i * 54;
			root.append(svg("path", { class: "edge", d: "M340 " + middle + " H365 V" + y + " H390" }));
			node(390, y, 402, m.state, m.order + ". " + m.label, view.text.members[i]);
		});
		return root;
	}

	function buttons(screen) {
		const box = el("div", { class: "buttons" });
		const help = el("button", { type: "button", "aria-expanded": screen.helpOpen ? "true" : "false", text: "? " + view.text.help, "data-button": "help" });
		help.addEventListener("click", () => post({ type: "help" }));
		box.append(help);
		for (const b of screen.buttons) {
			const label = b.id === "back" ? "◀ " + b.label : b.id === "next" ? b.label + " ▶" : b.label;
			const node = el("button", { type: "button", class: b.primary ? "primary" : false, text: label, disabled: !b.enabled, "data-button": b.id });
			node.addEventListener("click", () => post({ type: "button", id: b.id }));
			box.append(node);
		}
		return box;
	}

	// Same keys as the terminal installer.
	document.addEventListener("keydown", press => {
		if (!view || view.finished || press.ctrlKey || press.metaKey || press.altKey) return;
		const tag = press.target && press.target.tagName;
		const screen = view.screen;
		const primary = screen.buttons.find(b => b.primary && b.enabled);
		const kind = screen.control.kind;
		const stop = () => press.preventDefault();
		switch (press.key) {
			case "ArrowUp":
			case "ArrowDown":
				stop();
				post({ type: "move", delta: press.key === "ArrowUp" ? -1 : 1 });
				break;
			case "ArrowLeft":
				stop();
				post({ type: "back" });
				break;
			case "ArrowRight":
				stop();
				post({ type: "next" });
				break;
			case "?":
				post({ type: "help" });
				break;
			case "Escape":
				post({ type: "cancel" });
				break;
			case " ":
				if (tag === "BUTTON" || tag === "INPUT") break;
				stop();
				if (kind === "checklist") post({ type: "toggle", index: screen.cursor });
				else if (kind === "choice") post({ type: "select", index: screen.cursor });
				break;
			case "Enter":
				if (tag === "BUTTON") break;
				stop();
				if (kind === "choice") post({ type: "select", index: screen.cursor });
				if (kind === "checklist" && screen.control.openable) post({ type: "open", index: screen.cursor });
				else if (primary) post({ type: "button", id: primary.id });
				break;
		}
	});

	request("GET");
})();
`;
}
