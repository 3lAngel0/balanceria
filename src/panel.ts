import { emphasize, parseHintButtons, type HintButton, type MouseTarget } from "./control-center-mouse.ts";
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
import { chip, marchingArrows, pixelBar, pixelSpinner, pixelText, remainingColor, renderSprite, scaleSprite, type ColorMode, type PixelColor } from "./pixel.ts";
import { box, cellWidth, sideBySide, table, wrap } from "./tui-box.ts";
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
	/** Pointer feedback: the tab under the pointer and the one clicked in this frame. */
	hover?: MouseTarget;
	pressed?: MouseTarget;
	/** Filled with the content line of every selectable row (roles, pools, advisor), in row order. */
	rowLines?: number[];
	/** How much color the terminal gets; plain shapes when omitted. */
	mode?: ColorMode;
	/** Animation frame and whether it may move; a still frame when `animate` is off. */
	frame?: number;
	animate?: boolean;
	/** 0..1 fill-in of the quota bars right after the panel opens or the tab changes; fully drawn when omitted. */
	progress?: number;
}

const CATEGORY_COLOR: Record<RoleCategory, PixelColor> = { read: "sky", write: "xp", audit: "gold", orchestrate: "hp" };
const STRATEGY_COLOR: Record<string, PixelColor> = { hybrid: "sky", waterfall: "xp", "highest-quota": "mp" };
const THINKING_PIPS: Record<string, { pips: number; color: PixelColor }> = {
	low: { pips: 1, color: "steel" },
	medium: { pips: 2, color: "gold" },
	high: { pips: 3, color: "xp" },
};

function categoryBadge(cat: RoleCategory): string {
	// Fixed width keeps the columns aligned whatever the language.
	return pad(`[${t(`setup.category.${cat}`)}]`, 14);
}

/** The header cells, shared by the renderer and the mouse hit areas. */
export function controlCenterTabLabels(): { tab: ControlCenterTab; label: string }[] {
	return CONTROL_CENTER_TABS.map((tab, index) => ({ tab, label: `${index + 1} ${t(`setup.tab.${tab}`)}` }));
}

