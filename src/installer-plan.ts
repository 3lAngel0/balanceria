// Pure planning behind the installer: suggested backups, the recommended draft, repairs, the per-file summary and the undo plan.
// No I/O: the host reads the files, writes through `applyStepper` and copies the `.bak` files back.

import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { installerLoanTargets, PERMISSIONS_FILE } from "./permissions.ts";
import { t } from "./i18n/index.ts";
import { lastResortRef } from "./pools.ts";
import { DEFAULT_ORCHESTRATOR_MODE, type OrchestratorMode, type ProfileConfig, type ProfileWorkflow } from "./profiles.ts";
import { UNASSIGNED } from "./setup-advisor.ts";
import { applyAutoAssignRoles, buildStepperDiff, effectiveLastResort, effectiveLoans, initStepper, loansChanged, planLoans, type SetupStepperState, type StepperCurrent } from "./setup-stepper.ts";
import { buildBalancerProfileName, type DetectedProvider, type PoolConfig } from "./setup.ts";

export interface SingleModel {
	/** `provider/model`. */
	ref: string;
	provider: string;
	model: string;
}

const refOf = (provider: string, model: string) => `${provider}/${model}`;
const safeId = (model: string) => model.replace(/[^a-zA-Z0-9._-]/g, "-");

/** One suggested backup per model that 2+ detected subscriptions offer; models of a single subscription are listed apart. */
export function suggestBackups(providers: readonly DetectedProvider[]): { backups: PoolConfig[]; single: SingleModel[] } {
	const byModel = new Map<string, string[]>();
	for (const p of providers) {
		if (!p.detected) continue;
		for (const model of p.availableModels) byModel.set(model, [...(byModel.get(model) ?? []), p.id]);
	}
	const backups: PoolConfig[] = [];
	const single: SingleModel[] = [];
	for (const [model, owners] of byModel) {
		if (owners.length >= 2) backups.push({ id: safeId(model), name: model, candidates: owners.map(id => refOf(id, model)), strategy: "hybrid" });
		else single.push({ ref: refOf(owners[0]!, model), provider: owners[0]!, model });
	}
	return { backups, single };
}

export interface RecommendedDraftInput {
	detected: readonly DetectedProvider[];
	roles?: ProfileConfig;
	workflow?: ProfileWorkflow | OrchestratorMode;
	quotaByKey?: Readonly<Record<string, number>>;
}

/** The full recommended draft: suggested backups plus every agent task assigned (zero usage). */
export function buildRecommendedDraft(input: RecommendedDraftInput): SetupStepperState {
	const detected = [...input.detected];
	const draft = initStepper(detected, suggestBackups(detected).backups, input.roles ?? {}, input.workflow ?? DEFAULT_ORCHESTRATOR_MODE);
	return applyAutoAssignRoles(draft, input.quotaByKey);
}

export interface Repair {
	role: string;
	/** The target the task points to now. */
	model: string;
	reason: "missing-pool" | "missing-model";
	/** The proposed replacement, when one is known. */
	fix: string | undefined;
}

export function activeRoles(current: StepperCurrent): ProfileConfig {
	const name = current.profiles?.active ?? buildBalancerProfileName();
	return current.profiles?.profiles?.[name] ?? {};
}

/** Tasks pointing to backups or models that are not in `availableTargets`. */
export function findRepairs(current: StepperCurrent, availableTargets: readonly string[], fixes: Readonly<Record<string, string>> = {}): Repair[] {
	const known = new Set(availableTargets);
	const repairs: Repair[] = [];
	for (const [role, route] of Object.entries(activeRoles(current))) {
		const model = route?.model;
		if (typeof model !== "string" || model === UNASSIGNED || !model.includes("/") || known.has(model)) continue;
		repairs.push({ role, model, reason: model.startsWith("pool/") ? "missing-pool" : "missing-model", fix: fixes[role] });
	}
	return repairs;
}

/** Plain name of an agent task ("Reading files"); the technical name when the task is unknown. */
export function roleName(role: string): string {
	const key = `installer.role.${role}.name`;
	const name = t(key);
	return name === key ? role : name;
}

