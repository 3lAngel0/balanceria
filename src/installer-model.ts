// The renderer-agnostic installer: ONE data model that the terminal and the web page both draw.
// Pure: no rendering, no ANSI, no I/O. Hosts run the effects (scan, install, undo...) and report back through the `with*` reducers.

import { t } from "./i18n/index.ts";
import type { OrchestratorMode, ProfileWorkflow } from "./profiles.ts";
import type { RoutingStrategy } from "./router.ts";
import { buildAvailableModelTargets, recommendRolesHeuristic, ROLE_CATALOG, UNASSIGNED, type AdvisorReport, type RoleRecommendation } from "./setup-advisor.ts";
import {
	backupName,
	buildRecommendedDraft,
	activeRoles,
	findRepairs,
	friendlyModel,
	refLabel as planRefLabel,
	roleName,
	summaryByFile,
	suggestBackups,
	targetLabel,
	type FileSummary,
	type Repair,
} from "./installer-plan.ts";
import {
	applyAdvisorReport,
	applyAutoAssignRoles,
	createPoolFromTemplate,
	initStepper,
	poolCostWarning,
	setOrchestratorMode,
	setRole,
	toggleCandidate,
	toggleProvider,
	validateStep,
	type SetupStepperState,
	type StepperCurrent,
} from "./setup-stepper.ts";
import { moveCandidateInList, toggleCandidateInList, type DetectedProvider, type PoolConfig } from "./setup.ts";

export { friendlyModel };

export const INSTALLER_STEPS = ["welcome", "type", "scan", "subscriptions", "backups", "tasks", "main-agent", "summary", "installing", "done"] as const;
export type InstallerStep = (typeof INSTALLER_STEPS)[number];
export type InstallType = "recommended" | "custom" | "advanced";
export type ExistingMode = "modify" | "repair" | "fresh";
export type ProgressStatus = "pending" | "running" | "done" | "error";

export const INSTALL_PROGRESS_STEPS = ["copies", "backups", "tasks", "sessions"] as const;
const WIZARD_PHASES = ["template", "members", "order", "strategy"] as const;
export type WizardPhase = (typeof WIZARD_PHASES)[number];
const BACKUP_TEMPLATES = ["claude-opus-5-5", "claude-sonnet-5-5", "orchestrator"] as const;
const STRATEGIES: readonly RoutingStrategy[] = ["hybrid", "waterfall", "highest-quota"];
const MODES: readonly OrchestratorMode[] = ["organic", "full-delegation"];
const TYPES: readonly InstallType[] = ["recommended", "custom", "advanced"];
const EXISTING_MODES: readonly ExistingMode[] = ["modify", "repair", "fresh"];

export interface BackupWizard {
	phase: WizardPhase;
	/** Highlighted template in the first phase. */
	templateIndex: number;
	id: string;
	/** `provider/model` members, in the order they are used. */
	members: string[];
	strategy: RoutingStrategy;
}

export type ScanState =
	| { status: "idle" }
	| { status: "scanning" }
	| { status: "done"; found: { id: string; label: string }[] }
	| { status: "error"; error?: string };

export interface RepairChoice extends Repair {
	checked: boolean;
}

export interface InstallerState {
	step: InstallerStep;
	installType: InstallType;
	existing?: { mode: ExistingMode };
	draft: SetupStepperState;
	/** The live files, for the summary and for repairs. */
	current: StepperCurrent;
	cursor: number;
	wizard?: BackupWizard;
	/** The deep-analysis model picker; `model` is the chosen one. */
	deepAnalysis?: { model?: string };
	/** The picker that chooses the model of one agent task (the highlighted row is `cursor`). */
	taskPicker?: { role: string };
	scan: ScanState;
	progress: { id: string; status: ProgressStatus }[];
	installError?: string;
	/** `.bak` files written by the last install. */
	backups: string[];
	repairs: RepairChoice[];
	/** Once the user edited backups, going back to the subscriptions does not rebuild the suggestions. */
	backupsTouched: boolean;
	notice: string[];
	helpOpen: boolean;
	cancelled: boolean;
	finished: boolean;
}

export interface InstallerInit {
	detected: DetectedProvider[];
	current?: StepperCurrent;
	workflow?: ProfileWorkflow | OrchestratorMode;
	/** Whether a config already exists; derived from the current pools or profile when omitted. */
	installed?: boolean;
}

export type ButtonId = "back" | "next" | "cancel" | "retry" | "install" | "open-panel" | "exit" | "undo" | "assign-recommended" | "assign-task" | "deep-analysis" | "create-backup";

export interface ChoiceItem {
	id: string;
	label: string;
	description: string;
	recommended?: boolean;
}
export interface ChecklistItem {
	id: string;
	label: string;
	detail: string;
	checked: boolean;
	recommended?: boolean;
	warning?: string;
}
export type InstallerControl =
	| { kind: "choice"; items: ChoiceItem[]; selected: number }
	/** `openable`: Enter (or a click on the details) opens a picker for the row instead of going on. */
	| { kind: "checklist"; items: ChecklistItem[]; openable?: boolean }
	| { kind: "progress"; items: { label: string; status: ProgressStatus }[] }
	| { kind: "summary"; groups: FileSummary[] }
	| { kind: "message"; tone: "info" | "error"; text: string; hint?: string };

