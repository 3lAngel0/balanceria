// Pure state machine behind the step-by-step setup wizard (Providers → Strategy → Roles → Confirm).
// No UI and no filesystem access: writes go through the functions injected in `StepperDeps`.

import type { Integration } from "./integrations.ts";
import { DEFAULT_ORCHESTRATOR_MODE, isOrchestratorMode, type OrchestratorMode, type ProfileConfig, type ProfileWorkflow } from "./profiles.ts";
import { join } from "node:path";
import { PERMISSIONS_FILE, installerGrantsMatch, syncInstallerGrants, type Grant, type InstallerLoan } from "./permissions.ts";
import { lastResortRef } from "./pools.ts";
import type { RoutingStrategy } from "./router.ts";
import { t } from "./i18n/index.ts";
import { applyRecommendationsToProfile, recommendRolesHeuristic, type AdvisorReport } from "./setup-advisor.ts";
import {
	buildBalancerProfileName,
	carryRules,
	generateConfigPreview,
	generateRecommendedConfig,
	mergeIntegrations,
	moveCandidateInList,
	toggleCandidateInList,
	type DetectedProvider,
	type PoolConfig,
} from "./setup.ts";

export const SETUP_STEPS = ["providers", "strategy", "roles", "confirm"] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];

interface StepperDraft {
	enabled: string[];
	pools: PoolConfig[];
	roles: ProfileConfig;
	orchestratorMode: OrchestratorMode;
	/** `provider/model` used when a whole backup is spent (pools.json `lastResort`); absent when there is none. */
	lastResort?: string;
	/** Automatic loans the installer manages: backup id -> `provider/model` its tasks borrow while it is spent (permissions.json). */
	loans?: Record<string, string>;
}

export interface SetupStepperState extends StepperDraft {
	step: SetupStep;
	/** Furthest step index visited; `goTo` may return to any step up to here. */
	reached: number;
	detected: DetectedProvider[];
	dirty: boolean;
	messages: Partial<Record<SetupStep, string[]>>;
	/** The draft as initialised, restored by `discard`. */
	baseline: StepperDraft;
	/** Guided (dummy) mode: the strategy step also previews the pools.json block. */
	guided?: boolean;
	/** One-line advice of the last auto-assign or deep search. */
	advisorSummary?: string;
}

/** The live files, as read from disk by the caller. */
export interface StepperCurrent {
	pools?: unknown;
	integrations?: unknown;
	profiles?: { active?: string; profiles?: Record<string, ProfileConfig> } | null;
	/** The grants of permissions.json; absent when the host did not read them (the installer then leaves them alone). */
	grants?: Grant[];
}

export interface StepperDeps {
	root: string;
	current: StepperCurrent;
	profilesPath: string;
	writeConfig: (root: string, configs: { integrations?: unknown; pools?: unknown; lastResort?: string | null }) => {
		success: boolean;
		integrationsPath: string;
		poolsPath: string;
		backupCreated: boolean;
	};
	writeProfiles: (profileName: string, roles: ProfileConfig, workflow?: ProfileWorkflow) => void;
	/** Where permissions.json lives; defaults to AI_BALANCER_DATA_DIR or `<root>/data`. */
	dataDir?: string;
	/** The clock for grants. */
	now?: number;
}

export interface StepperApplyResult {
	ok: boolean;
	written: string[];
	backups: string[];
	error?: string;
	profilesError?: string;
	/** Set when the automatic loans could not be saved (the rest was written). */
	grantsError?: string;
}

type StepperPool = PoolConfig;
const clonePools = (pools: readonly PoolConfig[]): PoolConfig[] => pools.map(pool => ({ ...pool, candidates: [...pool.candidates] }));
const cloneRoles = (roles: ProfileConfig): ProfileConfig => JSON.parse(JSON.stringify(roles));
const cloneDraft = (draft: StepperDraft): StepperDraft => ({
	enabled: [...draft.enabled],
	pools: clonePools(draft.pools),
	roles: cloneRoles(draft.roles),
	orchestratorMode: draft.orchestratorMode,
	...(draft.lastResort ? { lastResort: draft.lastResort } : {}),
	...(draft.loans ? { loans: { ...draft.loans } } : {}),
});

