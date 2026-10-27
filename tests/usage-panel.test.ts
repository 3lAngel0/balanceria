import { test } from "node:test";
import assert from "node:assert/strict";
import type { HistoryEntry } from "../src/history.ts";
import { parsePrices } from "../src/prices.ts";
import type { QuotaReport } from "../src/quota-report.ts";
import { renderHudCompact } from "../src/hud.ts";
import { paint, plain } from "../src/style.ts";
import { formatUsd, renderAdvancedUsage as renderStyled, sparkline, summarizeHistory, type CurrentSession } from "../src/usage-panel.ts";

const renderAdvancedUsage = (...args: Parameters<typeof renderStyled>) => renderStyled(...args).map(plain);
/** Each toned span as <tone>text</tone>. */
const tones = (lines: string[]) => lines.map(line => paint(line, (name, text) => `<${name}>${text}</${name}>`));

const HOUR = 3_600_000;
const NOW = new Date(2026, 9, 18, 12).getTime();

function entry(ts: number, overrides: Partial<HistoryEntry> = {}): HistoryEntry {
	return {
		ts,
		session: "aaaaaaaa-1111",
		project: "balancingIa",
		provider: "claude-bridge",
		model: "claude-opus-5-5",
		input: 100,
		output: 200,
		cacheRead: 600,
		cacheWrite: 100,
		contextTokens: 40_000,
		contextWindow: 200_000,
		...overrides,
	};
}

const HISTORY: HistoryEntry[] = [
	entry(NOW - 3 * 24 * HOUR, { session: "bbbbbbbb-2222", provider: "antigravity", model: "gemini-3-flash", contextTokens: 10_000 }),
	entry(NOW - 2 * HOUR),
	entry(NOW - 30 * 60_000, { contextTokens: 60_000 }),
	entry(NOW - 10 * 60_000, { provider: "antigravity", model: "claude-sonnet-5-5", input: 1000, output: 0, cacheRead: 0, cacheWrite: 0, contextTokens: null }),
];

const CURRENT: CurrentSession = { session: "aaaaaaaa-1111", model: "claude-opus-5-5", contextTokens: 45_000, contextWindow: 200_000 };

test("summarizeHistory totals every token kind per provider, per session, per hour and per day", () => {
	const stats = summarizeHistory(HISTORY, NOW);

	assert.deepEqual(
		stats.providers.map(row => [row.provider, row.requests, row.input, row.output, row.cacheRead, row.cacheWrite, row.total]),
		[
			["antigravity", 2, 1100, 200, 600, 100, 2000],
			["claude-bridge", 2, 200, 400, 1200, 200, 2000],
		],
		"most tokens first, ties by name",
	);

	const [latest, older] = stats.sessions;
	assert.equal(latest.session, "aaaaaaaa-1111");
	assert.deepEqual([latest.requests, latest.total, latest.peakContext, latest.contextWindow], [3, 3000, 60_000, 200_000]);
	assert.deepEqual(latest.providers, ["claude-bridge", "antigravity"]);
	assert.deepEqual(latest.models, ["claude-opus-5-5", "claude-sonnet-5-5"]);
	assert.deepEqual([older.session, older.total, older.firstTs], ["bbbbbbbb-2222", 1000, NOW - 3 * 24 * HOUR]);

	assert.equal(stats.hourly.length, 24);
	assert.equal(stats.hourly[23], 2000, "the last hour holds the two most recent requests");
	assert.equal(stats.hourly[21], 1000);
	assert.equal(stats.hourly.reduce((sum, value) => sum + value, 0), 3000, "older than 24h stays out");

	assert.equal(stats.daily.length, 30);
	assert.equal(stats.daily[29].day, "2026-10-18");
	assert.equal(stats.daily[0].day, "2026-09-19");
	assert.deepEqual([stats.daily[29].total, stats.daily[29].byProvider], [3000, { "claude-bridge": 2000, antigravity: 1000 }]);
	assert.equal(stats.daily[26].total, 1000);
});

test("sparkline scales to the peak and marks empty hours", () => {
	assert.equal(sparkline([0, 1, 4, 8]), "·▁▄█");
	assert.equal(sparkline([0, 0]), "··");
});