export interface InstallerDiagram {
	agent: string;
	backup: string;
	members: { label: string; order: number; state: "active" | "standby" }[];
}

export interface InstallerScreen {
	step: InstallerStep;
	sidebar: { id: InstallerStep; label: string; status: "done" | "current" | "pending" }[];
	stepNumber: number;
	stepCount: number;
	title: string;
	body: string[];
	control: InstallerControl;
	diagram?: InstallerDiagram;
	help: { text: string; technicalName: string; file: string };
	helpOpen: boolean;
	cursor: number;
	buttons: { id: ButtonId; label: string; enabled: boolean; primary?: boolean }[];
}

export type InstallerAction =
	| { type: "next" }
	| { type: "back" }
	| { type: "cancel" }
	| { type: "move"; delta: number }
	| { type: "toggle"; index: number }
	| { type: "select"; index: number }
	| { type: "open"; index: number }
	| { type: "button"; id: ButtonId }
	| { type: "help" };

export type InstallerEffect = "scan" | "install" | "undo" | "open-panel" | "exit" | "advanced" | { type: "deep-analysis"; model: string; roles: string[] };

// ---------------------------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------------------------

function currentPools(current: StepperCurrent): PoolConfig[] {
	const list = (current.pools as { pools?: unknown } | null | undefined)?.pools;
	if (!Array.isArray(list)) return [];
	return list.filter((p): p is PoolConfig => typeof p?.id === "string" && Array.isArray(p.candidates));
}

const detectedOnly = (providers: readonly DetectedProvider[]) => providers.filter(p => p.detected);
const enabledProviders = (draft: SetupStepperState) => draft.detected.filter(p => p.detected && draft.enabled.includes(p.id));
const enabledRefs = (draft: SetupStepperState) => enabledProviders(draft).flatMap(p => p.availableModels.map(model => `${p.id}/${model}`));
const providerOf = (ref: string) => ref.slice(0, ref.indexOf("/"));
const modelOf = (ref: string) => ref.slice(ref.indexOf("/") + 1);

const refLabel = (draft: SetupStepperState, ref: string) => planRefLabel(ref, draft.detected);
const poolName = (pool: { id: string; name?: string }) => backupName(pool);

/** A backup member: just the subscription when the backup is for one model, "model · subscription" when it mixes several. */
function memberLabel(draft: SetupStepperState, pool: PoolConfig, ref: string): string {
	const single = new Set(pool.candidates.map(modelOf)).size <= 1;
	return single ? (draft.detected.find(p => p.id === providerOf(ref))?.label ?? providerOf(ref)) : refLabel(draft, ref);
}

/** Pools with at least one member in an enabled subscription (the ones Install would write). */
function livePools(draft: SetupStepperState): PoolConfig[] {
	return draft.pools.filter(pool => pool.candidates.some(ref => draft.enabled.includes(providerOf(ref))));
}

function advisorFor(draft: SetupStepperState): AdvisorReport {
	return recommendRolesHeuristic({ providers: enabledProviders(draft), pools: draft.pools });
}

function draftFromCurrent(detected: DetectedProvider[], current: StepperCurrent, workflow: InstallerInit["workflow"]): SetupStepperState {
	return initStepper(detected, currentPools(current), activeRoles(current), workflow);
}

export function initInstaller(input: InstallerInit): InstallerState {
	const current = input.current ?? {};
	const installed = input.installed ?? (currentPools(current).length > 0 || Object.keys(activeRoles(current)).length > 0);
	const draft = installed
		? draftFromCurrent(input.detected, current, input.workflow)
		: buildRecommendedDraft({ detected: input.detected, workflow: input.workflow });
	const targets = buildAvailableModelTargets(enabledProviders(draft), currentPools(current));
	const fixes = Object.fromEntries(advisorFor(draft).recommendations.map(r => [r.role, r.recommendedModel]));
	return {
		step: "welcome",
		installType: "recommended",
		...(installed ? { existing: { mode: "modify" as const } } : {}),
		draft,
		current,
		cursor: 0,
		scan: { status: "idle" },
		progress: INSTALL_PROGRESS_STEPS.map(id => ({ id, status: "pending" as const })),
		backups: [],
		repairs: installed ? findRepairs(current, targets, fixes).map(r => ({ ...r, checked: true })) : [],
		backupsTouched: false,
		notice: [],
		helpOpen: false,
		cancelled: false,
		finished: false,
	};
}