export function initStepper(
	detected: DetectedProvider[],
	recommended: PoolConfig[],
	existingRoles: ProfileConfig = {},
	initialWorkflow?: ProfileWorkflow | OrchestratorMode,
	options?: { guided?: boolean; lastResort?: string; loans?: Record<string, string> },
): SetupStepperState {
	const orchestratorMode: OrchestratorMode =
		typeof initialWorkflow === "string" && isOrchestratorMode(initialWorkflow)
			? initialWorkflow
			: typeof initialWorkflow === "object" && initialWorkflow && isOrchestratorMode(initialWorkflow.orchestratorMode)
				? initialWorkflow.orchestratorMode
				: DEFAULT_ORCHESTRATOR_MODE;
	const baseline: StepperDraft = {
		enabled: detected.filter(p => p.detected).map(p => p.id),
		pools: clonePools(recommended),
		roles: cloneRoles(existingRoles),
		orchestratorMode,
		...(options?.lastResort ? { lastResort: options.lastResort } : {}),
		...(options?.loans ? { loans: { ...options.loans } } : {}),
	};
	return { step: "providers", reached: 0, detected, dirty: false, messages: {}, ...cloneDraft(baseline), baseline, guided: options?.guided ?? false };
}

/** The initial state again; nothing was written. */
export function discard(state: SetupStepperState): SetupStepperState {
	return { ...state, step: "providers", reached: 0, dirty: false, messages: {}, ...cloneDraft(state.baseline) };
}

/** The last-resort model Save would write: dropped when its subscription is disabled, like pool members. */
export function effectiveLastResort(state: SetupStepperState): string | undefined {
	const ref = state.lastResort;
	return ref && state.enabled.includes(ref.slice(0, ref.indexOf("/"))) ? ref : undefined;
}

/** The automatic loans Save would write: only for backups that stay and targets whose subscription is enabled. */
export function effectiveLoans(state: SetupStepperState): Record<string, string> {
	const on = new Set(state.enabled);
	const live = new Set(state.pools.filter(pool => pool.candidates.some(ref => on.has(ref.slice(0, ref.indexOf("/"))))).map(pool => pool.id));
	return Object.fromEntries(Object.entries(state.loans ?? {}).filter(([id, to]) => live.has(id) && on.has(to.slice(0, to.indexOf("/")))));
}

/** The loans as grants: every task that uses the backup, in every saved profile that has one (the active profile with the draft's tasks). Backups no task uses get none. */
export function planLoans(state: SetupStepperState, current: StepperCurrent): InstallerLoan[] {
	const active = current.profiles?.active ?? buildBalancerProfileName();
	const byProfile: Record<string, ProfileConfig> = { ...(current.profiles?.profiles ?? {}), [active]: state.roles };
	const planned: InstallerLoan[] = [];
	for (const [poolId, to] of Object.entries(effectiveLoans(state))) {
		const profiles: string[] = [];
		const roles = new Set<string>();
		for (const [name, routes] of Object.entries(byProfile)) {
			const used = Object.entries(routes ?? {}).filter(([, route]) => route?.model === `pool/${poolId}`).map(([role]) => role);
			if (used.length === 0) continue;
			profiles.push(name);
			for (const role of used) roles.add(role);
		}
		if (roles.size > 0) planned.push({ poolId, to, profiles, roles: [...roles] });
	}
	return planned;
}

/** True when saving would change the installer's grants. Unknown (grants not read) counts as no change when there are no loans. */
export function loansChanged(state: SetupStepperState, current: StepperCurrent, now = Date.now()): boolean {
	const planned = planLoans(state, current);
	if (current.grants === undefined) return planned.length > 0;
	return !installerGrantsMatch(current.grants, planned, now);
}

/** Chooses the automatic loan of a backup (`provider/model` it borrows from while it is spent), or none with `undefined`. */
export function setLoan(state: SetupStepperState, poolId: string, to: string | undefined): SetupStepperState {
	const loans = { ...(state.loans ?? {}) };
	if (loans[poolId] === to) return state;
	if (to) loans[poolId] = to;
	else delete loans[poolId];
	return { ...state, loans, dirty: true };
}