/** The card in `lines` whose top border holds `title`: its body lines without the borders. */
function cardBody(lines: readonly string[], title: string): string[] {
	for (const [row, line] of lines.entries()) {
		const column = line.indexOf(`╭─ ${title}`);
		if (column < 0) continue;
		const end = line.indexOf("╮", column) + 1;
		const body: string[] = [];
		for (const next of lines.slice(row + 1)) {
			const slice = next.slice(column, end);
			if (!slice.startsWith("│")) break;
			body.push(slice.slice(2, -2).trimEnd());
		}
		return body;
	}
	throw new Error(`no card titled ${title}`);
}

test("the now view puts this session and the last 24h in side-by-side cards, and each provider in its own card", () => {
	const lines = renderAdvancedUsage(summarizeHistory(HISTORY, NOW), "now", CURRENT, NOW, 90);
	assert.match(lines[0], /\[1 now\]\s+2 quotas\s+3 days\s+4 sessions/);
	const top = lines.findIndex(line => line.includes("╭─ This session"));
	assert.match(lines[top], /^╭─ This session · aaaaaaaa ─*╮ ╭─ Last 24h · peak 2\.0k\/h ─*╮$/);
	assert.deepEqual(cardBody(lines, "This session"), [
		"model claude-opus-5-5",
		"context  ▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱  23%",
		"45.0k of 200.0k tokens",
		"requests 3   API $0*",
		"input 1.2k   output 400",
		"cache read 1.2k   write 200",
		"total 3.0k",
	]);
	assert.deepEqual(cardBody(lines, "Last 24h"), [`${"·".repeat(21)}▄·█`, `-24h${" ".repeat(17)}now`, "", "", "", "", ""]);
	assert.ok(lines.includes("30 days by provider"));
	assert.deepEqual(cardBody(lines, "antigravity"), ["total 2.0k   share 50%", "▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱", "requests 2   API $0*", "input 1.1k   output 200", "cache read 600   write 100"]);
	assert.deepEqual(cardBody(lines, "claude-bridge"), ["total 2.0k   share 50%", "▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱", "requests 2   API $0*", "input 200   output 400", "cache read 1.2k   write 200"]);
	assert.ok(lines.every(line => line.length <= 90), "no line exceeds the width");
});

test("the now view stacks its cards one per row when the panel is narrow", () => {
	const lines = renderAdvancedUsage(summarizeHistory(HISTORY, NOW), "now", CURRENT, NOW, 60);
	assert.match(lines.find(line => line.includes("╭─ This session")) ?? "", /^╭─ This session · aaaaaaaa ─+╮$/, "alone on its row");
	assert.ok(lines.some(line => /^╭─ Last 24h .*╮$/.test(line)));
	assert.ok(lines.every(line => line.length <= 60));
});

test("the days view trims leading empty days, keeps inner zero days, and lays each day out as a table row with one column per provider", () => {
	const lines = renderAdvancedUsage(summarizeHistory(HISTORY, NOW), "days", CURRENT, NOW, 90);
	const text = lines.join("\n");
	assert.match(text, /1 now\s+2 quotas\s+\[3 days\]\s+4 sessions/);
	assert.match(text, /no data before 10-15/);
	assert.doesNotMatch(text, /10-14/);
	assert.match(text, /█ antigravity\s+▓ claude-bridge/);
	assert.match(text, / {8}0 {15}3\.0k/);
	assert.match(text, /^  day   tokens per day {9}total  antigravity  claude-bridge {4}API \$$/m);
	assert.match(text, /^  10-18 █{7}▓{13} {4}3\.0k {9}1\.0k {11}2\.0k {6}\$0\*$/m);
	assert.match(text, /^  10-17 ░{20} {7}0 {12}- {14}- {8}-$/m);
	assert.match(text, /^  10-15 █+░+ {4}1\.0k {9}1\.0k {14}- {6}\$0\*$/m);
	assert.doesNotMatch(text, /claude-bridge 2\.0k · antigravity/, "the split moved into columns");
	assert.ok(lines.every(line => line.length <= 90));
});

