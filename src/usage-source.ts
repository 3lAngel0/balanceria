import { AGY_GROUP_ARGON, AGY_GROUP_CLAUDE, AGY_GROUP_GEMINI, agyQuotaKeyForGroup } from "./agy-usage.ts";
import { POOL_PROVIDER } from "./pools.ts";
import type { QuotaState } from "./state.ts";

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

export interface DisabledWindow {
	/** Limit name, as agyUsageLimits names it ("agy claude"). */
	name: string;
	label: string;
	windowSeconds: number;
}

/** The buckets agy switched off (a 5h window while its weekly one is spent), which agyUsageLimits skips. */
export function agyDisabledWindows(report: unknown): DisabledWindow[] {
	const command = isRecord(report) && isRecord(report.command) ? report.command : undefined;
	const data = command && isRecord(command.data) ? command.data : undefined;
	if (!data || !Array.isArray(data.groups)) return [];
	const disabled: DisabledWindow[] = [];
	for (const group of data.groups) {
		if (!isRecord(group) || typeof group.name !== "string" || !Array.isArray(group.buckets)) continue;
		for (const bucket of group.buckets.filter(isRecord)) {
			if (bucket.disabled !== true) continue;
			const seconds = bucket.window === "5h" ? FIVE_HOURS_S : bucket.window === "weekly" ? WEEK_S : undefined;
			if (seconds === undefined) continue;
			disabled.push({ name: AGY_LIMIT_NAMES[group.name] ?? `agy ${group.name}`, label: seconds === WEEK_S ? "week" : "5h", windowSeconds: seconds });
		}
	}
	return disabled;
}

/** Quota key of a limit name, when the name is one of the known subscription limits. */
export function quotaKeyForLimit(name: string): string | undefined {
	if (name === "claude" || name === "claude-bridge") return CLAUDE_KEY;
	const group = Object.entries(AGY_LIMIT_NAMES).find(([, groupName]) => groupName === name)?.[0];
	return group ? agyQuotaKeyForGroup(group) : undefined;
}

/**
 * The Claude subscription as the router's remaining fraction: what is left in
 * its fullest window (0 once the limit is reached), so highest-quota compares
 * claude-bridge with live numbers instead of a stale exhaustion.
 */
