import { labelRow, percentColumns, type ChartLabel, type PercentColumn } from "./chart.ts";
import type { RoleConsumer } from "./consumers.ts";
import type { ConsumptionSummary } from "./consumption.ts";
import { formatDuration, formatUsd, meter } from "./format.ts";
import { dayKey, RETENTION_DAYS, type HistoryEntry } from "./history.ts";
import { renderHudCompact } from "./hud.ts";
export { formatUsd } from "./format.ts";
import { formatTokens } from "./panel.ts";
import { requestCost, type PriceTable } from "./prices.ts";
import type { CurrentRead, Fill, QuotaReport, QuotaSeries } from "./quota-report.ts";
import { cardGrid, gridLayout, renderCard, type Card } from "./cards.ts";
import { contextTone, fillTone, plain, tone, type Tone } from "./style.ts";

// Plain-text layout of the advanced usage panel (ctrl+alt+u, `/balancer usage`):
// this session's live context and tokens, the subscription windows and when
// they filled, the last 30 days and the sessions behind them, each with the
// API-equivalent cost, and the compact HUD. The TUI component only frames and
// colors it.

const HOUR = 3_600_000;
const SPARK = "▁▂▃▄▅▆▇█";
const DAY_BAR_CELLS = 20;
const CONTEXT_BAR_CELLS = 16;
const MAX_SESSIONS = 20;
const MAX_FILLS = 15;
const QUOTA_METER_CELLS = 16;
/** Narrowest quota chart card; a longer day range widens it so every day keeps a column. */
const CHART_CARD_WIDTH = 36;
/** Width of the chart's percent axis (`100% ┤`). */
const CHART_AXIS = 6;

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
export function transientFrame(tick: number): string {
	return SPINNER_FRAMES[tick % SPINNER_FRAMES.length];
}

export function formatCard(title: string, lines: readonly string[], width: number): string[] {
	return renderCard({ title, body: lines }, width).map(plain);
}

// Minimum card widths: below them a grid stacks its cards one per row.
const SESSION_CARD_WIDTH = 40;
const SMALL_CARD_WIDTH = 28;

export type UsageViewName = "now" | "quotas" | "days" | "sessions" | "hud";
export const USAGE_VIEWS: readonly UsageViewName[] = ["now", "quotas", "days", "sessions", "hud"];

export interface TokenTotals {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	/** API-equivalent USD over the requests whose model has a price. */
	cost: number;
	/** Requests whose model has no price, so `cost` leaves them out. */
	unpriced: number;
}

export interface ProviderSummary extends TokenTotals {
	provider: string;
}

export interface SessionSummary extends TokenTotals {
	session: string;
	project: string;
	providers: string[];
	models: string[];
	firstTs: number;
	lastTs: number;
	peakContext: number | null;
	contextWindow: number | null;
}

export interface DaySummary {
	day: string;
	total: number;
	cost: number;
	unpriced: number;
	byProvider: Record<string, number>;
}

export interface UsageStats {
	providers: ProviderSummary[];
	/** Newest activity first. */
	sessions: SessionSummary[];
	/** Tokens per hour for the last 24 hours, oldest first. */
	hourly: number[];
	/** Tokens per local day for the retention window, oldest first. */
	daily: DaySummary[];
	/** Monthly USD per provider from prices.json. */
	subscriptions: Record<string, number>;
	pricesAsOf: string | undefined;
}

export interface CurrentSession {
	session: string;
	model: string | undefined;
	contextTokens: number | null;
	contextWindow: number | null;
}

function emptyTotals(): TokenTotals {
	return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, unpriced: 0 };
}

export function entryTokens(entry: HistoryEntry): number {
	return entry.input + entry.output + entry.cacheRead + entry.cacheWrite;
}

