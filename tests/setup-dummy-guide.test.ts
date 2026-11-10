import { test } from "node:test";
import assert from "node:assert/strict";
import { setLang } from "../src/i18n/index.ts";
import { cellWidth } from "../src/tui-box.ts";
import {
	dummyGuideInput,
	initDummyGuide,
	initModePrompt,
	modePromptInput,
	renderDummyGuide,
	renderModePrompt,
	type DummyGuideState,
} from "../src/setup-dummy-guide.ts";

setLang("en");

const key = (data: string) => ({ type: "key" as const, data });
const text = (lines: string[]) => lines.join("\n");
const slideText = (slide: number, providers?: readonly string[]) => {
	const state: DummyGuideState = { ...initDummyGuide(providers), slide };
	return text(renderDummyGuide(state, 80, "none"));
};

// ── S1b: mode selector ──────────────────────────────────────────────

test("initModePrompt defaults to guided and honors a given default", () => {
	const s = initModePrompt();
	assert.deepEqual(s, { selected: "guided", done: false, cancelled: false });
	assert.equal(initModePrompt("advanced").selected, "advanced");
});

test("modePromptInput selects with 1/g and 2/a", () => {
	let s = initModePrompt();
	s = modePromptInput(s, key("2"));
	assert.equal(s.selected, "advanced");
	s = modePromptInput(s, key("g"));
	assert.equal(s.selected, "guided");
	s = modePromptInput(s, key("a"));
	assert.equal(s.selected, "advanced");
	s = modePromptInput(s, key("1"));
	assert.equal(s.selected, "guided");
	assert.equal(s.done, false);
});

test("modePromptInput toggles with arrows, Tab, j and k", () => {
	for (const k of ["\x1b[B", "\x1b[A", "\t", "j", "k"]) {
		const a = modePromptInput(initModePrompt("guided"), key(k));
		assert.equal(a.selected, "advanced", k);
		assert.equal(modePromptInput(a, key(k)).selected, "guided", k);
	}
});

test("modePromptInput confirms with Enter or Space and cancels with Esc or q", () => {
	for (const k of ["\r", " "]) {
		const s = modePromptInput(modePromptInput(initModePrompt(), key("2")), key(k));
		assert.equal(s.done, true);
		assert.equal(s.cancelled, false);
		assert.equal(s.selected, "advanced");
	}
	for (const k of ["\x1b", "q"]) {
		const s = modePromptInput(initModePrompt(), key(k));
		assert.equal(s.cancelled, true);
		assert.equal(s.done, false);
	}
});

test("modePromptInput ignores input once finished and unknown keys", () => {
	const done = modePromptInput(initModePrompt(), key("\r"));
	assert.equal(modePromptInput(done, key("2")), done);
	const s = initModePrompt();
	assert.deepEqual(modePromptInput(s, key("z")), s);
});

test("renderModePrompt shows both options, marks the selection and fits the width", () => {
	const guided = text(renderModePrompt(initModePrompt("guided"), 60, "none"));
	assert.match(guided, /Guided/);
	assert.match(guided, /Advanced/);
	assert.match(guided, /▸ .*\[ 1 \]/);
	const adv = renderModePrompt(initModePrompt("advanced"), 60, "none");
	assert.match(text(adv), /▸ .*\[ 2 \]/);
	assert.ok(adv.every(l => cellWidth(l) <= 60));
});

test("renderModePrompt is translated to Spanish", () => {
	setLang("es");
	try {
		assert.match(text(renderModePrompt(initModePrompt(), 60, "none")), /Dummys/);
	} finally {
		setLang("en");
	}
});

// ── Navigation ──────────────────────────────────────────────────────

test("initDummyGuide starts at slide 0 and keeps detected providers", () => {
	const s = initDummyGuide(["antigravity", "claude"]);
	assert.equal(s.slide, 0);
	assert.equal(s.done, false);
	assert.equal(s.skipped, false);
	assert.equal(s.cancelled, false);
	assert.deepEqual(s.providers, ["antigravity", "claude"]);
	assert.deepEqual(initDummyGuide().providers, []);
});

test("advance keys move forward one slide", () => {
	for (const k of [" ", "\r", "\x1b[C", "l"]) {
		const s = dummyGuideInput(initDummyGuide(), key(k));
		assert.equal(s.slide, 1, JSON.stringify(k));
		assert.equal(s.done, false);
	}
});

test("back keys move back one slide and clamp at 0", () => {
	for (const k of ["\x1b[D", "h", "\x7f"]) {
		const s = dummyGuideInput({ ...initDummyGuide(), slide: 4 }, key(k));
		assert.equal(s.slide, 3, JSON.stringify(k));
		assert.equal(dummyGuideInput(initDummyGuide(), key(k)).slide, 0);
	}
});

test("advancing on the last slide (8) marks done without skipped", () => {
	const s = dummyGuideInput({ ...initDummyGuide(), slide: 8 }, key(" "));
	assert.equal(s.done, true);
	assert.equal(s.skipped, false);
	assert.equal(s.slide, 8);
});

test("walking 9 advances finishes the guide", () => {
	let s = initDummyGuide();
	for (let i = 0; i < 8; i++) {
		s = dummyGuideInput(s, key("\r"));
		assert.equal(s.done, false);
	}
	assert.equal(s.slide, 8);
	s = dummyGuideInput(s, key("\r"));
	assert.equal(s.done, true);
});

test("s skips the rest and Esc or q cancel", () => {
	const skipped = dummyGuideInput({ ...initDummyGuide(), slide: 2 }, key("s"));
	assert.equal(skipped.done, true);
	assert.equal(skipped.skipped, true);
	assert.equal(skipped.cancelled, false);
	for (const k of ["\x1b", "q"]) {
		const c = dummyGuideInput(initDummyGuide(), key(k));
		assert.equal(c.cancelled, true);
		assert.equal(c.done, false);
	}
});

