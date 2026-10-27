import { test } from "node:test";
import assert from "node:assert/strict";
import type { ApiConsumption, ConsumptionSummary, SubscriptionConsumption, WindowConsumption } from "../src/consumption.ts";
import type { RoleConsumer, SessionConsumer } from "../src/consumers.ts";
import { HUD_VIEWS, hudHints, moveCursor, pressRedKey, selectedSessionTarget, suggestionEnter, visibleSessions, renderHud as renderHudStyled, renderHudCompact as renderHudCompactStyled } from "../src/hud.ts";
import { paint, plain } from "../src/style.ts";

const renderHud = (...args: Parameters<typeof renderHudStyled>) => renderHudStyled(...args).map(plain);
const renderHudCompact = (...args: Parameters<typeof renderHudCompactStyled>) => renderHudCompactStyled(...args).map(plain);
const LEGEND = "● ok   ● watch it   ● full, or runs out before it refills";
/** Each toned span as <tone>text</tone>. */
const tones = (lines: string[]) => lines.map(line => paint(line, (name, text) => `<${name}>${text}</${name}>`));

const HOUR = 3_600_000;
const NOW = new Date(2026, 9, 19, 12, 0).getTime();

function window(
	key: string,
	name: string,
	usedPercent: number,
	resetIn: number,
	pace: WindowConsumption["pace"],
	windowSeconds = name === "week" ? 7 * 24 * 3600 : 5 * 3600,
	points: { ts: number; percent: number }[] = [{ ts: NOW, percent: usedPercent }],
): WindowConsumption {
	return { key, window: name, usedPercent, resetAt: NOW + resetIn, sampledAt: NOW, windowSeconds, points, pace };
}

const CLAUDE: SubscriptionConsumption = {
	provider: "claude-bridge",
	label: "Claude Pro (claude-bridge)",
	tokens: { last5h: 1000, today: 2000, last7d: 3000 },
	windows: [
		window("claude-bridge/claude", "5h", 40, 4 * HOUR, { percentPerHour: 20, fullAt: NOW + 3 * HOUR, fillsBeforeReset: true }),
		window("claude-bridge/claude", "week", 64, 50 * HOUR, { percentPerHour: 0.5, fullAt: NOW + 72 * HOUR, fillsBeforeReset: false }),
	],
};

const AGY: SubscriptionConsumption = {
	provider: "antigravity",
	label: "Google AI Pro (agy)",
	tokens: { last5h: 0, today: 0, last7d: 0 },
	windows: [
		window("antigravity/claude", "week", 100, 86 * HOUR, { percentPerHour: 0, fullAt: NOW - 2 * HOUR, fillsBeforeReset: true }),
		window("antigravity/gemini", "5h", 2, 2 * HOUR, null),
	],
};

const EXTRA: SubscriptionConsumption = { provider: "extra", label: "Extra (extra)", tokens: { last5h: 0, today: 0, last7d: 0 }, windows: [] };

const SUMMARY: ConsumptionSummary = { subscriptions: [CLAUDE, AGY, EXTRA], apis: [], unclassified: [] };

const ANTHROPIC: ApiConsumption = {
	provider: "anthropic",
	label: "Anthropic API",
	today: { requests: 3, usd: 1.2, partial: false },
	last7d: { requests: 10, usd: 4, partial: true },
	last30d: { requests: 12, usd: 4.5, partial: true },
};

const GOOGLE: ApiConsumption = {
	provider: "google",
	label: "Gemini API",
	today: { requests: 0, usd: 0, partial: false },
	last7d: { requests: 0, usd: 0, partial: false },
	last30d: { requests: 0, usd: 0, partial: false },
};

const WITH_APIS: ConsumptionSummary = { subscriptions: [], apis: [ANTHROPIC, GOOGLE], unclassified: [] };