/** The steps the chosen install visits, in order. */
function pathOf(state: InstallerState): InstallerStep[] {
	if (state.existing) {
		switch (state.existing.mode) {
			case "modify":
				return INSTALLER_STEPS.filter(s => s !== "type");
			case "repair":
				return ["welcome", "tasks", "summary", "installing", "done"];
			case "fresh":
				return ["welcome", "scan", "summary", "installing", "done"];
		}
	}
	switch (state.installType) {
		case "recommended":
			return ["welcome", "type", "scan", "summary", "installing", "done"];
		case "advanced":
			return ["welcome", "type"];
		case "custom":
			return [...INSTALLER_STEPS];
	}
}

const go = (state: InstallerState, step: InstallerStep): InstallerState => ({ ...state, step, cursor: 0, notice: [], helpOpen: false, taskPicker: undefined });

// ---------------------------------------------------------------------------------------------
// Reducers the host calls after running an effect
// ---------------------------------------------------------------------------------------------

export function withScanResult(state: InstallerState, result: { found: DetectedProvider[] } | { error: string }): InstallerState {
	if (state.step !== "scan") return state;
	if ("error" in result) return { ...state, scan: { status: "error", error: result.error } };
	const found = detectedOnly(result.found);
	if (found.length === 0) return { ...state, scan: { status: "error" } };
	const workflow = state.draft.orchestratorMode;
	const asCustom = state.installType === "custom" || state.existing?.mode === "modify";
	let draft: SetupStepperState;
	if (state.existing?.mode === "modify") draft = draftFromCurrent(result.found, state.current, workflow);
	else if (asCustom) draft = initStepper(result.found, suggestBackups(found).backups, {}, workflow);
	else draft = buildRecommendedDraft({ detected: result.found, workflow: state.existing ? undefined : workflow });
	return { ...state, draft, backupsTouched: false, scan: { status: "done", found: found.map(p => ({ id: p.id, label: p.label })) } };
}

export function withInstallProgress(state: InstallerState, id: string, status: ProgressStatus): InstallerState {
	return { ...state, progress: state.progress.map(item => (item.id === id ? { ...item, status } : item)) };
}

export function withInstallResult(state: InstallerState, result: { ok: boolean; written: string[]; backups: string[]; error?: string }): InstallerState {
	if (!result.ok) return { ...state, installError: result.error ?? t("installer.installing.unknownError") };
	const { installError: _cleared, ...rest } = state;
	return { ...go(rest, "done"), backups: result.backups, finished: true, progress: state.progress.map(i => ({ ...i, status: "done" as const })) };
}

export function withAdvisorReport(state: InstallerState, report: AdvisorReport): InstallerState {
	const { deepAnalysis: _closed, ...rest } = state;
	return { ...rest, draft: applyAdvisorReport(state.draft, report) };
}

// ---------------------------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------------------------

/** The stepper's cost warning, worded with installer vocabulary (backup, not pool). */
const costWarning = (pool: { id: string; name?: string; candidates: readonly string[] }) =>
	poolCostWarning(pool as Parameters<typeof poolCostWarning>[0]) ? t("installer.costWarning", { backup: poolName(pool) }) : undefined;
const help = (key: string) => ({ text: t(`installer.help.${key}.text`), technicalName: t(`installer.help.${key}.tech`), file: t(`installer.help.${key}.file`) });
const button = (id: ButtonId, enabled = true, primary = false, label = t(`installer.button.${id}`)) => ({ id, label, enabled, ...(primary ? { primary: true } : {}) });
const standardButtons = (state: InstallerState, nextEnabled = true) => [
	button("back", state.step !== "welcome" && pathOf(state).indexOf(state.step) > 0),
	button("next", nextEnabled, true),
	button("cancel"),
];

function choice(prefix: string, ids: readonly string[], selected: number, recommendedId?: string): InstallerControl {
	return {
		kind: "choice",
		selected,
		items: ids.map(id => ({ id, label: t(`${prefix}.${id}.label`), description: t(`${prefix}.${id}.desc`), ...(id === recommendedId ? { recommended: true } : {}) })),
	};
}

interface BackupItem {
	pool: PoolConfig;
	ref: string;
}

/** Every member a backup could have: its own plus the same model in the other enabled subscriptions. */
function backupItems(draft: SetupStepperState): BackupItem[] {
	const refs = enabledRefs(draft);
	return livePools(draft).flatMap(pool => {
		const models = new Set(pool.candidates.map(modelOf));
		const extra = refs.filter(ref => models.has(modelOf(ref)) && !pool.candidates.includes(ref));
		return [...pool.candidates.filter(ref => draft.enabled.includes(providerOf(ref))), ...extra].map(ref => ({ pool, ref }));
	});
}

function diagramOf(draft: SetupStepperState, pool: { id: string; name?: string }, members: readonly string[]): InstallerDiagram {
	const live = members.filter(ref => draft.enabled.includes(providerOf(ref)));
	return {
		agent: t("installer.diagram.agent"),
		backup: poolName(pool),
		members: live.map((ref, i) => ({ label: refLabel(draft, ref), order: i + 1, state: i === 0 ? "active" : "standby" })),
	};
}