/** The pools Save would write: candidates of disabled providers are left out, and emptied pools dropped. */
function effectivePools(state: SetupStepperState): PoolConfig[] {
	const on = new Set(state.enabled);
	return state.pools
		.map(pool => ({ ...pool, candidates: pool.candidates.filter(ref => on.has(ref.slice(0, ref.indexOf("/")))) }))
		.filter(pool => pool.candidates.length > 0);
}

export function validateStep(state: SetupStepperState, step: SetupStep): string[] {
	switch (step) {
		case "providers":
			return state.enabled.length === 0 ? [t("setup.stepper.err.noProvider")] : [];
		case "strategy":
			return state.pools.filter(pool => pool.candidates.length === 0).map(pool => t("setup.stepper.err.emptyPool", { pool: pool.id }));
		case "roles":
			return [];
		case "confirm":
			return [...validateStep(state, "providers"), ...validateStep(state, "strategy")];
	}
}

export function goNext(state: SetupStepperState): SetupStepperState {
	const index = SETUP_STEPS.indexOf(state.step);
	const errors = validateStep(state, state.step);
	if (errors.length > 0) return { ...state, messages: { ...state.messages, [state.step]: errors } };
	if (index === SETUP_STEPS.length - 1) return state;
	const { [state.step]: _cleared, ...messages } = state.messages;
	return { ...state, step: SETUP_STEPS[index + 1]!, reached: Math.max(state.reached, index + 1), messages };
}

export function goBack(state: SetupStepperState): SetupStepperState {
	const index = SETUP_STEPS.indexOf(state.step);
	return index === 0 ? state : { ...state, step: SETUP_STEPS[index - 1]! };
}

/** Jumps to a step already visited; anything further is refused (same state). */
export function goTo(state: SetupStepperState, step: SetupStep): SetupStepperState {
	return SETUP_STEPS.indexOf(step) <= state.reached ? { ...state, step } : state;
}

const edit = (state: SetupStepperState, patch: Partial<StepperDraft>): SetupStepperState => ({ ...state, ...patch, dirty: true });

const editPool = (state: SetupStepperState, poolId: string, change: (pool: PoolConfig) => PoolConfig): SetupStepperState =>
	edit(state, { pools: state.pools.map(pool => (pool.id === poolId ? change(pool) : pool)) });

export function toggleProvider(state: SetupStepperState, providerId: string): SetupStepperState {
	const on = state.enabled.includes(providerId);
	return edit(state, { enabled: on ? state.enabled.filter(id => id !== providerId) : [...state.enabled, providerId] });
}

export function toggleCandidate(state: SetupStepperState, poolId: string, candidate: string): SetupStepperState {
	return editPool(state, poolId, pool => ({ ...pool, candidates: toggleCandidateInList(pool.candidates, candidate) }));
}

export function moveCandidate(state: SetupStepperState, poolId: string, index: number, delta: -1 | 1): SetupStepperState {
	return editPool(state, poolId, pool => ({ ...pool, candidates: moveCandidateInList(pool.candidates, index, delta) }));
}

export function setPoolStrategy(state: SetupStepperState, poolId: string, strategy: RoutingStrategy): SetupStepperState {
	return editPool(state, poolId, pool => ({ ...pool, strategy }));
}

export function setRole(state: SetupStepperState, role: string, model: string, thinking?: string): SetupStepperState {
	const previous = state.roles[role] ?? {};
	return edit(state, { roles: { ...state.roles, [role]: { ...previous, model, ...(thinking !== undefined ? { thinking } : {}) } } });
}

/** Chooses the last-resort model (`provider/model`), or none with `undefined`. */
export function setLastResort(state: SetupStepperState, ref: string | undefined): SetupStepperState {
	if (state.lastResort === ref) return state;
	const { lastResort: _old, ...rest } = state;
	return { ...rest, ...(ref ? { lastResort: ref } : {}), dirty: true };
}

export function setOrchestratorMode(state: SetupStepperState, mode: OrchestratorMode): SetupStepperState {
	if (state.orchestratorMode === mode) return state;
	return edit(state, { orchestratorMode: mode });
}

