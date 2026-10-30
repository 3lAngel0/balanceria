import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import type { Integration } from "./integrations.ts";
import { validateIntegrationsConfig, validatePoolsConfig } from "./config-schema.ts";
import { ruleIssues } from "./pools.ts";
import { DEFAULT_PROFILES_PATH, loadProfilesStore, PROFILES_KIND, PROFILES_VERSION, readProfiles, saveProfilesStore, type ProfileConfig } from "./profiles.ts";
import { t } from "./i18n/index.ts";
import type { RoutingStrategy, RuleBlock } from "./router.ts";
import {
	ROLE_CATALOG,
	applyRecommendationsToProfile,
	buildAvailableModelTargets,
	createDefaultCliAiRunner,
	recommendRolesHeuristic,
	recommendRolesWithAdvisor,
	type AdvisorReport,
	type AiRunner,
} from "./setup-advisor.ts";

export interface DetectedProvider {
	id: string;
	label: string;
	kind: "subscription" | "api" | "local";
	detected: boolean;
	source: string;
	availableModels: string[];
}

export interface DetectOptions {
	settings?: { packages?: string[] } | null;
	settingsPath?: string;
	agentDir?: string;
	homeDir?: string;
	env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
	execWhich?: (bin: string) => boolean;
}

export interface PoolConfig {
	id: string;
	name: string;
	candidates: string[];
	strategy?: RoutingStrategy;
	rules?: RuleBlock[];
}

/**
 * The rules a regenerated pool keeps from its current version: the pick follows
 * the new strategy and a `prefer-for-role` or `prefer-for-context` whose candidate left is dropped, with
 * a preview note. A list that still cannot run is dropped whole.
 */
export function carryRules(current: unknown, pool: PoolConfig): { rules?: RuleBlock[]; notes: string[] } {
	if (current === undefined) return { notes: [] };
	const notes: string[] = [];
	const mode = pool.strategy === "waterfall" ? "first" : "highest-quota";
	const kept: unknown[] = [];
	for (const block of Array.isArray(current) ? current : []) {
		const value = block as { rule?: unknown; role?: unknown; candidate?: unknown } | null;
		if (value?.rule === "prefer-for-role" && typeof value.candidate === "string" && !pool.candidates.includes(value.candidate)) {
			notes.push(`~ Pool '${pool.id}' drops rule prefer-for-role ${String(value.role)} → ${value.candidate} (candidate removed)`);
			continue;
		}
		if (value?.rule === "prefer-for-context" && typeof value.candidate === "string" && !pool.candidates.includes(value.candidate)) {
			notes.push(`~ Pool '${pool.id}' drops rule prefer-for-context → ${value.candidate} (candidate removed)`);
			continue;
		}
		kept.push(value?.rule === "pick" ? { ...value, mode } : block);
	}
	if (ruleIssues(kept, pool.candidates, pool.strategy, "rules").length > 0) {
		notes.push(`~ Pool '${pool.id}' drops its rules (they no longer fit the pool) and routes on the default list`);
		return { notes };
	}
	return { rules: kept as RuleBlock[], notes };
}

export interface RecommendOptions {
	strategy?: RoutingStrategy;
	/** Whether Pi has this model; candidates it lacks are left out and listed in `skipped`. */
	hasModel?: (provider: string, model: string) => boolean;
}

export interface WizardUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	input?(title: string, placeholder?: string): Promise<string | undefined>;
}

export interface SetupWizardOptions {
	detectOptions?: DetectOptions;
	hasModel?: RecommendOptions["hasModel"];
	profilesPath?: string;
	aiRunner?: AiRunner;
	agyBin?: string;
	onOpenControlCenter?: () => Promise<void> | void;
}

/**
 * Generates a profile name adhering to `balanceador_<identificador>` convention.
 * Strips any redundant prefix and normalizes to lowercase alphanumeric with underscores/hyphens.
 */
export function buildBalancerProfileName(identifier?: string): string {
	const raw = (identifier ?? "").trim();
	const stripped = raw.replace(/^balanceador_/, "");
	const sanitized = stripped
		.toLowerCase()
		.replace(/[^a-z0-9_-]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "");
	return `balanceador_${sanitized || "default"}`;
}

/**
 * Toggles a `provider/model` candidate inside a pool's candidate list.
 * Refuses to remove the last remaining candidate so a pool is never left empty.
 */
export function toggleCandidateInList(candidates: readonly string[], candidate: string): string[] {
	const index = candidates.indexOf(candidate);
	if (index >= 0) {
		if (candidates.length <= 1) return [...candidates];
		return candidates.filter(c => c !== candidate);
	}
	return [...candidates, candidate];
}

/**
 * Moves a candidate at `index` by `delta` (-1 up, +1 down) within `candidates`.
 */
export function moveCandidateInList(candidates: readonly string[], index: number, delta: -1 | 1): string[] {
	const target = index + delta;
	if (index < 0 || index >= candidates.length || target < 0 || target >= candidates.length) {
		return [...candidates];
	}
	const next = [...candidates];
	const [moved] = next.splice(index, 1);
	next.splice(target, 0, moved!);
	return next;
}

/**
 * Strips npm: prefixes and @version suffixes from package names,
 * preserving scoped package paths (e.g. @estebanforge/pi-antigravity-bridge).
 */
export function normalizePackageName(pkg: string): string {
	let s = pkg.trim();
	if (s.startsWith("npm:")) {
		s = s.slice(4);
	}
	if (s.startsWith("@")) {
		const slash = s.indexOf("/");
		if (slash !== -1) {
			const at = s.indexOf("@", slash + 1);
			if (at !== -1) s = s.slice(0, at);
		}
	} else {
		const at = s.indexOf("@");
		if (at !== -1) s = s.slice(0, at);
	}
	return s;
}

/**
 * Resolves Pi agent configuration directory in priority order:
 * 1. Explicit agentDir option
 * 2. PI_CODING_AGENT_DIR environment variable
 * 3. ~/.gentle-shell/agent (if exists)
 * 4. ~/.pi/agent (if exists)
 * 5. ~/.gentle-shell/agent (default fallback)
 */