/** A model id in plain words: "claude-sonnet-5-5" -> "Claude Sonnet 5.5", "gemini-3-8-flash" -> "Gemini 3.8 Flash". */
export function friendlyModel(id: string): string {
	const words: string[] = [];
	let afterNumber = false;
	for (const token of id.split(/[-_\s]+/).filter(Boolean)) {
		const number = /^\d+$/.test(token);
		if (number && afterNumber) words[words.length - 1] += `.${token}`;
		else words.push(number ? token : token[0]!.toUpperCase() + token.slice(1));
		afterNumber = number;
	}
	return words.join(" ");
}

/** A backup's name in plain words; a name the user chose is kept, one that is just the id is made readable. */
export function backupName(pool: { id: string; name?: string }): string {
	const name = pool.name ?? pool.id;
	if (name !== pool.id) return name;
	const custom = /^custom-pool-(\d+)$/.exec(name);
	if (custom) return t("installer.backups.customName", { n: custom[1]! });
	return name === "orchestrator" ? t("installer.wizard.template.orchestrator.label") : friendlyModel(name);
}

type ProviderNames = readonly { id: string; label: string }[];

/** "Gemini 3.8 Flash · Google AI Pro" for a `provider/model` ref (model · subscription). */
export function refLabel(ref: string, providers: ProviderNames = []): string {
	const slash = ref.indexOf("/");
	if (slash < 0) return ref;
	const provider = ref.slice(0, slash);
	return `${friendlyModel(ref.slice(slash + 1))} · ${providers.find(p => p.id === provider)?.label ?? provider}`;
}

/** A model target in plain words: backups lose the `pool/` prefix, refs read "model · subscription". */
export function targetLabel(target: string, providers: ProviderNames = []): string {
	return target.startsWith("pool/") ? t("installer.target.backup", { name: backupName({ id: target.slice("pool/".length) }) }) : refLabel(target, providers);
}

export interface KeptBackup {
	id: string;
	/** The tasks (technical names) that still point to this backup. */
	roles: string[];
}

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/**
 * The draft with every saved backup that a task still uses: a backup referenced (`pool/<id>`) by any task of any saved profile stays,
 * unless the draft reassigns every task that uses it. Tasks of the active profile count with the draft's model when the draft sets one.
 */
export function withKeptBackups(draft: SetupStepperState, current: StepperCurrent): { draft: SetupStepperState; kept: KeptBackup[]; blocked: KeptBackup[] } {
	const live = (current.pools as { pools?: unknown } | null | undefined)?.pools;
	if (!Array.isArray(live)) return { draft, kept: [], blocked: [] };
	const on = new Set(draft.enabled);
	const have = new Set(draft.pools.filter(pool => pool.candidates.some(ref => on.has(ref.slice(0, ref.indexOf("/"))))).map(pool => pool.id));
	const users = new Map<string, Set<string>>();
	const active = current.profiles?.active ?? buildBalancerProfileName();
	for (const [name, roles] of Object.entries(current.profiles?.profiles ?? {})) {
		for (const [role, route] of Object.entries(roles ?? {})) {
			const model = name === active ? (draft.roles[role]?.model ?? route?.model) : route?.model;
			if (typeof model !== "string" || !model.startsWith("pool/")) continue;
			users.set(model.slice("pool/".length), (users.get(model.slice("pool/".length)) ?? new Set()).add(role));
		}
	}
	const kept: KeptBackup[] = [];
	const blocked: KeptBackup[] = [];
	const extra: PoolConfig[] = [];
	for (const old of live as { id?: unknown; name?: unknown; candidates?: unknown; strategy?: unknown }[]) {
		const id = old?.id;
		if (typeof id !== "string" || have.has(id) || !users.has(id)) continue;
		const candidates = strings(old.candidates);
		if (!candidates.some(ref => on.has(ref.slice(0, ref.indexOf("/"))))) {
			// Every subscription of this backup is off: it cannot be written, so the tasks that use it would point at nothing.
			blocked.push({ id, roles: [...users.get(id)!] });
			continue;
		}
		extra.push({ id, name: typeof old.name === "string" ? old.name : id, candidates, strategy: (old.strategy as PoolConfig["strategy"]) ?? "hybrid" });
		kept.push({ id, roles: [...users.get(id)!] });
	}
	return { draft: kept.length === 0 ? draft : { ...draft, pools: [...draft.pools, ...extra] }, kept, blocked };
}