/** A secondary pool that mixes cheap `flash` models with expensive `claude` quota can burn that quota on trivial requests. */
export function poolCostWarning(pool: StepperPool): string | undefined {
	if (pool.id === "orchestrator") return undefined;
	const hasFlash = pool.candidates.some(ref => /flash/i.test(ref));
	const hasClaude = pool.candidates.some(ref => /claude/i.test(ref));
	return hasFlash && hasClaude ? t("setup.stepper.costWarning", { pool: pool.id }) : undefined;
}

const POOL_TEMPLATES = ["claude-opus-5-5", "claude-sonnet-5-5", "orchestrator"] as const;
const TEMPLATE_MATCH: Record<(typeof POOL_TEMPLATES)[number], RegExp> = {
	"claude-opus-5-5": /opus/i,
	"claude-sonnet-5-5": /sonnet/i,
	orchestrator: /argon|sonnet/i,
};

/** Adds a pool from a template (or the next free custom one), filled from the enabled providers' models. */
export function createPoolFromTemplate(state: SetupStepperState, templateId?: string): SetupStepperState {
	const id = templateId ?? POOL_TEMPLATES.find(template => !state.pools.some(pool => pool.id === template)) ?? `custom-pool-${state.pools.length + 1}`;
	if (state.pools.some(pool => pool.id === id)) return state;
	const all = state.detected.filter(p => state.enabled.includes(p.id)).flatMap(p => p.availableModels.map(model => `${p.id}/${model}`));
	const match = TEMPLATE_MATCH[id as (typeof POOL_TEMPLATES)[number]];
	const matching = match ? all.filter(ref => match.test(ref)) : all;
	const candidates = matching.length > 0 ? matching : all;
	return edit(state, { pools: [...state.pools, { id, name: id, candidates, strategy: "hybrid" }] });
}

/** Zero-token heuristic over every catalog role. */
export function applyAutoAssignRoles(state: SetupStepperState, quotaByKey?: Readonly<Record<string, number>>): SetupStepperState {
	const report = recommendRolesHeuristic({ providers: state.detected.filter(p => state.enabled.includes(p.id)), pools: state.pools, quotaByKey });
	return { ...edit(state, { roles: applyRecommendationsToProfile(state.roles, report.recommendations) }), advisorSummary: report.summary };
}

/** Applies a (deep search) advisor report to the draft roles. */
export function applyAdvisorReport(state: SetupStepperState, report: AdvisorReport): SetupStepperState {
	return { ...edit(state, { roles: applyRecommendationsToProfile(state.roles, report.recommendations) }), advisorSummary: report.summary };
}

/** i18n key of the plain-language description of what a step decides. */
export function stepDescription(step: SetupStep): string {
	return `setup.stepper.desc.${step}`;
}

function profileTarget(state: SetupStepperState, current: StepperCurrent): { name: string; live: ProfileConfig } {
	const name = current.profiles?.active ?? buildBalancerProfileName();
	return { name, live: current.profiles?.profiles?.[name] ?? {} };
}

function roleChanges(draft: ProfileConfig, live: ProfileConfig): string[] {
	const show = (cfg: { model: string; thinking?: string }) => `${cfg.model}${cfg.thinking ? ` (${cfg.thinking})` : ""}`;
	const lines: string[] = [];
	for (const [role, cfg] of Object.entries(draft)) {
		const before = live[role];
		if (!before) lines.push(`+ ${role}: ${show(cfg)}`);
		else if (show(before) !== show(cfg)) lines.push(`~ ${role}: ${show(before)} → ${show(cfg)}`);
	}
	return lines;
}

function nextConfig(state: SetupStepperState, current: StepperCurrent): { pools: PoolConfig[]; lastResort?: string; integrations: Integration[]; notes: string[] } {
	// Same carry-over the classic wizard does: keep a pool's name and rules unless a removed candidate breaks them.
	const live = (current.pools as { pools?: { id?: unknown; name?: unknown; rules?: unknown }[] } | null | undefined)?.pools;
	const existing = new Map((Array.isArray(live) ? live : []).filter(pool => typeof pool?.id === "string").map(pool => [pool.id as string, pool]));
	const notes: string[] = [];
	const pools = effectivePools(state).map(pool => {
		const old = existing.get(pool.id);
		const named = typeof old?.name === "string" ? { ...pool, name: old.name } : pool;
		const carried = carryRules(old?.rules, named);
		notes.push(...carried.notes);
		return carried.rules ? { ...named, rules: carried.rules } : named;
	});
	const used = new Set(pools.flatMap(pool => pool.candidates.map(ref => ref.slice(0, ref.indexOf("/")))));
	const generated = generateRecommendedConfig(state.detected.filter(p => state.enabled.includes(p.id)));
	return { pools, notes, lastResort: effectiveLastResort(state), integrations: mergeIntegrations(current.integrations ?? null, generated.integrations.filter(entry => used.has(entry.provider))) };
}