export function resolveAgentDir(options?: {
	agentDir?: string;
	env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
	homeDir?: string;
}): string {
	if (options?.agentDir) return options.agentDir;
	const env = options?.env ?? process.env;
	if (env.PI_CODING_AGENT_DIR) return env.PI_CODING_AGENT_DIR;

	const home = options?.homeDir ?? env.HOME ?? homedir();
	const gentleAgent = join(home, ".gentle-shell", "agent");
	if (existsSync(gentleAgent)) return gentleAgent;

	const piAgent = join(home, ".pi", "agent");
	if (existsSync(piAgent)) return piAgent;

	return gentleAgent;
}

export function detectSystemProviders(options?: DetectOptions): DetectedProvider[] {
	const providers: DetectedProvider[] = [];
	const env = options?.env ?? process.env;
	const home = options?.homeDir ?? env.HOME ?? homedir();

	const checkWhich = options?.execWhich ?? ((cmd: string) => {
		try {
			execSync(`which ${cmd}`, { stdio: "ignore" });
			return true;
		} catch {
			return false;
		}
	});

	// Load packages from Pi agent settings.json
	let packages: string[] = [];
	if (options?.settings !== undefined) {
		if (options.settings && Array.isArray(options.settings.packages)) {
			packages = options.settings.packages;
		}
	} else {
		const agentDir = resolveAgentDir({
			agentDir: options?.agentDir,
			env,
			homeDir: home,
		});
		const settingsFile = options?.settingsPath ?? join(agentDir, "settings.json");
		if (existsSync(settingsFile)) {
			try {
				const parsed = JSON.parse(readFileSync(settingsFile, "utf8"));
				if (parsed && Array.isArray(parsed.packages)) {
					packages = parsed.packages;
				}
			} catch {
				// Non-fatal if settings.json is malformed
			}
		}
	}

	const normalizedPackages = new Set(packages.map(normalizePackageName));

	// 1. Antigravity (agy)
	let agyFound = false;
	let agySource = "Not found in PATH or settings";
	if (checkWhich("agy")) {
		agyFound = true;
		agySource = "CLI binary 'agy'";
	} else if (existsSync(join(home, ".local", "bin", "agy"))) {
		agyFound = true;
		agySource = "Binary ~/.local/bin/agy";
	} else if (normalizedPackages.has("@estebanforge/pi-antigravity-bridge")) {
		agyFound = true;
		agySource = "Pi package '@estebanforge/pi-antigravity-bridge'";
	} else if (normalizedPackages.has("pi-antigravity-bridge")) {
		agyFound = true;
		agySource = "Pi package 'pi-antigravity-bridge'";
	}

	providers.push({
		id: "antigravity",
		label: "Google AI Pro (agy)",
		kind: "subscription",
		detected: agyFound,
		source: agySource,
		availableModels: ["claude-opus-5-5", "claude-sonnet-5-5", "gemini-4-argon", "gemini-3-8-flash"],
	});

	// 2. Claude Bridge
	let bridgeFound = false;
	let bridgeSource = "Optional bridge (not installed in packages)";
	const bridgePkg = [...normalizedPackages].find(
		p => p === "pi-claude-bridge" || p.endsWith("/pi-claude-bridge"),
	);
	if (bridgePkg) {
		bridgeFound = true;
		bridgeSource = `Pi package '${bridgePkg}'`;
	} else if (Boolean(env.CLAUDE_BRIDGE_PORT)) {
		bridgeFound = true;
		bridgeSource = "Environment CLAUDE_BRIDGE_PORT";
	} else if (existsSync(join(home, ".local", "share", "pi", "extensions", "pi-claude-bridge"))) {
		bridgeFound = true;
		bridgeSource = "Pi extension ~/.local/share/pi/extensions/pi-claude-bridge";
	}

	providers.push({
		id: "claude-bridge",
		label: "Claude Pro (claude-bridge)",
		kind: "subscription",
		detected: bridgeFound,
		source: bridgeSource,
		availableModels: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-3-7-sonnet"],
	});

	// 3. Claude Code
	let claudeCodeFound = false;
	let claudeCodeSource = "Not found in PATH";
	if (checkWhich("claude")) {
		claudeCodeFound = true;
		claudeCodeSource = "CLI binary 'claude'";
	} else if (normalizedPackages.has("claude-code") || normalizedPackages.has("@anthropic-ai/claude-code")) {
		claudeCodeFound = true;
		claudeCodeSource = "Pi package 'claude-code'";
	}

	providers.push({
		id: "claude-code",
		label: "Claude Code CLI",
		kind: "subscription",
		detected: claudeCodeFound,
		source: claudeCodeSource,
		availableModels: ["claude-3-7-sonnet"],
	});

	// 4. OpenCode
	let openCodeFound = false;
	let openCodeSource = "Not found in PATH";
	if (checkWhich("opencode")) {
		openCodeFound = true;
		openCodeSource = "CLI binary 'opencode'";
	} else if (normalizedPackages.has("opencode") || normalizedPackages.has("opencode-ai")) {
		openCodeFound = true;
		openCodeSource = "Pi package 'opencode'";
	}

	providers.push({
		id: "opencode",
		label: "OpenCode Engine",
		kind: "subscription",
		detected: openCodeFound,
		source: openCodeSource,
		availableModels: ["opencode-code-v1"],
	});

	// 5. Ollama / Local
	const ollamaFound = checkWhich("ollama");
	providers.push({
		id: "ollama",
		label: "Ollama (Local LLM)",
		kind: "local",
		detected: ollamaFound,
		source: ollamaFound ? "CLI binary 'ollama'" : "Not found in PATH",
		availableModels: ["qwen2.5-coder", "llama3.2"],
	});

	// 6. Direct APIs from environment
	if (env.ANTHROPIC_API_KEY) {
		providers.push({
			id: "anthropic",
			label: "Anthropic API",
			kind: "api",
			detected: true,
			source: "Environment ANTHROPIC_API_KEY",
			availableModels: ["claude-3-5-sonnet-20241022", "claude-3-5-haiku-20241022"],
		});
	}
	if (env.GEMINI_API_KEY) {
		providers.push({
			id: "google",
			label: "Gemini API",
			kind: "api",
			detected: true,
			source: "Environment GEMINI_API_KEY",
			availableModels: ["gemini-1.5-pro", "gemini-1.5-flash"],
		});
	}

	return providers;
}

