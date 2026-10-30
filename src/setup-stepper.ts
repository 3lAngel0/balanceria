// Pure state machine behind the step-by-step setup wizard (Providers → Strategy → Roles → Confirm).
// No UI and no filesystem access: writes go through the functions injected in `StepperDeps`.

import type { Integration } from "./integrations.ts";
import type { ProfileConfig } from "./profiles.ts";
import type { RoutingStrategy } from "./router.ts";
import { t } from "./i18n/index.ts";
import {
	buildBalancerProfileName,
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
}

/** The live files, as read from disk by the caller. */
export interface StepperCurrent {
	pools?: unknown;
	integrations?: unknown;
	profiles?: { active?: string; profiles?: Record<string, ProfileConfig> } | null;
}

export interface StepperDeps {
	root: string;
	current: StepperCurrent;
	profilesPath: string;
	writeConfig: (root: string, configs: { integrations?: unknown; pools?: unknown }) => {
		success: boolean;
		integrationsPath: string;
		poolsPath: string;
		backupCreated: boolean;
	};
	writeProfiles: (profileName: string, roles: ProfileConfig) => void;
}

export interface StepperApplyResult {
	ok: boolean;
	written: string[];
	backups: string[];
	error?: string;
	profilesError?: string;
}

const clonePools = (pools: readonly PoolConfig[]): PoolConfig[] => pools.map(pool => ({ ...pool, candidates: [...pool.candidates] }));
const cloneRoles = (roles: ProfileConfig): ProfileConfig => JSON.parse(JSON.stringify(roles));
const cloneDraft = (draft: StepperDraft): StepperDraft => ({ enabled: [...draft.enabled], pools: clonePools(draft.pools), roles: cloneRoles(draft.roles) });

export function initStepper(detected: DetectedProvider[], recommended: PoolConfig[], existingRoles: ProfileConfig = {}): SetupStepperState {
	const baseline: StepperDraft = {
		enabled: detected.filter(p => p.detected).map(p => p.id),
		pools: clonePools(recommended),
		roles: cloneRoles(existingRoles),
	};
	return { step: "providers", reached: 0, detected, dirty: false, messages: {}, ...cloneDraft(baseline), baseline };
}

/** The initial state again; nothing was written. */
export function discard(state: SetupStepperState): SetupStepperState {
	return { ...state, step: "providers", reached: 0, dirty: false, messages: {}, ...cloneDraft(state.baseline) };
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

function nextConfig(state: SetupStepperState, current: StepperCurrent): { pools: PoolConfig[]; integrations: Integration[] } {
	const pools = effectivePools(state);
	const used = new Set(pools.flatMap(pool => pool.candidates.map(ref => ref.slice(0, ref.indexOf("/")))));
	const generated = generateRecommendedConfig(state.detected.filter(p => state.enabled.includes(p.id)));
	return { pools, integrations: mergeIntegrations(current.integrations ?? null, generated.integrations.filter(entry => used.has(entry.provider))) };
}

/** A line-oriented summary of what Save would write, plus which files it would touch. */
export function buildStepperDiff(state: SetupStepperState, current: StepperCurrent): { lines: string[]; writes: { pools: boolean; integrations: boolean; profiles: boolean } } {
	const next = nextConfig(state, current);
	const preview = generateConfigPreview({ pools: current.pools, integrations: current.integrations }, next);
	const lines = preview.split("\n");
	const { name, live } = profileTarget(state, current);
	const roles = roleChanges(state.roles, live);
	if (roles.length > 0) lines.push(`  • profiles.json [${name}] role assignments:`, ...roles.map(line => `      ${line}`));
	return {
		lines,
		writes: {
			pools: !lines.some(line => line.includes("pools.json: Unchanged")),
			integrations: !lines.some(line => line.includes("integrations.json: Unchanged")),
			profiles: roles.length > 0,
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
		res = deps.writeConfig(deps.root, next);
	} catch (err) {
		return { ok: false, written: [], backups: [], error: err instanceof Error ? err.message : String(err) };
	}
	const result: StepperApplyResult = {
		ok: true,
		written: [res.poolsPath, res.integrationsPath],
		backups: res.backupCreated ? [`${res.poolsPath}.bak`, `${res.integrationsPath}.bak`] : [],
	};
	const { name, live } = profileTarget(state, deps.current);
	if (roleChanges(state.roles, live).length > 0) {
		try {
			deps.writeProfiles(name, state.roles);
			result.written.push(deps.profilesPath);
		} catch (err) {
			result.profilesError = err instanceof Error ? err.message : String(err);
		}
	}
	return result;
}