function ownLimit(models: readonly string[]): string {
	return models.length > 0
		? t("installer.subscriptions.detail", { models: models.map(friendlyModel).join(", ") })
		: t("installer.subscriptions.detailNoModels");
}

function installStepLabel(id: string): string {
	return t(`installer.installing.${id}`);
}

type Content = Pick<InstallerScreen, "title" | "body" | "control" | "buttons"> & { diagram?: InstallerDiagram; help: InstallerScreen["help"] };

function wizardContent(state: InstallerState, wizard: BackupWizard): Content {
	const draft = state.draft;
	const phaseIndex = WIZARD_PHASES.indexOf(wizard.phase);
	const sub = Math.min(phaseIndex + 1, 3);
	const body = [t("installer.wizard.progress", { n: sub, total: 3 }), t(`installer.wizard.${wizard.phase}.body`), ...(wizard.phase === "members" ? [t("installer.backups.limitNote")] : [])];
	const last = wizard.phase === "strategy";
	const buttons = [
		button("back"),
		button("next", true, true, last ? t("installer.button.createBackup") : undefined),
		button("cancel", true, false, t("installer.button.cancelBackup")),
	];
	const base = { title: t(`installer.wizard.${wizard.phase}.title`), body, buttons };
	const pool = { id: wizard.id, name: wizard.id, candidates: wizard.members };
	switch (wizard.phase) {
		case "template":
			return { ...base, control: choice("installer.wizard.template", wizardTemplates(draft), wizard.templateIndex), help: help("backups") };
		case "members": {
			const warning = costWarning(pool);
			return {
				...base,
				control: {
					kind: "checklist",
					items: enabledRefs(draft).map(ref => {
						const checked = wizard.members.includes(ref);
						return { id: ref, label: refLabel(draft, ref), detail: "", checked, ...(checked && warning && /flash|claude/i.test(ref) ? { warning } : {}) };
					}),
				},
				diagram: diagramOf(draft, pool, wizard.members),
				help: help("backups"),
			};
		}
		case "order":
			return {
				...base,
				control: { kind: "checklist", items: wizard.members.map((ref, i) => ({ id: ref, label: refLabel(draft, ref), detail: t("installer.wizard.order.position", { n: i + 1 }), checked: true })) },
				diagram: diagramOf(draft, pool, wizard.members),
				help: help("backups"),
			};
		case "strategy":
			return {
				...base,
				control: choice("installer.strategy", STRATEGIES, STRATEGIES.indexOf(wizard.strategy), "hybrid"),
				diagram: diagramOf(draft, pool, wizard.members),
				help: help("strategy"),
			};
	}
}

const wizardTemplates = (draft: SetupStepperState): string[] => [...BACKUP_TEMPLATES.filter(id => !draft.pools.some(p => p.id === id)), "custom"];

/** What a task can point to: the enabled backups first (they never stop), then the models of the enabled subscriptions. */
const pickerTargets = (draft: SetupStepperState): string[] => [...livePools(draft).map(p => `pool/${p.id}`), ...enabledRefs(draft)];

function tasksContent(state: InstallerState): Content {
	const draft = state.draft;
	if (state.existing?.mode === "repair") {
		if (state.repairs.length === 0) {
			return {
				title: t("installer.repair.title"),
				body: [t("installer.repair.body")],
				control: { kind: "message", tone: "info", text: t("installer.repair.none") },
				buttons: standardButtons(state),
				help: help("tasks"),
			};
		}
		return {
			title: t("installer.repair.title"),
			body: [t("installer.repair.body")],
			control: {
				kind: "checklist",
				items: state.repairs.map(r => ({
					id: r.role,
					label: roleName(r.role),
					detail: t("installer.repair.detail", { from: targetLabel(r.model, draft.detected), to: r.fix ? targetLabel(r.fix, draft.detected) : t("installer.repair.noFix") }),
					checked: r.checked,
				})),
			},
			buttons: standardButtons(state),
			help: help("tasks"),
		};
	}
	const names = ROLE_CATALOG.map(e => roleName(e.role));
	if (state.deepAnalysis) {
		const refs = enabledRefs(draft);
		const chosen = state.deepAnalysis.model;
		return {
			title: t("installer.tasks.title"),
			body: [t("installer.tasks.deepIntro", { tasks: names.join(", ") })],
			control: { kind: "choice", selected: Math.max(0, refs.indexOf(chosen ?? "")), items: refs.map(ref => ({ id: ref, label: refLabel(draft, ref), description: t("installer.subscriptions.ownLimit") })) },
			buttons: [button("back"), button("deep-analysis", chosen !== undefined, true), button("cancel")],
			help: help("tasks"),
		};
	}
	const recommended = new Map(advisorFor(draft).recommendations.map(r => [r.role, r] as const));
	if (state.taskPicker) {
		const role = state.taskPicker.role;
		const rec = recommended.get(role)?.recommendedModel;
		return {
			title: t("installer.tasks.title"),
			body: [t("installer.tasks.pickerIntro", { task: roleName(role) })],
			control: {
				kind: "choice",
				selected: Math.max(0, Math.min(state.cursor, pickerTargets(draft).length - 1)),
				items: pickerTargets(draft).map(target => ({
					id: target,
					label: targetLabel(target, draft.detected),
					description: t(target.startsWith("pool/") ? "installer.tasks.backupDesc" : "installer.tasks.directDesc"),
					...(target === rec ? { recommended: true } : {}),
				})),
			},
			buttons: [button("back"), button("assign-task", true, true), button("cancel")],
			help: help("tasks"),
		};
	}
	return {
		title: t("installer.tasks.title"),
		body: [t("installer.tasks.body")],
		control: {
			kind: "checklist",
			openable: true,
			items: ROLE_CATALOG.map(entry => {
				const rec = recommended.get(entry.role);
				const now = draft.roles[entry.role]?.model;
				return {
					id: entry.role,
					label: roleName(entry.role),
					detail: [
						t(`installer.role.${entry.role}.does`),
						t("installer.tasks.uses", { level: t(`installer.consumption.${entry.category}`) }),
						t("installer.tasks.state", {
							now: now && now !== UNASSIGNED ? targetLabel(now, draft.detected) : t("installer.tasks.notAssigned"),
							model: rec ? targetLabel(rec.recommendedModel, draft.detected) : "-",
						}),
					].join(" "),
					checked: Boolean(rec) && now === rec!.recommendedModel,
					recommended: true,
				};
			}),
		},
		buttons: [...standardButtons(state), button("assign-recommended"), button("deep-analysis")],
		help: help("tasks"),
	};
}

