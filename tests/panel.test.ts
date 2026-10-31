import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPanel, renderControlCenter, formatTokens, statusLine, contextNotice, statusWithContext } from "../src/panel.ts";
import { foldEvents, type BalancerEvent } from "../src/events.ts";

const NOW = Date.parse("2026-10-16T12:00:00Z");
const HOUR = 3_600_000;

const EVENTS: BalancerEvent[] = [
	{
		type: "agy-usage",
		ts: NOW - 60_000,
		groups: {
			"Claude and GPT models": { remainingFraction: 0, resetAt: Date.parse("2026-10-23T05:37:32Z") },
			"Gemini Models": { remainingFraction: 0.4, resetAt: NOW + 2 * HOUR },
			"Gemini 4 Argon": { remainingFraction: 1, resetAt: undefined },
		},
	},
	{ type: "usage", ts: NOW - 60_000, provider: "claude-bridge", model: "claude-opus-5-5", input: 1000, output: 234, cacheRead: 0, cacheWrite: 0 },
	{ type: "route", ts: NOW - 30_000, pool: "claude-opus-5-5", provider: "claude-bridge", reason: "user" },
];

test("formatTokens abbreviates thousands and millions", () => {
	assert.equal(formatTokens(0), "0");
	assert.equal(formatTokens(950), "950");
	assert.equal(formatTokens(1234), "1.2k");
	assert.equal(formatTokens(2_500_000), "2.5M");
});

test("renderPanel shows routing, each subscription window and token totals", () => {
	const lines = renderPanel(foldEvents(EVENTS, NOW), NOW, 40);
	const text = lines.join("\n");
	assert.match(text, /opus .*→ claude-bridge/);
	assert.match(text, /agy claude .* 0%/);
	assert.match(text, /spent until \d{2}-\d{2} \d{2}:\d{2}/);
	assert.match(text, /agy gemini .* 40%/);
	assert.match(text, /agy argon .*100%/);
	assert.match(text, /claude-bridge .*1\.2k/);
});

test("renderPanel keeps every line within the requested width", () => {
	for (const width of [24, 32, 40]) {
		for (const line of renderPanel(foldEvents(EVENTS, NOW), NOW, width)) {
			assert.ok(line.length <= width, `line wider than ${width}: ${JSON.stringify(line)}`);
		}
	}
});

test("renderPanel says when no data has been collected yet", () => {
	assert.match(renderPanel(foldEvents([], NOW), NOW, 40).join("\n"), /no usage yet/);
});

test("statusLine names the active route and spent windows", () => {
	assert.equal(statusLine(foldEvents(EVENTS, NOW), NOW), "⚖ opus→claude-bridge · spent: agy claude");
	assert.equal(statusLine(foldEvents([], NOW), NOW), "⚖ ai-balancer idle");
});

test("contextNotice stays quiet below 120k and warns from 120k, alerting from 200k", () => {
	assert.equal(contextNotice(null), undefined);
	assert.equal(contextNotice(119_999), undefined);
	assert.deepEqual(contextNotice(120_000), { level: "warn", text: "ctx 120.0k ⚠ /compact" });
	assert.deepEqual(contextNotice(199_999), { level: "warn", text: "ctx 200.0k ⚠ /compact" });
	assert.deepEqual(contextNotice(200_000), { level: "alert", text: "ctx 200.0k ‼ /compact" });
	assert.deepEqual(contextNotice(839_241), { level: "alert", text: "ctx 839.2k ‼ /compact" });
});

test("statusWithContext appends the painted notice and leaves the status alone otherwise", () => {
	const base = statusLine(foldEvents(EVENTS, NOW), NOW);
	const paint = (level: string, text: string) => `<${level}>${text}</${level}>`;
	assert.equal(statusWithContext(base, 50_000, paint), "⚖ opus→claude-bridge · spent: agy claude");
	assert.equal(statusWithContext(base, undefined, paint), "⚖ opus→claude-bridge · spent: agy claude");
	assert.equal(statusWithContext(base, 152_300, paint), "⚖ opus→claude-bridge · spent: agy claude · <warn>ctx 152.3k ⚠ /compact</warn>");
	assert.equal(statusWithContext(base, 250_000, paint), "⚖ opus→claude-bridge · spent: agy claude · <alert>ctx 250.0k ‼ /compact</alert>");
});

