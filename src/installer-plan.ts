// Pure planning behind the installer: suggested backups, the recommended draft, repairs, the per-file summary and the undo plan.
// No I/O: the host reads the files, writes through `applyStepper` and copies the `.bak` files back.

import { t } from "./i18n/index.ts";
import { DEFAULT_ORCHESTRATOR_MODE, type OrchestratorMode, type ProfileConfig, type ProfileWorkflow } from "./profiles.ts";
import { UNASSIGNED } from "./setup-advisor.ts";
import { applyAutoAssignRoles, buildStepperDiff, initStepper, type SetupStepperState, type StepperCurrent } from "./setup-stepper.ts";
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

export interface FileSummary {
	file: "integrations.json" | "pools.json" | "profiles.json";
	lines: string[];
	changed: boolean;
}

/** What Install would do, in plain words and grouped by file; `current` holds the live files. */
export function summaryByFile(draft: SetupStepperState, current: StepperCurrent): FileSummary[] {
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
		"pools.json": pools.map(pool => t("installer.summary.backup", { name: backupName(pool), members: pool.candidates.map(label).join(t("installer.summary.then")) })),
		"profiles.json": roleLines,
	};
	const changed: Record<FileSummary["file"], boolean> = {
		"integrations.json": writes.integrations,
		"pools.json": writes.pools,
		"profiles.json": writes.profiles,
	};
	return (["integrations.json", "pools.json", "profiles.json"] as const).map(file => ({
		file,
		changed: changed[file],
		lines: changed[file] ? [...lines[file], t("installer.summary.bakLine", { file })] : [t("installer.summary.unchanged")],
	}));
}

export interface UndoStep {
	/** The file to restore. */
	file: string;
	/** The `.bak` copy to restore it from. */
	backup: string;
}

/** Which backup restores which file; the host performs the copy. */
export function planUndo(backups: readonly string[]): UndoStep[] {
	return backups.filter(b => b.endsWith(".bak")).map(backup => ({ file: backup.slice(0, -".bak".length), backup }));
}
