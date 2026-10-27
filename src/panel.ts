import type { FoldedEvents } from "./events.ts";
import type { CircuitBreakerStatus } from "./circuit-breaker.ts";
import type { ProfileConfig } from "./profiles.ts";
import type { DetectedProvider, PoolConfig } from "./setup.ts";
import {
	displayModel,
	displayThinking,
	resolveEffectiveRoleRoutes,
	UNASSIGNED,
	type AdvisorReport,
	type RoleCategory,
} from "./setup-advisor.ts";
import { tone } from "./style.ts";
import { t } from "./i18n/index.ts";

// Plain-text rendering of the side panel, status line, and the interactive
// Control Center TUI modal. The TUI component only adds color; keeping the
// layout here makes it testable.

const KEY_LABELS: Record<string, string> = {
	"antigravity/claude": "agy claude",
	"antigravity/gemini": "agy gemini",
	"antigravity/gemini-4-argon": "agy argon",
	"claude-bridge/claude": "claude-bridge",
};
const KEY_ORDER = Object.keys(KEY_LABELS);

export function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
	return String(count);
}

function poolLabel(poolId: string): string {
	return poolId.replace(/^claude-/, "").replace(/-[\d-]+$/, "");
}

function keyLabel(key: string): string {
	return KEY_LABELS[key] ?? key;
}

function fit(line: string, width: number): string {
	return line.length > width ? `${line.slice(0, Math.max(0, width - 1))}…` : line;
}

function pad(text: string, size: number): string {
	return text.length >= size ? text : text + " ".repeat(size - text.length);
}

function bar(fraction: number): string {
	const filled = Math.round(Math.max(0, Math.min(1, fraction)) * 5);
	return "█".repeat(filled) + "░".repeat(5 - filled);
}