export function generateRecommendedConfig(
	providers: DetectedProvider[],
	options: RecommendOptions = {},
): {
	integrations: Integration[];
	pools: PoolConfig[];
	skipped: string[];
} {
	const selected = providers.filter(p => p.detected);
	const selectedIds = new Set(selected.map(p => p.id));

	const integrations: Integration[] = [];
	for (const p of selected) {
		integrations.push({
			provider: p.id,
			kind: p.kind === "local" ? "subscription" : p.kind,
			label: p.label,
		});
	}

	// Always ensure standard subscription integrations exist if none selected
	if (integrations.length === 0) {
		integrations.push(
			{ provider: "claude-bridge", kind: "subscription", label: "Claude Pro (claude-bridge)" },
			{ provider: "antigravity", kind: "subscription", label: "Google AI Pro (agy)" },
		);
	}

	const hasAgy = selectedIds.has("antigravity");
	const hasBridge = selectedIds.has("claude-bridge");
	const hasClaudeCode = selectedIds.has("claude-code");
	const hasOpenCode = selectedIds.has("opencode");
	const hasOllama = selectedIds.has("ollama");

	const pools: PoolConfig[] = [];

	// 1. Opus 5.5 pool
	const opusCandidates: string[] = [];
	if (hasAgy) opusCandidates.push("antigravity/claude-opus-5-5");
	if (hasBridge) opusCandidates.push("claude-bridge/claude-opus-5-5");
	if (hasAgy) opusCandidates.push("antigravity/gemini-4-argon");
	if (hasOllama) opusCandidates.push("ollama/qwen2.5-coder");

	// If no candidates matched selected providers (e.g. empty selection), provide standard defaults
	const finalOpusCandidates = opusCandidates.length > 0
		? opusCandidates
		: (hasBridge || hasAgy ? [] : ["antigravity/claude-opus-5-5", "claude-bridge/claude-opus-5-5"]);

	if (finalOpusCandidates.length > 0) {
		pools.push({
			id: "claude-opus-5-5",
			name: "Opus 5.5 (pool)",
			candidates: finalOpusCandidates,
		});
	}

	// 2. Sonnet 5.5 pool
	const sonnetCandidates: string[] = [];
	if (hasAgy) sonnetCandidates.push("antigravity/claude-sonnet-5-5");
	if (hasBridge) sonnetCandidates.push("claude-bridge/claude-sonnet-5-5");
	if (hasClaudeCode) sonnetCandidates.push("claude-code/claude-3-7-sonnet");
	if (hasAgy) sonnetCandidates.push("antigravity/gemini-3-8-flash");

	const finalSonnetCandidates = sonnetCandidates.length > 0
		? sonnetCandidates
		: (hasBridge || hasAgy || hasClaudeCode ? [] : ["antigravity/claude-sonnet-5-5", "claude-bridge/claude-sonnet-5-5"]);

	if (finalSonnetCandidates.length > 0) {
		pools.push({
			id: "claude-sonnet-5-5",
			name: "Sonnet 5.5 (pool)",
			candidates: finalSonnetCandidates,
		});
	}

	// 3. Orchestrator pool
	const orchCandidates: string[] = [];
	if (hasAgy) orchCandidates.push("antigravity/gemini-4-argon", "antigravity/gemini-3-8-flash");
	if (hasBridge) orchCandidates.push("claude-bridge/claude-sonnet-5-5");
	if (hasClaudeCode) orchCandidates.push("claude-code/claude-3-7-sonnet");
	if (hasOpenCode) orchCandidates.push("opencode/opencode-code-v1");
	if (hasOllama) orchCandidates.push("ollama/llama3.2");

	const finalOrchCandidates = orchCandidates.length > 0
		? orchCandidates
		: (hasBridge || hasAgy || hasClaudeCode || hasOpenCode ? [] : ["antigravity/gemini-4-argon", "claude-bridge/claude-sonnet-5-5"]);

	if (finalOrchCandidates.length > 0) {
		pools.push({
			id: "orchestrator",
			name: "Orchestrator (pool)",
			candidates: finalOrchCandidates,
		});
	}

	const strategy = options.strategy ?? "hybrid";
	const skipped: string[] = [];
	const known = (ref: string) => {
		const slash = ref.indexOf("/");
		const ok = !options.hasModel || options.hasModel(ref.slice(0, slash), ref.slice(slash + 1));
		if (!ok && !skipped.includes(ref)) skipped.push(ref);
		return ok;
	};
	const usable = pools
		.map(pool => ({ ...pool, candidates: pool.candidates.filter(known), strategy }))
		.filter(pool => pool.candidates.length > 0);
	return { integrations, pools: usable, skipped };
}

/** The current integrations, untouched, followed by the generated ones for providers not listed yet. */
export function mergeIntegrations(current: unknown, generated: readonly Integration[]): Integration[] {
	const list = Array.isArray(current)
		? current
		: current && typeof current === "object" && Array.isArray((current as { integrations?: unknown }).integrations)
			? (current as { integrations: unknown[] }).integrations
			: [];
	const kept = list.filter((entry): entry is Integration => Boolean(entry) && typeof (entry as Integration).provider === "string");
	const listed = new Set(kept.map(entry => entry.provider));
	return [...kept, ...generated.filter(entry => !listed.has(entry.provider))];
}

