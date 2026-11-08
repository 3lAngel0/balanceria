// Pixel-art pieces for the terminal panels: a palette, half-block sprites, segmented bars, chips and
// small animations. Pure: nothing reads the clock or the terminal, every animated piece takes a `frame`
// and every colored piece takes a color `mode`, so the output is testable and degrades cleanly.
//
// truecolor -> raw RGB (the same palette as the web panel), ansi -> the theme's own colors through the
// tone marks of style.ts, none -> shapes only. Fallbacks use only colors Pi's theme has.

import { tone, type Tone } from "./style.ts";

export type Rgb = readonly [number, number, number];

/** The panel's palette (same family as packages/panel/ui/style.css). */
export const PALETTE = {
	hp: [56, 183, 100],
	mp: [59, 93, 201],
	xp: [163, 99, 217],
	gold: [254, 174, 52],
	bad: [228, 59, 68],
	sky: [65, 166, 246],
	steel: [148, 176, 194],
	snow: [244, 244, 244],
	slate: [58, 68, 102],
	ink: [14, 11, 22],
} as const satisfies Record<string, Rgb>;

export type PixelColor = keyof typeof PALETTE;

/** Theme colors used when RGB is not available. Only names Pi's theme is known to have. */
export const FALLBACK_TONE: Readonly<Record<PixelColor, Tone>> = {
	hp: "success",
	mp: "accent",
	xp: "accent",
	gold: "warning",
	bad: "error",
	sky: "accent",
	steel: "muted",
	snow: "accent",
	slate: "dim",
	ink: "dim",
};

export type ColorMode = "truecolor" | "ansi" | "none";
export type Env = Readonly<Record<string, string | undefined>>;

/** NO_COLOR (non-empty) and a dumb terminal turn color off; COLORTERM opts into truecolor. */
export function colorMode(env: Env = process.env): ColorMode {
	if ((env.NO_COLOR ?? "") !== "" || env.TERM === "dumb") return "none";
	const colorterm = (env.COLORTERM ?? "").toLowerCase();
	return colorterm === "truecolor" || colorterm === "24bit" ? "truecolor" : "ansi";
}

/** Animation is on unless the user asks to reduce motion or the terminal is dumb. */
export function motionEnabled(env: Env = process.env): boolean {
	if (env.TERM === "dumb") return false;
	return !["1", "true", "yes"].includes((env.AI_BALANCER_REDUCE_MOTION ?? "").toLowerCase());
}

const fgRgb = (color: PixelColor) => `38;2;${PALETTE[color].join(";")}`;
const bgRgb = (color: PixelColor) => `48;2;${PALETTE[color].join(";")}`;

/** Text in a palette color: RGB, a theme tone, or plain. */
export function pixelText(color: PixelColor, text: string, mode: ColorMode): string {
	if (mode === "truecolor") return `\x1b[${fgRgb(color)}m${text}\x1b[39m`;
	return mode === "ansi" ? tone(FALLBACK_TONE[color], text) : text;
}

/** A label on a colored background (` READ `); `[READ]` in the theme or plain modes. Always label + 2 cells. */
export function chip(label: string, color: PixelColor, mode: ColorMode): string {
	if (mode === "truecolor") return `\x1b[${bgRgb(color)};${fgRgb("ink")}m ${label} \x1b[39;49m`;
	return mode === "ansi" ? tone(FALLBACK_TONE[color], `[${label}]`) : `[${label}]`;
}

export interface Sprite {
	/** One string per pixel row; a space or `.` is transparent, any other letter is a key of `colors`. */
	rows: readonly string[];
	colors: Readonly<Record<string, PixelColor>>;
	/** Shown instead when truecolor is not available. */
	fallback: readonly string[];
}

const pixelAt = (sprite: Sprite, row: number, col: number): PixelColor | undefined => {
	const key = sprite.rows[row]?.[col];
	return key === undefined || key === "." || key === " " ? undefined : sprite.colors[key];
};

/** Two pixel rows per terminal row using half blocks (▀ ▄), so a sprite is as wide as its pixels and half as tall. */
export function renderSprite(sprite: Sprite, mode: ColorMode): string[] {
	if (mode !== "truecolor") return [...sprite.fallback];
	const width = Math.max(0, ...sprite.rows.map(row => row.length));
	const lines: string[] = [];
	for (let row = 0; row < sprite.rows.length; row += 2) {
		let line = "";
		for (let col = 0; col < width; col++) {
			const top = pixelAt(sprite, row, col);
			const bottom = pixelAt(sprite, row + 1, col);
			if (top && bottom) line += `\x1b[${fgRgb(top)};${bgRgb(bottom)}m▀\x1b[39;49m`;
			else if (top) line += `\x1b[${fgRgb(top)}m▀\x1b[39m`;
			else if (bottom) line += `\x1b[${fgRgb(bottom)}m▄\x1b[39m`;
			else line += " ";
		}
		lines.push(line);
	}
	return lines;
}