function content(state: InstallerState): Content {
	const draft = state.draft;
	const step = state.step;
	switch (step) {
		case "welcome":
			return {
				title: t("installer.welcome.title"),
				body: [t("installer.welcome.what1"), t("installer.welcome.what2"), t("installer.welcome.what3")],
				control: state.existing
					? choice("installer.existing", EXISTING_MODES, EXISTING_MODES.indexOf(state.existing.mode), "modify")
					: { kind: "message", tone: "info", text: t("installer.welcome.time"), hint: t("installer.welcome.safe") },
				buttons: standardButtons(state),
				help: help("welcome"),
			};
		case "type":
			return {
				title: t("installer.type.title"),
				body: [t("installer.type.body")],
				control: choice("installer.type", TYPES, TYPES.indexOf(state.installType), "recommended"),
				buttons: standardButtons(state),
				help: help("type"),
			};
		case "scan": {
			const scan = state.scan;
			if (scan.status === "error") {
				return {
					title: t("installer.scan.errorTitle"),
					body: [t("installer.scan.errorBody")],
					control: { kind: "message", tone: "error", text: scan.error ?? t("installer.scan.none"), hint: t("installer.scan.hint") },
					buttons: [button("back"), button("next", false, false), button("cancel"), button("retry", true, true)],
					help: help("scan"),
				};
			}
			const items =
				scan.status === "done"
					? scan.found.map(f => ({ label: f.label, status: "done" as const }))
					: [{ label: t("installer.scan.looking"), status: scan.status === "scanning" ? ("running" as const) : ("pending" as const) }];
			return {
				title: t("installer.scan.title"),
				body: [t("installer.scan.body")],
				control: { kind: "progress", items },
				buttons: standardButtons(state, scan.status === "done"),
				help: help("scan"),
			};
		}
		case "subscriptions":
			return {
				title: t("installer.subscriptions.title"),
				body: [t("installer.subscriptions.body"), ...state.notice],
				control: {
					kind: "checklist",
					items: draft.detected
						.filter(p => p.detected)
						.map(p => ({ id: p.id, label: p.label, detail: ownLimit(p.availableModels), checked: draft.enabled.includes(p.id), recommended: true })),
				},
				buttons: standardButtons(state),
				help: help("subscriptions"),
			};
		case "backups": {
			const items = backupItems(draft);
			const focus = items[Math.min(state.cursor, items.length - 1)]?.pool;
			const { single } = suggestBackups(enabledProviders(draft));
			const owner = (provider: string) => draft.detected.find(p => p.id === provider)?.label ?? provider;
			return {
				title: t("installer.backups.title"),
				body: [
					t("installer.backups.body"),
					t("installer.backups.limitNote"),
					...(items.length === 0 ? [t("installer.backups.none")] : []),
					...single.map(s => t("installer.backups.single", { model: friendlyModel(s.model), subscription: owner(s.provider) })),
				],
				control: {
					kind: "checklist",
					items: items.map(({ pool, ref }) => {
						const checked = pool.candidates.includes(ref);
						const warning = costWarning(pool);
						return {
							id: `${pool.id}:${ref}`,
							label: t("installer.backups.item", { backup: poolName(pool), member: memberLabel(draft, pool, ref) }),
							detail: "",
							checked,
							recommended: true,
							...(checked && warning ? { warning } : {}),
						};
					}),
				},
				...(focus ? { diagram: diagramOf(draft, focus, focus.candidates) } : {}),
				buttons: [...standardButtons(state), button("create-backup")],
				help: help("backups"),
			};
		}
		case "tasks":
			return tasksContent(state);
		case "main-agent":
			return {
				title: t("installer.mainAgent.title"),
				body: [t("installer.mainAgent.body")],
				control: choice("installer.mode", MODES, MODES.indexOf(draft.orchestratorMode), "organic"),
				buttons: standardButtons(state),
				help: help("main-agent"),
			};
		case "summary": {
			const errors = validateStep(draft, "confirm");
			return {
				title: t("installer.summary.title"),
				body: [t("installer.summary.intro"), t("installer.summary.bak"), ...errors],
				control: { kind: "summary", groups: summaryByFile(draft, state.current) },
				buttons: [button("back"), button("install", errors.length === 0, true), button("cancel")],
				help: help("summary"),
			};
		}
		case "installing":
			return {
				title: t("installer.installing.title"),
				body: [t("installer.installing.body"), ...(state.installError ? [t("installer.installing.failed", { error: state.installError })] : [])],
				control: { kind: "progress", items: state.progress.map(i => ({ label: installStepLabel(i.id), status: i.status })) },
				buttons: state.installError ? [button("retry", true, true), button("exit")] : [button("cancel", false)],
				help: help("installing"),
			};
		case "done":
			return {
				title: t("installer.done.title"),
				body: [t("installer.done.body"), ...(state.backups.length > 0 ? [t("installer.done.backups", { count: state.backups.length })] : [])],
				control: { kind: "summary", groups: summaryByFile(draft, state.current) },
				buttons: [button("open-panel", true, true), button("exit"), button("undo", state.backups.length > 0)],
				help: help("done"),
			};
	}
}

