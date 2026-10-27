import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PROFILES_PATH, loadProfilesStore, readProfiles, saveProfilesStore, type ProfilesStore } from "../../../src/profiles.ts";
import { detectSystemProviders, writeConfigSafely, type DetectedProvider, type PoolConfig } from "../../../src/setup.ts";
import {
	ROLE_CATALOG,
	buildAvailableModelTargets,
	recommendRolesHeuristic,
	recommendRolesWithAdvisor,
	createDefaultCliAiRunner,
	applyRecommendationsToProfile,
	resolveEffectiveRoleRoutes,
	type AdvisorReport,
	type EffectiveRoleRow,
} from "../../../src/setup-advisor.ts";

export interface SetupViewOptions {
	root: string;
	poolsPath?: string;
	profilesPath?: string;
}

export interface SetupSaveOptions extends SetupViewOptions {
	hasModel?: (provider: string, model: string) => boolean;
	agyBin?: string;
}

export interface SetupViewData {
	providers: DetectedProvider[];
	pools: PoolConfig[];
	activeProfile: string | null;
	roles: Record<string, { model: string; thinking?: string }>;
	roleRows: EffectiveRoleRow[];
	availableTargets: string[];
	advisor: AdvisorReport;
}

export function readSetupPools(poolsPath: string): PoolConfig[] {
	try {
		if (existsSync(poolsPath)) {
			const raw = JSON.parse(readFileSync(poolsPath, "utf8")) as { pools?: PoolConfig[] };
			if (Array.isArray(raw.pools)) return raw.pools;
		}
	} catch {
		// return empty list on unreadable file
	}
	return [];
}

export function readSetupView(options: SetupViewOptions): SetupViewData {
	const poolsPath = options.poolsPath || join(options.root, "pools.json");
	const profilesPath = options.profilesPath || DEFAULT_PROFILES_PATH;

	const providers = detectSystemProviders();
	const pools = readSetupPools(poolsPath);
	const store = loadProfilesStore(profilesPath);
	const activeProfile = store?.active ?? null;
	const activeRoles = activeProfile && store?.profiles?.[activeProfile] ? store.profiles[activeProfile] : {};

	const roleRows = resolveEffectiveRoleRoutes(activeRoles, pools);
	const availableTargets = buildAvailableModelTargets(providers, pools);
	const advisor = recommendRolesHeuristic({
		providers,
		pools,
	});

	return {
		providers,
		pools,
		activeProfile,
		roles: activeRoles,
		roleRows,
		availableTargets,
		advisor,
	};
}

export async function saveSetupView(options: SetupSaveOptions, action: unknown): Promise<{ status: number; body: unknown }> {
	if (!action || typeof action !== "object") {
		return { status: 400, body: { ok: false, message: "action must be an object" } };
	}
	const payload = action as { type?: string; role?: string; model?: string; thinking?: string; poolId?: string; strategy?: string; prompt?: string };
	const poolsPath = options.poolsPath || join(options.root, "pools.json");
	const profilesPath = options.profilesPath || DEFAULT_PROFILES_PATH;
	const hasModel = options.hasModel ?? (() => true);

	if (payload.type === "set-role") {
		if (!payload.role || !payload.model) {
			return { status: 400, body: { ok: false, message: "role and model are required" } };
		}
		const store = loadProfilesStore(profilesPath);
		if (!store || !store.active) {
			return { status: 400, body: { ok: false, message: "no active profile found in profiles.json" } };
		}
		const profile = store.profiles[store.active] ?? {};
		profile[payload.role] = {
			...(profile[payload.role] ?? {}),
			model: payload.model,
			...(payload.thinking ? { thinking: payload.thinking } : {}),
		};
		store.profiles[store.active] = profile;
		try {
			const read = readProfiles(profilesPath);
			saveProfilesStore(store, read, { path: profilesPath, hasModel });
			return { status: 200, body: { ok: true, setup: readSetupView(options) } };
		} catch (err) {
			return { status: 400, body: { ok: false, message: err instanceof Error ? err.message : String(err) } };
		}
	}

	if (payload.type === "apply-advisor") {
		const store = loadProfilesStore(profilesPath);
		if (!store || !store.active) {
			return { status: 400, body: { ok: false, message: "no active profile found in profiles.json" } };
		}
		const current = readSetupView(options);
		store.profiles[store.active] = applyRecommendationsToProfile(
			store.profiles[store.active],
			current.advisor.recommendations,
		);
		try {
			const read = readProfiles(profilesPath);
			saveProfilesStore(store, read, { path: profilesPath, hasModel });
			return { status: 200, body: { ok: true, setup: readSetupView(options) } };
		} catch (err) {
			return { status: 400, body: { ok: false, message: err instanceof Error ? err.message : String(err) } };
		}
	}

	if (payload.type === "toggle-strategy") {
		if (!payload.poolId) {
			return { status: 400, body: { ok: false, message: "poolId is required" } };
		}
		const pools = readSetupPools(poolsPath);
		const target = pools.find(p => p.id === payload.poolId);
		if (!target) {
			return { status: 404, body: { ok: false, message: `pool ${payload.poolId} not found` } };
		}
		const nextStrategy = payload.strategy === "waterfall" || payload.strategy === "hybrid"
			? payload.strategy
			: target.strategy === "waterfall" ? "hybrid" : "waterfall";
		const updated = pools.map(p => p.id === payload.poolId ? { ...p, strategy: nextStrategy } : p);
		try {
			writeConfigSafely(options.root, { pools: updated });
			return { status: 200, body: { ok: true, setup: readSetupView(options) } };
		} catch (err) {
			return { status: 400, body: { ok: false, message: err instanceof Error ? err.message : String(err) } };
		}
	}

	if (payload.type === "query-ai") {
		const current = readSetupView(options);
		try {
			const runner = createDefaultCliAiRunner(options.agyBin);
			const advisor = await recommendRolesWithAdvisor(
				{ providers: current.providers, pools: current.pools },
				{ aiRunner: runner },
			);
			return { status: 200, body: { ok: true, advisor } };
		} catch (err) {
			return { status: 200, body: { ok: false, message: err instanceof Error ? err.message : String(err), advisor: current.advisor } };
		}
	}

	return { status: 400, body: { ok: false, message: `unknown action type "${payload.type}"` } };
}
