import { windowChart } from "./chart.ts";
import type { ApiConsumption, ConsumptionSummary, CostPeriod, SubscriptionConsumption, WindowConsumption } from "./consumption.ts";
import type { RoleConsumer, SessionConsumer } from "./consumers.ts";
import { formatDuration, formatUsd, meter } from "./format.ts";
import type { Suggestion } from "./suggestions.ts";
import { dayKey } from "./history.ts";
import { formatTokens } from "./panel.ts";
import { clip } from "./session-index.ts";
import { fillTone, LEGEND, tone, type Tone } from "./style.ts";

// Plain-text layout of the HUD in two sizes: a compact one for the `5 hud`
// tab of the usage panel (ctrl+alt+u) and the detailed `/hud` panel. The TUI
// component only frames and colors these lines.

export type HudViewName = "subscriptions" | "apis" | "sessions" | "suggestions";
export const HUD_VIEWS: readonly HudViewName[] = ["subscriptions", "apis", "sessions", "suggestions"];

/** From this share of context re-sent a session is worth a /compact. */
const RESEND_WARN = 0.9;
const COMPACT_ROLES = 3;
export const SESSIONS_PER_ROLE = 5;
const ALIAS_WIDTH = 40;
const PROJECT_WIDTH = 14;

const COMPACT_METER_CELLS = 10;
const HUD_METER_CELLS = 20;

/** "claude 5h" for key "claude-bridge/claude", window "5h", under provider "claude-bridge". */
function windowName(provider: string, window: WindowConsumption): string {
	const limit = window.key.startsWith(`${provider}/`) ? window.key.slice(provider.length + 1) : window.key;
	return `${limit} ${window.window}`;
}

function percent(value: number): string {
	return `${Math.round(value)}%`.padStart(4);
}

function rate(window: WindowConsumption): string {
	return `+${window.pace!.percentPerHour.toFixed(1)}%/h`;
}

function two(value: number): string {
	return String(value).padStart(2, "0");
}

/** "15:00" today, "10-22 12:00" on another day. */
function clock(ts: number, now: number): string {
	const date = new Date(ts);
	const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
	return dayKey(ts) === dayKey(now) ? time : `${two(date.getMonth() + 1)}-${two(date.getDate())} ${time}`;
}

function resetsIn(window: WindowConsumption, now: number): string | undefined {
	return window.resetAt !== null && window.resetAt > now ? `resets in ${formatDuration(window.resetAt - now)}` : undefined;
}

/** The color of a window: its fill, red when it is full or fills before its reset. */
function windowTone(window: WindowConsumption): Tone {
	return fillTone(window.usedPercent / 100, window.pace?.fillsBeforeReset ?? false);
}

function windowMeter(window: WindowConsumption, cells: number): string {
	const color = windowTone(window);
	return `${tone(color, meter(window.usedPercent / 100, cells, "▰", "▱"))}  ${tone(color, percent(window.usedPercent))}`;
}

function compactStatus(window: WindowConsumption, now: number): string {
	const reset = resetsIn(window, now);
	const dimReset = reset ? tone("dim", reset) : undefined;
	if (window.usedPercent >= 100) return [tone("error", "full"), dimReset].filter(Boolean).join(" · ");
	if (window.pace?.fillsBeforeReset) return tone("error", `${rate(window)} · full in ${formatDuration(window.pace.fullAt - now)} ⚠`);
	if (window.pace) return [rate(window), dimReset].filter(Boolean).join(" · ");
	return dimReset ?? "";
}

function nameWidth(subscriptions: readonly SubscriptionConsumption[]): number {
	return Math.max(0, ...subscriptions.flatMap(subscription => subscription.windows.map(window => windowName(subscription.provider, window).length)));
}

function compactSubscriptions(summary: ConsumptionSummary, now: number): string[] {
	const lines = [tone("accent", "Subscriptions · window use and pace")];
	if (summary.subscriptions.length === 0) return [...lines, tone("dim", "  no subscriptions in integrations.json")];
	const providerWidth = Math.max(...summary.subscriptions.map(subscription => subscription.provider.length));
	const names = nameWidth(summary.subscriptions);
	for (const subscription of summary.subscriptions) {
		const provider = subscription.provider.padEnd(providerWidth);
		if (subscription.windows.length === 0) lines.push(`  ${provider}  ${tone("dim", "no quota reads yet")}`);
		for (const window of subscription.windows) {
			lines.push(`  ${provider}  ${windowName(subscription.provider, window).padEnd(names)}  ${windowMeter(window, COMPACT_METER_CELLS)}  ${compactStatus(window, now)}`.trimEnd());
		}
	}
	return [...lines, `  ${LEGEND}`];
}

