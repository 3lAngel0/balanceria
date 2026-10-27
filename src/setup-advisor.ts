import { execFile } from "node:child_process";
import type { ProfileConfig, RoleRoute } from "./profiles.ts";
import type { DetectedProvider, PoolConfig } from "./setup.ts";
import { t } from "./i18n/index.ts";

export type RoleCategory = "read" | "write" | "audit" | "orchestrate";

export interface RoleCatalogEntry {
	role: string;
	shortName: string;
	category: RoleCategory;
	purpose: string;
	defaultThinking: "low" | "medium" | "high";
}

export const ROLE_CATALOG: readonly RoleCatalogEntry[] = [
	{
		role: "orchestrator",
		shortName: "orchestrator",
		category: "orchestrate",
		get purpose() {
			return t("setup.role.orchestrator.purpose");
		},
		defaultThinking: "medium",
	},
	{
		role: "gentle-ai-explore",
		shortName: "explore",
		category: "read",
		get purpose() {
			return t("setup.role.gentle-ai-explore.purpose");
		},
		defaultThinking: "low",
	},
	{
		role: "gentle-ai-worker",
		shortName: "worker",
		category: "write",
		get purpose() {
			return t("setup.role.gentle-ai-worker.purpose");
		},
		defaultThinking: "medium",
	},
	{
		role: "gentle-ai-verify",
		shortName: "verify",
		category: "audit",
		get purpose() {
			return t("setup.role.gentle-ai-verify.purpose");
		},
		defaultThinking: "medium",
	},
	{
		role: "review-risk",
		shortName: "rev-risk",
		category: "audit",
		get purpose() {
			return t("setup.role.review-risk.purpose");
		},
		defaultThinking: "high",
	},
	{
		role: "review-reliability",
		shortName: "rev-rel",
		category: "audit",
		get purpose() {
			return t("setup.role.review-reliability.purpose");
		},
		defaultThinking: "medium",
	},
	{
		role: "review-resilience",
		shortName: "rev-res",
		category: "audit",
		get purpose() {
			return t("setup.role.review-resilience.purpose");
		},
		defaultThinking: "medium",
	},
	{
		role: "review-readability",
		shortName: "rev-read",
		category: "read",
		get purpose() {
			return t("setup.role.review-readability.purpose");
		},
		defaultThinking: "low",
	},
	{
		role: "jd-judge-a",
		shortName: "judge-a",
		category: "audit",
		get purpose() {
			return t("setup.role.jd-judge-a.purpose");
		},
		defaultThinking: "high",
	},
	{
		role: "jd-judge-b",
		shortName: "judge-b",
		category: "audit",
		get purpose() {
			return t("setup.role.jd-judge-b.purpose");
		},
		defaultThinking: "high",
	},
	{
		role: "jd-fix-agent",
		shortName: "jd-fix",
		category: "write",
		get purpose() {
			return t("setup.role.jd-fix-agent.purpose");
		},
		defaultThinking: "medium",
	},
];

export interface RoleRecommendation {
	role: string;
	category: RoleCategory;
	purpose: string;
	recommendedModel: string;
	thinking: "low" | "medium" | "high";
	reason: string;
}

export interface AdvisorReport {
	source: "heuristic" | "ai+heuristic";
	estimatedTokens: number;
	summary: string;
	recommendations: RoleRecommendation[];
}

export interface AdvisorInput {
	providers: readonly DetectedProvider[];
	pools: readonly PoolConfig[];
	quotaByKey?: Readonly<Record<string, number>>;
	roleTokensLast7d?: Readonly<Record<string, number>>;
}

export interface LightweightAiResponse {
	text: string;
	tokensUsed: number;
}

export type LightweightAiRunner = (prompt: string) => Promise<LightweightAiResponse>;

/**
 * Lists every selectable model target: virtual `pool/<id>` entries first,
 * followed by all unique `provider/model` candidates from detected providers and pools.
 */