/** Why Install must wait: backups still used by tasks that the draft cannot write (all their subscriptions are off). */
export function installBlockers(draft: SetupStepperState, current: StepperCurrent): string[] {
	return withKeptBackups(draft, current).blocked.map(k => t("installer.summary.blocked", { name: backupName({ id: k.id }), tasks: keptTasks(k) }));
}

const keptTasks = (kept: KeptBackup) => kept.roles.map(roleName).join(", ");

export interface FileSummary {
	file: "integrations.json" | "pools.json" | "profiles.json" | "permissions.json";
	lines: string[];
	changed: boolean;
}

/** "Last-resort model: Gemini 3.8 Flash · Google AI Pro" / "none" (nothing when there is none and none was saved). */
function lastResortLines(draft: SetupStepperState, current?: StepperCurrent): string[] {
	const ref = effectiveLastResort(draft);
	if (ref) return [t("installer.summary.lastResort", { model: refLabel(ref, draft.detected) })];
	return current !== undefined && lastResortRef(current.pools) === undefined ? [] : [t("installer.summary.lastResortNone")];
}

/** "Automatic loan: Claude Sonnet 5.5 borrows Gemini 3.8 Flash · Google AI Pro when it runs out..." per backup; says when no task uses the backup yet. */
function loanLines(draft: SetupStepperState, current: StepperCurrent): string[] {
	const used = new Set(planLoans(draft, current).map(loan => loan.poolId));
	return Object.entries(effectiveLoans(draft)).flatMap(([id, to]) => {
		const name = backupName({ id, name: draft.pools.find(pool => pool.id === id)?.name });
		const line = t("installer.summary.loan", { backup: name, model: refLabel(to, draft.detected) });
		return used.has(id) ? [line] : [line, t("installer.summary.loanNoTasks", { backup: name })];
	});
}

/** What Install would do, in plain words and grouped by file; `current` holds the live files. */
export function summaryByFile(plain: SetupStepperState, current: StepperCurrent): FileSummary[] {
	const { draft, kept } = withKeptBackups(plain, current);
	const { writes } = buildStepperDiff(draft, current);
	const on = new Set(draft.enabled);
	const label = (ref: string) => refLabel(ref, draft.detected);
	const pools = draft.pools
		.map(pool => ({ ...pool, candidates: pool.candidates.filter(ref => on.has(ref.slice(0, ref.indexOf("/")))) }))
		.filter(pool => pool.candidates.length > 0);
	const live = activeRoles(current);
	const roleLines = Object.entries(draft.roles)
		.filter(([role, route]) => live[role]?.model !== route.model)
		.map(([role, route]) => t("installer.summary.task", { task: roleName(role), model: targetLabel(route.model, draft.detected) }));
	if (draft.orchestratorMode !== draft.baseline.orchestratorMode) {
		roleLines.push(t("installer.summary.mainAgent", { mode: t(`installer.mode.${draft.orchestratorMode}.label`) }));
	}
	const lines: Record<FileSummary["file"], string[]> = {
		"integrations.json": draft.detected.filter(p => on.has(p.id)).map(p => t("installer.summary.connect", { name: p.label })),
		"pools.json": [
			...pools.map(pool => t("installer.summary.backup", { name: backupName(pool), members: pool.candidates.map(label).join(t("installer.summary.then")) })),
			...kept.map(k => t("installer.summary.kept", { name: backupName({ id: k.id }), tasks: keptTasks(k) })),
			...lastResortLines(draft, current),
		],
		"profiles.json": roleLines,
	};
	const changed: Record<FileSummary["file"], boolean> = {
		"integrations.json": writes.integrations,
		"pools.json": writes.pools,
		"profiles.json": writes.profiles,
	};
	const groups = (["integrations.json", "pools.json", "profiles.json"] as const).map(file => ({
		file: file as FileSummary["file"],
		changed: changed[file],
		lines: changed[file] ? [...lines[file], t("installer.summary.bakLine", { file })] : [t("installer.summary.unchanged")],
	}));
	// The grants file shows only when there are loans or the installer had some before.
	const loans = loanLines(draft, current);
	const before = current.grants !== undefined && Object.keys(installerLoanTargets(current.grants, Date.now())).length > 0;
	if (loans.length > 0 || before) {
		const file = "permissions.json";
		const grantsChanged = loansChanged(draft, current);
		const unused = loans.length !== Object.keys(effectiveLoans(draft)).length;
		groups.push({ file, changed: grantsChanged, lines: grantsChanged ? [...(loans.length > 0 ? loans : [t("installer.summary.loansNone")]), t("installer.summary.bakLine", { file })] : unused ? loans : [t("installer.summary.unchanged")] });
	}
	return groups;
}