/** USD of a period, starred when some of its requests had no price. */
function usd(period: CostPeriod): string {
	return `${formatUsd(period.usd)}${period.partial ? "*" : ""}`;
}

function anyPartial(apis: readonly ApiConsumption[]): boolean {
	return apis.some(api => api.today.partial || api.last7d.partial || api.last30d.partial);
}

function compactApis(summary: ConsumptionSummary): string[] {
	const lines = [tone("accent", "APIs · USD at list price")];
	if (summary.apis.length === 0) return [...lines, tone("dim", "  no API integrations in integrations.json")];
	const width = Math.max(...summary.apis.map(api => api.provider.length));
	for (const api of summary.apis) {
		const provider = api.provider.padEnd(width);
		if (api.last30d.requests === 0) lines.push(`  ${provider}  ${tone("dim", "no requests in 30 days")}`);
		else lines.push(`  ${provider}  today ${usd(api.today)} · 7d ${usd(api.last7d)} · 30d ${usd(api.last30d)} · ${api.last30d.requests} requests`);
	}
	if (anyPartial(summary.apis)) lines.push(tone("dim", "  * some requests use a model without a price in prices.json"));
	return lines;
}

function resendShare(totals: { contextResend: number; total: number }): number {
	return totals.total > 0 ? totals.contextResend / totals.total : 0;
}

/** "98% context re-sent", warning from 90%. */
function resendText(totals: { contextResend: number; total: number }, suffix: string): string {
	const text = `${Math.round(resendShare(totals) * 100)}% ${suffix}`;
	return resendShare(totals) >= RESEND_WARN ? tone("warning", text) : text;
}

const NO_REQUESTS = tone("dim", "  no requests in the last 7 days");

function compactConsumers(consumers: readonly RoleConsumer[]): string[] {
	const lines = [tone("accent", "Top consumers · last 7 days")];
	if (consumers.length === 0) return [...lines, NO_REQUESTS];
	const all = consumers.reduce((sum, role) => sum + role.total, 0);
	const top = consumers.slice(0, COMPACT_ROLES);
	const width = Math.max(...top.map(role => role.role.length));
	for (const role of top) {
		lines.push(`  ${role.role.padEnd(width)}  ${formatTokens(role.total).padStart(6)}  ${meter(all > 0 ? role.total / all : 0, COMPACT_METER_CELLS, "▰", "▱")}  ${resendText(role, "context re-sent")}`);
	}
	return lines;
}

/** The HUD section of the usage panel's `5 hud` tab; consumers add the top roles. */
export function renderHudCompact(summary: ConsumptionSummary, now: number, consumers?: readonly RoleConsumer[]): string[] {
	return [...compactSubscriptions(summary, now), "", ...compactApis(summary), ...(consumers ? ["", ...compactConsumers(consumers)] : [])];
}

function paceLine(window: WindowConsumption, now: number): string {
	if (window.usedPercent >= 100) return tone("error", `full since ${clock(window.pace?.fullAt ?? window.sampledAt, now)}`);
	if (!window.pace) return tone("dim", "no pace yet: needs two reads 5 minutes apart in the last hour");
	const verdict = window.pace.fillsBeforeReset ? tone("error", "before the reset ⚠") : tone("success", "after the reset");
	return `${rate(window)} → full at ${clock(window.pace.fullAt, now)}, ${verdict}`;
}

function resetText(window: WindowConsumption, now: number): string {
	if (window.resetAt === null) return "";
	if (window.resetAt <= now) return tone("dim", "reset since last read");
	return tone("dim", `resets ${clock(window.resetAt, now)} (in ${formatDuration(window.resetAt - now)})`);
}

const CHART_INDENT = "    ";
const CHART_NOTE = "chart: █ used so far · • current pace · ▲ full · ┴ now · ┤ reset · · no reading";