export function buildAvailableModelTargets(
	providers: readonly DetectedProvider[],
	pools: readonly PoolConfig[],
): string[] {
	const targets = new Set<string>();
	for (const pool of pools) {
		targets.add(`pool/${pool.id}`);
	}
	for (const pool of pools) {
		for (const candidate of pool.candidates) {
			if (candidate.includes("/")) targets.add(candidate);
		}
	}
	for (const provider of providers) {
		if (!provider.detected) continue;
		for (const model of provider.availableModels) {
			targets.add(`${provider.id}/${model}`);
		}
	}
	return [...targets];
}

function firstAvailable(preferred: readonly string[], available: ReadonlySet<string>, fallback: string): string {
	for (const item of preferred) {
		if (available.has(item)) return item;
	}
	return [...available][0] ?? fallback;
}

/**
 * Deterministic zero-token role recommender based on detected bridges, pools,
 * and live quota availability.
 */
export function recommendRolesHeuristic(input: AdvisorInput): AdvisorReport {
	const available = new Set(buildAvailableModelTargets(input.providers, input.pools));
	const hasAgy = input.providers.some(p => p.id === "antigravity" && p.detected);
	const hasBridge = input.providers.some(p => p.id === "claude-bridge" && p.detected);
	const agyGeminiQuota = input.quotaByKey?.["antigravity/gemini"] ?? 1;
	const claudeBridgeQuota = input.quotaByKey?.["claude-bridge/claude"] ?? 1;

	const readModel = firstAvailable(
		[
			"antigravity/gemini-3-8-flash",
			"antigravity/gemini-4-argon",
			"pool/orchestrator",
			"pool/claude-sonnet-5-5",
			"claude-bridge/claude-3-7-sonnet",
		],
		available,
		"antigravity/gemini-3-8-flash",
	);

	const writeModel = firstAvailable(
		[
			"pool/claude-sonnet-5-5",
			"claude-bridge/claude-sonnet-5-5",
			"antigravity/claude-sonnet-5-5",
			"claude-code/claude-3-7-sonnet",
			"antigravity/gemini-4-argon",
		],
		available,
		"pool/claude-sonnet-5-5",
	);

	const auditDeepModel = firstAvailable(
		["antigravity/gemini-4-argon", "claude-bridge/claude-sonnet-5-5", "pool/claude-sonnet-5-5"],
		available,
		"antigravity/gemini-4-argon",
	);

	const auditDiverseModel = firstAvailable(
		[
			"antigravity/gemini-4-argon",
			"pool/orchestrator",
			"pool/claude-sonnet-5-5",
			"antigravity/gemini-3-8-flash",
		],
		available,
		"pool/orchestrator",
	);

	const orchestratorModel = firstAvailable(
		[
			"pool/orchestrator",
			"antigravity/gemini-4-argon",
			"pool/claude-sonnet-5-5",
			"claude-bridge/claude-sonnet-5-5",
		],
		available,
		"pool/orchestrator",
	);

	const recommendations: RoleRecommendation[] = ROLE_CATALOG.map(entry => {
		if (entry.category === "read") {
			return {
				role: entry.role,
				category: entry.category,
				purpose: entry.purpose,
				recommendedModel: readModel,
				thinking: entry.defaultThinking,
				reason: hasAgy
					? t("setup.advisor.reason.readAgy", { model: readModel, percent: Math.round(agyGeminiQuota * 100) })
					: t("setup.advisor.reason.readFast", { model: readModel }),
			};
		}
		if (entry.category === "write") {
			return {
				role: entry.role,
				category: entry.category,
				purpose: entry.purpose,
				recommendedModel: writeModel,
				thinking: entry.defaultThinking,
				reason: writeModel.startsWith("pool/")
					? t("setup.advisor.reason.writePool", { model: writeModel })
					: t("setup.advisor.reason.writeDirect", { model: writeModel }),
			};
		}
		if (entry.category === "orchestrate") {
			return {
				role: entry.role,
				category: entry.category,
				purpose: entry.purpose,
				recommendedModel: orchestratorModel,
				thinking: entry.defaultThinking,
				reason: t("setup.advisor.reason.orchestrate", { model: orchestratorModel }),
			};
		}
		// Audit roles: deep critical roles vs secondary/resilience roles
		const isDeepAudit = entry.role === "review-risk" || entry.role === "jd-judge-a" || entry.role === "gentle-ai-verify";
		const chosen = isDeepAudit ? auditDeepModel : auditDiverseModel;
		return {
			role: entry.role,
			category: entry.category,
			purpose: entry.purpose,
			recommendedModel: chosen,
			thinking: entry.defaultThinking,
			reason: isDeepAudit
				? t("setup.advisor.reason.auditDeep", { model: chosen, percent: Math.round(claudeBridgeQuota * 100) })
				: t("setup.advisor.reason.auditDiverse", { model: chosen }),
		};
	});

	const bridgeNote =
		hasAgy && hasBridge
			? t("setup.advisor.summary.both")
			: hasAgy
				? t("setup.advisor.summary.agy")
				: t("setup.advisor.summary.bridge");

	return {
		source: "heuristic",
		estimatedTokens: 0,
		summary: bridgeNote,
		recommendations,
	};
}