function addTo(totals: TokenTotals, entry: HistoryEntry, cost: number | undefined): void {
	totals.requests += 1;
	totals.input += entry.input;
	totals.output += entry.output;
	totals.cacheRead += entry.cacheRead;
	totals.cacheWrite += entry.cacheWrite;
	totals.total += entryTokens(entry);
	if (cost === undefined) totals.unpriced += 1;
	else totals.cost += cost;
}

function pushUnique(list: string[], value: string): void {
	if (!list.includes(value)) list.push(value);
}

function retentionDays(now: number): string[] {
	const days: string[] = [];
	for (let offset = RETENTION_DAYS - 1; offset >= 0; offset--) {
		const date = new Date(now);
		date.setDate(date.getDate() - offset);
		days.push(dayKey(date.getTime()));
	}
	return days;
}

export function summarizeHistory(entries: readonly HistoryEntry[], now: number, prices: PriceTable = { models: {}, subscriptions: {} }): UsageStats {
	const providers = new Map<string, ProviderSummary>();
	const sessions = new Map<string, SessionSummary>();
	const hourly = new Array<number>(24).fill(0);
	const daily = retentionDays(now).map(day => ({ day, total: 0, cost: 0, unpriced: 0, byProvider: {} as Record<string, number> }));
	const dayIndex = new Map(daily.map((summary, index) => [summary.day, index]));

	for (const entry of entries) {
		const tokens = entryTokens(entry);
		const cost = requestCost(prices, entry);

		const provider = providers.get(entry.provider) ?? { provider: entry.provider, ...emptyTotals() };
		addTo(provider, entry, cost);
		providers.set(entry.provider, provider);

		const session = sessions.get(entry.session) ?? {
			session: entry.session,
			project: entry.project,
			providers: [],
			models: [],
			firstTs: entry.ts,
			lastTs: entry.ts,
			peakContext: null,
			contextWindow: null,
			...emptyTotals(),
		};
		addTo(session, entry, cost);
		pushUnique(session.providers, entry.provider);
		pushUnique(session.models, entry.model);
		session.firstTs = Math.min(session.firstTs, entry.ts);
		session.lastTs = Math.max(session.lastTs, entry.ts);
		if (entry.contextTokens !== null && (session.peakContext === null || entry.contextTokens > session.peakContext)) {
			session.peakContext = entry.contextTokens;
		}
		if (entry.contextWindow !== null) session.contextWindow = entry.contextWindow;
		sessions.set(entry.session, session);

		const age = now - entry.ts;
		if (age >= 0 && age < 24 * HOUR) hourly[23 - Math.floor(age / HOUR)] += tokens;

		const index = dayIndex.get(dayKey(entry.ts));
		if (index !== undefined) {
			const day = daily[index];
			day.total += tokens;
			if (cost === undefined) day.unpriced += 1;
			else day.cost += cost;
			day.byProvider[entry.provider] = (day.byProvider[entry.provider] ?? 0) + tokens;
		}
	}

	return {
		providers: [...providers.values()].sort((a, b) => b.total - a.total || a.provider.localeCompare(b.provider)),
		sessions: [...sessions.values()].sort((a, b) => b.lastTs - a.lastTs),
		hourly,
		daily,
		subscriptions: prices.subscriptions,
		pricesAsOf: prices.asOf,
	};
}

/** A cost, starred when some of its requests had no price and are left out. */
function costText(totals: { cost: number; unpriced: number }): string {
	return `${formatUsd(totals.cost)}${totals.unpriced > 0 ? "*" : ""}`;
}

function footnote(unpriced: number): string[] {
	return unpriced > 0 ? ["", `* ${unpriced} requests of models without a price in prices.json`] : [];
}

export function sparkline(values: readonly number[]): string {
	const peak = Math.max(0, ...values);
	return values
		.map(value => {
			if (value <= 0 || peak === 0) return "·";
			return SPARK[Math.max(0, Math.ceil((value / peak) * SPARK.length) - 1)];
		})
		.join("");
}

/** Clip to `width` columns; colors do not count, and a clipped line loses them. */
function fit(line: string, width: number): string {
	const text = plain(line);
	return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : line;
}