test("renderControlCenter renders inline model picker in roles tab and candidate editor in pools tab", () => {
	const pools = [
		{ id: "claude-opus-5-5", name: "Opus 5.5", candidates: ["antigravity/claude-opus-5-5", "claude-bridge/claude-opus-5-5"], strategy: "hybrid" as const },
	];
	const providers = [
		{ id: "antigravity", label: "Google AI Pro (agy)", kind: "subscription" as const, detected: true, source: "cli", availableModels: ["claude-opus-5-5", "gemini-3-8-flash"] },
		{ id: "claude-bridge", label: "Claude Pro", kind: "subscription" as const, detected: true, source: "pkg", availableModels: ["claude-opus-5-5"] },
	];

	const rolesLines = renderControlCenter({
		tab: "roles",
		width: 100,
		folded: foldEvents(EVENTS, NOW),
		now: NOW,
		activeProfile: "default",
		pools,
		providers,
		cursor: 1,
		rolePickerOpen: true,
		rolePickerTargets: ["pool/claude-opus-5-5", "antigravity/gemini-3-8-flash"],
		rolePickerCursor: 1,
	});
	assert.match(rolesLines.join("\n"), /Select target for gentle-ai-explore/i);
	assert.match(rolesLines.join("\n"), /antigravity\/gemini-3-8-flash/);

	const poolsLines = renderControlCenter({
		tab: "pools",
		width: 100,
		folded: foldEvents(EVENTS, NOW),
		now: NOW,
		activeProfile: "default",
		pools,
		providers,
		poolCursor: 0,
		poolEditOpen: true,
		poolCandidateOptions: ["antigravity/claude-opus-5-5", "claude-bridge/claude-opus-5-5", "antigravity/gemini-3-8-flash"],
		poolCandidateCursor: 2,
	});
	assert.match(poolsLines.join("\n"), /Editing candidates for pool\/claude-opus-5-5/i);
	assert.match(poolsLines.join("\n"), /\[✓\] #1 antigravity\/claude-opus-5-5/);
	assert.match(poolsLines.join("\n"), /\[ \]    antigravity\/gemini-3-8-flash/);
});


import { plain } from "../src/style.ts";

test("renderControlCenter draws boxed tables and its row indexes point at the selected boxed row", () => {
	const folded = foldEvents(EVENTS, NOW);
	const pools = [
		{ id: "sonnet", name: "Sonnet", candidates: ["antigravity/s", "claude-bridge/s"], strategy: "hybrid" as const },
		{ id: "opus", name: "Opus", candidates: ["claude-bridge/o"], strategy: "waterfall" as const },
	];
	const overview = renderControlCenter({ tab: "overview", width: 90, folded, now: NOW, activeProfile: "p", pools, providers: [] }).map(plain);
	assert.ok(overview.some(line => /^╭─ Profile & last route ─+╮$/.test(line)));
	assert.ok(overview.some(line => /Pool\s+Strategy\s+Active\s+Candidates in order/.test(line)));
	assert.ok(overview.some(line => /Role\s+Type\s+Model\s+Thinking/.test(line)));
	for (const line of overview.slice(2)) assert.equal([...line].length, 90, line);

	for (const [tab, cursorKey] of [["roles", "cursor"], ["pools", "poolCursor"]] as const) {
		const rowLines: number[] = [];
		const lines = renderControlCenter({ tab, width: 90, folded, now: NOW, activeProfile: "p", pools, providers: [], [cursorKey]: 1, rowLines }).map(plain);
		assert.ok(rowLines.length >= 2);
		rowLines.forEach((at, index) => assert.match(lines[at]!, index === 1 ? /^│ ▸ / : /^│   /, `${tab} row ${index} -> line ${at}: ${lines[at]}`));
	}
});

import { paint } from "../src/style.ts";

const PX_POOLS = [
	{ id: "sonnet", name: "Sonnet", candidates: ["antigravity/s", "claude-bridge/s"], strategy: "hybrid" as const },
	{ id: "orch", name: "Orch", candidates: ["antigravity/o"], strategy: "waterfall" as const },
];
const PX_PROVIDERS = [
	{ id: "antigravity", label: "Google AI Pro (agy)", kind: "subscription" as const, detected: true, source: "cli", availableModels: ["s", "o"] },
	{ id: "claude-bridge", label: "Claude Pro", kind: "subscription" as const, detected: false, source: "", availableModels: [] },
];
const pixelInput = (extra: Record<string, unknown> = {}) => ({
	tab: "overview" as const,
	width: 90,
	folded: foldEvents(EVENTS, NOW),
	now: NOW,
	activeProfile: "p",
	pools: PX_POOLS,
	providers: PX_PROVIDERS,
	...extra,
});
const screen = (extra: Record<string, unknown> = {}) => renderControlCenter(pixelInput(extra) as Parameters<typeof renderControlCenter>[0]);

test("color modes: truecolor adds RGB and the pixel mascot, ansi stays on theme tones, none has no escapes", () => {
	const none = screen().join("\n");
	assert.ok(!/\x1b/.test(none), "the default is plain");
	assert.match(none, /⚖/, "the mascot falls back to one glyph");
	assert.match(none, /▰|▱/, "bars are shapes, readable without color");
	assert.match(none, /\[READ\/EXPLORE\]/, "a role type is a bracketed label");

	const truecolor = screen({ mode: "truecolor" }).join("\n");
	assert.match(truecolor, /\x1b\[38;2;\d+;\d+;\d+/);
	assert.match(truecolor, /\x1b\[48;2;\d+;\d+;\d+/, "chips have a background");
	assert.match(truecolor, /[▀▄]/, "the mascot is drawn with half blocks");

	const ansi = screen({ mode: "ansi" }).join("\n");
	assert.ok(!/\x1b\[(?:38|48);2;/.test(ansi), "no raw RGB outside truecolor");
	assert.match(ansi, /[\uE010-\uE01F]/, "theme tones are marked for the overlay to paint");
});

test("every box line keeps its exact width in every color mode", () => {
	for (const mode of ["none", "ansi", "truecolor"] as const) {
		for (const tab of ["overview", "roles", "pools", "advisor"] as const) {
			const lines = screen({ mode, tab, animate: true, frame: 7 }).map(plain);
			for (const line of lines.slice(2)) assert.equal([...line].length, 90, `${mode} ${tab}: ${line}`);
		}
	}
});

test("no tone span is left open or nested: painting every line with an identity style leaves no marks behind", () => {
	for (const mode of ["none", "ansi", "truecolor"] as const) {
		for (const tab of ["overview", "roles", "pools", "advisor"] as const) {
			const lines = screen({ mode, tab, cursor: 1, poolCursor: 1 });
			for (const line of lines) assert.ok(!/[\uE000\uE001\uE010-\uE01F]/.test(paint(line, (_name, text) => text)), `${mode} ${tab}: ${JSON.stringify(plain(line))}`);
		}
	}
});

test("selectable rows still point at the selected boxed row in every color mode", () => {
	for (const mode of ["none", "ansi", "truecolor"] as const) {
		for (const [tab, cursorKey] of [["roles", "cursor"], ["pools", "poolCursor"]] as const) {
			const rowLines: number[] = [];
			const lines = screen({ mode, tab, [cursorKey]: 1, rowLines }).map(plain);
			assert.ok(rowLines.length >= 2);
			rowLines.forEach((at, index) => assert.match(lines[at]!, index === 1 ? /^│ ▸ / : /^│   /, `${mode} ${tab} row ${index}: ${lines[at]}`));
		}
	}
});

test("the overview animates with the frame, and stands still when motion is off", () => {
	const frames = (animate: boolean) => new Set([0, 3, 6, 9, 12, 15].map(frame => screen({ mode: "truecolor", animate, frame }).join("\n")));
	assert.ok(frames(true).size > 1, "mascot, arrows and bar shine move");
	assert.equal(frames(false).size, 1, "reduced motion renders one still frame");
	const plainFrames = new Set([0, 1, 2].map(frame => screen({ mode: "none", animate: true, frame }).map(plain).join("\n")));
	assert.ok(plainFrames.size > 1, "the marching arrows move even without color");
});

test("quota bars fill in with progress and show the real fraction once drawn", () => {
	const windowLines = (progress: number) => screen({ mode: "none", progress }).map(plain).filter(line => /agy gemini|agy claude|claude-bridge/.test(line) && /[▰▱]{5}/.test(line));
	assert.ok(windowLines(1).length >= 1);
	assert.ok(windowLines(0).every(line => !line.includes("▰")), "nothing is filled at the start of the animation");
	assert.ok(windowLines(1).some(line => line.includes("▰")), "the bars are filled when it ends");
	assert.ok(windowLines(1).some(line => /agy gemini\s+▰+▱+\s+40%/.test(line)), "the percentage is still printed");
});

test("the tabs drop the long help paragraphs now that the Help box and the footer say it", () => {
	const text = (tab: "roles" | "pools" | "advisor") => screen({ tab }).map(plain).join("\n");
	assert.ok(!/Select an agent role with/.test(text("roles")));
	assert.ok(!/Select a pool with/.test(text("pools")));
	assert.ok(!/Press g to run a lightweight/.test(text("advisor")));
	assert.match(text("roles"), /p/, "the active profile is still named");
});

test("role types, strategies and thinking levels are chips and pips in color, and keep their words", () => {
	const roles = screen({ mode: "truecolor", tab: "roles", roles: { orchestrator: { model: "pool/orch", thinking: "high" } } }).map(plain).join("\n");
	assert.match(roles, /READ\/EXPLORE/);
	assert.match(roles, /▰▰▰ high/, "three pips for high");
	const pools = screen({ mode: "none", tab: "pools" }).map(plain).join("\n");
	assert.match(pools, /\[hybrid\]/);
	assert.match(pools, /\[waterfall\]/);
});