test("the sessions view lists sessions newest first with tokens and peak context", () => {
	const text = renderAdvancedUsage(summarizeHistory(HISTORY, NOW), "sessions", CURRENT, NOW, 100).join("\n");
	assert.match(text, /\[4 sessions\]/);
	const rows = text.split("\n").filter(line => /aaaaaaaa|bbbbbbbb/.test(line));
	assert.equal(rows.length, 2);
	assert.match(rows[0], /▸ 10-18 11:50\s+balancingIa\s+aaaaaaaa\s+claude-opus-5-5 \+1\s+3\s+3\.0k\s+60\.0k\/200\.0k/);
	assert.match(rows[1], /  10-15 12:00\s+balancingIa\s+bbbbbbbb\s+gemini-3-flash\s+1\s+1\.0k\s+10\.0k\/200\.0k/);
});

test("an empty history still renders the current session and says there is nothing recorded", () => {
	const text = renderAdvancedUsage(summarizeHistory([], NOW), "now", { session: "cccccccc", model: undefined, contextTokens: null, contextWindow: null }, NOW, 80).join("\n");
	assert.match(text, /This session · cccccccc/);
	assert.match(text, /context\s+unknown until the next response/);
	assert.match(text, /no requests recorded yet/);
});

const PRICES = parsePrices({
	models: {
		"claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		"gemini-3-flash": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.5 },
	},
	subscriptions: { "claude-bridge": 20 },
});

test("formatUsd rounds by magnitude", () => {
	assert.deepEqual([0, 0.004, 0.01, 12.345, 99.99, 123.4, 1234.5].map(formatUsd), ["$0", "<$0.01", "$0.01", "$12.35", "$99.99", "$123", "$1235"]);
});

test("summarizeHistory prices every request and counts the ones without a price", () => {
	const stats = summarizeHistory(HISTORY, NOW, PRICES);
	// opus: (100*4 + 200*20 + 600*0.2 + 100*5) / 1e6 = 0.00502 per request
	const claude = stats.providers.find(row => row.provider === "claude-bridge");
	const agy = stats.providers.find(row => row.provider === "antigravity");
	assert.ok(claude && agy);
	assert.ok(Math.abs(claude.cost - 0.01004) < 1e-9);
	assert.equal(claude.unpriced, 0);
	// gemini-3-flash is priced; claude-sonnet-5-5 on antigravity is not
	assert.equal(agy.unpriced, 1);
	assert.ok(Math.abs(agy.cost - (100 * 0.5 + 200 * 3 + 600 * 0.05 + 100 * 0.5) / 1e6) < 1e-9);
	assert.ok(Math.abs(stats.daily[29].cost - 0.01004) < 1e-9);
	assert.deepEqual(stats.subscriptions, { "claude-bridge": 20 });
	assert.equal(stats.pricesAsOf, undefined);
	const noPrices = summarizeHistory(HISTORY, NOW);
	assert.deepEqual([noPrices.providers[0].cost, noPrices.providers[0].unpriced], [0, 2]);
});

test("the now view shows the API cost in the session and provider cards and marks costs with unpriced requests", () => {
	const stats = summarizeHistory(HISTORY, NOW, PRICES);
	const lines = renderAdvancedUsage(stats, "now", CURRENT, NOW, 120);
	const text = lines.join("\n");
	assert.equal(cardBody(lines, "This session")[3], "requests 3   API $0.01*");
	assert.equal(cardBody(lines, "claude-bridge")[2], "requests 2   API $0.01");
	assert.equal(cardBody(lines, "antigravity")[2], "requests 2   API <$0.01*");
	assert.match(text, /\* 1 requests of models without a price in prices\.json/);
	const clean = renderAdvancedUsage(summarizeHistory(HISTORY.slice(1, 3), NOW, PRICES), "now", CURRENT, NOW, 120).join("\n");
	assert.doesNotMatch(clean, /without a price/);
});