function cell(text: string, size: number, alignRight = false): string {
	return alignRight ? text.padStart(size) : text.padEnd(size);
}

/** A fixed-width column: text that would touch the next column is clipped. */
function column(text: string, size: number): string {
	return text.length >= size ? `${text.slice(0, size - 2)}… ` : text.padEnd(size);
}

function two(value: number): string {
	return String(value).padStart(2, "0");
}

function shortDay(day: string): string {
	return day.slice(5);
}

function stamp(ts: number): string {
	const date = new Date(ts);
	return `${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}

function shortSession(session: string): string {
	return session.slice(0, 8);
}

function tabs(view: UsageViewName): string {
	const labels: Record<UsageViewName, string> = { now: "1 now", quotas: "2 quotas", days: "3 days", sessions: "4 sessions", hud: "5 hud" };
	return USAGE_VIEWS.map(name => (name === view ? tone("accent", `[${labels[name]}]`) : tone("dim", labels[name]))).join("   ");
}

function contextLines(current: CurrentSession): string[] {
	if (current.contextTokens === null || !current.contextWindow) return ["context  unknown until the next response"];
	const fraction = current.contextTokens / current.contextWindow;
	const color = contextTone(current.contextTokens);
	return [
		`context  ${tone(color, meter(fraction, CONTEXT_BAR_CELLS, "▰", "▱"))}  ${tone(color, `${Math.round(fraction * 100)}%`)}`,
		`${formatTokens(current.contextTokens)} of ${formatTokens(current.contextWindow)} tokens`,
	];
}

/** Requests and cost, then the token kinds, three short lines that fit a small card. */
function totalsLines(totals: TokenTotals): string[] {
	return [
		`requests ${totals.requests}   API ${costText(totals)}`,
		`input ${formatTokens(totals.input)}   output ${formatTokens(totals.output)}`,
		`cache read ${formatTokens(totals.cacheRead)}   write ${formatTokens(totals.cacheWrite)}`,
	];
}

const SAME_RESET_MS = 2 * 60_000;

/**
 * Whether the HUD forecasts this read's window to fill before its reset. A
 * read carries no provider key, so it matches the HUD window with the same
 * window name, percent and reset (within the jitter between reads).
 */
function fillsBeforeReset(read: CurrentRead, consumption: ConsumptionSummary | undefined): boolean {
	if (!consumption || read.resetAt === null) return false;
	return consumption.subscriptions.some(subscription =>
		subscription.windows.some(window =>
			window.window === read.window &&
			window.usedPercent === read.usedPercent &&
			window.resetAt !== null &&
			Math.abs(window.resetAt - read.resetAt!) <= SAME_RESET_MS &&
			(window.pace?.fillsBeforeReset ?? false),
		),
	);
}

function subscriptionCard(read: CurrentRead, now: number, consumption?: ConsumptionSummary): Card {
	const age = tone("dim", `read ${formatDuration(now - read.ts)} ago`);
	if (read.stale) return { title: seriesName(read), titleTone: "dim", body: [tone("dim", "reset since last read"), "", age] };
	const color = fillTone(read.usedPercent / 100, fillsBeforeReset(read, consumption));
	const reset = read.resetAt !== null && read.resetAt > now ? tone("dim", `resets in ${formatDuration(read.resetAt - now)}`) : "";
	return {
		title: seriesName(read),
		titleTone: color,
		body: [`${tone(color, meter(read.usedPercent / 100, QUOTA_METER_CELLS, "▰", "▱"))}  ${tone(color, `${Math.round(read.usedPercent)}%`)}`, reset, age],
	};
}

function renderSubscriptionsNow(quota: QuotaReport, now: number, width: number, consumption?: ConsumptionSummary): string[] {
	const lines = ["Subscriptions now"];
	if (quota.current.length === 0) return [...lines, "  no quota reads yet"];
	return [...lines, ...cardGrid(quota.current.map(read => subscriptionCard(read, now, consumption)), width, SMALL_CARD_WIDTH)];
}

function providerCard(row: ProviderSummary, sum: number): Card {
	const share = sum > 0 ? row.total / sum : 0;
	return {
		title: row.provider,
		titleTone: "accent",
		body: [
			`total ${formatTokens(row.total)}   share ${Math.round(share * 100)}%`,
			tone("accent", meter(share, QUOTA_METER_CELLS, "▰", "▱")),
			...totalsLines(row),
		],
	};
}

function renderNow(stats: UsageStats, current: CurrentSession, quota: QuotaReport, now: number, width: number, consumption?: ConsumptionSummary): string[] {
	const own = stats.sessions.find(summary => summary.session === current.session) ?? emptyTotals();
	const session: Card = {
		title: `This session · ${shortSession(current.session)}`,
		titleTone: "accent",
		body: [
			...(current.model ? [`model ${current.model}`] : []),
			...contextLines(current),
			...totalsLines(own),
			`total ${formatTokens(own.total)}`,
		],
	};
	const peak = Math.max(0, ...stats.hourly);
	const day: Card = {
		title: `Last 24h · peak ${formatTokens(peak)}/h`,
		body: [sparkline(stats.hourly), tone("dim", `${"-24h".padEnd(20)}${"now".padStart(4)}`)],
	};
	const lines = [...cardGrid([session, day], width, SESSION_CARD_WIDTH)];

	lines.push("", ...renderSubscriptionsNow(quota, now, width, consumption));

	lines.push("", `${RETENTION_DAYS} days by provider`);
	if (stats.providers.length === 0) {
		lines.push("  no requests recorded yet");
		return lines;
	}
	const sum = stats.providers.reduce((total, row) => total + row.total, 0);
	lines.push(...cardGrid(stats.providers.map(row => providerCard(row, sum)), width, SMALL_CARD_WIDTH));
	lines.push(...footnote(stats.providers.reduce((count, row) => count + row.unpriced, 0)));
	return lines;
}

function seriesName(series: { limit: string; window: string }): string {
	return `${series.limit} ${series.window}`.trim();
}

/** Aligned columns under a dim header; a missing value is "-". */
function table(header: readonly string[], rows: readonly string[][], alignRight: readonly boolean[] = []): string[] {
	const widths = header.map((title, index) => Math.max(title.length, ...rows.map(row => row[index].length)));
	const line = (cells: readonly string[]) => `  ${cells.map((text, index) => cell(text, widths[index], alignRight[index])).join("  ")}`.trimEnd();
	return [tone("dim", line(header)), ...rows.map(line)];
}

function reportRow(series: QuotaSeries): string[] {
	const duration = (ms: number | undefined) => (ms === undefined ? "-" : formatDuration(ms));
	// A fill without a known reset has no blocked time to report.
	return [seriesName(series), String(series.fills), duration(series.everyMs), duration(series.fillsInMs), series.blockedMs > 0 ? formatDuration(series.blockedMs) : "-"];
}

function fillRow(fill: Fill): string[] {
	return [
		stamp(fill.ts),
		seriesName(fill),
		fill.top ? `${shortSession(fill.top.session)} ${fill.top.project}` : "-",
		fill.top ? formatTokens(fill.top.tokens) : "-",
		fill.source === "error" && fill.hitSession ? `${shortSession(fill.hitSession)} ${fill.hitProject ?? ""}`.trimEnd() : "-",
	];
}

function dateLabels(days: readonly string[], cellWidth: number, fillOffsets: readonly number[]): ChartLabel[] {
	if (days.length === 0) return [];
	const order = [
		0,
		...(days.length > 1 ? [days.length - 1] : []),
		...fillOffsets,
		...days.map((_, index) => index),
	];
	const seen = new Set<number>();
	const labels: ChartLabel[] = [];
	for (const index of order) {
		if (seen.has(index) || index < 0 || index >= days.length) continue;
		seen.add(index);
		labels.push({ at: index * cellWidth, text: shortDay(days[index]), align: "left" });
	}
	return labels;
}

function renderQuotas(quota: QuotaReport, now: number, width: number): string[] {
	const lines = ["Subscription usage · daily peak per window"];
	if (quota.series.length === 0) {
		lines.push("  no quota reads yet");
	} else {
		lines.push(tone("dim", "  ▲ filled that day · · no reading"));
		const days = retentionDays(now);
		let firstIndex = days.length;
		for (const series of quota.series) {
			const idx = series.daily.findIndex(value => value !== null);
			if (idx >= 0 && idx < firstIndex) firstIndex = idx;
		}
		if (firstIndex >= days.length) firstIndex = days.length - 1;
		if (firstIndex > 0) lines.push(tone("dim", `  no data before ${shortDay(days[firstIndex])}`));
		const shownDays = days.slice(firstIndex);
		// Size the chart to the card it lands in: card borders take 4 columns, the last label 5.
		const minWidth = Math.max(CHART_CARD_WIDTH, 4 + CHART_AXIS + shownDays.length + 5);
		const { cardWidth } = gridLayout(quota.series.length, width, minWidth);
		const cellWidth = Math.max(1, Math.min(6, Math.floor((cardWidth - 4 - CHART_AXIS - 1) / Math.max(1, shownDays.length))));
		const cards: Card[] = [];
		// Windows without a reading share one line instead of an empty card each.
		const unread: string[] = [];
		for (const series of quota.series) {
			const peak = series.peak === null ? "-" : `${Math.round(series.peak)}%`;
			const title = `${seriesName(series)} · peak ${peak} · ${series.fills} fills`;
			const titleTone = series.peak === null ? "dim" : fillTone(series.peak / 100, series.fills > 0);
			const slice = series.daily.slice(firstIndex);
			if (slice.every(value => value === null)) {
				unread.push(seriesName(series));
				continue;
			}
			const columns: PercentColumn[] = slice.map((percent, offset) => {
				const dayIdx = firstIndex + offset;
				const filled = series.fillDays.includes(dayIdx);
				return {
					percent: percent ?? null,
					tone: fillTone((percent ?? 0) / 100, filled),
					mark: filled,
				};
			});
			const body = percentColumns(columns, { rows: 4, cell: cellWidth });
			const fillOffsets = series.fillDays.map(index => index - firstIndex).filter(offset => offset >= 0);
			const row = labelRow(dateLabels(shownDays, cellWidth, fillOffsets));
			if (row) body.push(row);
			cards.push({ title, titleTone, body });
		}
		lines.push(...cardGrid(cards, width, minWidth));
		if (unread.length > 0) lines.push(tone("dim", `  no readings in these days: ${unread.join(", ")}`));
	}

	const filled = quota.series.filter(series => series.fills > 0);
	if (filled.length > 0) {
		lines.push("", "Report", ...table(["window", "fills", "every", "fills in", "blocked"], filled.map(reportRow)));
	}

	lines.push("", "Fills (newest first)");
	if (quota.fills.length === 0) return [...lines, "  no fills in the last 30 days"];
	lines.push(...table(["when", "window", "top session", "tokens", "hit in"], quota.fills.slice(0, MAX_FILLS).map(fillRow), [false, false, false, true]));
	if (quota.fills.length > MAX_FILLS) lines.push(`  … ${quota.fills.length - MAX_FILLS} older fills`);
	return lines;
}

const PROVIDER_STYLES: readonly { glyph: string; tone: Tone }[] = [
	{ glyph: "█", tone: "accent" },
	{ glyph: "▓", tone: "muted" },
	{ glyph: "▒", tone: "dim" },
];

function providerStyle(index: number): { glyph: string; tone: Tone } {
	return PROVIDER_STYLES[Math.min(index, PROVIDER_STYLES.length - 1)];
}

function stackedDayBar(day: DaySummary, providers: readonly ProviderSummary[], peak: number): string {
	if (day.total <= 0 || peak <= 0) return tone("dim", "░".repeat(DAY_BAR_CELLS));
	const filled = Math.max(1, Math.min(DAY_BAR_CELLS, Math.round((day.total / peak) * DAY_BAR_CELLS)));
	const active = providers
		.map((row, index) => ({ index, tokens: day.byProvider[row.provider] ?? 0 }))
		.filter(item => item.tokens > 0);
	if (active.length === 0) return tone("dim", "░".repeat(DAY_BAR_CELLS));
	const counts = active.map(item => Math.round((item.tokens / day.total) * filled));
	for (let i = 0; i < counts.length && filled >= active.length; i++) {
		if (counts[i] === 0) counts[i] = 1;
	}
	let diff = filled - counts.reduce((sum, count) => sum + count, 0);
	while (diff !== 0) {
		const step = diff > 0 ? 1 : -1;
		let best = 0;
		for (let i = 1; i < active.length; i++) {
			if (step < 0 && counts[i] <= 1) continue;
			if (active[i].tokens > active[best].tokens || (step < 0 && counts[best] <= 1)) best = i;
		}
		counts[best] += step;
		diff -= step;
	}
	const segments = active.map((item, i) => {
		const style = providerStyle(item.index);
		return counts[i] > 0 ? tone(style.tone, style.glyph.repeat(counts[i])) : "";
	});
	const empty = DAY_BAR_CELLS - filled;
	if (empty > 0) segments.push(tone("dim", "░".repeat(empty)));
	return segments.join("");
}

function renderDays(stats: UsageStats, width: number): string[] {
	const tokens = stats.providers.reduce((sum, row) => sum + row.total, 0);
	const total = { cost: stats.providers.reduce((sum, row) => sum + row.cost, 0), unpriced: stats.providers.reduce((sum, row) => sum + row.unpriced, 0) };
	// The pace extrapolates from the days since the first recorded request, so a
	// recently started history is not diluted by days that were never tracked.
	const firstDay = stats.daily.findIndex(day => day.total > 0);
	const trackedDays = firstDay < 0 ? 0 : stats.daily.length - firstDay;
	const star = total.unpriced > 0 ? "*" : "";
	const pace = trackedDays > 0 ? (total.cost / trackedDays) * RETENTION_DAYS : 0;
	const lines = [
		`${RETENTION_DAYS} days · tokens ${formatTokens(tokens)} · API ${costText(total)} · avg ${formatUsd(total.cost / RETENTION_DAYS)}${star}/day · month pace ${formatUsd(pace)}${star}`,
	];
	const cards = stats.providers.map((row, index): Card => {
		const style = providerStyle(index);
		const plan = stats.subscriptions[row.provider];
		const ratio = plan !== undefined && plan > 0
			? `vs plan ${Number.isInteger(plan) ? `$${plan}` : formatUsd(plan)} → ${(row.cost / plan).toFixed(1)}x`
			: tone("dim", "no plan price");
		return { title: `${tone(style.tone, style.glyph)} ${row.provider}`, body: [`tokens ${formatTokens(row.total)}`, `API ${costText(row)}`, ratio] };
	});
	lines.push(...cardGrid(cards, width, SMALL_CARD_WIDTH));
	lines.push("", `Tokens per day · last ${RETENTION_DAYS} days`);
	if (firstDay < 0) {
		lines.push(tone("dim", "  no requests in the last 30 days"));
		return lines;
	}
	if (firstDay > 0) lines.push(tone("dim", `  no data before ${shortDay(stats.daily[firstDay].day)}`));
	if (stats.providers.length > 0) {
		lines.push(
			`  ${stats.providers
				.map((row, index) => {
					const style = providerStyle(index);
					return `${tone(style.tone, style.glyph)} ${row.provider}`;
				})
				.join("   ")}`,
		);
	}
	const peak = Math.max(0, ...stats.daily.map(day => day.total));
	lines.push(`        ${tone("dim", `0${formatTokens(peak).padStart(DAY_BAR_CELLS - 1)}`)}`);
	// One column per provider, as wide as its name, so a day reads across like a ledger.
	const widths = stats.providers.map(row => Math.max(row.provider.length, 6));
	const header = stats.providers.map((row, index) => `  ${cell(row.provider, widths[index], true)}`).join("");
	lines.push(tone("dim", `  ${cell("day", 5)} ${cell("tokens per day", DAY_BAR_CELLS)} ${cell("total", 7, true)}${header}  ${cell("API $", 7, true)}`));
	for (const day of [...stats.daily.slice(firstDay)].reverse()) {
		const columns = stats.providers
			.map((row, index) => {
				const tokens = day.byProvider[row.provider] ?? 0;
				return `  ${cell(tokens > 0 ? formatTokens(tokens) : "-", widths[index], true)}`;
			})
			.join("");
		const bar = stackedDayBar(day, stats.providers, peak);
		const cost = day.total > 0 ? costText(day) : "-";
		lines.push(`  ${shortDay(day.day)} ${bar} ${cell(formatTokens(day.total), 7, true)}${columns}  ${cell(cost, 7, true)}`);
	}
	lines.push(...footnote(total.unpriced));
	return lines;
}

function renderSessions(stats: UsageStats, current: CurrentSession): string[] {
	const lines = [`Sessions · last ${RETENTION_DAYS} days, newest first`];
	if (stats.sessions.length === 0) return [...lines, "  no requests recorded yet"];
	const header = `  ${cell("last use", 12)}${cell("project", 14)}${cell("session", 10)}${cell("model", 22)}${cell("req", 5, true)}${cell("tokens", 9, true)}  ${cell("peak ctx", 16)}${cell("API $", 8, true)}`;
	lines.push(header);
	for (const session of stats.sessions.slice(0, MAX_SESSIONS)) {
		const mark = session.session === current.session ? "▸ " : "  ";
		const extra = session.models.length > 1 ? ` +${session.models.length - 1}` : "";
		const context = session.peakContext === null ? "-" : `${formatTokens(session.peakContext)}${session.contextWindow ? `/${formatTokens(session.contextWindow)}` : ""}`;
		lines.push(
			`${mark}${cell(stamp(session.lastTs), 12)}${column(session.project, 14)}${cell(shortSession(session.session), 10)}${column(`${session.models[0]}${extra}`, 22)}${cell(String(session.requests), 5, true)}${cell(formatTokens(session.total), 9, true)}  ${column(context, 16)}${cell(costText(session), 8, true)}`,
		);
	}
	if (stats.sessions.length > MAX_SESSIONS) lines.push(`  … ${stats.sessions.length - MAX_SESSIONS} older sessions`);
	lines.push(...footnote(stats.sessions.slice(0, MAX_SESSIONS).reduce((count, session) => count + session.unpriced, 0)));
	return lines;
}

const NO_QUOTA: QuotaReport = { current: [], series: [], fills: [] };

export function renderAdvancedUsage(
	stats: UsageStats,
	view: UsageViewName,
	current: CurrentSession,
	now: number,
	width: number,
	quota: QuotaReport = NO_QUOTA,
	consumption?: ConsumptionSummary,
	consumers?: readonly RoleConsumer[],
): string[] {
	const body =
		view === "hud" ? (consumption ? renderHudCompact(consumption, now, consumers) : ["HUD · no consumption data yet"]) :
		view === "quotas" ? renderQuotas(quota, now, width) :
		view === "days" ? renderDays(stats, width) :
		view === "sessions" ? renderSessions(stats, current) :
		renderNow(stats, current, quota, now, width, consumption);
	return [tabs(view), "", ...body].map(line => fit(line, width));
}