test("compact: one aligned line per window with meter, percent and pace, warning when it fills before reset", () => {
	assert.deepEqual(renderHudCompact(SUMMARY, NOW), [
		"Subscriptions · window use and pace",
		"  claude-bridge  claude 5h    ▰▰▰▰▱▱▱▱▱▱   40%  +20.0%/h · full in 3h 0m ⚠",
		"  claude-bridge  claude week  ▰▰▰▰▰▰▱▱▱▱   64%  +0.5%/h · resets in 2d 2h",
		"  antigravity    claude week  ▰▰▰▰▰▰▰▰▰▰  100%  full · resets in 3d 14h",
		"  antigravity    gemini 5h    ▱▱▱▱▱▱▱▱▱▱    2%  resets in 2h 0m",
		"  extra          no quota reads yet",
		`  ${LEGEND}`,
		"",
		"APIs · USD at list price",
		"  no API integrations in integrations.json",
	]);
});

test("compact: no subscriptions or APIs configured says so", () => {
	assert.deepEqual(renderHudCompact({ subscriptions: [], apis: [], unclassified: [] }, NOW), [
		"Subscriptions · window use and pace",
		"  no subscriptions in integrations.json",
		"",
		"APIs · USD at list price",
		"  no API integrations in integrations.json",
	]);
});

test("compact: one line per API with USD today, 7d and 30d, * and a footnote when a price is missing", () => {
	assert.deepEqual(renderHudCompact(WITH_APIS, NOW), [
		"Subscriptions · window use and pace",
		"  no subscriptions in integrations.json",
		"",
		"APIs · USD at list price",
		"  anthropic  today $1.20 · 7d $4.00* · 30d $4.50* · 12 requests",
		"  google     no requests in 30 days",
		"  * some requests use a model without a price in prices.json",
	]);
});

const CHART_LEGEND = "chart: █ used so far · • current pace · ▲ full · ┴ now · ┤ reset · · no reading";

test("/hud subscriptions view: a card per subscription with tokens, reset clock, pace verdict and chart note when under 2 readings", () => {
	assert.deepEqual(renderHud("subscriptions", SUMMARY, NOW), [
		"[1 subscriptions]   2 apis   3 sessions   4 suggestions",
		"",
		"Subscriptions · bridges and plugins, window use and pace",
		LEGEND,
		CHART_LEGEND,
		"",
		"Claude Pro (claude-bridge)",
		"  tokens  5h 1.0k · today 2.0k · 7d 3.0k",
		"  claude 5h    ▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱   40%  resets 16:00 (in 4h 0m)",
		"               +20.0%/h → full at 15:00, before the reset ⚠",
		"    chart after the next reading",
		"  claude week  ▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱   64%  resets 10-21 14:00 (in 2d 2h)",
		"               +0.5%/h → full at 10-22 12:00, after the reset",
		"    chart after the next reading",
		"",
		"Google AI Pro (agy)",
		"  tokens  5h 0 · today 0 · 7d 0",
		"  claude week  ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰  100%  resets 10-23 02:00 (in 3d 14h)",
		"               full since 10:00",
		"    chart after the next reading",
		"  gemini 5h    ▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱    2%  resets 14:00 (in 2h 0m)",
		"               no pace yet: needs two reads 5 minutes apart in the last hour",
		"    chart after the next reading",
		"",
		"Extra (extra)",
		"  tokens  5h 0 · today 0 · 7d 0",
		"  no quota reads yet",
	]);
});

test("/hud subscriptions view draws a windowChart from start to reset when a window has at least two readings", () => {
	const charted: ConsumptionSummary = {
		subscriptions: [
			{
				provider: "claude-bridge",
				label: "Claude Pro (claude-bridge)",
				tokens: { last5h: 1000, today: 2000, last7d: 3000 },
				windows: [
					window(
						"claude-bridge/claude",
						"5h",
						60,
						2.5 * HOUR,
						{ percentPerHour: 40, fullAt: NOW + HOUR, fillsBeforeReset: true },
						5 * HOUR / 1000,
						[
							{ ts: NOW - 2 * HOUR, percent: 10 },
							{ ts: NOW - HOUR, percent: 35 },
							{ ts: NOW, percent: 60 },
						],
					),
				],
			},
		],
		apis: [],
		unclassified: [],
	};
	const lines = renderHud("subscriptions", charted, NOW, undefined, 80);
	const text = lines.join("\n");
	assert.match(text, /    100% ┤.*•/);
	assert.match(text, /      0% ┼─+┴─*▲─*┤/);
	assert.match(text, /09:30.*now 12:00.*reset 14:30/);
	assert.ok(lines.every(line => line.length <= 80));
	const wide = renderHud("subscriptions", charted, NOW, undefined, 116);
	assert.ok(wide.every(line => line.length <= 116));
});