test("finished or cancelled guides ignore further input; unknown keys do nothing", () => {
	const done = dummyGuideInput({ ...initDummyGuide(), slide: 8 }, key(" "));
	assert.equal(dummyGuideInput(done, key("h")), done);
	const cancelled = dummyGuideInput(initDummyGuide(), key("q"));
	assert.equal(dummyGuideInput(cancelled, key(" ")), cancelled);
	const s = initDummyGuide();
	assert.deepEqual(dummyGuideInput(s, key("z")), s);
});

// ── S2: Acto 1 ──────────────────────────────────────────────────────

test("slide 0 shows the agent request", () => {
	const t0 = slideText(0);
	assert.match(t0, /1\/6/);
	assert.match(t0, /Write this code/);
});

test("slide 0 request is translated to Spanish", () => {
	setLang("es");
	try {
		assert.match(slideText(0), /Escribí este código/);
	} finally {
		setLang("en");
	}
});

test("slide 1 connects directly to a single subscription", () => {
	const t1 = slideText(1);
	assert.match(t1, /2\/6/);
	assert.match(t1, /Agent/);
	assert.match(t1, /Google AI Pro/);
	assert.doesNotMatch(t1, /pool\/claude-sonnet-5-5/);
});

test("slide 2 shows 429 in red and the session stopping", () => {
	const lines = renderDummyGuide({ ...initDummyGuide(), slide: 2 }, 80, "truecolor");
	const joined = text(lines);
	assert.match(joined, /3\/6/);
	assert.match(joined, /\x1b\[38;2;228;59;68m[^\n]*429/);
	assert.match(text(renderDummyGuide({ ...initDummyGuide(), slide: 2 }, 80, "none")), /429/);
});

test("slide 3 introduces the pool with the balance sprite", () => {
	const t3 = slideText(3);
	assert.match(t3, /4\/6/);
	assert.match(t3, /pool\/claude-sonnet-5-5/);
	assert.match(t3, /Google AI Pro/);
	assert.match(t3, /Claude Pro/);
});

test("slide 3 sprite follows the frame when animated and rests when not", () => {
	const at = (frame: number, animate: boolean) =>
		text(renderDummyGuide({ ...initDummyGuide(), slide: 3 }, 80, "truecolor", frame, animate));
	assert.equal(at(0, false), at(9, false));
	assert.notEqual(at(0, true), at(3, true));
});

test("slide 4 routes the request to Google AI Pro, the one with the most quota", () => {
	const t4 = slideText(4);
	assert.match(t4, /5\/6/);
	assert.match(t4, /pool\/claude-sonnet-5-5/);
	assert.match(t4, /Google AI Pro/);
	assert.match(t4, /quota/i);
});

test("slide 5 fails over from Google AI Pro 429 to Claude Pro in green", () => {
	const plain = slideText(5);
	assert.match(plain, /6\/6/);
	assert.match(plain, /429/);
	assert.match(plain, /Claude Pro/);
	assert.match(plain, /▶/);
	const color = text(renderDummyGuide({ ...initDummyGuide(), slide: 5 }, 80, "truecolor"));
	assert.match(color, /\x1b\[38;2;56;183;100m[^\n]*Claude Pro/);
	assert.match(color, /\x1b\[38;2;228;59;68m[^\n]*429/);
});

test("slide 5 arrows march when animated", () => {
	const at = (frame: number) => text(renderDummyGuide({ ...initDummyGuide(), slide: 5 }, 80, "none", frame, true));
	assert.notEqual(at(0), at(1));
});

// ── S3: Acto 2 ──────────────────────────────────────────────────────

test("slide 6 shows providers, integrations.json and the detected providers", () => {
	const t6 = slideText(6, ["antigravity", "claude"]);
	assert.match(t6, /Act 2/);
	assert.match(t6, /1\/3/);
	assert.match(t6, /integrations\.json/);
	assert.match(t6, /antigravity/);
	assert.match(t6, /claude/);
});

test("slide 6 says so when no provider was detected", () => {
	assert.match(slideText(6), /No providers detected/);
});

test("slide 7 explains pools and pools.json", () => {
	const t7 = slideText(7);
	assert.match(t7, /2\/3/);
	assert.match(t7, /pools\.json/);
	assert.match(t7, /tank/i);
});

test("slide 8 explains profiles.json, heavy roles to Claude and explore to Flash", () => {
	const t8 = slideText(8);
	assert.match(t8, /3\/3/);
	assert.match(t8, /~\/\.gentle-shell\/config\/gentle-ai\/profiles\.json/);
	assert.match(t8, /explore/);
	assert.match(t8, /antigravity\/gemini-3-8-flash/);
	assert.match(t8, /Claude/);
});

test("Spanish slides 6..8 use the pipe/tank/tap metaphor", () => {
	setLang("es");
	try {
		assert.match(slideText(6), /caños/i);
		assert.match(slideText(7), /tanques/i);
		assert.match(slideText(8), /canillas/i);
	} finally {
		setLang("en");
	}
});

// ── Layout ──────────────────────────────────────────────────────────

test("every slide fits the width and shows a keys footer", () => {
	for (const width of [40, 60, 100]) {
		for (let slide = 0; slide <= 8; slide++) {
			const lines = renderDummyGuide({ ...initDummyGuide(["antigravity"]), slide }, width, "none");
			assert.ok(lines.length > 0);
			for (const l of lines) assert.ok(cellWidth(l) <= Math.max(40, width), `slide ${slide} width ${width}: ${l}`);
			assert.match(text(lines), /Esc/);
		}
	}
});
