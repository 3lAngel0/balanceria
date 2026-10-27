import { AGY_GROUP_ARGON, AGY_GROUP_CLAUDE, AGY_GROUP_GEMINI, agyQuotaKeyForGroup } from "./agy-usage.ts";
import { POOL_PROVIDER } from "./pools.ts";

// Feeds Gentle Shell's native usage bar and `/gentle:usage` panel (alt+u).
// The shell meters the session's provider, which is `pool` on a pool model, so
// this source answers for `pool` with both subscriptions: the Claude windows
// that pi-claude-usage reports for `claude-bridge`, and the agy groups.
// Shapes mirror gentle-pi's lib/shell-usage.ts usage-source contract verbatim;
// the shell validates every field on its side of the event bus.

export const USAGE_SOURCE_EVENT = "gentle-pi:usage-source/v1";
export const USAGE_SOURCE_SCHEMA = "gentle-pi.usage-source/v1";
export const CLAUDE_BRIDGE_PROVIDER = "claude-bridge";

export interface UsageWindow {
	label: string;
	usedPercent: number;
	windowSeconds: number;
	resetAt: number | null;
}

export interface UsageLimit {
	name: string;
	windows: UsageWindow[];
	limitReached: boolean;
}

export interface ProviderUsage {
	provider: string;
	plan: string | undefined;
	limits: UsageLimit[];
	fetchedAt: number;
}

export type UsageFetch = (apiKey: string | undefined, fetchFn: typeof fetch, now: number) => Promise<ProviderUsage | undefined>;

export interface UsageSource {
	schema: typeof USAGE_SOURCE_SCHEMA;
	provider: string;
	pendingNote?: string;
	fetch: UsageFetch;
}

const FIVE_HOURS_S = 5 * 3600;
const WEEK_S = 7 * 24 * 3600;
const CLAUDE_KEY = "claude-bridge/claude";