test("/hud apis view: a card per API with requests and USD per period", () => {
	assert.deepEqual(renderHud("apis", WITH_APIS, NOW), [
		"1 subscriptions   [2 apis]   3 sessions   4 suggestions",
		"",
		"APIs · billed per token, USD at the list price in prices.json",
		"",
		"Anthropic API",
		"  period  requests  USD",
		"  today          3  $1.20",
		"  7d            10  $4.00*",
		"  30d           12  $4.50*",
		"",
		"Gemini API",
		"  no requests in 30 days",
		"",
		"* some requests use a model without a price in prices.json, so the USD is a lower bound",
	]);
});

test("/hud apis view without API integrations says how to add one", () => {
	assert.deepEqual(renderHud("apis", { subscriptions: [], apis: [], unclassified: [] }, NOW), [
		"1 subscriptions   [2 apis]   3 sessions   4 suggestions",
		"",
		"APIs · billed per token, USD at the list price in prices.json",
		"",
		"  no API integrations in integrations.json",
		"  add one as { \"provider\", \"kind\": \"api\", \"label\" }",
	]);
});

test("/hud lists its views in order", () => {
	assert.deepEqual(HUD_VIEWS, ["subscriptions", "apis", "sessions", "suggestions"]);
});

test("/hud suggestions view renders suggestions with evidence, saving, and cursor selection", () => {
	const suggestions = [
		{
			rule: "expensive-role" as const,
			title: "Try small for gentle-ai-verify",
			target: { role: "gentle-ai-verify", model: "claude-bridge/claude-opus-5-5", cheaperModel: "antigravity/gemini-3-8-flash" },
			evidence: ["3 sessions with small output", "API cost $0.24 vs $0.06"],
			saving: { usd: 0.18, tokens: null, quotaPercent: null },
			quality: "Quality is not measured",
		},
	];
	const lines = renderHud("suggestions", SUMMARY, NOW, undefined, 100, { suggestions, cursor: 0 });
	const text = lines.join("\n");
	assert.match(text, /\[4 suggestions\]/);
	assert.match(text, /Suggestions · evidence-based tuning hints/);
	assert.match(text, /▸ Try small for gentle-ai-verify/);
	assert.match(text, /save \$0\.18/);
	assert.match(text, /• 3 sessions with small output/);
	assert.match(text, /Quality is not measured/);
	assert.match(text, /enter or 'c' creates a new profile/);
});

const LARGE = {
	rule: "large-context" as const,
	title: 'Compact or split "01a155f0"',
	target: { session: "01a155f0" },
	evidence: ["peak context 692k tokens"],
	saving: { usd: 10.8, tokens: 55_900_000, quotaPercent: null },
	quality: "Quality is not measured",
};
const SWITCH = { ...LARGE, rule: "provider-switch" as const, title: 'Keep "01a155f0" on one model' };
const IDLE = { ...LARGE, rule: "idle-quota" as const, title: "Move work to antigravity before it resets", target: { quotaKey: "antigravity", window: "week" } };

test("/hud suggestions: each selected suggestion says what enter does, and only profile suggestions mention 'c'", () => {
	const action = (item: typeof LARGE | typeof SWITCH | typeof IDLE) => {
		const lines = renderHud("suggestions", SUMMARY, NOW, undefined, 100, { suggestions: [item], cursor: 0 });
		assert.doesNotMatch(lines.join("\n"), /'c'/);
		return lines[lines.findIndex(line => line.startsWith("▸ ")) + 2];
	};
	assert.equal(action(LARGE), "    → enter opens it · x compacts it · f continues it in a fresh session from a summary");
	assert.equal(action(SWITCH), "    → enter opens that session; keep it on one model, each switch re-sends the whole context uncached");
	assert.equal(action(IDLE), "    → up to you: send work to antigravity before it resets (enter has nothing to open)");
	const header = renderHud("suggestions", SUMMARY, NOW, undefined, 100, { suggestions: [LARGE], cursor: 0 })[3];
	assert.equal(header, "quality is not measured · ↑↓ select · enter acts on the selected one");
});