const WEEK_S = 7 * 24 * 3600;
const QUOTA: QuotaReport = {
	current: [
		{ limit: "agy claude", window: "week", usedPercent: 62, resetAt: NOW + 2 * 24 * HOUR + 3 * HOUR, ts: NOW - 5 * 60_000, stale: false },
		{ limit: "claude", window: "5h", usedPercent: 90, resetAt: NOW - HOUR, ts: NOW - 3 * HOUR, stale: true },
	],
	series: [
		{
			limit: "agy claude", window: "week", key: "antigravity/claude", fills: 2, peak: 100,
			daily: [...new Array<number | null>(26).fill(null), 0, 100, 50, 100],
			fillDays: [27, 29], everyMs: 26 * HOUR, fillsInMs: 5 * 24 * HOUR + 2 * HOUR, blockedMs: 90 * 60_000,
		},
		{ limit: "claude", window: "5h", fills: 0, peak: 10, daily: new Array<number | null>(30).fill(null), fillDays: [], blockedMs: 0 },
	],
	fills: [
		{ limit: "agy claude", window: "week", key: "antigravity/claude", ts: NOW - 2 * HOUR, resetAt: NOW + HOUR, windowSeconds: WEEK_S, source: "error", hitSession: "dddddddd-9", hitProject: "web", top: { session: "aaaaaaaa-1111", project: "balancingIa", tokens: 12_345 } },
		{ limit: "agy claude", window: "week", key: "antigravity/claude", ts: NOW - 3 * 24 * HOUR, resetAt: null, windowSeconds: WEEK_S, source: "usage" },
	],
};

test("the now view gives each subscription read a card with a meter, reset and age, side by side, and flags stale reads", () => {
	const raw = renderStyled(summarizeHistory(HISTORY, NOW, PRICES), "now", CURRENT, NOW, 120, QUOTA);
	const lines = raw.map(plain);
	assert.ok(lines.includes("Subscriptions now"));
	assert.match(lines.find(line => line.includes("╭─ agy claude week")) ?? "", /╭─ agy claude week ─*╮ ╭─ claude 5h ─*╮/);
	assert.deepEqual(cardBody(lines, "agy claude week"), ["▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱  62%", "resets in 2d 3h", "read 5m ago"]);
	assert.deepEqual(cardBody(lines, "claude 5h"), ["reset since last read", "", "read 3h 0m ago"]);
	assert.match(tones(raw).join("\n"), /<success>agy claude week<\/success>/, "the title takes the fill color");
	const empty = renderAdvancedUsage(summarizeHistory(HISTORY, NOW, PRICES), "now", CURRENT, NOW, 120).join("\n");
	assert.match(empty, /Subscriptions now\n {2}no quota reads yet/);
});

test("the quotas view lays the window charts out as side-by-side cards, then the report and the fills as tables", () => {
	const gemini = { limit: "agy gemini", window: "5h", fills: 0, peak: 40, daily: [...new Array<number | null>(26).fill(null), 10, 20, 40, 30], fillDays: [], blockedMs: 0 };
	const grid: QuotaReport = { ...QUOTA, series: [QUOTA.series[0], gemini, QUOTA.series[1]] };
	const lines = renderAdvancedUsage(summarizeHistory(HISTORY, NOW, PRICES), "quotas", CURRENT, NOW, 140, grid);
	const text = lines.join("\n");
	assert.match(lines[0], /1 now\s+\[2 quotas\]\s+3 days\s+4 sessions/);
	assert.match(text, /Subscription usage · daily peak per window/);
	assert.match(text, /▲ filled that day · · no reading/);
	assert.match(text, /no data before 10-15/);
	assert.ok(
		lines.some(line => /^╭─ agy claude week · peak 100% · 2 fills ─*╮ ╭─ agy gemini 5h · peak 40% · 0 fills ─*╮$/.test(line)),
		"both charted windows share one row of cards",
	);
	assert.match(text, /│ 100% ┤ {6}█████ {7}█████/);
	assert.match(text, /│  50% ┤ {6}█████ █████ █████/);
	assert.match(text, /│   0% ┼──────▲───────────▲─────/);
	assert.match(text, /│ {7}10-15 10-16 10-17 10-18/);
	assert.doesNotMatch(text, /╭─ claude 5h/, "a window without readings gets no card");
	assert.match(text, /\n {2}no readings in these days: claude 5h\n/);
	assert.match(text, /Report\n {2}window {11}fills {2}every {2}fills in {2}blocked\n {2}agy claude week {2}2 {6}1d 2h {2}5d 2h {5}1h 30m\n/);
	assert.doesNotMatch(text, /^ {2}(claude|agy gemini) 5h /m, "a window that never filled has no report row");
	assert.match(text, /Fills \(newest first\)\n {2}when {9}window {11}top session {11}tokens {2}hit in\n/);
	assert.match(text, /\n {2}10-18 10:00 {2}agy claude week {2}aaaaaaaa balancingIa {3}12\.3k {2}dddddddd web\n/);
	assert.match(text, /\n {2}10-15 12:00 {2}agy claude week {2}- {26}- {2}-$/);
	assert.ok(lines.every(line => line.length <= 140));
	const narrow = renderAdvancedUsage(summarizeHistory(HISTORY, NOW, PRICES), "quotas", CURRENT, NOW, 80, grid);
	assert.ok(narrow.every(line => line.length <= 80));
	assert.ok(narrow.some(line => /╭─ agy claude week.*╮ ╭─ agy gemini 5h.*╮/.test(line)), "two cards still fit in 80 columns");
	const tiny = renderAdvancedUsage(summarizeHistory(HISTORY, NOW, PRICES), "quotas", CURRENT, NOW, 50, grid);
	assert.ok(tiny.every(line => line.length <= 50));
	assert.ok(!tiny.some(line => /╮ ╭─/.test(line)), "a narrow panel stacks the cards");
});

