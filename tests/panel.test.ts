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