export interface UndoStep {
	/** The file to restore. */
	file: string;
	/** The `.bak` copy to restore it from. */
	backup: string;
}

const INSTALLER_COPY = /^(.*)\.bak-installer-\d{14}(?:-\d+)?$/;

/** Which backup restores which file; the host performs the copy. Knows `<file>.bak` and `<file>.bak-installer-<YYYYMMDDHHMMSS>[-n]`. */
export function planUndo(backups: readonly string[]): UndoStep[] {
	const steps: UndoStep[] = [];
	for (const backup of backups) {
		const copy = INSTALLER_COPY.exec(backup);
		if (copy) steps.push({ file: copy[1]!, backup });
		else if (backup.endsWith(".bak")) steps.push({ file: backup.slice(0, -".bak".length), backup });
	}
	return steps;
}

/** The file operations of the per-install copies; injectable so tests run on a temp dir or in memory. */
export interface InstallFs {
	exists(path: string): boolean;
	copy(from: string, to: string): void;
	remove(path: string): void;
}

export const nodeInstallFs: InstallFs = { exists: existsSync, copy: copyFileSync, remove: path => rmSync(path, { force: true }) };

/** Every file an install may write, for `snapshotForInstall`: the three configs and the grants file (automatic loans). */
export function installerSnapshotFiles(root: string, dataDir: string, profilesPath: string): string[] {
	return [join(root, "pools.json"), join(root, "integrations.json"), profilesPath, join(dataDir, PERMISSIONS_FILE)];
}

