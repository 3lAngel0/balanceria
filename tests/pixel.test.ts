import { test } from "node:test";
import assert from "node:assert/strict";
import { plain } from "../src/style.ts";
import { cellWidth } from "../src/tui-box.ts";
import {
	FALLBACK_TONE,
	FRAME_MS,
	PALETTE,
	chip,
	colorMode,
	fillProgress,
	frameOf,
	marchingArrows,
	motionEnabled,
	pixelBar,
	pixelSpinner,
	pixelText,
	remainingColor,
	renderSprite,
	scaleSprite,
	type Sprite,
} from "../src/pixel.ts";

// Pi's theme.fg throws on names outside its palette (the Esc crash), so every fallback must be one of these.
const THEME_TONES = new Set(["accent", "success", "warning", "error", "muted", "dim"]);
const RGB = /\x1b\[(?:38|48);2;\d+;\d+;\d+/;

test("colorMode: NO_COLOR wins, COLORTERM enables truecolor, anything else keeps the theme colors", () => {
	assert.equal(colorMode({ NO_COLOR: "1", COLORTERM: "truecolor" }), "none");
	assert.equal(colorMode({ COLORTERM: "truecolor" }), "truecolor");
	assert.equal(colorMode({ COLORTERM: "24bit" }), "truecolor");
	assert.equal(colorMode({ NO_COLOR: "", COLORTERM: "truecolor" }), "truecolor", "an empty NO_COLOR is ignored");
	assert.equal(colorMode({ TERM: "xterm-256color" }), "ansi");
	assert.equal(colorMode({ COLORTERM: "truecolor", TERM: "dumb" }), "none");
	assert.equal(colorMode({}), "ansi");
});

test("motionEnabled: on by default, off when the user asks to reduce motion", () => {
	assert.equal(motionEnabled({}), true);
	for (const value of ["1", "true", "yes", "TRUE"]) assert.equal(motionEnabled({ AI_BALANCER_REDUCE_MOTION: value }), false, value);
	for (const value of ["0", "false", ""]) assert.equal(motionEnabled({ AI_BALANCER_REDUCE_MOTION: value }), true, value);
	assert.equal(motionEnabled({ TERM: "dumb" }), false);
});

test("every theme fallback is a color Pi's theme really has", () => {
	for (const color of Object.keys(PALETTE)) assert.ok(THEME_TONES.has(FALLBACK_TONE[color as keyof typeof PALETTE]), color);
});

test("pixelText paints RGB in truecolor, a theme tone in ansi and nothing without color", () => {
	assert.match(pixelText("hp", "ok", "truecolor"), RGB);
	assert.equal(plain(pixelText("hp", "ok", "truecolor")), "ok", "plain() strips the escapes too");
	assert.equal(cellWidth(pixelText("hp", "ok", "truecolor")), 2);
	const ansi = pixelText("hp", "ok", "ansi");
	assert.ok(!RGB.test(ansi) && ansi !== "ok", "a tone mark, no raw RGB");
	assert.equal(plain(ansi), "ok");
	assert.equal(pixelText("hp", "ok", "none"), "ok");
});

test("chip is label plus two cells in every mode, with a background only in truecolor", () => {
	for (const mode of ["truecolor", "ansi", "none"] as const) assert.equal(cellWidth(chip("READ", "sky", mode)), 6, mode);
	assert.match(chip("READ", "sky", "truecolor"), /\x1b\[48;2;/);
	assert.equal(plain(chip("READ", "sky", "none")), "[READ]");
	assert.equal(plain(chip("READ", "sky", "ansi")), "[READ]");
});

const TINY: Sprite = {
	rows: ["ab.", "a.b", ".bb"],
	colors: { a: "hp", b: "bad" },
	fallback: ["T"],
};

test("renderSprite packs two pixel rows into one half-block row and pads an odd height", () => {
	const lines = renderSprite(TINY, "truecolor");
	assert.equal(lines.length, 2, "3 rows -> 2 terminal rows");
	for (const line of lines) assert.equal(cellWidth(line), 3);
	assert.equal(plain(lines[0]!), "▀▀▄", "top+bottom -> ▀ with a background, top only -> ▀, bottom only -> ▄");
	assert.equal(plain(lines[1]!), " ▀▀", "an odd last row pairs with a transparent one");
	assert.match(lines[0]!, /\x1b\[38;2;\d+;\d+;\d+;48;2;/, "a pixel above another uses a foreground and a background");
});

test("renderSprite falls back to its plain lines without truecolor", () => {
	assert.deepEqual(renderSprite(TINY, "ansi"), ["T"]);
	assert.deepEqual(renderSprite(TINY, "none"), ["T"]);
});

test("the scale sprite keeps its size across frames, rocks only when motion is on, and mirrors", () => {
	const sizes = new Set<string>();
	const seen = new Set<string>();
	for (let frame = 0; frame < 16; frame++) {
		const lines = renderSprite(scaleSprite(frame, true), "truecolor");
		sizes.add(`${lines.length}x${cellWidth(lines[0]!)}`);
		seen.add(lines.map(plain).join("|"));
	}
	assert.deepEqual([...sizes], ["4x12"]);
	assert.equal(seen.size, 3, "level, left-down and right-down");
	const still = new Set(Array.from({ length: 16 }, (_unused, frame) => renderSprite(scaleSprite(frame, false), "truecolor").map(plain).join("|")));
	assert.equal(still.size, 1, "reduced motion shows one still frame");
	const [level, left, , right] = [0, 3, 6, 9].map(frame => renderSprite(scaleSprite(frame, true), "truecolor").map(plain));
	assert.notDeepEqual(left, level);
	assert.deepEqual(right!.map(row => [...row].reverse().join("")), left, "the right tilt is the mirror of the left one");
});

test("remainingColor goes green, gold, red and slate when spent", () => {
	assert.deepEqual([1, 0.5, 0.49, 0.2, 0.19, 0.01, 0].map(remainingColor), ["hp", "hp", "gold", "gold", "bad", "bad", "slate"]);
});

test("pixelBar is exactly as wide as asked and its shapes alone tell filled from empty", () => {
	for (const mode of ["truecolor", "ansi", "none"] as const) {
		for (const fraction of [0, 0.01, 0.5, 1]) {
			const bar = pixelBar(fraction, 10, { mode });
			assert.equal(cellWidth(bar), 10, `${mode} ${fraction}`);
			const shapes = plain(bar);
			assert.equal(shapes.length, 10);
			assert.ok(/^▰*▱*$/.test(shapes), shapes);
		}
	}
	assert.equal(plain(pixelBar(0.5, 10, { mode: "none" })), "▰▰▰▰▰▱▱▱▱▱");
	assert.equal(plain(pixelBar(0, 10, { mode: "none" })), "▱▱▱▱▱▱▱▱▱▱");
	assert.equal(plain(pixelBar(0.01, 10, { mode: "none" })), "▰▱▱▱▱▱▱▱▱▱", "a little quota still shows one segment");
	assert.equal(plain(pixelBar(7, 4, { mode: "none" })), "▰▰▰▰", "out-of-range fractions are clamped");
	assert.equal(plain(pixelBar(-1, 4, { mode: "none" })), "▱▱▱▱");
});

test("pixelBar fills in with progress, and the shine never changes the shapes", () => {
	assert.equal(plain(pixelBar(1, 10, { mode: "none", progress: 0 })), "▱".repeat(10));
	assert.equal(plain(pixelBar(1, 10, { mode: "none", progress: 0.5 })), "▰▰▰▰▰▱▱▱▱▱");
	for (let frame = 0; frame < 24; frame++) {
		const shiny = pixelBar(0.7, 10, { mode: "truecolor", frame, animate: true });
		assert.equal(plain(shiny), plain(pixelBar(0.7, 10, { mode: "truecolor" })), `frame ${frame}`);
		assert.equal(cellWidth(shiny), 10);
	}
	const colors = new Set(Array.from({ length: 24 }, (_unused, frame) => pixelBar(0.7, 10, { mode: "truecolor", frame, animate: true })));
	assert.ok(colors.size > 1, "the shine moves across the filled segments");
	assert.equal(new Set(Array.from({ length: 24 }, (_unused, frame) => pixelBar(0.7, 10, { mode: "truecolor", frame, animate: false }))).size, 1);
});

test("fillProgress eases from 0 to 1 and stays there", () => {
	assert.equal(fillProgress(0, 600), 0);
	assert.equal(fillProgress(600, 600), 1);
	assert.equal(fillProgress(5_000, 600), 1);
	assert.equal(fillProgress(-50, 600), 0);
	const steps = [0, 100, 200, 300, 400, 500, 600].map(ms => fillProgress(ms, 600));
	for (let i = 1; i < steps.length; i++) assert.ok(steps[i]! >= steps[i - 1]!, "monotonic");
	assert.ok(fillProgress(300, 600) > 0.5, "ease-out: more than half done at half the time");
});

test("frameOf follows the clock and the spinner and arrows cycle", () => {
	assert.equal(frameOf(0), 0);
	assert.equal(frameOf(FRAME_MS * 3 + 1), 3);
	assert.deepEqual([0, 1, 2, 3, 4].map(pixelSpinner), ["▖", "▘", "▝", "▗", "▖"]);
	assert.equal(plain(marchingArrows(0, 3, "none", true)), "▶▷▷");
	assert.equal(plain(marchingArrows(1, 3, "none", true)), "▷▶▷");
	assert.equal(plain(marchingArrows(5, 3, "none", true)), "▷▷▶");
	assert.equal(plain(marchingArrows(0, 3, "none", false)), "▷▷▶", "reduced motion keeps the arrow on the active end");
	assert.equal(cellWidth(marchingArrows(2, 3, "truecolor", true)), 3);
});
