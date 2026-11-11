// The installer in the browser. The model (`installer-model.ts`) lives on the server: this module holds the one active session
// (state + the host that runs its effects), validates the actions the page sends, and serves the page that draws `installerScreen(state)`.
// The terminal installer runs on the same session, so both channels run identical effects.

import { t } from "./i18n/index.ts";
import { mascotPoseFor } from "./installer-mascot.ts";
export { installerPageScript, installerPageStyle } from "./web-installer-page.ts";
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
	"last-resort": true,
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
	const pose = mascotPoseFor(screen.step, Boolean(screen.pending)) ?? "idle";
	const reduceMotion = process.env.AI_BALANCER_REDUCE_MOTION === "1";
	return {
		screen,
		pending: session.pending,
		finished: session.outcome !== undefined,
		outcome: session.outcome,
		pose,
		reduceMotion,
		text: {
			title: t("installer.web.page.title"),
			steps: t("installer.web.page.steps"),
			stepOf: t("installer.tui.stepOf", { n: screen.stepNumber, total: screen.stepCount }),
			recommended: t("installer.tui.recommended"),
			help: t("installer.tui.helpTitle"),
			helpWhat: t("installer.tui.helpWhat"),
			helpPurpose: t("installer.tui.helpPurpose"),
			helpIf: t("installer.tui.helpIf"),
			helpName: t("installer.tui.helpName", { name: screen.help.focus?.technicalName ?? screen.help.technicalName }),
			helpFile: t("installer.tui.helpFile", { file: screen.help.focus?.file ?? screen.help.file }),
			guideName: t("installer.web.page.guide"),
			mascot: t("installer.web.page.mascot"),
			elapsed: t("installer.tui.pending.elapsed", { seconds: "{seconds}" }),
			change: t("installer.web.page.change"),
			working: t("installer.web.page.working"),
			diagram: t("installer.web.page.diagram"),
			closed: t("installer.web.page.closed"),
			advanced: t("installer.web.page.advanced"),
			panel: t("installer.web.page.panel"),
			cancelled: t("installer.web.cancelled"),
			cancelledHint: t("installer.web.page.cancelledHint"),
			error: t("installer.web.page.error", { error: "{error}" }),
			members: (screen.diagram?.members ?? []).map(m => (m.state === "active" ? `✓ ${t("installer.tui.diagram.active")}` : t("installer.tui.diagram.standby", { n: m.order - 1 }))),
		},
	};
}

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