function buildCompactAdvisorPrompt(input: AdvisorInput, availableTargets: readonly string[]): string {
	const rolesBrief = ROLE_CATALOG.map(r => `${r.role}(${r.category})`).join(",");
	const targetsBrief = availableTargets.slice(0, 12).join(",");
	const quotasBrief = input.quotaByKey
		? Object.entries(input.quotaByKey)
				.map(([k, v]) => `${k}:${Math.round(v * 100)}%`)
				.join(",")
		: "none";
	return [
		"Return ONLY valid JSON: {\"summary\":\"1 sentence advice\",\"roles\":{\"<role>\":{\"model\":\"<target>\",\"thinking\":\"low|medium|high\",\"reason\":\"short reason\"}}}.",
		`Allowed targets: ${targetsBrief}.`,
		`Quotas free: ${quotasBrief}.`,
		`Roles: ${rolesBrief}.`,
		"Rule: assign fast AGY/Flash to read, Sonnet to write, Argon/Sonnet to audit/control.",
	].join(" ");
}

/**
 * Runs a minimal-token (~300-500 tokens) CLI/LLM query via `agy` when available,
 * or a caller-provided runner, merging validated model recommendations over the
 * heuristic baseline. Never throws; falls back to heuristic on any error.
 */
export function createDefaultCliAiRunner(agyBin = "agy", timeoutMs = 12_000): LightweightAiRunner {
	return (prompt: string) =>
		new Promise((resolve, reject) => {
			execFile(
				agyBin,
				["--model", "gemini-3-8-flash", "--print", prompt],
				{ timeout: timeoutMs },
				(err, stdout) => {
					if (err) return reject(err);
					const text = String(stdout ?? "").trim();
					if (!text) return reject(new Error("empty output"));
					const estimated = Math.max(120, Math.round((prompt.length + text.length) / 4));
					resolve({ text, tokensUsed: estimated });
				},
			);
		});
}

const OPUS = /opus/i;

export async function recommendRolesWithAdvisor(
	input: AdvisorInput,
	options?: { aiRunner?: LightweightAiRunner },
): Promise<AdvisorReport> {
	const baseline = recommendRolesHeuristic(input);
	if (!options?.aiRunner) return baseline;

	// Opus is never offered to or accepted from the advisor; cost containment decides, not the model.
	const available = new Set(buildAvailableModelTargets(input.providers, input.pools).filter(target => !OPUS.test(target)));
	const prompt = buildCompactAdvisorPrompt(input, [...available]);

	try {
		const response = await options.aiRunner(prompt);
		const jsonMatch = /\{[\s\S]*\}/.exec(response.text);
		if (!jsonMatch) return baseline;
		const parsed = JSON.parse(jsonMatch[0]) as {
			summary?: unknown;
			roles?: Record<string, { model?: unknown; thinking?: unknown; reason?: unknown }>;
		};
		if (!parsed || typeof parsed !== "object") return baseline;

		const rolesMap = parsed.roles && typeof parsed.roles === "object" ? parsed.roles : {};
		let appliedAny = false;
		const merged = baseline.recommendations.map(rec => {
			const override = rolesMap[rec.role];
			if (!override || typeof override !== "object") return rec;
			const model = typeof override.model === "string" && available.has(override.model) ? override.model : rec.recommendedModel;
			const thinking =
				override.thinking === "low" || override.thinking === "medium" || override.thinking === "high"
					? override.thinking
					: rec.thinking;
			const reason =
				typeof override.reason === "string" && override.reason.trim().length > 0 && !OPUS.test(override.reason) ? override.reason.trim() : rec.reason;
			if (model !== rec.recommendedModel || reason !== rec.reason) appliedAny = true;
			return { ...rec, recommendedModel: model, thinking, reason };
		});

		const summary =
			typeof parsed.summary === "string" && parsed.summary.trim().length > 0 && !OPUS.test(parsed.summary)
				? parsed.summary.trim()
				: baseline.summary;

		if (!appliedAny && summary === baseline.summary) return baseline;

		return {
			source: "ai+heuristic",
			estimatedTokens: response.tokensUsed > 0 ? response.tokensUsed : Math.round((prompt.length + response.text.length) / 4),
			summary,
			recommendations: merged,
		};
	} catch {
		return baseline;
	}
}