const AGY_LIMIT_NAMES: Record<string, string> = {
	[AGY_GROUP_GEMINI]: "agy gemini",
	[AGY_GROUP_CLAUDE]: "agy claude",
	[AGY_GROUP_ARGON]: "agy argon",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function agyWindow(bucket: Record<string, unknown>): UsageWindow | undefined {
	if (bucket.disabled === true || typeof bucket.remaining_fraction !== "number") return undefined;
	const seconds = bucket.window === "5h" ? FIVE_HOURS_S : bucket.window === "weekly" ? WEEK_S : undefined;
	if (seconds === undefined) return undefined;
	const resetAt = typeof bucket.reset_time === "string" ? Date.parse(bucket.reset_time) : Number.NaN;
	const remaining = Math.max(0, Math.min(1, bucket.remaining_fraction));
	return {
		label: seconds === WEEK_S ? "week" : "5h",
		usedPercent: (1 - remaining) * 100,
		windowSeconds: seconds,
		resetAt: Number.isNaN(resetAt) ? null : resetAt,
	};
}

/** One limit per agy group, one window per enabled bucket, shortest window first. */
export function agyUsageLimits(report: unknown): UsageLimit[] {
	const command = isRecord(report) && isRecord(report.command) ? report.command : undefined;
	const data = command && isRecord(command.data) ? command.data : undefined;
	if (!data || !Array.isArray(data.groups)) return [];

	const limits: UsageLimit[] = [];
	for (const group of data.groups) {
		if (!isRecord(group) || typeof group.name !== "string" || !Array.isArray(group.buckets)) continue;
		const windows = group.buckets
			.filter(isRecord)
			.map(agyWindow)
			.filter((window): window is UsageWindow => window !== undefined)
			.sort((a, b) => a.windowSeconds - b.windowSeconds);
		if (windows.length === 0) continue;
		limits.push({
			name: AGY_LIMIT_NAMES[group.name] ?? `agy ${group.name}`,
			windows,
			limitReached: windows.some(window => window.usedPercent >= 100),
		});
	}
	return limits;
}

/** Quota key of a limit name, when the name is one of the known subscription limits. */
export function quotaKeyForLimit(name: string): string | undefined {
	if (name === "claude") return CLAUDE_KEY;
	const group = Object.entries(AGY_LIMIT_NAMES).find(([, groupName]) => groupName === name)?.[0];
	return group ? agyQuotaKeyForGroup(group) : undefined;
}

/**
 * The Claude subscription as the router's remaining fraction: what is left in
 * its fullest window (0 once the limit is reached), so highest-quota compares
 * claude-bridge with live numbers instead of a stale exhaustion.
 */
export function claudeQuotaEvents(usage: ProviderUsage): { type: "quota"; ts: number; key: string; remainingFraction: number; resetAt: number | undefined }[] {
	const limit = usage.limits.find(candidate => candidate.name === "claude");
	if (!limit || limit.windows.length === 0) return [];
	const fullest = limit.windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
	const remainingFraction = limit.limitReached ? 0 : Math.min(1, Math.max(0, Math.round(100 - fullest.usedPercent) / 100));
	return [{ type: "quota", ts: usage.fetchedAt, key: CLAUDE_KEY, remainingFraction, resetAt: fullest.resetAt ?? undefined }];
}

/** Limit name of a quota key; the key itself when it is not a known limit. */
export function limitNameForKey(key: string): string {
	if (key === CLAUDE_KEY) return "claude";
	const group = Object.keys(AGY_LIMIT_NAMES).find(name => agyQuotaKeyForGroup(name) === key);
	return group ? AGY_LIMIT_NAMES[group] : key;
}

/** Name of a Claude limit once it sits next to the agy ones in the pool. */
export function claudeLimitName(name: string): string {
	return name === "claude" ? "claude" : `claude ${name}`;
}

/**
 * Both subscriptions as one `pool` usage. The limit of the quota key the pool
 * currently routes to goes first, because the shell's bar shows the first one.
 */
export function combinePoolUsage(
	claude: ProviderUsage | undefined,
	agy: readonly UsageLimit[],
	routedKey: string | undefined,
	now: number,
): ProviderUsage | undefined {
	const claudeLimits = (claude?.limits ?? []).map(limit => ({
		...limit,
		name: claudeLimitName(limit.name),
	}));
	const limits = [...claudeLimits, ...agy];
	if (limits.length === 0) return undefined;
	const routed = limits.findIndex(limit => routedKey !== undefined && quotaKeyForLimit(limit.name) === routedKey);
	if (routed > 0) limits.unshift(...limits.splice(routed, 1));
	return {
		provider: POOL_PROVIDER,
		plan: claude?.plan ? `claude ${claude.plan}` : undefined,
		limits,
		// A cached Claude snapshot keeps its own age, so "updated" never overstates it.
		fetchedAt: Math.min(claude?.fetchedAt ?? now, now),
	};
}

export interface CachedClaudeUsage {
	/** Last request to Anthropic, successful or not. */
	attemptedAt: number;
	/** Last good answer, kept across failed attempts. */
	usage?: ProviderUsage;
}

export interface ClaudeUsageStore {
	load(): CachedClaudeUsage | undefined;
	save(cached: CachedClaudeUsage): void;
}

/**
 * Anthropic's usage endpoint rate-limits quickly (429 with a retry-after of
 * minutes), and every alt+u in every session would hit it. This wrapper asks
 * at most once per interval across sessions sharing the store, and answers
 * with the last good usage whenever the request is skipped or fails.
 */
export function throttledClaudeFetch(fetchClaude: UsageFetch, store: ClaudeUsageStore, minIntervalMs: number): UsageFetch {
	return async (apiKey, fetchFn, now) => {
		const cached = store.load();
		if (cached && now - cached.attemptedAt < minIntervalMs) return cached.usage;
		// Claim the attempt first so a parallel session does not repeat it.
		store.save({ attemptedAt: now, usage: cached?.usage });
		const fresh = await fetchClaude(apiKey, fetchFn, now).catch(() => undefined);
		if (!fresh) return cached?.usage;
		store.save({ attemptedAt: now, usage: fresh });
		return fresh;
	};
}

export interface PoolUsageSourceDeps {
	/** The claude-bridge source pi-claude-usage registered, when it did. */
	claudeSource: () => Pick<UsageSource, "fetch"> | undefined;
	/** Latest known `agy --print /usage --output-format json` report; must answer fast. */
	readAgyReport: () => Promise<unknown>;
	/** Quota key the pool routes to right now, e.g. "antigravity/claude". */
	routedKey: () => string | undefined;
}

export function createPoolUsageSource(deps: PoolUsageSourceDeps): UsageSource {
	return {
		schema: USAGE_SOURCE_SCHEMA,
		provider: POOL_PROVIDER,
		pendingNote: "claude + agy usage pending · r to fetch",
		async fetch(apiKey, fetchFn, now) {
			const [claude, report] = await Promise.all([
				Promise.resolve()
					.then(() => deps.claudeSource()?.fetch(apiKey, fetchFn, now))
					.catch(() => undefined),
				deps.readAgyReport().catch(() => undefined),
			]);
			return combinePoolUsage(claude, agyUsageLimits(report), deps.routedKey(), now);
		},
	};
}

/** The `fetch` of a usage-source registration for `provider`, when the payload is one. */
export function usageSourceFetch(payload: unknown, provider: string): UsageFetch | undefined {
	if (!isRecord(payload) || payload.schema !== USAGE_SOURCE_SCHEMA || payload.provider !== provider) return undefined;
	return typeof payload.fetch === "function" ? (payload.fetch as UsageFetch) : undefined;
}