export function generateConfigPreview(
	current: { pools?: unknown; integrations?: unknown } | null,
	next: { integrations: Integration[]; pools: PoolConfig[]; skipped?: readonly string[]; ruleNotes?: readonly string[] },
): string {
	const lines: string[] = [];

	lines.push("Resulting Pools:");
	for (const pool of next.pools) {
		const candidateStr = pool.candidates.join(" → ");
		lines.push(`  • ${pool.id}${pool.strategy ? ` [${pool.strategy}]` : ""}: ${candidateStr}`);
	}
	if (next.skipped && next.skipped.length > 0) {
		lines.push(`  Skipped (model not available in Pi): ${next.skipped.join(", ")}`);
	}

	lines.push("");
	lines.push(`Integrations (${next.integrations.length} providers):`);
	for (const int of next.integrations) {
		lines.push(`  • ${int.label} (${int.provider}) [${int.kind}]`);
	}

	lines.push("");
	lines.push("Changes versus current files:");

	// Compare pools
	const currentPools = (current && typeof current === "object" && current.pools && typeof current.pools === "object" && "pools" in current.pools && Array.isArray((current.pools as any).pools))
		? (current.pools as any).pools
		: (current && typeof current === "object" && Array.isArray(current.pools) ? current.pools : null);

	if (!currentPools || currentPools.length === 0) {
		lines.push(`  • pools.json: Will create new file with ${next.pools.length} pools`);
	} else {
		const currentMap = new Map<string, string[]>();
		const currentStrategy = new Map<string, string>();
		for (const p of currentPools) {
			if (p && typeof p.id === "string") {
				const cands = Array.isArray(p.candidates)
					? p.candidates.map((c: any) => typeof c === "string" ? c : `${c.provider}/${c.model}`)
					: [];
				currentMap.set(p.id, cands);
				// A pool without a strategy routes as "hybrid".
				currentStrategy.set(p.id, typeof p.strategy === "string" ? p.strategy : "hybrid");
			}
		}

		const poolChanges: string[] = [];
		for (const nextPool of next.pools) {
			const curCands = currentMap.get(nextPool.id);
			if (!curCands) {
				poolChanges.push(`+ Add pool '${nextPool.id}' (${nextPool.candidates.join(" → ")})`);
			} else {
				const curStr = curCands.join(" → ");
				const nextStr = nextPool.candidates.join(" → ");
				if (curStr !== nextStr) {
					poolChanges.push(`~ Update pool '${nextPool.id}': [${curStr}] → [${nextStr}]`);
				}
				const before = currentStrategy.get(nextPool.id) ?? "hybrid";
				const after = nextPool.strategy ?? "hybrid";
				if (before !== after) {
					poolChanges.push(`~ Update pool '${nextPool.id}': strategy ${before} → ${after}`);
				}
			}
		}
		for (const [curId] of currentMap) {
			if (!next.pools.some(p => p.id === curId)) {
				poolChanges.push(`- Remove pool '${curId}'`);
			}
		}
		poolChanges.push(...(next.ruleNotes ?? []));

		if (poolChanges.length === 0) {
			lines.push("  • pools.json: Unchanged (matches existing configuration)");
		} else {
			lines.push("  • pools.json changes:");
			for (const ch of poolChanges) {
				lines.push(`      ${ch}`);
			}
		}
	}

	// Compare integrations
	const currentIntegrations = (current && typeof current === "object" && current.integrations && typeof current.integrations === "object" && "integrations" in current.integrations && Array.isArray((current.integrations as any).integrations))
		? (current.integrations as any).integrations
		: (current && typeof current === "object" && Array.isArray(current.integrations) ? current.integrations : null);

	if (!currentIntegrations || currentIntegrations.length === 0) {
		lines.push(`  • integrations.json: Will create new file with ${next.integrations.length} providers`);
	} else {
		const curProviders = new Set<string>(currentIntegrations.map((i: any) => i.provider));
		const nextProviders = new Set<string>(next.integrations.map(i => i.provider));
		const added = [...nextProviders].filter(p => !curProviders.has(p));
		const removed = [...curProviders].filter(p => !nextProviders.has(p));

		if (added.length === 0 && removed.length === 0) {
			lines.push("  • integrations.json: Unchanged");
		} else {
			const diffParts: string[] = [];
			if (added.length > 0) diffParts.push(`add ${added.join(", ")}`);
			if (removed.length > 0) diffParts.push(`remove ${removed.join(", ")}`);
			lines.push(`  • integrations.json: Modified (${diffParts.join("; ")})`);
		}
	}

	return lines.join("\n");
}

export function writeConfigSafely(root: string, configs: { integrations?: unknown; pools?: unknown }): {
	success: boolean;
	integrationsPath: string;
	poolsPath: string;
	backupCreated: boolean;
} {
	// Support both array representation and wrapped object representation
	let rawIntegrations = configs.integrations;
	if (rawIntegrations === undefined) {
		const intPath = join(root, "integrations.json");
		if (existsSync(intPath)) {
			try {
				rawIntegrations = JSON.parse(readFileSync(intPath, "utf8"));
			} catch {
				// Keep undefined
			}
		}
	}
	if (Array.isArray(rawIntegrations)) {
		rawIntegrations = { integrations: rawIntegrations };
	}

	let rawPools = configs.pools;
	if (rawPools === undefined) {
		const poolPath = join(root, "pools.json");
		if (existsSync(poolPath)) {
			try {
				rawPools = JSON.parse(readFileSync(poolPath, "utf8"));
			} catch {
				// Keep undefined
			}
		}
	}
	if (Array.isArray(rawPools)) {
		rawPools = { pools: rawPools };
	}

	// Normalize any object candidates inside pools to strings
	if (rawPools && typeof rawPools === "object" && "pools" in rawPools && Array.isArray((rawPools as any).pools)) {
		const normalizedPools = (rawPools as any).pools.map((p: any) => {
			if (!p || typeof p !== "object" || !Array.isArray(p.candidates)) return p;
			const normalizedCandidates = p.candidates.map((c: any) => {
				if (typeof c === "string") return c;
				if (c && typeof c === "object" && typeof c.provider === "string" && typeof c.model === "string") {
					return `${c.provider}/${c.model}`;
				}
				return c;
			});
			return { ...p, candidates: normalizedCandidates };
		});
		rawPools = { ...(rawPools as any), pools: normalizedPools };
	}

	const intValid = validateIntegrationsConfig(rawIntegrations);
	const poolValid = validatePoolsConfig(rawPools);
	if (!intValid.valid || !poolValid.valid) {
		throw new Error(
			`Configuration validation failed: ${[...intValid.issues, ...poolValid.issues]
				.map(i => `${i.path}: ${i.message}`)
				.join(", ")}`,
		);
	}

	const intPath = join(root, "integrations.json");
	const poolPath = join(root, "pools.json");
	let backupCreated = false;

	if (existsSync(intPath)) {
		copyFileSync(intPath, `${intPath}.bak`);
		backupCreated = true;
	}
	if (existsSync(poolPath)) {
		copyFileSync(poolPath, `${poolPath}.bak`);
		backupCreated = true;
	}

	writeFileSync(intPath, JSON.stringify(rawIntegrations, null, 2), "utf8");
	writeFileSync(poolPath, JSON.stringify(rawPools, null, 2), "utf8");

	return {
		success: true,
		integrationsPath: intPath,
		poolsPath: poolPath,
		backupCreated,
	};
}