/** Stored in `configuredModel` when a role has no route; compare against it, show it with `displayModel`. */
export const UNASSIGNED = "(unassigned)";
/** Stored in `thinking` when a role has no thinking level of its own. */
export const THINKING_DEFAULT = "default";

/** The text to show for a configured model: the sentinel is translated, real targets are not. */
export function displayModel(model: string): string {
	return model === UNASSIGNED ? t("setup.unassigned") : model;
}

/** The text to show for a thinking level: the sentinel is translated, `low`/`medium`/`high` are not. */
export function displayThinking(thinking: string): string {
	return thinking === THINKING_DEFAULT ? t("setup.thinkingDefault") : thinking;
}

export interface EffectiveRoleRow {
	role: string;
	shortName: string;
	category: RoleCategory;
	purpose: string;
	configuredModel: string;
	thinking: string;
	effectiveTarget: string;
}

/**
 * Resolves every catalog role (plus any extra custom roles in the profile) into a clear
 * row showing what is configured (`pool/X` or `provider/model`) and what it actually routes to.
 */
export function resolveEffectiveRoleRoutes(
	profile: ProfileConfig | undefined,
	pools: readonly PoolConfig[],
	lastRoutedByPool?: Readonly<Record<string, string>>,
): EffectiveRoleRow[] {
	const poolMap = new Map(pools.map(p => [p.id, p]));
	const seen = new Set<string>();
	const rows: EffectiveRoleRow[] = [];

	const buildRow = (
		role: string,
		shortName: string,
		category: RoleCategory,
		purpose: string,
		route: RoleRoute | undefined,
	): EffectiveRoleRow => {
		const configuredModel = route?.model || UNASSIGNED;
		const thinking = route?.thinking || THINKING_DEFAULT;
		let effectiveTarget = configuredModel;
		if (configuredModel.startsWith("pool/")) {
			const poolId = configuredModel.slice(5);
			const pool = poolMap.get(poolId);
			const activeProvider = lastRoutedByPool?.[poolId];
			if (pool) {
				const chain = pool.candidates.join(" → ");
				effectiveTarget = activeProvider ? `${activeProvider} [${chain}]` : chain;
			}
		}
		return {
			role,
			shortName,
			category,
			purpose,
			configuredModel,
			thinking,
			effectiveTarget,
		};
	};

	for (const entry of ROLE_CATALOG) {
		seen.add(entry.role);
		rows.push(buildRow(entry.role, entry.shortName, entry.category, entry.purpose, profile?.[entry.role]));
	}

	if (profile) {
		for (const [role, route] of Object.entries(profile)) {
			if (seen.has(role)) continue;
			rows.push(buildRow(role, role, "write", t("setup.role.custom.purpose"), route));
		}
	}

	return rows;
}

/** Applies a set of role recommendations onto a ProfileConfig copy. */
export function applyRecommendationsToProfile(
	base: ProfileConfig | undefined,
	recommendations: readonly RoleRecommendation[],
): ProfileConfig {
	const next: ProfileConfig = base ? JSON.parse(JSON.stringify(base)) : {};
	for (const rec of recommendations) {
		next[rec.role] = {
			...(next[rec.role] ?? {}),
			model: rec.recommendedModel,
			thinking: rec.thinking,
		};
	}
	return next;
}