test("enter on a suggestion: open its session, create the profile, or explain", () => {
	const ROLE = { ...LARGE, rule: "expensive-role" as const, target: { role: "gentle-ai-verify" } };
	assert.equal(suggestionEnter(LARGE), "open");
	assert.equal(suggestionEnter(SWITCH), "open");
	assert.equal(suggestionEnter(ROLE), "profile");
	assert.equal(suggestionEnter(IDLE), "explain");
	assert.equal(suggestionEnter({ ...LARGE, target: {} }), "explain");
});

test("/hud footer lists only the keys that work in each view", () => {
	assert.equal(hudHints("subscriptions"), "1-4/tab view · pgup/pgdn scroll · q close");
	assert.equal(hudHints("apis"), "1-4/tab view · pgup/pgdn scroll · q close");
	assert.equal(hudHints("sessions"), "↑↓ select · enter open · x compact · f fresh · 1-4/tab view · pgup/pgdn scroll · q close");
	assert.equal(hudHints("suggestions"), "↑↓ select · enter act · c profile · x compact · f fresh · 1-4/tab view · pgup/pgdn scroll · q close");
});

test("/hud suggestions: the note shows right under the selected suggestion, not at the end of the list", () => {
	const lines = renderHud("suggestions", SUMMARY, NOW, undefined, 100, { suggestions: [LARGE, SWITCH, IDLE], cursor: 1, note: "hello" });
	const title = lines.findIndex(line => line.startsWith("▸ "));
	assert.equal(lines[title + 3], "    hello");
	assert.equal(lines.filter(line => line.includes("hello")).length, 1);
});

test("/hud suggestions: every suggestion says in one plain line what is wrong; only the selected one shows its evidence", () => {
	const ROLE = { ...LARGE, rule: "expensive-role" as const, title: "Try small for gentle-ai-verify", target: { role: "gentle-ai-verify" } };
	const lines = renderHud("suggestions", SUMMARY, NOW, undefined, 100, { suggestions: [LARGE, SWITCH, ROLE, IDLE], cursor: 1 });
	const after = (title: string) => lines[lines.findIndex(line => line.includes(title)) + 1];
	assert.equal(after('Compact or split "01a155f0"'), "    why: every turn re-sends this whole conversation, and it grew past 120k tokens");
	assert.equal(after('Keep "01a155f0" on one model'), "    why: changing model mid-session drops the cache, so the whole conversation is paid again");
	assert.equal(after("Try small for gentle-ai-verify"), "    why: this subagent writes short answers on a model at least twice as expensive");
	assert.equal(after("Move work to antigravity"), "    why: this quota resets mostly unused while another one runs out");
	assert.equal(lines.filter(line => line.includes("• peak context 692k tokens")).length, 1);
	assert.ok(lines.findIndex(line => line.includes("• peak context")) > lines.findIndex(line => line.startsWith("▸ ")));
	assert.equal(lines.filter(line => line.includes("note: Quality is not measured")).length, 1);
});

test("compact colors: meter and percent by fill, red when it fills before reset or is full, dim reset times", () => {
	const lines = tones(renderHudCompactStyled(SUMMARY, NOW));
	assert.equal(lines[0], "<accent>Subscriptions · window use and pace</accent>");
	assert.equal(lines[1], "  claude-bridge  claude 5h    <error>▰▰▰▰▱▱▱▱▱▱</error>  <error> 40%</error>  <error>+20.0%/h · full in 3h 0m ⚠</error>");
	assert.equal(lines[2], "  claude-bridge  claude week  <success>▰▰▰▰▰▰▱▱▱▱</success>  <success> 64%</success>  +0.5%/h · <dim>resets in 2d 2h</dim>");
	assert.equal(lines[3], "  antigravity    claude week  <error>▰▰▰▰▰▰▰▰▰▰</error>  <error>100%</error>  <error>full</error> · <dim>resets in 3d 14h</dim>");
	assert.equal(lines[6], "  <success>●</success> ok   <warning>●</warning> watch it   <error>●</error> full, or runs out before it refills");
});