function renderWindowChart(window: WindowConsumption, now: number, width: number): string[] {
	if (window.points.length < 2 || window.resetAt === null || window.windowSeconds <= 0 || window.resetAt <= now) {
		return [`${CHART_INDENT}${tone("dim", "chart after the next reading")}`];
	}
	const chartWidth = Math.max(24, Math.min(72, width - CHART_INDENT.length - 8));
	return windowChart({
		points: window.points,
		start: window.resetAt - window.windowSeconds * 1000,
		reset: window.resetAt,
		now,
		percentPerHour: window.pace?.percentPerHour ?? null,
		tone: windowTone(window),
		width: chartWidth,
		rows: 4,
		clock: ts => clock(ts, now),
	}).map(line => `${CHART_INDENT}${line}`);
}

function subscriptionsView(summary: ConsumptionSummary, now: number, width: number): string[] {
	const lines = [tone("accent", "Subscriptions · bridges and plugins, window use and pace"), LEGEND, tone("dim", CHART_NOTE)];
	if (summary.subscriptions.length === 0) return [...lines, "", tone("dim", "  no subscriptions in integrations.json")];
	const names = nameWidth(summary.subscriptions);
	const indent = " ".repeat(2 + names + 2);
	for (const subscription of summary.subscriptions) {
		const { tokens } = subscription;
		lines.push("", tone("accent", subscription.label), `  tokens  5h ${formatTokens(tokens.last5h)} · today ${formatTokens(tokens.today)} · 7d ${formatTokens(tokens.last7d)}`);
		if (subscription.windows.length === 0) lines.push(tone("dim", "  no quota reads yet"));
		for (const window of subscription.windows) {
			lines.push(`  ${windowName(subscription.provider, window).padEnd(names)}  ${windowMeter(window, HUD_METER_CELLS)}  ${resetText(window, now)}`.trimEnd());
			lines.push(`${indent}${paceLine(window, now)}`);
			lines.push(...renderWindowChart(window, now, width));
		}
	}
	return lines;
}

function apisView(summary: ConsumptionSummary): string[] {
	const lines = [tone("accent", "APIs · billed per token, USD at the list price in prices.json")];
	if (summary.apis.length === 0) return [...lines, "", tone("dim", "  no API integrations in integrations.json"), tone("dim", '  add one as { "provider", "kind": "api", "label" }')];
	for (const api of summary.apis) {
		lines.push("", tone("accent", api.label));
		if (api.last30d.requests === 0) {
			lines.push(tone("dim", "  no requests in 30 days"));
			continue;
		}
		lines.push(tone("dim", "  period  requests  USD"));
		const periods: [string, CostPeriod][] = [["today", api.today], ["7d", api.last7d], ["30d", api.last30d]];
		for (const [name, period] of periods) lines.push(`  ${name.padEnd(6)}  ${String(period.requests).padStart(8)}  ${usd(period)}`);
	}
	if (anyPartial(summary.apis)) lines.push("", tone("dim", "* some requests use a model without a price in prices.json, so the USD is a lower bound"));
	return lines;
}

/** The sessions the `/hud` sessions view lists: up to 5 per role, in display order. */
export function visibleSessions(consumers: readonly RoleConsumer[]): SessionConsumer[] {
	return consumers.flatMap(role => role.sessions.slice(0, SESSIONS_PER_ROLE));
}

/** The selected row after moving by `delta`, clamped to a list of `length` rows. */
export function moveCursor(cursor: number, delta: number, length: number): number {
	return Math.max(0, Math.min(length - 1, cursor + delta));
}

/** The two red keys: `x` compacts a session, `f` continues it in a fresh session from a summary. */
export type RedKey = "compact" | "fresh";

export interface SessionTarget {
	session: string;
	label: string;
}

/** A red key pressed once, waiting for the same key on the same session. */
export interface PendingConfirm {
	kind: RedKey;
	session: string;
}

/** The first press asks; the same key on the same session confirms; anything else asks again. */
export function pressRedKey(pending: PendingConfirm | undefined, kind: RedKey, target: SessionTarget): { confirmed: boolean; pending?: PendingConfirm } {
	if (pending?.kind === kind && pending.session === target.session) return { confirmed: true };
	return { confirmed: false, pending: { kind, session: target.session } };
}