test("the quotas view says so when there are no fills", () => {
	const quiet: QuotaReport = { current: [], series: [QUOTA.series[1]], fills: [] };
	const text = renderAdvancedUsage(summarizeHistory([], NOW), "quotas", CURRENT, NOW, 100, quiet).join("\n");
	assert.match(text, /no fills in the last 30 days/);
	const none = renderAdvancedUsage(summarizeHistory([], NOW), "quotas", CURRENT, NOW, 100).join("\n");
	assert.match(none, /no fills in the last 30 days/);
});

test("the days view reports the 30-day API cost, per-provider plan ratio, provider tones and the cost of each day", () => {
	const raw = renderStyled(summarizeHistory(HISTORY, NOW, PRICES), "days", CURRENT, NOW, 140);
	const lines = raw.map(plain);
	const text = lines.join("\n");
	assert.match(text, /30 days · tokens 4\.0k · API \$0\.01\* · avg <\$0\.01\*\/day · month pace \$0\.08\*/);
	assert.deepEqual(cardBody(lines, "▓ claude-bridge"), ["tokens 2.0k", "API $0.01", "vs plan $20 → 0.0x"]);
	assert.deepEqual(cardBody(lines, "█ antigravity"), ["tokens 2.0k", "API <$0.01*", "no plan price"]);
	assert.match(text, /^  10-18 █+▓+ {4}3\.0k {9}1\.0k {11}2\.0k {3}\$0\.01\*$/m);
	assert.match(text, /\* 1 requests of models without a price/);
	const toned = tones(raw).join("\n");
	assert.match(toned, /<accent>█<\/accent> antigravity/);
	assert.match(toned, /<muted>▓<\/muted> claude-bridge/);
	assert.match(toned, /10-18 <accent>█{7}<\/accent><muted>▓{13}<\/muted>/);
});

test("the sessions view adds the API cost column", () => {
	const text = renderAdvancedUsage(summarizeHistory(HISTORY, NOW, PRICES), "sessions", CURRENT, NOW, 120).join("\n");
	assert.match(text, /peak ctx\s+API \$/);
	const rows = text.split("\n").filter(line => /aaaaaaaa|bbbbbbbb/.test(line));
	assert.match(rows[0], /60\.0k\/200\.0k\s+\$0\.01\*/);
	assert.match(rows[1], /10\.0k\/200\.0k\s+<\$0\.01/);
});