test("compact colors: a window between 70% and 90% that lasts until its reset is yellow", () => {
	const summary: ConsumptionSummary = {
		subscriptions: [{ ...EXTRA, windows: [window("extra/x", "5h", 75, HOUR, null)] }],
		apis: [],
		unclassified: [],
	};
	assert.match(tones(renderHudCompactStyled(summary, NOW))[1], /<warning>▰+▱+<\/warning>  <warning> 75%<\/warning>/);
});

test("/hud colors: active tab accent, pace verdict green after the reset and red before it, no pace dim", () => {
	const lines = tones(renderHudStyled("subscriptions", SUMMARY, NOW));
	assert.equal(lines[0], "<accent>[1 subscriptions]</accent>   <dim>2 apis</dim>   <dim>3 sessions</dim>   <dim>4 suggestions</dim>");
	assert.equal(lines[4], `<dim>${CHART_LEGEND}</dim>`);
	assert.equal(lines[9], "               +20.0%/h → full at 15:00, <error>before the reset ⚠</error>");
	assert.equal(lines[10], "    <dim>chart after the next reading</dim>");
	assert.equal(lines[12], "               +0.5%/h → full at 10-22 12:00, <success>after the reset</success>");
	assert.equal(lines[18], "               <error>full since 10:00</error>");
	assert.equal(lines[21], "               <dim>no pace yet: needs two reads 5 minutes apart in the last hour</dim>");
});

function session(id: string, alias: string | null, total: number, resend: number, lastTs: number, project = "web"): SessionConsumer {
	return { session: id, alias, project, parentSession: null, providers: ["claude-bridge"], firstTs: lastTs, lastTs, requests: 3, contextResend: resend, newOutput: total - resend, total };
}

function role(name: string, sessions: SessionConsumer[]): RoleConsumer {
	const sum = (pick: (s: SessionConsumer) => number) => sessions.reduce((acc, s) => acc + pick(s), 0);
	return { role: name, requests: sum(s => s.requests), contextResend: sum(s => s.contextResend), newOutput: sum(s => s.newOutput), total: sum(s => s.total), sessions };
}

const LONG = "refactor the whole authentication module and its tests";
const CONSUMERS: RoleConsumer[] = [
	role("orchestrator", [
		session("01a1510a-8e84-75aa-a1fe-c3d9560786c3", "login refactor", 98_500_000, 98_000_000, NOW - HOUR),
		session("02b2620b-9f95-86bb-b2ff-d4ea671897d4", null, 1_000_000, 500_000, NOW - 30 * HOUR, "api"),
		session("03c3730c-0aa6-97cc-83a0-e5fb782908e5", LONG, 500_000, 300_000, NOW - 50 * HOUR),
		session("04d4841d-1bb7-a8dd-94b1-f60c893a19f6", "four", 400_000, 300_000, NOW),
		session("05e5952e-2cc8-b9ee-a5c2-07d1904b2a07", "five", 300_000, 200_000, NOW),
		session("06f6a63f-3dd9-caff-b6d3-18e2a15c3b18", "six hidden", 100_000, 50_000, NOW),
	]),
	role("gentle-ai-verify", [session("07a7b740-4eea-dbaa-c7e4-29f3b26d4c29", "verify login token", 10_000_000, 9_000_000, NOW - 2 * HOUR)]),
];

test("visibleSessions lists up to 5 sessions per role in display order", () => {
	assert.deepEqual(visibleSessions(CONSUMERS).map(s => s.alias), ["login refactor", null, LONG, "four", "five", "verify login token"]);
});

test("moveCursor moves by one and clamps to the list", () => {
	assert.equal(moveCursor(0, 1, 3), 1);
	assert.equal(moveCursor(2, 1, 3), 2);
	assert.equal(moveCursor(0, -1, 3), 0);
	assert.equal(moveCursor(1, -1, 3), 0);
	assert.equal(moveCursor(5, 0, 3), 2);
	assert.equal(moveCursor(0, 1, 0), 0);
});