function confirmPrompt(kind: RedKey, label: string): string {
	return kind === "compact"
		? `‼ x again: compact it, one large request summarizes "${label}" · any other key cancels`
		: `‼ f again: new session from a summary of "${label}", the original stays · any other key cancels`;
}

export interface SessionsViewState {
	consumers: readonly RoleConsumer[];
	/** Index into `visibleSessions(consumers)`. */
	cursor: number;
	/** A short hint shown under the list. */
	note?: string;
	/** A red key waiting for confirmation on the selected session. */
	confirm?: RedKey;
}

function sessionLabel(session: SessionConsumer): string {
	return session.alias ?? session.session.slice(0, 8);
}

function sessionRow(session: SessionConsumer, selected: boolean, now: number): string {
	const alias = clip(session.alias ?? session.session.slice(0, 8), ALIAS_WIDTH);
	const head = `${selected ? "▸" : " "} ${alias.padEnd(ALIAS_WIDTH)}  ${clip(session.project, PROJECT_WIDTH).padEnd(PROJECT_WIDTH)}  ${formatTokens(session.total).padStart(6)}  `;
	const tail = `  ${clock(session.lastTs, now)}`;
	const percentText = `${Math.round(resendShare(session) * 100)}%`.padStart(4);
	if (selected) return tone("accent", `${head}${percentText} re-sent${tail}`);
	const resent = resendShare(session) >= RESEND_WARN ? tone("warning", `${percentText} re-sent`) : `${percentText} re-sent`;
	return `${head}${resent}${tail}`;
}

function sessionsView(now: number, state?: SessionsViewState): string[] {
	const lines = [
		tone("accent", "Sessions · what spends the most, by role · last 7 days"),
		tone("dim", "tokens = context re-sent every turn + new output · x compacts a session · f moves it to a fresh one from a summary"),
	];
	if (!state || state.consumers.length === 0) return [...lines, "", NO_REQUESTS];
	let index = 0;
	for (const role of state.consumers) {
		lines.push("", `${tone("accent", role.role)}  ${tone("dim", `${formatTokens(role.total)} tokens · `)}${resendText(role, "context re-sent")}`);
		for (const session of role.sessions.slice(0, SESSIONS_PER_ROLE)) {
			const selected = index++ === state.cursor;
			lines.push(sessionRow(session, selected, now));
			if (selected && state.confirm) lines.push(`  ${tone("error", confirmPrompt(state.confirm, sessionLabel(session)))}`);
		}
	}
	if (state.note) lines.push("", tone("dim", state.note));
	return lines;
}

export interface SuggestionsViewState {
	suggestions: readonly Suggestion[];
	cursor: number;
	note?: string;
	/** A red key waiting for confirmation on the selected suggestion's session. */
	confirm?: RedKey;
}

function suggestionLabel(item: Suggestion): string {
	return item.target.alias ?? item.target.session!.slice(0, 8);
}

/** The session the red keys act on: the selected row, or the selected suggestion's session. */
export function selectedSessionTarget(view: HudViewName, sessions?: SessionsViewState, suggestions?: SuggestionsViewState): SessionTarget | undefined {
	if (view === "sessions" && sessions) {
		const rows = visibleSessions(sessions.consumers);
		const row = rows[moveCursor(sessions.cursor, 0, rows.length)];
		return row ? { session: row.session, label: sessionLabel(row) } : undefined;
	}
	if (view === "suggestions" && suggestions) {
		const item = suggestions.suggestions[moveCursor(suggestions.cursor, 0, suggestions.suggestions.length)];
		return item?.target.session ? { session: item.target.session, label: suggestionLabel(item) } : undefined;
	}
	return undefined;
}

function savingSummary(saving: Suggestion["saving"]): string {
	const parts: string[] = [];
	if (saving.usd !== null && saving.usd > 0) parts.push(`save ${formatUsd(saving.usd)}`);
	if (saving.tokens !== null && saving.tokens > 0) parts.push(`${formatTokens(saving.tokens)} excess`);
	if (saving.quotaPercent !== null && saving.quotaPercent > 0) parts.push(`${saving.quotaPercent}% unused`);
	return parts.length > 0 ? parts.join(" · ") : "no direct saving estimated";
}