export function installerScreen(state: InstallerState): InstallerScreen {
	const path = pathOf(state);
	const index = Math.max(0, path.indexOf(state.step));
	const c = state.wizard ? wizardContent(state, state.wizard) : content(state);
	const length = c.control.kind === "choice" || c.control.kind === "checklist" ? c.control.items.length : 0;
	const cursor = c.control.kind === "choice" ? c.control.selected : Math.max(0, Math.min(state.cursor, length - 1));
	return {
		step: state.step,
		sidebar: path.map((id, i) => ({ id, label: t(`installer.step.${id}`), status: i < index ? "done" : i === index ? "current" : "pending" })),
		stepNumber: index + 1,
		stepCount: path.length,
		title: c.title,
		body: c.body,
		control: c.control,
		...(c.diagram ? { diagram: c.diagram } : {}),
		help: c.help,
		helpOpen: state.helpOpen,
		cursor,
		buttons: c.buttons,
	};
}

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------

interface Result {
	state: InstallerState;
	effect?: InstallerEffect;
}

const stay = (state: InstallerState): Result => ({ state });

function startScan(state: InstallerState): Result {
	return { state: { ...go(state, "scan"), scan: { status: "scanning" } }, effect: "scan" };
}

function enter(state: InstallerState, step: InstallerStep): Result {
	return step === "scan" ? startScan(state) : stay(go(state, step));
}

function applyRepairs(state: InstallerState): InstallerState {
	let draft = state.draft;
	for (const r of state.repairs) {
		const target = r.checked && r.fix ? r.fix : r.model;
		draft = setRole(draft, r.role, target, draft.roles[r.role]?.thinking);
	}
	return { ...state, draft };
}

function leave(state: InstallerState): InstallerState {
	if (state.step === "subscriptions" && !state.backupsTouched && !state.existing && state.installType === "custom") {
		return { ...state, draft: { ...state.draft, pools: suggestBackups(enabledProviders(state.draft)).backups } };
	}
	if (state.step === "tasks" && state.existing?.mode === "repair") return applyRepairs(state);
	return state;
}

function onNext(state: InstallerState): Result {
	if (state.wizard) return wizardNext(state, state.wizard);
	if (state.taskPicker) return stay(state);
	const path = pathOf(state);
	const step = state.step;
	if (step === "summary") return { state: { ...go(state, "installing"), installError: undefined, progress: INSTALL_PROGRESS_STEPS.map(id => ({ id, status: "pending" as const })) }, effect: "install" };
	if (step === "installing" || step === "done") return stay(state);
	if (step === "welcome" && state.existing) {
		const mode = state.existing.mode;
		const installType: InstallType = mode === "fresh" ? "recommended" : "custom";
		const set = { ...state, installType };
		return enter(set, pathOf(set)[1]!);
	}
	if (step === "type" && state.installType === "advanced") return { state, effect: "advanced" };
	if (step === "scan" && state.scan.status !== "done") return stay(state);
	if (step === "subscriptions") {
		const errors = validateStep(state.draft, "providers");
		if (errors.length > 0) return stay({ ...state, notice: errors });
	}
	const after = path[path.indexOf(step) + 1];
	return after ? enter(leave(state), after) : stay(state);
}