const SCALE_COLORS = { g: "gold", s: "steel", k: "slate" } as const satisfies Record<string, PixelColor>;
const SCALE_FALLBACK = ["  ⚖  "];
const SCALE_LEVEL = [
	".....gg.....",
	".....gg.....",
	".gggggggggg.",
	".s...gg...s.",
	".s...gg...s.",
	"ssss.gg.ssss",
	".ss..gg..ss.",
	"....gggg....",
] as const;
const SCALE_LEFT = [
	".....gg.....",
	".....ggggggg",
	"..gggggg..s.",
	".gg..gg...s.",
	".s...gg.ssss",
	".s...gg..ss.",
	"ssss.gg.....",
	".ss.gggg....",
] as const;
const mirror = (rows: readonly string[]) => rows.map(row => [...row].reverse().join(""));
const SCALE_FRAMES = [SCALE_LEVEL, SCALE_LEFT, SCALE_LEVEL, mirror(SCALE_LEFT)] as const;

/** The balance mascot: it rocks every few frames, or stays level when motion is off. */
export function scaleSprite(frame: number, animate: boolean): Sprite {
	const step = animate ? Math.floor(Math.max(0, frame) / 3) % SCALE_FRAMES.length : 0;
	return { rows: SCALE_FRAMES[step]!, colors: SCALE_COLORS, fallback: SCALE_FALLBACK };
}

/** Quota left: green from half, gold from a fifth, red below, slate when nothing is left. */
export function remainingColor(remaining: number): PixelColor {
	if (remaining <= 0) return "slate";
	if (remaining < 0.2) return "bad";
	return remaining < 0.5 ? "gold" : "hp";
}

export interface BarOptions {
	mode: ColorMode;
	/** The animation frame; only used with `animate`. */
	frame?: number;
	animate?: boolean;
	/** 0..1 fill-in progress for a bar that is drawing itself; omitted means fully drawn. */
	progress?: number;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
const SHINE_GAP = 6;

/** A segmented quota bar of exactly `width` cells (▰ filled, ▱ empty), colored by what is left. */
export function pixelBar(remaining: number, width: number, options: BarOptions): string {
	const { mode } = options;
	const fraction = clamp01(remaining);
	const progress = clamp01(options.progress ?? 1);
	const total = Math.max(0, Math.floor(width));
	const done = progress >= 1;
	let filled = done ? Math.round(fraction * total) : Math.floor(fraction * progress * total);
	if (done && fraction > 0) filled = Math.max(1, filled);
	const shine = options.animate && options.frame !== undefined && filled > 0 ? Math.max(0, options.frame) % (filled + SHINE_GAP) : -1;
	const color = remainingColor(fraction);
	const parts: string[] = [];
	if (shine >= 0 && shine < filled) {
		parts.push(pixelText(color, "▰".repeat(shine), mode), pixelText("snow", "▰", mode), pixelText(color, "▰".repeat(filled - shine - 1), mode));
	} else if (filled > 0) {
		parts.push(pixelText(color, "▰".repeat(filled), mode));
	}
	if (total - filled > 0) parts.push(pixelText("slate", "▱".repeat(total - filled), mode));
	return parts.join("");
}

/** Ease-out progress (fast start, soft landing) of a fill that began `elapsedMs` ago. */
export function fillProgress(elapsedMs: number, durationMs: number): number {
	const t = clamp01(durationMs <= 0 ? 1 : elapsedMs / durationMs);
	return 1 - (1 - t) ** 3;
}

/** One animation tick of the panels. */
export const FRAME_MS = 200;

export const frameOf = (now: number, frameMs: number = FRAME_MS): number => Math.floor(now / frameMs);

const SPINNER = ["▖", "▘", "▝", "▗"] as const;

export const pixelSpinner = (frame: number): string => SPINNER[((Math.floor(frame) % SPINNER.length) + SPINNER.length) % SPINNER.length]!;

/** `▶▷▷`: the lit arrow marches along the route; with motion off it rests on the last one. */
export function marchingArrows(frame: number, count: number, mode: ColorMode, animate: boolean): string {
	const lit = animate ? Math.max(0, Math.floor(frame)) % count : count - 1;
	return Array.from({ length: count }, (_unused, i) => (i === lit ? pixelText("gold", "▶", mode) : pixelText("slate", "▷", mode))).join("");
}