test("/hud sessions view: roles biggest first, each session by alias with project, tokens, % re-sent and last use", () => {
	const lines = renderHud("sessions", SUMMARY, NOW, { consumers: CONSUMERS, cursor: 0 });
	assert.deepEqual(lines, [
		"1 subscriptions   2 apis   [3 sessions]   4 suggestions",
		"",
		"Sessions · what spends the most, by role · last 7 days",
		"tokens = context re-sent every turn + new output · x compacts a session · f moves it to a fresh one from a summary",
		"",
		"orchestrator  100.8M tokens · 99% context re-sent",
		"▸ login refactor                            web              98.5M   99% re-sent  11:00",
		"  02b2620b                                  api               1.0M   50% re-sent  10-18 06:00",
		`  ${LONG.slice(0, 39)}…  web             500.0k   60% re-sent  10-17 10:00`,
		"  four                                      web             400.0k   75% re-sent  12:00",
		"  five                                      web             300.0k   67% re-sent  12:00",
		"",
		"gentle-ai-verify  10.0M tokens · 90% context re-sent",
		"  verify login token                        web              10.0M   90% re-sent  10:00",
	]);
});

test("/hud sessions view: a note shows under the list, no data says so", () => {
	const lines = renderHud("sessions", SUMMARY, NOW, { consumers: CONSUMERS, cursor: 1, note: "no session file for this one" });
	assert.equal(lines[6].startsWith("  login refactor"), true);
	assert.equal(lines[7].startsWith("▸ 02b2620b"), true);
	assert.deepEqual(lines.slice(-2), ["", "no session file for this one"]);
	assert.deepEqual(renderHud("sessions", SUMMARY, NOW, { consumers: [], cursor: 0 }).slice(4), ["", "  no requests in the last 7 days"]);
	assert.deepEqual(renderHud("sessions", SUMMARY, NOW).slice(4), ["", "  no requests in the last 7 days"]);
});

test("/hud sessions colors: selected row accent, role accent with dim totals, >= 90% re-sent warning", () => {
	const lines = tones(renderHudStyled("sessions", SUMMARY, NOW, { consumers: CONSUMERS, cursor: 0, note: "hint" }));
	assert.equal(lines[0], "<dim>1 subscriptions</dim>   <dim>2 apis</dim>   <accent>[3 sessions]</accent>   <dim>4 suggestions</dim>");
	assert.equal(lines[2], "<accent>Sessions · what spends the most, by role · last 7 days</accent>");
	assert.equal(lines[3], "<dim>tokens = context re-sent every turn + new output · x compacts a session · f moves it to a fresh one from a summary</dim>");
	assert.equal(lines[5], "<accent>orchestrator</accent>  <dim>100.8M tokens · </dim><warning>99% context re-sent</warning>");
	assert.match(lines[6], /^<accent>▸ login refactor .*99% re-sent {2}11:00<\/accent>$/);
	assert.match(lines[7], /^ {2}02b2620b/);
	assert.match(lines[8], /60% re-sent/);
	assert.doesNotMatch(lines[8], /<warning>/);
	assert.match(lines[13], /<warning> 90% re-sent<\/warning>/);
	assert.equal(lines.at(-1), "<dim>hint</dim>");
});