/** The footer buttons: the tab's hints plus the glossary and the action list. */
export function controlCenterButtons(tab: ControlCenterTab): HintButton[] {
	return parseHintButtons([controlCenterHints(tab), t("setup.hints.help"), t("setup.hints.actions")].join(" · "));
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
	const feedback = (tab: ControlCenterTab) =>
		input.pressed?.kind === "tab" && input.pressed.tab === tab ? "pressed" : input.hover?.kind === "tab" && input.hover.tab === tab ? "hover" : undefined;
	const tabHeaders = controlCenterTabLabels()
		.map(({ tab, label }) => emphasize(input.tab === tab ? tone("accent", `[${label}]`) : ` ${label} `, feedback(tab)))
		.join("  ");

	const lines: string[] = [tabHeaders, ""];

	if (input.note) {
		lines.push(tone("warning", `  ${t("setup.cc.notice", { note: input.note })}`), "");
	}

	const head = lines.length;
	const wide = Math.max(40, input.width);
	const mode: ColorMode = input.mode ?? "none";
	const animate = input.animate ?? false;
	const frame = input.frame ?? 0;
	const edge = (text: string) => tone("dim", text);
	const heading = (text: string) => tone("accent", text);
	const col = (key: string) => t(`setup.col.${key}`);
	const bare = (text: string) => text.replace(/:$/, "");
	const rows = resolveEffectiveRoleRoutes(input.roles, input.pools, input.lastRoutedByPool);
	const snapshot = input.folded.state.snapshot();
	const rowStart = input.rowLines?.length ?? 0;
	// The body gathered since the header goes in one titled box; selectable rows move down by its top border.
	const framed = (title: string): string[] => {
		const body = lines.splice(head);
		if (input.rowLines) for (let i = rowStart; i < input.rowLines.length; i++) input.rowLines[i] += 1;
		return [...lines, ...box(title, body, wide, edge)];
	};
	// Cells carry their own colors, so a selected row only lights its marker and first cell (spans never nest).
	const category = (cat: RoleCategory) => chip(t(`setup.category.${cat}`), CATEGORY_COLOR[cat], mode);
	const strategyChip = (name: string | undefined) => chip(name ?? "hybrid", STRATEGY_COLOR[name ?? "hybrid"] ?? "steel", mode);
	const modelCell = (value: string) =>
		value === UNASSIGNED ? pixelText("slate", displayModel(value), mode) : value.startsWith("pool/") ? pixelText("sky", value, mode) : value;
	const thinkingCell = (level: string) => {
		const { pips, color } = THINKING_PIPS[level] ?? { pips: 0, color: "slate" as PixelColor };
		return `${pixelText(color, "▰".repeat(pips) + "▱".repeat(3 - pips), mode)} ${pixelText("steel", displayThinking(level), mode)}`;
	};
	const activeProviderOf = (pool: PoolConfig) =>
		input.lastRoutedByPool?.[pool.id] ?? (input.folded.lastRoute?.pool === pool.id ? input.folded.lastRoute.provider : undefined);
	const chain = (candidates: readonly string[], active?: string) =>
		candidates.map(ref => (active && ref.startsWith(`${active}/`) ? pixelText("gold", ref, mode) : ref)).join(` ${pixelText("slate", "→", mode)} `);
	const marker = (selected: boolean) => (selected ? heading("▸ ") : "  ");
	const first = (selected: boolean, text: string) => (selected ? heading(text) : text);

	if (input.tab === "overview") {
		const sprite = renderSprite(scaleSprite(frame, animate), mode);
		const spriteWidth = Math.max(0, ...sprite.map(cellWidth));
		const info = [
			heading(t("setup.cc.activeProfile", { name: input.activeProfile ?? t("setup.none") })),
			input.folded.lastRoute
				? `${marchingArrows(frame, 3, mode, animate)} ${t("setup.cc.lastRoute", { pool: input.folded.lastRoute.pool, provider: input.folded.lastRoute.provider })}`
				: tone("dim", t("setup.cc.lastRouteIdle")),
		];
		const profile = box(
			t("setup.box.profile"),
			sideBySide(sprite, [...(sprite.length > 2 ? [""] : []), ...info], spriteWidth, Math.max(10, wide - 4 - spriteWidth - 2), 2),
			wide,
			edge,
		);
		const poolRows = input.pools.map(pool => {
			const active = activeProviderOf(pool);
			return [
				`pool/${pool.id}`,
				strategyChip(pool.strategy),
				active ? `${marchingArrows(frame, 3, mode, animate)} ${active}` : pixelText("slate", "–", mode),
				chain(pool.candidates, active),
			];
		});
		const pools = box(
			bare(t("setup.cc.poolsTitle")),
			poolRows.length === 0 ? [tone("dim", t("setup.cc.noPools"))] : table([col("pool"), col("strategy"), col("active"), col("candidates")], poolRows, wide - 4, { head: heading }),
			wide,
			edge,
		);
		const roles = box(
			bare(t("setup.cc.rolesTitle")),
			table(
				[col("role"), col("type"), col("model"), col("thinking")],
				rows.map(row => [row.role, category(row.category), modelCell(row.configuredModel), thinkingCell(row.thinking)]),
				wide - 4,
				{ head: heading },
			),
			wide,
			edge,
		);
		const windows: string[] = [];
		const keys = new Set([...snapshot.keys(), "claude-bridge/claude"]);
		for (const key of [...keys].sort((a, b) => KEY_ORDER.indexOf(a) - KEY_ORDER.indexOf(b))) {
			const entry = snapshot.get(key);
			const available = input.folded.state.isAvailable(key, input.now);
			const fraction = entry?.remainingFraction;
			const label = pad(keyLabel(key), 16);
			const spent = chip(t("setup.window.spent").toUpperCase(), "bad", mode);
			if (fraction !== undefined) {
				const percent = pixelText(remainingColor(fraction), `${Math.round(fraction * 100)}%`.padStart(4), mode);
				windows.push(`${label} ${pixelBar(fraction, 14, { mode, frame, animate, progress: input.progress })} ${percent}${available ? "" : ` ${spent}`}`);
			} else {
				windows.push(`${label} ${available ? chip(t("setup.window.ok").toUpperCase(), "hp", mode) : spent}`);
			}
		}
		return [...lines, ...profile, ...pools, ...roles, ...box(bare(t("setup.cc.windowsTitle")), windows, wide, edge)];
	}

	if (input.tab === "roles") {
		lines.push(`${pixelText("steel", col("profile"), mode)} ${pixelText("gold", input.activeProfile ?? t("setup.none"), mode)}`, "");
		const cur = Math.max(0, Math.min(rows.length - 1, input.cursor ?? 0));
		const grid = table(
			[col("role"), col("type"), col("model"), col("thinking")],
			rows.map((row, idx) => [first(idx === cur, row.role), category(row.category), modelCell(row.configuredModel), thinkingCell(row.thinking)]),
			wide - 4,
			{ prefixes: rows.map((_row, idx) => marker(idx === cur)), head: heading },
		);
		lines.push(grid[0]!, grid[1]!);
		rows.forEach((row, idx) => {
			input.rowLines?.push(lines.length);
			lines.push(grid[idx + 2]!);
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
		return framed(t("setup.tab.roles"));
	}

	if (input.tab === "pools") {
		const pCur = Math.max(0, Math.min(Math.max(0, input.pools.length - 1, 0), input.poolCursor ?? 0));
		if (input.pools.length === 0) {
			lines.push(tone("dim", `  ${t("setup.cc.noPoolsWizard")}`));
		} else {
			const grid = table(
				[col("pool"), col("strategy"), col("name")],
				input.pools.map((pool, idx) => [first(idx === pCur, `pool/${pool.id}`), strategyChip(pool.strategy), pool.name]),
				wide - 4,
				{ prefixes: input.pools.map((_pool, idx) => marker(idx === pCur)), head: heading },
			);
			lines.push(grid[0]!, grid[1]!);
			input.pools.forEach((pool, idx) => {
				input.rowLines?.push(lines.length);
				lines.push(grid[idx + 2]!);
				for (const part of wrap(chain(pool.candidates, activeProviderOf(pool)), wide - 4 - 6)) lines.push(`      ${part}`);
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
		lines.push("", heading(t("setup.cc.providersTitle")));
		lines.push(
			...table(
				[col("provider"), col("id"), col("status"), col("models")],
				input.providers.map(p => [
					p.label,
					p.id,
					p.detected ? `${chip("ON", "hp", mode)} ${pixelText("steel", p.source, mode)}` : chip("OFF", "slate", mode),
					p.detected && p.availableModels.length > 0 ? pixelText("steel", p.availableModels.map(m => `${p.id}/${m}`).join(", "), mode) : pixelText("slate", "–", mode),
				]),
				wide - 4,
				{ head: heading },
			),
		);
		return framed(t("setup.tab.pools"));
	}

	// Tab 4: Advisor
	if (input.advisorLoading) {
		lines.push(`${pixelText("gold", pixelSpinner(frame), mode)} ${tone("warning", t("setup.cc.advisorLoading"))}`);
		return framed(t("setup.tab.advisor"));
	}
	if (!input.advisor) {
		lines.push(tone("dim", `  ${t("setup.cc.advisorEmpty")}`));
		return framed(t("setup.tab.advisor"));
	}

	lines.push(
		`  ${t("setup.cc.source", { source: input.advisor.source === "ai+heuristic" ? t("setup.advisor.sourceAi", { tokens: input.advisor.estimatedTokens }) : t("setup.advisor.sourceHeuristic") })}`,
		`  ${t("setup.cc.summary", { summary: input.advisor.summary })}`,
		"",
	);
	const rCur = Math.max(0, Math.min(input.advisor.recommendations.length - 1, input.cursor ?? 0));
	const recs = input.advisor.recommendations;
	const grid = table(
		[col("role"), col("type"), col("change"), col("thinking")],
		recs.map((rec, idx) => {
			const currentModel = input.roles?.[rec.role]?.model ?? UNASSIGNED;
			const change = currentModel !== rec.recommendedModel ? `${displayModel(currentModel)} → ${rec.recommendedModel}` : pixelText("hp", `${rec.recommendedModel} (${t("setup.tag.matches")})`, mode);
			return [first(idx === rCur, rec.role), category(rec.category), change, thinkingCell(rec.thinking)];
		}),
		wide - 4,
		{ prefixes: recs.map((_rec, idx) => marker(idx === rCur)), head: heading },
	);
	lines.push(grid[0]!, grid[1]!);
	recs.forEach((rec, idx) => {
		input.rowLines?.push(lines.length);
		lines.push(grid[idx + 2]!);
		if (idx === rCur) lines.push(tone("dim", `      ${t("setup.cc.why", { reason: rec.reason })}`));
	});
	return framed(t("setup.tab.advisor"));
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