/** Closes the task picker and puts the cursor back on the task it was opened for. */
function closePicker(state: InstallerState): InstallerState {
	const { taskPicker, ...rest } = state;
	return { ...rest, cursor: Math.max(0, ROLE_CATALOG.findIndex(e => e.role === taskPicker?.role)) };
}

function onBack(state: InstallerState): Result {
	if (state.wizard) return wizardBack(state, state.wizard);
	if (state.taskPicker) return stay(closePicker(state));
	if (state.deepAnalysis) {
		const { deepAnalysis: _closed, ...rest } = state;
		return stay(rest);
	}
	if (state.step === "installing" || state.step === "done") return stay(state);
	const path = pathOf(state);
	const before = path[path.indexOf(state.step) - 1];
	return before ? stay(go(state, before)) : stay(state);
}

function onCancel(state: InstallerState): Result {
	if (state.wizard) return stay({ ...state, wizard: undefined, cursor: 0 });
	if (state.taskPicker) return stay(closePicker(state));
	if (state.deepAnalysis) {
		const { deepAnalysis: _closed, ...rest } = state;
		return stay(rest);
	}
	if (state.step === "installing" || state.step === "done") return stay(state);
	return { state: { ...state, cancelled: true }, effect: "exit" };
}

// -- sub-wizard -------------------------------------------------------------------------------

function openWizard(state: InstallerState): InstallerState {
	return { ...state, cursor: 0, wizard: { phase: "template", templateIndex: 0, id: "", members: [], strategy: "hybrid" } };
}

function wizardNext(state: InstallerState, wizard: BackupWizard): Result {
	const draft = state.draft;
	switch (wizard.phase) {
		case "template": {
			const template = wizardTemplates(draft)[wizard.templateIndex] ?? "custom";
			const id = template === "custom" ? `custom-pool-${draft.pools.length + 1}` : template;
			const created = createPoolFromTemplate(draft, id).pools.find(p => p.id === id);
			const members = created ? [...created.candidates] : enabledRefs(draft);
			return stay({ ...state, cursor: 0, wizard: { ...wizard, phase: "members", id, members } });
		}
		case "members":
			return stay({ ...state, cursor: 0, wizard: { ...wizard, phase: "order" } });
		case "order":
			return stay({ ...state, cursor: 0, wizard: { ...wizard, phase: "strategy" } });
		case "strategy": {
			const pool: PoolConfig = { id: wizard.id, name: wizard.id, candidates: wizard.members, strategy: wizard.strategy };
			const next = { ...draft, pools: [...draft.pools.filter(p => p.id !== pool.id), pool], dirty: true };
			return stay({ ...state, draft: next, wizard: undefined, cursor: 0, backupsTouched: true });
		}
	}
}

function wizardBack(state: InstallerState, wizard: BackupWizard): Result {
	const index = WIZARD_PHASES.indexOf(wizard.phase);
	if (index === 0) return stay({ ...state, wizard: undefined, cursor: 0 });
	return stay({ ...state, cursor: 0, wizard: { ...wizard, phase: WIZARD_PHASES[index - 1]! } });
}

function wizardMove(state: InstallerState, wizard: BackupWizard, delta: number): InstallerState {
	if (wizard.phase !== "order") return state;
	const dir = delta < 0 ? -1 : 1;
	const members = moveCandidateInList(wizard.members, state.cursor, dir);
	const moved = members.some((m, i) => m !== wizard.members[i]);
	return { ...state, cursor: moved ? state.cursor + dir : state.cursor, wizard: { ...wizard, members } };
}

function wizardSelect(state: InstallerState, wizard: BackupWizard, index: number): InstallerState {
	if (wizard.phase === "template") return { ...state, cursor: index, wizard: { ...wizard, templateIndex: Math.max(0, Math.min(index, wizardTemplates(state.draft).length - 1)) } };
	if (wizard.phase === "strategy") return { ...state, cursor: index, wizard: { ...wizard, strategy: STRATEGIES[index] ?? wizard.strategy } };
	return { ...state, cursor: index };
}

function wizardToggle(state: InstallerState, wizard: BackupWizard, index: number): InstallerState {
	if (wizard.phase !== "members") return state;
	const ref = enabledRefs(state.draft)[index];
	if (!ref) return state;
	return { ...state, cursor: index, wizard: { ...wizard, members: toggleCandidateInList(wizard.members, ref) } };
}

// -- select / toggle / move ------------------------------------------------------------------------

function onSelect(state: InstallerState, index: number): InstallerState {
	if (state.wizard) return wizardSelect(state, state.wizard, index);
	const at = { ...state, cursor: index };
	switch (state.step) {
		case "welcome":
			return state.existing && EXISTING_MODES[index] ? { ...at, existing: { mode: EXISTING_MODES[index]! } } : state;
		case "type":
			return TYPES[index] ? { ...at, installType: TYPES[index]! } : state;
		case "main-agent":
			return MODES[index] ? { ...at, draft: setOrchestratorMode(state.draft, MODES[index]!) } : state;
		case "tasks": {
			const ref = enabledRefs(state.draft)[index];
			return state.deepAnalysis && ref ? { ...at, deepAnalysis: { model: ref } } : at;
		}
		default:
			return at;
	}
}