export function claudeQuotaEvents(usage: ProviderUsage): { type: "quota"; ts: number; key: string; remainingFraction: number; resetAt: number | undefined }[] {
	const limit = usage.limits.find(candidate => candidate.name === "claude" || candidate.name === "claude-bridge");
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

export type UsageQuotaView = Pick<QuotaState, "isAvailable" | "availableAt">;

/** "2h 5m", "3d 4h", "12m": how long until `until`. */
function formatWait(until: number, now: number): string {
	const minutes = Math.max(1, Math.ceil((until - now) / 60_000));
	const days = Math.floor(minutes / 1440);
	const hours = Math.floor((minutes % 1440) / 60);
	const rest = minutes % 60;
	if (days > 0) return `${days}d ${hours}h`;
	return hours > 0 ? `${hours}h ${rest}m` : `${rest}m`;
}

/** Name of a limit in alt+u, matching the HUD: provider then subscription ("antigravity gemini-4-argon"). */
function displayName(limit: UsageLimit, side: "claude" | "agy"): string {
	const key = quotaKeyForLimit(limit.name);
	if (side === "agy" && key) return key.replace("/", " ");
	if (side === "agy") return `antigravity ${limit.name.replace(/^agy /, "")}`;
	return `${CLAUDE_BRIDGE_PROVIDER} ${limit.name}`;
}

const GROUP_PREFIX: Record<string, string> = { week: "week ·", "5h": "5h   ·" };
const GROUP_ORDER = ["week", "5h"];

interface Row {
	group: string;
	key: string | undefined;
	limit: UsageLimit;
}

/**
 * One limit per window, so the shell (one row per window, in order) lists
 * every weekly row first and then every 5h row. The row name carries the group
 * ("week ·") and the window label carries the subscription. Percentages are the
 * reported ones; a router block only adds "router waits …" beside them.
 */
function windowRows(
	sides: readonly { side: "claude" | "agy"; limits: readonly UsageLimit[] }[],
	disabled: readonly DisabledWindow[],
	now: number,
	state: UsageQuotaView | undefined,
): Row[] {
	const rows: Row[] = [];
	for (const { side, limits } of sides) {
		for (const limit of limits) {
			const key = quotaKeyForLimit(limit.name);
			const blockedUntil = key && state && !state.isAvailable(key, now) ? state.availableAt(key, now) : undefined;
			const name = displayName(limit, side);
			const label = blockedUntil === undefined ? name : `${name} · router waits ${formatWait(blockedUntil, now)}`;
			for (const window of limit.windows) {
				rows.push({
					group: window.label,
					key,
					limit: { name: GROUP_PREFIX[window.label] ?? `${window.label} ·`, windows: [{ ...window, label }], limitReached: window.usedPercent >= 100 },
				});
			}
		}
	}
	if (sides.some(({ side }) => side === "agy")) {
		const agyLimits = sides.find(({ side }) => side === "agy")?.limits ?? [];
		for (const off of disabled) {
			const limit = agyLimits.find(candidate => candidate.name === off.name) ?? { name: off.name, windows: [], limitReached: false };
			const why = limit.windows.some(window => window.usedPercent >= 100) ? "disabled · weekly limit hit" : "disabled";
			rows.push({
				group: off.label,
				key: quotaKeyForLimit(off.name),
				limit: {
					name: GROUP_PREFIX[off.label] ?? `${off.label} ·`,
					windows: [{ label: `${displayName(limit, "agy")} · ${why}`, usedPercent: 0, windowSeconds: off.windowSeconds, resetAt: null }],
					limitReached: false,
				},
			});
		}
	}
	const rank = (group: string) => (GROUP_ORDER.indexOf(group) < 0 ? GROUP_ORDER.length : GROUP_ORDER.indexOf(group));
	return rows.map((row, index) => ({ row, index })).sort((a, b) => rank(a.row.group) - rank(b.row.group) || a.index - b.index).map(({ row }) => row);
}

/** The routed key's first row (its weekly one) goes first: the shell's bar shows the first limit. */
function routedFirst(rows: Row[], routedKey: string | undefined): UsageLimit[] {
	const routed = routedKey === undefined ? -1 : rows.findIndex(row => row.key === routedKey && !row.limit.windows[0]?.label.includes("· disabled"));
	if (routed > 0) rows.unshift(...rows.splice(routed, 1));
	return rows.map(row => row.limit);
}

export interface PoolUsageInfo {
	poolName?: string;
	activeRoute?: string;
}

/**
 * Both subscriptions as one `pool` usage, grouped by window (weekly rows, then
 * 5h rows). The routed key's row goes first, because the shell's bar shows it.
 */
export function combinePoolUsage(
	claude: ProviderUsage | undefined,
	agy: readonly UsageLimit[],
	routedKey: string | undefined,
	now: number,
	state?: UsageQuotaView,
	poolInfo?: PoolUsageInfo,
	disabled: readonly DisabledWindow[] = [],
): ProviderUsage | undefined {
	const rows = windowRows([{ side: "claude", limits: claude?.limits ?? [] }, { side: "agy", limits: agy }], disabled, now, state);
	if (rows.length === 0) return undefined;
	const limits = routedFirst(rows, routedKey);

	const parts: string[] = [];
	if (poolInfo?.poolName || poolInfo?.activeRoute) parts.push(poolInfo.poolName ?? "pool");
	if (poolInfo?.activeRoute) parts.push(`now ${poolInfo.activeRoute}`);
	if (claude?.plan) parts.push(`claude ${claude.plan}`);

	return {
		provider: POOL_PROVIDER,
		plan: parts.length > 0 ? parts.join(" · ") : undefined,
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
	/** Optional active pool details (pool name and currently routed candidate/model). */
	poolInfo?: () => PoolUsageInfo | undefined;
	/** Optional live quota state so runtime exhaustion/stall blocks are reflected in `alt+u` and the top bar. */
	state?: () => UsageQuotaView | undefined;
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
			return combinePoolUsage(claude, agyUsageLimits(report), deps.routedKey(), now, deps.state?.(), deps.poolInfo?.(), agyDisabledWindows(report));
		},
	};
}

export const ANTIGRAVITY_PROVIDER = "antigravity";

export interface AntigravityUsageSourceDeps {
	readAgyReport: () => Promise<unknown>;
	routedKey: () => string | undefined;
	state?: () => UsageQuotaView | undefined;
}

/** alt+u for the `antigravity` provider (subagents on agy models): the agy groups only. */
export function createAntigravityUsageSource(deps: AntigravityUsageSourceDeps): UsageSource {
	return {
		schema: USAGE_SOURCE_SCHEMA,
		provider: ANTIGRAVITY_PROVIDER,
		pendingNote: "agy usage pending · r to fetch",
		async fetch(_apiKey, _fetchFn, now) {
			const report = await deps.readAgyReport().catch(() => undefined);
			const rows = windowRows([{ side: "agy", limits: agyUsageLimits(report) }], agyDisabledWindows(report), now, deps.state?.());
			if (rows.length === 0) return undefined;
			return { provider: ANTIGRAVITY_PROVIDER, plan: undefined, limits: routedFirst(rows, deps.routedKey()), fetchedAt: now };
		},
	};
}

/** The `fetch` of a usage-source registration for `provider`, when the payload is one. */
export function usageSourceFetch(payload: unknown, provider: string): UsageFetch | undefined {
	if (!isRecord(payload) || payload.schema !== USAGE_SOURCE_SCHEMA || payload.provider !== provider) return undefined;
	return typeof payload.fetch === "function" ? (payload.fetch as UsageFetch) : undefined;
}