async function runInteractiveBridgeToggle(
	ui: WizardUI,
	detectedActive: readonly DetectedProvider[],
	initialSelected: readonly DetectedProvider[],
): Promise<DetectedProvider[] | undefined> {
	const activeIds = new Set(initialSelected.map(p => p.id));
	while (true) {
		const options: string[] = [
			`✓ Continue with selected providers (${activeIds.size} active)`,
			...detectedActive.map(p => {
				const checked = activeIds.has(p.id) ? "[✓]" : "[ ]";
				const models = p.availableModels.length > 0 ? ` — models: ${p.availableModels.join(", ")}` : "";
				return `${checked} ${p.label} (${p.id})${models}`;
			}),
		];
		const choice = await ui.select("Toggle Active Bridges (Enter toggles, Continue when ready)", options);
		if (!choice) return undefined;
		if (choice.startsWith("✓ Continue")) {
			const selected = detectedActive.filter(p => activeIds.has(p.id));
			if (selected.length === 0) {
				ui.notify("Select at least one provider before continuing.", "warning");
				continue;
			}
			return selected;
		}
		const clicked = detectedActive.find(p => choice.includes(`(${p.id})`));
		if (clicked) {
			if (activeIds.has(clicked.id)) {
				if (activeIds.size <= 1) {
					ui.notify("At least one provider must stay active.", "warning");
				} else {
					activeIds.delete(clicked.id);
				}
			} else {
				activeIds.add(clicked.id);
			}
		}
	}
}

function usableCandidatesForProviders(
	providers: readonly DetectedProvider[],
	hasModel?: RecommendOptions["hasModel"],
): string[] {
	const refs: string[] = [];
	for (const p of providers) {
		if (!p.detected) continue;
		for (const m of p.availableModels) {
			if (!hasModel || hasModel(p.id, m)) {
				const ref = `${p.id}/${m}`;
				if (!refs.includes(ref)) refs.push(ref);
			}
		}
	}
	return refs;
}