/** What is wrong, in one plain line, for every suggestion of a rule. */
function suggestionProblem(item: Suggestion): string {
	switch (item.rule) {
		case "large-context":
			return "why: every turn re-sends this whole conversation, and it grew past 120k tokens";
		case "provider-switch":
			return "why: changing model mid-session drops the cache, so the whole conversation is paid again";
		case "expensive-role":
			return "why: this subagent writes short answers on a model at least twice as expensive";
		case "idle-quota":
			return "why: this quota resets mostly unused while another one runs out";
		case "pool-bypass":
			return "why: the call named a spent model instead of a pool, so the balancer could not route around it";
	}
}

/** What enter does on a suggestion: open its session, create the profile, or only explain. */
export function suggestionEnter(item: Suggestion): "open" | "profile" | "explain" {
	if (item.rule === "expensive-role") return "profile";
	return item.target.session ? "open" : "explain";
}

/** What the user does with a suggestion; only expensive-role ones can become a profile. */
function suggestionAction(item: Suggestion): string {
	switch (item.rule) {
		case "expensive-role":
			return "→ enter or 'c' creates a new profile with this cheaper model (profiles.json is backed up first)";
		case "large-context":
			return "→ enter opens it · x compacts it · f continues it in a fresh session from a summary";
		case "provider-switch":
			return "→ enter opens that session; keep it on one model, each switch re-sends the whole context uncached";
		case "idle-quota":
			return `→ up to you: send work to ${item.target.quotaKey ?? "that quota"} before it resets (enter has nothing to open)`;
		case "pool-bypass":
			return `→ point ${item.target.role ?? "this agent"} at a pool model in its model profile instead of ${item.target.quotaKey ?? "the spent model"} · enter opens the session`;
	}
}

function suggestionsView(state?: SuggestionsViewState): string[] {
	const lines = [
		tone("accent", "Suggestions · evidence-based tuning hints"),
		tone("dim", "quality is not measured · ↑↓ select · enter acts on the selected one"),
	];
	if (!state || state.suggestions.length === 0) {
		return [...lines, "", tone("dim", "  no optimization suggestions right now")];
	}
	state.suggestions.forEach((item, index) => {
		const selected = index === state.cursor;
		const mark = selected ? "▸ " : "  ";
		const title = selected ? tone("accent", `${mark}${item.title}`) : `${mark}${item.title}`;
		lines.push("", `${title}  ${tone("dim", `(${savingSummary(item.saving)})`)}`, `    ${suggestionProblem(item)}`);
		if (!selected) return;
		// The action and the note go right under the title, so they stay on screen with the cursor.
		lines.push(`    ${tone("accent", suggestionAction(item))}`);
		if (state.note) lines.push(`    ${tone("warning", state.note)}`);
		if (state.confirm && item.target.session) lines.push(`    ${tone("error", confirmPrompt(state.confirm, suggestionLabel(item)))}`);
		for (const ev of item.evidence) lines.push(`    ${tone("dim", `• ${ev}`)}`);
		lines.push(`    ${tone("dim", `note: ${item.quality}`)}`);
	});
	return lines;
}

const VIEW_KEYS = "1-4/tab view · pgup/pgdn scroll · q close";

/** The footer of the `/hud` panel: only the keys that work in this view. */
export function hudHints(view: HudViewName): string {
	if (view === "sessions") return `↑↓ select · enter open · x compact · f fresh · ${VIEW_KEYS}`;
	if (view === "suggestions") return `↑↓ select · enter act · c profile · x compact · f fresh · ${VIEW_KEYS}`;
	return VIEW_KEYS;
}

function tabs(view: HudViewName): string {
	return HUD_VIEWS.map((name, index) => (name === view ? tone("accent", `[${index + 1} ${name}]`) : tone("dim", `${index + 1} ${name}`))).join("   ");
}

/** The body of the `/hud` panel for one view, tabs first. */
export function renderHud(
	view: HudViewName,
	summary: ConsumptionSummary,
	now: number,
	sessions?: SessionsViewState,
	width = 80,
	suggestions?: SuggestionsViewState,
): string[] {
	const body =
		view === "apis" ? apisView(summary) :
		view === "sessions" ? sessionsView(now, sessions) :
		view === "suggestions" ? suggestionsView(suggestions) :
		subscriptionsView(summary, now, width);
	return [tabs(view), "", ...body];
}