function formatReset(epochMs: number): string {
	const date = new Date(epochMs);
	const two = (value: number) => String(value).padStart(2, "0");
	return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

function spentKeys(folded: FoldedEvents, now: number): string[] {
	return [...folded.state.snapshot().keys()]
		.filter(key => !folded.state.isAvailable(key, now))
		.sort((a, b) => KEY_ORDER.indexOf(a) - KEY_ORDER.indexOf(b));
}

export interface TurnTelemetry {
	/** Every token the turn moved: input, output, cache read and cache write. */
	lastTurnTokens: number;
	/** The part not read from cache: input, output and cache write. */
	newTokens: number;
	/** Context after the turn minus context before it; unknown on the first turn. */
	contextDelta?: number;
	isBalancer?: boolean;
}

export interface TurnUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export function turnTelemetry(usage: TurnUsage, contextTokens: number | null | undefined, previousContext: number | null | undefined): TurnTelemetry {
	const newTokens = (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheWrite ?? 0);
	const known = contextTokens != null && previousContext != null;
	return { lastTurnTokens: newTokens + (usage.cacheRead ?? 0), newTokens, contextDelta: known ? contextTokens - previousContext : undefined };
}

// A turn that re-sends a large cached context is what drains a window, so the
// light follows every token moved, not only the fresh ones.
const TURN_WARN_TOKENS = 50_000;
const TURN_ALERT_TOKENS = 150_000;

export function turnBadge(telemetry?: TurnTelemetry): string | undefined {
	if (!telemetry) return undefined;
	const count = telemetry.lastTurnTokens;
	const icon = count >= TURN_ALERT_TOKENS ? "🔴" : count >= TURN_WARN_TOKENS ? "🟡" : "🟢";
	const delta = telemetry.contextDelta;
	const context = delta === undefined ? "" : ` · ctx ${delta < 0 ? "-" : "+"}${formatTokens(Math.abs(delta))}`;
	const tag = telemetry.isBalancer ? " [balancer]" : "";
	return `${icon} ${t("setup.status.turn")} ${formatTokens(count)} · ${t("setup.status.new")} ${formatTokens(telemetry.newTokens)}${context}${tag}`;
}

export interface PanelProfileContext {
	activeProfile?: string;
	pools?: readonly PoolConfig[];
	roles?: ProfileConfig;
}

export function renderPanel(
	folded: FoldedEvents,
	now: number,
	width: number,
	circuitStatus?: CircuitBreakerStatus,
	profileCtx?: PanelProfileContext,
): string[] {
	const lines: string[] = [" ai-balancer"];
	const snapshot = folded.state.snapshot();

	if (circuitStatus?.tripped) {
		lines.push(` 🚨 ${t("setup.panel.circuitBreaker")}`);
		lines.push(`  ${t("setup.panel.allSpent")}`);
		lines.push(`  ${t("setup.panel.checkpointed")}`);
		if (circuitStatus.soonestResetAt) {
			lines.push(`  ${t("setup.panel.reset", { at: formatReset(circuitStatus.soonestResetAt) })}`);
		}
	}

	if (profileCtx?.activeProfile) {
		lines.push(` ${t("setup.panel.profile", { name: profileCtx.activeProfile })}`);
	}

	if (snapshot.size === 0 && folded.tokens.size === 0 && !folded.lastRoute && !profileCtx?.roles) {
		lines.push(`  ${t("setup.panel.noUsage")}`);
		return lines.map(line => fit(line, width));
	}

	if (folded.lastRoute) {
		lines.push(` ${t("setup.panel.route")}`);
		lines.push(`  ${pad(poolLabel(folded.lastRoute.pool), 7)} → ${folded.lastRoute.provider}`);
	}

	if (profileCtx?.roles && Object.keys(profileCtx.roles).length > 0) {
		lines.push(` ${t("setup.panel.agents")}`);
		const rows = resolveEffectiveRoleRoutes(profileCtx.roles, profileCtx.pools ?? []);
		for (const row of rows.slice(0, 6)) {
			if (row.configuredModel === UNASSIGNED) continue;
			lines.push(`  ${pad(row.shortName, 9)} [${row.category[0]}] → ${row.configuredModel}`);
		}
	}

	lines.push(` ${t("setup.panel.windowsLeft")}`);
	const keys = new Set([...snapshot.keys(), "claude-bridge/claude"]);
	for (const key of [...keys].sort((a, b) => KEY_ORDER.indexOf(a) - KEY_ORDER.indexOf(b))) {
		const entry = snapshot.get(key);
		const available = folded.state.isAvailable(key, now);
		const fraction = entry?.remainingFraction;
		if (fraction !== undefined) {
			const percent = `${Math.round(fraction * 100)}%`.padStart(4);
			lines.push(`  ${pad(keyLabel(key), 14)}${bar(fraction)} ${percent}`);
		} else {
			lines.push(`  ${pad(keyLabel(key), 14)}${available ? t("setup.window.ok") : t("setup.window.spent")}`);
		}
		const until = folded.state.availableAt(key, now);
		if (!available && until !== undefined) lines.push(`    ${t("setup.window.spentUntil", { at: formatReset(until) })}`);
	}

	lines.push(` ${t("setup.panel.tokens")}`);
	if (folded.tokens.size === 0) lines.push(`  ${t("setup.panel.noneYet")}`);
	for (const [provider, totals] of folded.tokens) {
		lines.push(`  ${pad(provider, 14)}${formatTokens(totals.last5h)}/${formatTokens(totals.today)}/${formatTokens(totals.last7d)}`);
	}
	return lines.map(line => fit(line, width));
}

export type ControlCenterTab = "overview" | "roles" | "pools" | "advisor";
export const CONTROL_CENTER_TABS: readonly ControlCenterTab[] = ["overview", "roles", "pools", "advisor"];

export interface ControlCenterRenderInput {
	tab: ControlCenterTab;
	width: number;
	folded: FoldedEvents;
	now: number;
	circuitStatus?: CircuitBreakerStatus;
	activeProfile?: string;
	pools: readonly PoolConfig[];
	roles?: ProfileConfig;
	providers: readonly DetectedProvider[];
	advisor?: AdvisorReport | null;
	advisorLoading?: boolean;
	cursor?: number;
	poolCursor?: number;
	note?: string;
	lastRoutedByPool?: Readonly<Record<string, string>>;
	rolePickerOpen?: boolean;
	rolePickerTargets?: readonly string[];
	rolePickerCursor?: number;
	poolEditOpen?: boolean;
	poolCandidateOptions?: readonly string[];
	poolCandidateCursor?: number;
}

function categoryBadge(cat: RoleCategory): string {
	// Fixed width keeps the columns aligned whatever the language.
	return pad(`[${t(`setup.category.${cat}`)}]`, 14);
}

export function controlCenterHints(tab: ControlCenterTab): string {
	switch (tab) {
		case "overview":
			return t("setup.hints.overview");
		case "roles":
			return t("setup.hints.roles");
		case "pools":
			return t("setup.hints.pools");
		case "advisor":
			return t("setup.hints.advisor");
	}
}

export function renderControlCenter(input: ControlCenterRenderInput): string[] {
	const tabHeaders = [
		...CONTROL_CENTER_TABS.map((tab, index) => {
			const label = `${index + 1} ${t(`setup.tab.${tab}`)}`;
			return input.tab === tab ? tone("accent", `[${label}]`) : ` ${label} `;
		}),
	].join("  ");

	const lines: string[] = [tabHeaders, ""];

	if (input.note) {
		lines.push(tone("warning", `  ${t("setup.cc.notice", { note: input.note })}`), "");
	}

	const rows = resolveEffectiveRoleRoutes(input.roles, input.pools, input.lastRoutedByPool);
	const snapshot = input.folded.state.snapshot();

	if (input.tab === "overview") {
		lines.push(tone("accent", t("setup.cc.activeProfile", { name: input.activeProfile ?? t("setup.none") })));
		if (input.folded.lastRoute) {
			lines.push(`  ${t("setup.cc.lastRoute", { pool: input.folded.lastRoute.pool, provider: input.folded.lastRoute.provider })}`);
		} else {
			lines.push(tone("dim", `  ${t("setup.cc.lastRouteIdle")}`));
		}
		lines.push("");

		lines.push(tone("accent", t("setup.cc.poolsTitle")));
		if (input.pools.length === 0) {
			lines.push(tone("dim", `  ${t("setup.cc.noPools")}`));
		} else {
			for (const pool of input.pools) {
				const active = input.lastRoutedByPool?.[pool.id] ?? (input.folded.lastRoute?.pool === pool.id ? input.folded.lastRoute.provider : undefined);
				const activeTag = active ? ` (${t("setup.cc.active", { provider: active })})` : "";
				lines.push(`  • pool/${pad(pool.id, 18)} [${pool.strategy ?? "hybrid"}]${activeTag}`);
				lines.push(`      ${pool.candidates.join(" → ")}`);
			}
		}
		lines.push("");

		lines.push(tone("accent", t("setup.cc.rolesTitle")));
		for (const row of rows) {
			lines.push(
				`  ${pad(row.role, 20)} ${categoryBadge(row.category)} → ${pad(displayModel(row.configuredModel), 28)} (${displayThinking(row.thinking)})`,
			);
		}
		lines.push("");

		lines.push(tone("accent", t("setup.cc.windowsTitle")));
		const keys = new Set([...snapshot.keys(), "claude-bridge/claude"]);
		for (const key of [...keys].sort((a, b) => KEY_ORDER.indexOf(a) - KEY_ORDER.indexOf(b))) {
			const entry = snapshot.get(key);
			const available = input.folded.state.isAvailable(key, input.now);
			const fraction = entry?.remainingFraction;
			if (fraction !== undefined) {
				const percent = `${Math.round(fraction * 100)}%`.padStart(4);
				lines.push(`  ${pad(keyLabel(key), 16)} ${bar(fraction)} ${percent}`);
			} else {
				lines.push(`  ${pad(keyLabel(key), 16)} ${available ? t("setup.window.ok") : t("setup.window.spent")}`);
			}
		}
		return lines;
	}

	if (input.tab === "roles") {
		lines.push(
			tone("accent", t("setup.cc.rolesHeader", { name: input.activeProfile ?? t("setup.none") })),
			tone("dim", t("setup.cc.rolesHelp")),
			"",
		);
		const cur = Math.max(0, Math.min(rows.length - 1, input.cursor ?? 0));
		rows.forEach((row, idx) => {
			const prefix = idx === cur ? "▸ " : "  ";
			const line = `${prefix}${pad(row.role, 20)} ${categoryBadge(row.category)}  ${t("setup.cc.model")}: ${pad(displayModel(row.configuredModel), 30)} ${t("setup.cc.thinking")}: ${displayThinking(row.thinking)}`;
			lines.push(idx === cur ? tone("accent", line) : line);
			if (idx === cur) {
				lines.push(tone("dim", `      ${t("setup.cc.task", { purpose: row.purpose })}`));
				lines.push(tone("dim", `      ${t("setup.cc.effective", { target: displayModel(row.effectiveTarget) })}`));
				if (input.rolePickerOpen && input.rolePickerTargets && input.rolePickerTargets.length > 0) {
					lines.push(tone("accent", `      ${t("setup.cc.pickTarget", { role: row.role })}`));
					const pCur = Math.max(0, Math.min(input.rolePickerTargets.length - 1, input.rolePickerCursor ?? 0));
					const rec = input.advisor?.recommendations.find(r => r.role === row.role);
					input.rolePickerTargets.forEach((target, tIdx) => {
						const tPrefix = tIdx === pCur ? "      ▸ " : "        ";
						const recTag = rec && rec.recommendedModel === target ? ` (${t("setup.tag.recommended")})` : "";
						const curTag = row.configuredModel === target ? ` [${t("setup.tag.current")}]` : "";
						const tLine = `${tPrefix}${target}${curTag}${recTag}`;
						lines.push(tIdx === pCur ? tone("accent", tLine) : tLine);
					});
				}
			}
		});
		return lines;
	}

	if (input.tab === "pools") {
		lines.push(
			tone("accent", t("setup.cc.poolsHeader")),
			tone("dim", t("setup.cc.poolsHelp")),
			"",
		);
		const pCur = Math.max(0, Math.min(Math.max(0, input.pools.length - 1, 0), input.poolCursor ?? 0));
		if (input.pools.length === 0) {
			lines.push(tone("dim", `  ${t("setup.cc.noPoolsWizard")}`));
		} else {
			input.pools.forEach((pool, idx) => {
				const prefix = idx === pCur ? "▸ " : "  ";
				const head = `${prefix}pool/${pool.id}  [${pool.strategy ?? "hybrid"}] — ${pool.name}`;
				lines.push(idx === pCur ? tone("accent", head) : head);
				lines.push(`      ${t("setup.cc.candidates", { list: pool.candidates.join(" → ") })}`);
				if (idx === pCur && input.poolEditOpen && input.poolCandidateOptions && input.poolCandidateOptions.length > 0) {
					lines.push(tone("accent", `      ${t("setup.cc.editCandidates", { pool: pool.id })}`));
					const cCur = Math.max(0, Math.min(input.poolCandidateOptions.length - 1, input.poolCandidateCursor ?? 0));
					input.poolCandidateOptions.forEach((cand, cIdx) => {
						const orderIdx = pool.candidates.indexOf(cand);
						const inPool = orderIdx >= 0;
						const statusTag = inPool ? `[✓] #${orderIdx + 1}` : "[ ]   ";
						const cPrefix = cIdx === cCur ? "      ▸ " : "        ";
						const cLine = `${cPrefix}${statusTag} ${cand}`;
						lines.push(cIdx === cCur ? tone("accent", cLine) : cLine);
					});
				}
			});
		}
		lines.push("");
		lines.push(tone("accent", t("setup.cc.providersTitle")));
		for (const p of input.providers) {
			const status = p.detected ? t("setup.provider.detected", { source: p.source }) : t("setup.provider.notDetected");
			lines.push(`  • ${pad(p.label, 28)} [${p.id}] : ${status}`);
			if (p.detected && p.availableModels.length > 0) {
				lines.push(tone("dim", `      ${t("setup.cc.models", { list: p.availableModels.map(m => `${p.id}/${m}`).join(", ") })}`));
			}
		}
		return lines;
	}

	// Tab 4: Advisor
	lines.push(
		tone("accent", t("setup.cc.advisorHeader")),
		tone("dim", t("setup.cc.advisorHelp")),
		"",
	);
	if (input.advisorLoading) {
		lines.push(tone("warning", `  ${t("setup.cc.advisorLoading")}`));
		return lines;
	}
	if (!input.advisor) {
		lines.push(tone("dim", `  ${t("setup.cc.advisorEmpty")}`));
		return lines;
	}

	lines.push(
		`  ${t("setup.cc.source", { source: input.advisor.source === "ai+heuristic" ? t("setup.advisor.sourceAi", { tokens: input.advisor.estimatedTokens }) : t("setup.advisor.sourceHeuristic") })}`,
		`  ${t("setup.cc.summary", { summary: input.advisor.summary })}`,
		"",
	);
	const rCur = Math.max(0, Math.min(input.advisor.recommendations.length - 1, input.cursor ?? 0));
	input.advisor.recommendations.forEach((rec, idx) => {
		const prefix = idx === rCur ? "▸ " : "  ";
		const currentModel = input.roles?.[rec.role]?.model ?? UNASSIGNED;
		const changed = currentModel !== rec.recommendedModel ? `${displayModel(currentModel)} → ${rec.recommendedModel}` : `${rec.recommendedModel} (${t("setup.tag.matches")})`;
		const line = `${prefix}${pad(rec.role, 20)} ${categoryBadge(rec.category)}  ${changed} [${rec.thinking}]`;
		lines.push(idx === rCur ? tone("accent", line) : line);
		if (idx === rCur) {
			lines.push(tone("dim", `      ${t("setup.cc.why", { reason: rec.reason })}`));
		}
	});
	return lines;
}

export function statusLine(
	folded: FoldedEvents,
	now: number,
	circuitStatus?: CircuitBreakerStatus,
	telemetry?: TurnTelemetry,
): string {
	if (circuitStatus?.tripped) {
		const resetInfo = circuitStatus.soonestResetAt ? ` · ${t("setup.status.reset", { at: formatReset(circuitStatus.soonestResetAt) })}` : "";
		return `🚨 ${t("setup.status.circuit")}${resetInfo}`;
	}

	const parts: string[] = [];
	if (folded.lastRoute) parts.push(`${poolLabel(folded.lastRoute.pool)}→${folded.lastRoute.provider}`);
	const spent = spentKeys(folded, now).map(keyLabel);
	if (spent.length > 0) parts.push(`${t("setup.status.spent")}: ${spent.join(", ")}`);

	const badge = turnBadge(telemetry);
	if (badge) parts.push(badge);

	return parts.length > 0 ? `⚖ ${parts.join(" · ")}` : `⚖ ${t("setup.status.idle")}`;
}

// Every request resends the whole context, so a long session spends the
// subscription window much faster than its share of a 1M window suggests.
export const CONTEXT_WARN_TOKENS = 120_000;
export const CONTEXT_ALERT_TOKENS = 200_000;

export type ContextLevel = "warn" | "alert";

export function contextNotice(tokens: number | null | undefined): { level: ContextLevel; text: string } | undefined {
	if (tokens == null || tokens < CONTEXT_WARN_TOKENS) return undefined;
	const level: ContextLevel = tokens >= CONTEXT_ALERT_TOKENS ? "alert" : "warn";
	return { level, text: `ctx ${formatTokens(tokens)} ${level === "alert" ? "‼" : "⚠"} /compact` };
}

export function statusWithContext(
	status: string,
	tokens: number | null | undefined,
	paint: (level: ContextLevel, text: string) => string,
): string {
	const notice = contextNotice(tokens);
	return notice ? `${status} · ${paint(notice.level, notice.text)}` : status;
}