function onToggle(state: InstallerState, index: number): InstallerState {
	if (state.wizard) return wizardToggle(state, state.wizard, index);
	const draft = state.draft;
	const at = { ...state, cursor: index };
	switch (state.step) {
		case "subscriptions": {
			const provider = draft.detected.filter(p => p.detected)[index];
			return provider ? { ...at, draft: toggleProvider(draft, provider.id) } : state;
		}
		case "backups": {
			const item = backupItems(draft)[index];
			return item ? { ...at, backupsTouched: true, draft: toggleCandidate(draft, item.pool.id, item.ref) } : state;
		}
		case "tasks": {
			if (state.existing?.mode === "repair") {
				return state.repairs[index] ? { ...at, repairs: state.repairs.map((r, i) => (i === index ? { ...r, checked: !r.checked } : r)) } : state;
			}
			const entry = ROLE_CATALOG[index];
			const rec: RoleRecommendation | undefined = entry && advisorFor(draft).recommendations.find(r => r.role === entry.role);
			return entry && rec ? { ...at, draft: setRole(draft, entry.role, rec.recommendedModel, rec.thinking) } : at;
		}
		default:
			return state;
	}
}

function onMove(state: InstallerState, delta: number): InstallerState {
	if (state.wizard?.phase === "order") return wizardMove(state, state.wizard, delta);
	const c = installerScreen(state).control;
	if (c.kind !== "choice" && c.kind !== "checklist") return state;
	const target = Math.max(0, Math.min(c.items.length - 1, state.cursor + delta));
	return c.kind === "choice" ? onSelect(state, target) : { ...state, cursor: target };
}

function onOpen(state: InstallerState, index: number): InstallerState {
	const entry = ROLE_CATALOG[index];
	if (state.step !== "tasks" || state.wizard || state.deepAnalysis || state.taskPicker || state.existing?.mode === "repair" || !entry) return state;
	const targets = pickerTargets(state.draft);
	const rec = advisorFor(state.draft).recommendations.find(r => r.role === entry.role)?.recommendedModel;
	const start = targets.indexOf(state.draft.roles[entry.role]?.model ?? rec ?? "");
	return { ...state, taskPicker: { role: entry.role }, cursor: Math.max(0, start) };
}

function assignTask(state: InstallerState): InstallerState {
	if (!state.taskPicker) return state;
	const role = state.taskPicker.role;
	const target = pickerTargets(state.draft)[state.cursor];
	if (!target) return closePicker(state);
	const thinking = state.draft.roles[role]?.thinking ?? advisorFor(state.draft).recommendations.find(r => r.role === role)?.thinking;
	return closePicker({ ...state, draft: setRole(state.draft, role, target, thinking) });
}

// -- buttons ----------------------------------------------------------------------------------------

function onButton(state: InstallerState, id: ButtonId): Result {
	const enabled = installerScreen(state).buttons.find(b => b.id === id)?.enabled;
	if (!enabled) return stay(state);
	switch (id) {
		case "back":
			return onBack(state);
		case "next":
			return onNext(state);
		case "cancel":
			return onCancel(state);
		case "install":
			return state.step === "summary" ? onNext(state) : stay(state);
		case "retry":
			return state.step === "installing"
				? { state: { ...state, installError: undefined, progress: INSTALL_PROGRESS_STEPS.map(i => ({ id: i, status: "pending" as const })) }, effect: "install" }
				: startScan(state);
		case "open-panel":
		case "exit":
		case "undo":
			return { state: id === "exit" ? { ...state, cancelled: !state.finished } : state, effect: id };
		case "assign-task":
			return stay(assignTask(state));
		case "assign-recommended":
			return stay({ ...state, draft: applyAutoAssignRoles(state.draft) });
		case "create-backup":
			return stay(openWizard({ ...state, backupsTouched: true }));
		case "deep-analysis": {
			if (!state.deepAnalysis) return stay({ ...state, cursor: 0, deepAnalysis: {} });
			const model = state.deepAnalysis.model;
			return model ? { state, effect: { type: "deep-analysis", model, roles: ROLE_CATALOG.map(e => e.role) } } : stay(state);
		}
	}
}

export function installerInput(state: InstallerState, action: InstallerAction): Result {
	switch (action.type) {
		case "next":
			return onNext(state);
		case "back":
			return onBack(state);
		case "cancel":
			return onCancel(state);
		case "move":
			return stay(onMove(state, action.delta));
		case "toggle":
			return stay(onToggle(state, action.index));
		case "select":
			return stay(onSelect(state, action.index));
		case "open":
			return stay(onOpen(state, action.index));
		case "button":
			return onButton(state, action.id);
		case "help":
			return stay({ ...state, helpOpen: !state.helpOpen });
	}
}