test("a project name wider than its column is clipped instead of running into the session id", () => {
	const legacy = entry(NOW - HOUR, { session: "legacy", project: "(before history)" });
	const text = renderAdvancedUsage(summarizeHistory([legacy], NOW, PRICES), "sessions", CURRENT, NOW, 120).join("\n");
	assert.match(text, /\(before hist… legacy/);
});

test("the 5 hud tab shows the compact HUD for the consumption summary", () => {
	const consumption = {
		subscriptions: [{ provider: "claude-bridge", label: "Claude Pro", tokens: { last5h: 0, today: 0, last7d: 0 }, windows: [] }],
		apis: [],
		unclassified: [],
	};
	const lines = renderAdvancedUsage(summarizeHistory(HISTORY, NOW), "hud", CURRENT, NOW, 120, undefined, consumption);
	assert.match(lines[0], /1 now\s+2 quotas\s+3 days\s+4 sessions\s+\[5 hud\]/);
	assert.deepEqual(lines.slice(2), renderHudCompact(consumption, NOW).map(plain));
});

test("the 5 hud tab without a consumption summary says it has no data", () => {
	const lines = renderAdvancedUsage(summarizeHistory(HISTORY, NOW), "hud", CURRENT, NOW, 120);
	assert.deepEqual(lines.slice(2), ["HUD · no consumption data yet"]);
});

test("colors: the active tab is accent and the others dim", () => {
	const lines = tones(renderStyled(summarizeHistory(HISTORY, NOW, PRICES), "quotas", CURRENT, NOW, 140, QUOTA));
	assert.equal(lines[0], "<dim>1 now</dim>   <accent>[2 quotas]</accent>   <dim>3 days</dim>   <dim>4 sessions</dim>   <dim>5 hud</dim>");
});

test("colors: the now view tones the context meter by size and each window by fill, with the read age dim", () => {
	const lines = tones(renderStyled(summarizeHistory(HISTORY, NOW, PRICES), "now", CURRENT, NOW, 120, QUOTA));
	assert.ok(lines.some(line => /│<\/dim> context {2}<success>▰+▱+<\/success> {2}<success>23%<\/success>/.test(line)), "45k of context is green");
	const big = tones(renderStyled(summarizeHistory(HISTORY, NOW, PRICES), "now", { ...CURRENT, contextTokens: 150_000 }, NOW, 120, QUOTA));
	assert.ok(big.some(line => /│<\/dim> context {2}<warning>▰+▱+<\/warning>/.test(line)), "150k of context is yellow");
	const text = lines.join("\n");
	assert.match(text, /<success>agy claude week<\/success>/);
	assert.match(text, /<success>▰{10}▱{6}<\/success> {2}<success>62%<\/success>/);
	assert.match(text, /<dim>resets in 2d 3h<\/dim>/);
	assert.match(text, /<dim>read 5m ago<\/dim>/);
});

test("colors: fill markers in the quotas view are red", () => {
	const lines = tones(renderStyled(summarizeHistory(HISTORY, NOW, PRICES), "quotas", CURRENT, NOW, 140, QUOTA));
	assert.ok(lines.some(line => /<error>▲<\/error>/.test(line)));
});

test("colors do not count toward the width: a toned line that fits is kept, one that does not is clipped as plain text", () => {
	const lines = renderStyled(summarizeHistory(HISTORY, NOW, PRICES), "quotas", CURRENT, NOW, 140, QUOTA);
	assert.ok(lines.some(line => line !== plain(line)), "some lines carry colors at 140 columns");
	const narrow = renderStyled(summarizeHistory(HISTORY, NOW, PRICES), "now", CURRENT, NOW, 30, QUOTA);
	assert.ok(narrow.every(line => plain(line).length <= 30));
});

test("colors: a window that fills before its reset is red in the now view too, as in the HUD", () => {
	const read = QUOTA.current[0];
	const consumption = {
		subscriptions: [{
			provider: "antigravity",
			label: "Google AI Pro",
			tokens: { last5h: 0, today: 0, last7d: 0 },
			windows: [{ key: "antigravity/claude", window: "week", usedPercent: 62, resetAt: read.resetAt! + 30_000, sampledAt: read.ts, pace: { percentPerHour: 5, fullAt: NOW + 8 * HOUR, fillsBeforeReset: true } }],
		}],
		apis: [],
		unclassified: [],
	};
	const lines = tones(renderStyled(summarizeHistory(HISTORY, NOW, PRICES), "now", CURRENT, NOW, 120, QUOTA, consumption));
	const text = lines.join("\n");
	assert.match(text, /<error>agy claude week<\/error>/);
	assert.match(text, /<error>▰{10}▱{6}<\/error> {2}<error>62%<\/error>/);
});

test("the 5 hud tab passes the top consumers to the compact HUD", () => {
	const consumption = { subscriptions: [], apis: [], unclassified: [] };
	const consumers = [{ role: "orchestrator", requests: 2, contextResend: 900, newOutput: 100, total: 1000, sessions: [] }];
	const lines = renderAdvancedUsage(summarizeHistory(HISTORY, NOW), "hud", CURRENT, NOW, 120, undefined, consumption, consumers);
	assert.deepEqual(lines.slice(2), renderHudCompact(consumption, NOW, consumers).map(plain));
	assert.ok(lines.includes("Top consumers · last 7 days"));
});