test("compact: top 3 roles with total, share meter and % context re-sent, warning from 90%", () => {
	const extra = [...CONSUMERS, role("gentle-ai-explore", [session("08b8c851-4ffb-ecbb-d8f5-3a04c37e5d3a", null, 100_000, 10_000, NOW)]), role("small", [session("09c9d962-50ac-fdcc-e906-4b15d48f6e4b", null, 1, 1, NOW)])];
	const lines = renderHudCompact(SUMMARY, NOW, extra);
	assert.deepEqual(lines.slice(-5), [
		"",
		"Top consumers · last 7 days",
		"  orchestrator       100.8M  ▰▰▰▰▰▰▰▰▰▱  99% context re-sent",
		"  gentle-ai-verify    10.0M  ▰▱▱▱▱▱▱▱▱▱  90% context re-sent",
		"  gentle-ai-explore  100.0k  ▱▱▱▱▱▱▱▱▱▱  10% context re-sent",
	]);
	const styled = tones(renderHudCompactStyled(SUMMARY, NOW, extra));
	assert.equal(styled.at(-5), "");
	assert.equal(styled.at(-4), "<accent>Top consumers · last 7 days</accent>");
	assert.match(styled.at(-3)!, /<warning>99% context re-sent<\/warning>$/);
	assert.match(styled.at(-1)!, /10% context re-sent$/);
	assert.doesNotMatch(styled.at(-1)!, /<warning>/);
});

test("compact: without consumers the HUD tab is unchanged, with none it says so", () => {
	assert.equal(renderHudCompact(SUMMARY, NOW).includes("Top consumers · last 7 days"), false);
	assert.deepEqual(renderHudCompact(SUMMARY, NOW, []).slice(-3), ["", "Top consumers · last 7 days", "  no requests in the last 7 days"]);
});

test("red keys: the selected session in the sessions view, or the session of the selected suggestion", () => {
	assert.deepEqual(selectedSessionTarget("sessions", { consumers: CONSUMERS, cursor: 1 }), { session: "02b2620b-9f95-86bb-b2ff-d4ea671897d4", label: "02b2620b" });
	assert.deepEqual(selectedSessionTarget("sessions", { consumers: CONSUMERS, cursor: 0 }), { session: "01a1510a-8e84-75aa-a1fe-c3d9560786c3", label: "login refactor" });
	const named = { ...LARGE, target: { session: "01a155f0", alias: "fix the login form" } };
	assert.deepEqual(selectedSessionTarget("suggestions", undefined, { suggestions: [IDLE, named], cursor: 1 }), { session: "01a155f0", label: "fix the login form" });
	assert.deepEqual(selectedSessionTarget("suggestions", undefined, { suggestions: [LARGE], cursor: 0 }), { session: "01a155f0", label: "01a155f0" });
	assert.equal(selectedSessionTarget("suggestions", undefined, { suggestions: [IDLE], cursor: 0 }), undefined);
	assert.equal(selectedSessionTarget("subscriptions", { consumers: CONSUMERS, cursor: 0 }), undefined);
	assert.equal(selectedSessionTarget("sessions", { consumers: [], cursor: 0 }), undefined);
});

test("red keys: the first press asks, the same key on the same session confirms, anything else asks again", () => {
	const target = { session: "a", label: "A" };
	assert.deepEqual(pressRedKey(undefined, "compact", target), { confirmed: false, pending: { kind: "compact", session: "a" } });
	assert.deepEqual(pressRedKey({ kind: "compact", session: "a" }, "compact", target), { confirmed: true });
	assert.deepEqual(pressRedKey({ kind: "fresh", session: "a" }, "compact", target), { confirmed: false, pending: { kind: "compact", session: "a" } });
	assert.deepEqual(pressRedKey({ kind: "compact", session: "b" }, "compact", target), { confirmed: false, pending: { kind: "compact", session: "a" } });
});

test("red keys: the confirmation shows in red right under the selected session or suggestion", () => {
	const sessions = tones(renderHudStyled("sessions", SUMMARY, NOW, { consumers: CONSUMERS, cursor: 0, confirm: "compact" }));
	assert.equal(sessions[7], '  <error>‼ x again: compact it, one large request summarizes "login refactor" · any other key cancels</error>');
	const fresh = renderHud("suggestions", SUMMARY, NOW, undefined, 100, { suggestions: [LARGE, SWITCH], cursor: 0, confirm: "fresh" });
	const title = fresh.findIndex(line => line.startsWith("▸ "));
	assert.equal(fresh[title + 3], '    ‼ f again: new session from a summary of "01a155f0", the original stays · any other key cancels');
	assert.equal(renderHud("sessions", SUMMARY, NOW, { consumers: CONSUMERS, cursor: 0 }).filter(line => line.includes("‼")).length, 0);
});