export async function runSetupWizard(
	ctx: { ui: WizardUI },
	root: string,
	options?: SetupWizardOptions,
): Promise<boolean> {
	const detected = detectSystemProviders(options?.detectOptions);
	const subscriptionProviders = detected.filter(p => p.detected && p.kind === "subscription");

	// Step 0: Check if any subscription provider is detected
	if (subscriptionProviders.length === 0) {
		ctx.ui.notify(
			"ai-balancer: No subscription providers detected (e.g. pi-claude-bridge, agy, claude-code). Nothing written.",
			"warning",
		);
		return false;
	}

	// Step 1: Show what was detected
	const detectedSummary = [
		"Detected providers on your system:",
		...detected.map(p => {
			const models = p.detected && p.availableModels.length > 0 ? ` [models: ${p.availableModels.join(", ")}]` : "";
			return `  • ${p.label}: ${p.detected ? `Found (${p.source})${models}` : "Not found"}`;
		}),
		"",
		"Continue with interactive setup?",
	].join("\n");

	const step1Confirmed = await ctx.ui.confirm("ai-balancer: Detected Providers", detectedSummary);
	if (!step1Confirmed) {
		ctx.ui.notify("setup cancelled, nothing written", "info");
		return false;
	}

	// Step 2: Let user pick which detected providers go into the pools (all, custom toggle combination, or single)
	const detectedActive = detected.filter(p => p.detected);
	const providerChoiceOptions: string[] = [];

	if (detectedActive.length > 1) {
		providerChoiceOptions.push(
			`All detected providers (${detectedActive.map(p => p.label).join(", ")}) (Recommended)`,
			"Custom combination — toggle bridges on/off interactively…",
		);
	}
	for (const p of detectedActive) {
		providerChoiceOptions.push(`${p.label} only (${p.id})`);
	}

	const selectedProviderChoice = await ctx.ui.select(
		"Select Providers for Pools",
		providerChoiceOptions,
	);
	if (!selectedProviderChoice) {
		ctx.ui.notify("setup cancelled, nothing written", "info");
		return false;
	}

	let chosenProviders: DetectedProvider[];
	if (selectedProviderChoice.startsWith("All detected providers")) {
		chosenProviders = [...detectedActive];
	} else if (selectedProviderChoice.includes("Custom combination")) {
		const toggled = await runInteractiveBridgeToggle(ctx.ui, detectedActive, detectedActive);
		if (!toggled) {
			ctx.ui.notify("setup cancelled, nothing written", "info");
			return false;
		}
		chosenProviders = toggled;
	} else {
		chosenProviders = detectedActive.filter(p => selectedProviderChoice.includes(`(${p.id})`));
	}

	// Step 3: Offer the routing strategy
	// Only the strategies the router tells apart: "highest-quota" routes exactly like "hybrid".
	const strategyOptions = [
		"hybrid (Recommended) - start each new turn on the candidate with the most free quota, stay on it for follow-ups",
		"waterfall - always use the first candidate in the list until it is spent, then the next",
	];

	const selectedStrategyChoice = await ctx.ui.select(
		"Select Routing Strategy",
		strategyOptions,
	);
	if (!selectedStrategyChoice) {
		ctx.ui.notify("setup cancelled, nothing written", "info");
		return false;
	}

	let strategy: RoutingStrategy = selectedStrategyChoice.startsWith("waterfall") ? "waterfall" : "hybrid";

	let currentConfig: { pools?: unknown; integrations?: unknown } | null = null;
	const existingPoolsPath = join(root, "pools.json");
	const existingIntPath = join(root, "integrations.json");
	try {
		const curPools = existsSync(existingPoolsPath)
			? JSON.parse(readFileSync(existingPoolsPath, "utf8"))
			: null;
		const curInt = existsSync(existingIntPath)
			? JSON.parse(readFileSync(existingIntPath, "utf8"))
			: null;
		if (curPools || curInt) {
			currentConfig = { pools: curPools, integrations: curInt };
		}
	} catch {
		// Ignore read/parse errors for preview
	}

	const currentPools = currentConfig?.pools as { pools?: { id?: unknown; name?: unknown; rules?: unknown }[] } | null | undefined;
	const currentList = (Array.isArray(currentPools?.pools) ? currentPools.pools : []).filter(pool => typeof pool?.id === "string");
	const names = new Map(currentList.filter(pool => typeof pool.name === "string").map(pool => [pool.id as string, pool.name as string]));
	const currentRules = new Map(currentList.map(pool => [pool.id as string, pool.rules]));

	const rebuildPoolsFromProviders = (providersList: DetectedProvider[], strat: RoutingStrategy) => {
		const gen = generateRecommendedConfig(providersList, { strategy: strat, hasModel: options?.hasModel });
		const notes: string[] = [];
		const built = gen.pools.map(pool => {
			const named = { ...pool, name: names.get(pool.id) ?? pool.name };
			const carried = carryRules(currentRules.get(pool.id), named);
			notes.push(...carried.notes);
			return carried.rules ? { ...named, rules: carried.rules } : named;
		});
		return { generated: gen, pools: built, ruleNotes: notes };
	};

	let { generated, pools, ruleNotes } = rebuildPoolsFromProviders(chosenProviders, strategy);
	if (pools.length === 0) {
		ctx.ui.notify(`ai-balancer: none of the chosen providers' models are available in Pi (${generated.skipped.join(", ")}). Nothing written.`, "warning");
		return false;
	}

	// Load existing profiles.json so user can also inspect/customize agent role assignments in the wizard
	const profilesPath = options?.profilesPath ?? DEFAULT_PROFILES_PATH;
	const existingProfilesStore = loadProfilesStore(profilesPath);
	let activeProfileName = existingProfilesStore?.active;
	let draftRoles: ProfileConfig = {};
	let rolesModified = false;

	let advisor: AdvisorReport = recommendRolesHeuristic({
		providers: chosenProviders,
		pools,
	});

	if (activeProfileName && existingProfilesStore?.profiles?.[activeProfileName]) {
		const switchChoice = await ctx.ui.select(
			t("setup.profile.activePrompt", { name: activeProfileName }),
			[t("setup.profile.build"), t("setup.profile.keep", { name: activeProfileName })],
		);
		if (switchChoice === t("setup.profile.build")) {
			let ident: string | undefined;
			if (ctx.ui.input) {
				ident = await ctx.ui.input(t("setup.profile.idPrompt"), t("setup.profile.idHint"));
			}
			activeProfileName = buildBalancerProfileName(ident);
			draftRoles = applyRecommendationsToProfile(
				existingProfilesStore.profiles[existingProfilesStore.active ?? ""] ?? {},
				advisor.recommendations,
			);
			rolesModified = true;
			ctx.ui.notify(`Created balanced profile '${activeProfileName}'.`, "info");
		} else {
			draftRoles = {
				...(existingProfilesStore.profiles[activeProfileName] ?? {}),
			};
		}
	} else {
		// No active profile found or profiles.json is missing/empty
		const offerChoice = await ctx.ui.select(
			t("setup.profile.offerPrompt"),
			[t("setup.profile.create"), t("setup.profile.skip")],
		);
		if (offerChoice === t("setup.profile.create")) {
			let ident: string | undefined;
			if (ctx.ui.input) {
				ident = await ctx.ui.input(t("setup.profile.idPrompt"), t("setup.profile.idHint"));
			}
			activeProfileName = buildBalancerProfileName(ident);
			draftRoles = applyRecommendationsToProfile({}, advisor.recommendations);
			rolesModified = true;
			ctx.ui.notify(`Created balanced profile '${activeProfileName}'.`, "info");
		} else {
			activeProfileName = "default";
		}
	}

	// Step 4: Interactive Customization Hub (Finish is option[0] so quick-setup and default tests proceed directly)
	while (true) {
		const hubOptions: string[] = [
			"✓ Finish & review configuration summary (Recommended)",
			`🤖 Role & Model Advisor (${advisor.source === "ai+heuristic" ? "AI + Heuristic" : "Heuristic"}: view/apply recommendations or run ~350-token AI query)…`,
			`🎭 Customize Agent Roles (${activeProfileName ? `Profile: ${activeProfileName}` : "No profile"} - ${ROLE_CATALOG.length} roles)…`,
			t("setup.profile.hub"),
			`🏊 Customize Pool Candidates & Priority (${pools.length} pools: toggle/reorder models & strategy per pool)…`,
			`🔌 Toggle Active Bridges / Providers (${chosenProviders.length}/${detectedActive.length} active)…`,
		];
		if (options?.onOpenControlCenter) {
			hubOptions.push("🖥️ Open Interactive Control Center GUI (tabs: Overview, Roles, Pools, Advisor)");
		}

		const hubChoice = await ctx.ui.select(
			"ai-balancer Setup: Customize Pools, Roles & Advisor",
			hubOptions,
		);
		if (!hubChoice) {
			ctx.ui.notify("setup cancelled, nothing written", "info");
			return false;
		}

		if (hubChoice.startsWith("✓ Finish")) {
			break;
		}

		if (hubChoice === t("setup.profile.hub")) {
			let ident: string | undefined;
			if (ctx.ui.input) {
				ident = await ctx.ui.input(t("setup.profile.idPrompt"), t("setup.profile.idHint"));
			}
			const newProfileName = buildBalancerProfileName(ident);
			activeProfileName = newProfileName;
			draftRoles = applyRecommendationsToProfile(draftRoles, advisor.recommendations);
			rolesModified = true;
			ctx.ui.notify(t("setup.profile.configured", { name: activeProfileName }), "info");
			continue;
		}

		if (hubChoice.includes("Toggle Active Bridges")) {
			const updatedProviders = await runInteractiveBridgeToggle(ctx.ui, detectedActive, chosenProviders);
			if (updatedProviders) {
				chosenProviders = updatedProviders;
				const rebuilt = rebuildPoolsFromProviders(chosenProviders, strategy);
				if (rebuilt.pools.length === 0) {
					ctx.ui.notify("None of the selected providers have available models in Pi; keeping previous pools.", "warning");
				} else {
					generated = rebuilt.generated;
					pools = rebuilt.pools;
					ruleNotes = rebuilt.ruleNotes;
					advisor = recommendRolesHeuristic({ providers: chosenProviders, pools });
				}
			}
			continue;
		}

		if (hubChoice.includes("Customize Pool Candidates")) {
			while (true) {
				const poolMenuOptions = [
					"← Back to Setup Hub",
					...pools.map(p => `pool/${p.id} [${p.strategy ?? "hybrid"}]: ${p.candidates.join(" → ")}`),
				];
				const poolChoice = await ctx.ui.select(
					"Customize Pools (Select a pool to edit candidates, priority order, or strategy)",
					poolMenuOptions,
				);
				if (!poolChoice || poolChoice.startsWith("← Back")) break;

				const targetPool = pools.find(p => poolChoice.startsWith(`pool/${p.id} `));
				if (!targetPool) continue;

				const allUsable = usableCandidatesForProviders(chosenProviders, options?.hasModel);
				while (true) {
					const editOptions: string[] = [
						`← Done editing pool/${targetPool.id}`,
						`🔀 Toggle strategy (current: ${targetPool.strategy ?? "hybrid"} → switch to ${targetPool.strategy === "waterfall" ? "hybrid" : "waterfall"})`,
					];
					targetPool.candidates.forEach((cand, idx) => {
						if (idx > 0) {
							editOptions.push(`↑ Move up (#${idx + 1} → #${idx}): ${cand}`);
						}
						if (idx < targetPool.candidates.length - 1) {
							editOptions.push(`↓ Move down (#${idx + 1} → #${idx + 2}): ${cand}`);
						}
					});
					for (const ref of allUsable) {
						const inPool = targetPool.candidates.includes(ref);
						editOptions.push(
							inPool
								? `[✓] Remove candidate from pool/${targetPool.id}: ${ref}`
								: `[ ] Add candidate to pool/${targetPool.id}: ${ref}`,
						);
					}

					const editChoice = await ctx.ui.select(
						`Edit pool/${targetPool.id} [${targetPool.strategy ?? "hybrid"}]: ${targetPool.candidates.join(" → ")}`,
						editOptions,
					);
					if (!editChoice || editChoice.startsWith("← Done")) break;

					if (editChoice.includes("Toggle strategy")) {
						targetPool.strategy = targetPool.strategy === "waterfall" ? "hybrid" : "waterfall";
						const carried = carryRules(targetPool.rules, targetPool);
						targetPool.rules = carried.rules;
						continue;
					}
					if (editChoice.startsWith("↑ Move up")) {
						const cand = editChoice.slice(editChoice.indexOf(": ") + 2).trim();
						const idx = targetPool.candidates.indexOf(cand);
						if (idx > 0) {
							targetPool.candidates = moveCandidateInList(targetPool.candidates, idx, -1);
						}
						continue;
					}
					if (editChoice.startsWith("↓ Move down")) {
						const cand = editChoice.slice(editChoice.indexOf(": ") + 2).trim();
						const idx = targetPool.candidates.indexOf(cand);
						if (idx >= 0 && idx < targetPool.candidates.length - 1) {
							targetPool.candidates = moveCandidateInList(targetPool.candidates, idx, 1);
						}
						continue;
					}
					if (editChoice.startsWith("[✓]") || editChoice.startsWith("[ ]")) {
						const cand = editChoice.slice(editChoice.indexOf(": ") + 2).trim();
						const next = toggleCandidateInList(targetPool.candidates, cand);
						if (next.length === targetPool.candidates.length && targetPool.candidates.length === 1) {
							ctx.ui.notify(`pool/${targetPool.id} must keep at least 1 candidate.`, "warning");
						} else {
							targetPool.candidates = next;
							const carried = carryRules(targetPool.rules, targetPool);
							targetPool.rules = carried.rules;
						}
					}
				}
				advisor = recommendRolesHeuristic({ providers: chosenProviders, pools });
			}
			continue;
		}

		if (hubChoice.includes("Customize Agent Roles")) {
			while (true) {
				const availableTargets = buildAvailableModelTargets(chosenProviders, pools);
				const roleMenuOptions: string[] = [
					"← Back to Setup Hub",
					`✨ Apply Advisor recommendations to all ${ROLE_CATALOG.length} roles`,
					...ROLE_CATALOG.map(r => {
						const curModel = draftRoles[r.role]?.model ?? "pool/orchestrator";
						const curThinking = draftRoles[r.role]?.thinking ?? r.defaultThinking;
						return `${r.role} [${r.category.toUpperCase()}] → ${curModel} (thinking: ${curThinking}) — ${r.purpose}`;
					}),
				];
				const roleChoice = await ctx.ui.select(
					`Customize Agent Roles (Profile: ${activeProfileName})`,
					roleMenuOptions,
				);
				if (!roleChoice || roleChoice.startsWith("← Back")) break;

				if (roleChoice.startsWith("✨ Apply Advisor")) {
					draftRoles = applyRecommendationsToProfile(draftRoles, advisor.recommendations);
					rolesModified = true;
					ctx.ui.notify(`Applied ${advisor.recommendations.length} advisor recommendations to draft profile '${activeProfileName}'.`, "info");
					continue;
				}

				const selectedRole = ROLE_CATALOG.find(r => roleChoice.startsWith(`${r.role} [`));
				if (!selectedRole) continue;

				const rec = advisor.recommendations.find(r => r.role === selectedRole.role);
				const curModel = draftRoles[selectedRole.role]?.model ?? "pool/orchestrator";
				const targetOptions = [
					...availableTargets.map(t => {
						const tags: string[] = [];
						if (t === curModel) tags.push("Current");
						if (rec && t === rec.recommendedModel) tags.push(`Recommended: ${rec.reason}`);
						return tags.length > 0 ? `${t} (${tags.join(" · ")})` : t;
					}),
					"← Cancel",
				];
				const modelChoice = await ctx.ui.select(
					`Select Model or Pool for ${selectedRole.role} (${selectedRole.category.toUpperCase()}: ${selectedRole.purpose})`,
					targetOptions,
				);
				if (!modelChoice || modelChoice.startsWith("← Cancel")) continue;
				const chosenModel = modelChoice.split(" (")[0]!.trim();

				const curThinking = draftRoles[selectedRole.role]?.thinking ?? selectedRole.defaultThinking;
				const thinkingLevels: ("low" | "medium" | "high")[] = ["low", "medium", "high"];
				const thinkingOptions = thinkingLevels.map(lvl => {
					const tags: string[] = [];
					if (lvl === curThinking) tags.push("Current");
					if (lvl === selectedRole.defaultThinking) tags.push("Default");
					return tags.length > 0 ? `${lvl} (${tags.join(" · ")})` : lvl;
				});
				const thinkingChoice = await ctx.ui.select(
					`Select Thinking Level for ${selectedRole.role}`,
					thinkingOptions,
				);
				const chosenThinking = (thinkingChoice ? thinkingChoice.split(" (")[0]!.trim() : curThinking) as "low" | "medium" | "high";

				draftRoles[selectedRole.role] = {
					...(draftRoles[selectedRole.role] ?? {}),
					model: chosenModel,
					thinking: chosenThinking,
				};
				rolesModified = true;
			}
			continue;
		}

		if (hubChoice.includes("Role & Model Advisor")) {
			while (true) {
				const advOptions: string[] = [
					"← Back to Setup Hub",
					`✓ Apply all ${advisor.recommendations.length} recommended role assignments`,
					"⚡ Query lightweight AI Advisor (~350 tokens) for tailored analysis",
					...advisor.recommendations.map(rec => {
						const current = draftRoles[rec.role]?.model ?? "(unassigned)";
						const matchTag = current === rec.recommendedModel ? " [matches]" : "";
						return `Apply ${rec.role} [${rec.category.toUpperCase()}] → ${rec.recommendedModel} (${rec.thinking})${matchTag} — ${rec.reason}`;
					}),
				];
				const advChoice = await ctx.ui.select(
					`Role & Model Advisor — ${advisor.summary}`,
					advOptions,
				);
				if (!advChoice || advChoice.startsWith("← Back")) break;

				if (advChoice.startsWith("✓ Apply all")) {
					draftRoles = applyRecommendationsToProfile(draftRoles, advisor.recommendations);
					rolesModified = true;
					ctx.ui.notify(`Applied all ${advisor.recommendations.length} recommendations to draft profile '${activeProfileName}'.`, "info");
					continue;
				}
				if (advChoice.startsWith("⚡ Query")) {
					if (!(await ctx.ui.confirm(t("setup.advisor.consentTitle"), t("setup.advisor.consentBody")))) continue;
					const runner = options?.aiRunner ?? createDefaultCliAiRunner(options?.agyBin);
					advisor = await recommendRolesWithAdvisor(
						{ providers: chosenProviders, pools },
						{ aiRunner: runner },
					);
					ctx.ui.notify(`Advisor updated: ${advisor.summary}`, "info");
					continue;
				}
				const clickedRec = advisor.recommendations.find(rec => advChoice.startsWith(`Apply ${rec.role} [`));
				if (clickedRec) {
					draftRoles[clickedRec.role] = {
						...(draftRoles[clickedRec.role] ?? {}),
						model: clickedRec.recommendedModel,
						thinking: clickedRec.thinking,
					};
					rolesModified = true;
					ctx.ui.notify(`Assigned ${clickedRec.role} → ${clickedRec.recommendedModel} (${clickedRec.thinking})`, "info");
				}
			}
			continue;
		}

		if (hubChoice.includes("Open Interactive Control Center") && options?.onOpenControlCenter) {
			await options.onOpenControlCenter();
			return true;
		}
	}

	// Step 5: Preview resulting pools, integrations, and role changes, then ask for confirmation
	const used = new Set(pools.flatMap(pool => pool.candidates.map(ref => ref.slice(0, ref.indexOf("/")))));
	const recommended = {
		...generated,
		pools,
		ruleNotes,
		integrations: mergeIntegrations(
			currentConfig?.integrations ?? null,
			generated.integrations.filter(entry => used.has(entry.provider)),
		),
	};
	let previewText = generateConfigPreview(currentConfig, recommended);
	if (rolesModified) {
		const roleLines = Object.entries(draftRoles).map(
			([role, cfg]) => `      • ${role} → ${cfg.model}${cfg.thinking ? ` (${cfg.thinking})` : ""}`,
		);
		previewText += `\n  • profiles.json [${activeProfileName}] role assignments:\n${roleLines.join("\n")}`;
	}
	const confirmMessage = `${previewText}\n\nApply and write configuration to pools.json${rolesModified ? ", integrations.json, and profiles.json" : " and integrations.json"}?`;

	const confirmed = await ctx.ui.confirm("Confirm ai-balancer Configuration", confirmMessage);
	if (!confirmed) {
		ctx.ui.notify("setup cancelled, nothing written", "info");
		return false;
	}

	// Step 6: Safely write configuration with backups and notify
	const res = writeConfigSafely(root, { integrations: recommended.integrations, pools: recommended.pools });
	if (rolesModified) {
		try {
			const existingStore = loadProfilesStore(profilesPath);
			if (existingStore) {
				existingStore.profiles[activeProfileName] = draftRoles;
				existingStore.active = activeProfileName;
				const read = readProfiles(profilesPath);
				saveProfilesStore(existingStore, read, { path: profilesPath, hasModel: options?.hasModel ?? (() => true) });
			} else {
				writeFileSync(
					profilesPath,
					`${JSON.stringify({ kind: PROFILES_KIND, version: PROFILES_VERSION, active: activeProfileName, profiles: { [activeProfileName]: draftRoles } }, null, 2)}\n`,
					{ encoding: "utf8", mode: 0o600 },
				);
			}
		} catch (err) {
			ctx.ui.notify(`Warning: failed to save profiles.json: ${err instanceof Error ? err.message : String(err)}`, "warning");
		}
	}
	ctx.ui.notify(
		`ai-balancer: Setup complete! Wrote ${res.poolsPath} and ${res.integrationsPath}${rolesModified ? ` and ${profilesPath}` : ""}${
			res.backupCreated ? ` (backups created at ${res.poolsPath}.bak, ${res.integrationsPath}.bak)` : ""
		}`,
		"info",
	);

	return true;
}