/** A line-oriented summary of what Save would write, plus which files it would touch. */
export function buildStepperDiff(state: SetupStepperState, current: StepperCurrent): { lines: string[]; writes: { pools: boolean; integrations: boolean; profiles: boolean } } {
	const next = nextConfig(state, current);
	const preview = generateConfigPreview({ pools: current.pools, integrations: current.integrations }, next);
	const lines = [...preview.split("\n"), ...next.notes.map(note => `  ${note}`)];
	const lastBefore = lastResortRef(current.pools);
	const lastChanged = lastBefore !== next.lastResort;
	if (lastChanged) lines.push(`  • pools.json last-resort model: ${lastBefore ?? "none"} → ${next.lastResort ?? "none"}`);
	const { name, live } = profileTarget(state, current);
	const roles = roleChanges(state.roles, live);
	if (roles.length > 0) lines.push(`  • profiles.json [${name}] role assignments:`, ...roles.map(line => `      ${line}`));
	const workflowChanged = state.orchestratorMode !== state.baseline.orchestratorMode;
	if (workflowChanged) lines.push(`  • profiles.json [${name}] workflow: orchestratorMode -> ${state.orchestratorMode}`);
	return {
		lines,
		writes: {
			pools: lastChanged || !lines.some(line => line.includes("pools.json: Unchanged")),
			integrations: !lines.some(line => line.includes("integrations.json: Unchanged")),
			profiles: roles.length > 0 || workflowChanged,
		},
	};
}

/** The Save path: refuses an invalid draft, writes pools and integrations, then profiles only when roles changed. */
export function applyStepper(state: SetupStepperState, deps: StepperDeps): StepperApplyResult {
	const errors = validateStep(state, "confirm");
	if (errors.length > 0) return { ok: false, written: [], backups: [], error: errors.join("; ") };
	const next = nextConfig(state, deps.current);
	let res: ReturnType<StepperDeps["writeConfig"]>;
	try {
		res = deps.writeConfig(deps.root, { pools: next.pools, lastResort: next.lastResort ?? null, integrations: next.integrations });
	} catch (err) {
		return { ok: false, written: [], backups: [], error: err instanceof Error ? err.message : String(err) };
	}
	const result: StepperApplyResult = {
		ok: true,
		written: [res.poolsPath, res.integrationsPath],
		backups: res.backupCreated ? [`${res.poolsPath}.bak`, `${res.integrationsPath}.bak`] : [],
	};
	const { name, live } = profileTarget(state, deps.current);
	const workflowChanged = state.orchestratorMode !== state.baseline.orchestratorMode;
	// Automatic loans: only when the host read the grants (so "no loans" there never revokes what it did not see) or the draft has some.
	const planned = planLoans(state, deps.current);
	if (deps.current.grants !== undefined || planned.length > 0) {
		const now = deps.now ?? Date.now();
		const dataDir = deps.dataDir ?? process.env.AI_BALANCER_DATA_DIR ?? join(deps.root, "data");
		try {
			const changed = syncInstallerGrants(dataDir, planned, now, deps.current.grants !== undefined);
			if (changed.added.length > 0 || changed.revoked.length > 0) result.written.push(join(dataDir, PERMISSIONS_FILE));
		} catch (err) {
			result.grantsError = err instanceof Error ? err.message : String(err);
		}
	}
	if (roleChanges(state.roles, live).length > 0 || workflowChanged) {
		try {
			deps.writeProfiles(name, state.roles, { orchestratorMode: state.orchestratorMode });
			result.written.push(deps.profilesPath);
		} catch (err) {
			result.profilesError = err instanceof Error ? err.message : String(err);
		}
	}
	return result;
}