export interface InstallSnapshot {
	/** The copies made by this install, one per file that existed. */
	backups: string[];
	/** Files that did not exist before the install: Undo removes them. */
	created: string[];
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");
const stamp = (now: Date) => `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

/** Copies each existing file to `<file>.bak-installer-<YYYYMMDDHHMMSS>` (a `-2`, `-3`... suffix when the name is taken), never overwriting a copy. */
export function snapshotForInstall(files: readonly string[], fs: InstallFs, now: Date = new Date()): InstallSnapshot {
	const snapshot: InstallSnapshot = { backups: [], created: [] };
	for (const file of files) {
		if (!fs.exists(file)) {
			snapshot.created.push(file);
			continue;
		}
		const base = `${file}.bak-installer-${stamp(now)}`;
		let copy = base;
		for (let n = 2; fs.exists(copy); n += 1) copy = `${base}-${n}`;
		fs.copy(file, copy);
		snapshot.backups.push(copy);
	}
	return snapshot;
}

/** Decides what to do with an install's snapshot once the install ran. A failed install that wrote nothing has nothing to undo: its copies are removed and no backups are reported (so Undo stays off). Any other install keeps the snapshot. */
export function settleInstallSnapshot(snapshot: InstallSnapshot, result: { ok: boolean; written: readonly string[] }, fs: InstallFs): { keep: boolean; backups: string[] } {
	if (!result.ok && result.written.length === 0) {
		for (const copy of snapshot.backups) fs.remove(copy);
		return { keep: false, backups: [] };
	}
	return { keep: true, backups: snapshot.backups };
}

/** Puts the files back as they were before that install; returns how many files were restored or removed. Old copies are kept. */
export function undoInstall(snapshot: InstallSnapshot, fs: InstallFs): number {
	const steps = planUndo(snapshot.backups);
	for (const step of steps) fs.copy(step.backup, step.file);
	let removed = 0;
	for (const file of snapshot.created) {
		if (!fs.exists(file)) continue;
		fs.remove(file);
		removed += 1;
	}
	return steps.length + removed;
}

export interface SummaryStory {
	/** One paragraph in plain words: what the balancer will do with the chosen configuration. */
	narrative: string;
	/** The configuration, line by line: subscriptions, each backup in order with how it chooses, each task, main agent, files. */
	detail: string[];
}

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

/** The human summary of a draft (the narrative the user reads first and the detail they review). */
export function summaryStory(plain: SetupStepperState, current: StepperCurrent): SummaryStory {
	const { draft, kept } = withKeptBackups(plain, current);
	const blockers = installBlockers(plain, current);
	const on = new Set(draft.enabled);
	const providers = draft.detected.filter(p => p.detected && on.has(p.id));
	const live = draft.pools
		.map(pool => ({ ...pool, candidates: pool.candidates.filter(ref => on.has(ref.slice(0, ref.indexOf("/")))) }))
		.filter(pool => pool.candidates.length > 0);
	const strategyOf = (pool: PoolConfig) => t(`installer.strategy.${pool.strategy ?? "hybrid"}.label`);
	const subscriptions = (pool: PoolConfig) => unique(pool.candidates.map(ref => providers.find(p => p.id === ref.slice(0, ref.indexOf("/")))?.label ?? ref.slice(0, ref.indexOf("/"))));
	const models = unique(live.length > 0 ? live.flatMap(pool => pool.candidates.map(ref => friendlyModel(ref.slice(ref.indexOf("/") + 1)))) : providers.flatMap(p => p.availableModels.map(friendlyModel)));
	const mode = t(`installer.mode.${draft.orchestratorMode}.label`);
	const names = providers.map(p => p.label).join(", ");
	const narrative = [
		t("installer.summary.narrative.balance", { providers: names }),
		live.length > 0
			? t("installer.summary.narrative.backups", { backups: live.map(pool => `${backupName(pool)} (${subscriptions(pool).join(", ")})`).join("; ") })
			: t("installer.summary.narrative.noBackups"),
		live.length > 0
			? t("installer.summary.narrative.models", { models: models.join(", "), strategies: unique(live.map(strategyOf)).join(", ") })
			: t("installer.summary.narrative.modelsOnly", { models: models.join(", ") }),
		...kept.map(k => t("installer.summary.narrative.kept", { name: backupName({ id: k.id }), tasks: keptTasks(k) })),
		...blockers,
		t("installer.summary.narrative.main", { mode }),
	].join(" ");
	const tasks = Object.entries(draft.roles).filter(([, route]) => typeof route?.model === "string" && route.model !== UNASSIGNED);
	const files = summaryByFile(draft, current).filter(group => group.changed).map(group => group.file);
	const detail = [
		t("installer.summary.detail.subscriptions", { names }),
		...live.map(pool =>
			t("installer.summary.detail.backup", {
				name: backupName(pool),
				members: pool.candidates.map((ref, i) => t("installer.summary.detail.member", { n: i + 1, label: refLabel(ref, draft.detected) })).join(", "),
				strategy: strategyOf(pool),
			}),
		),
		...(tasks.length > 0 ? tasks.map(([role, route]) => t("installer.summary.detail.task", { task: roleName(role), model: targetLabel(route.model!, draft.detected) })) : [t("installer.summary.detail.noTasks")]),
		...kept.map(k => t("installer.summary.kept", { name: backupName({ id: k.id }), tasks: keptTasks(k) })),
		...blockers,
		...lastResortLines(draft),
		...loanLines(draft, current),
		t("installer.summary.detail.mainAgent", { mode }),
		files.length > 0 ? t("installer.summary.detail.files", { files: files.join(", ") }) : t("installer.summary.detail.noFiles"),
	];
	return { narrative, detail };
}
