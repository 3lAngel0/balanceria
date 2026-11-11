// The installer's mascot: a capybara next to the balance, in pixel art (half-block sprite) or, without truecolor, in plain ASCII.
// Pure: every piece takes the animation `frame` and `animate` (false = one still frame, for AI_BALANCER_REDUCE_MOTION and dumb terminals),
// so the output is testable. Every frame of every pose has exactly MASCOT_HEIGHT lines of MASCOT_WIDTH cells.

import { pixelText, type ColorMode, type Rgb } from "./pixel.ts";
import { cellWidth, padRight } from "./tui-box.ts";

export type MascotPose = "idle" | "working" | "happy";

export const MASCOT_WIDTH = 26;
/** Terminal rows of the mascot (two pixel rows each). */
export const MASCOT_HEIGHT = 6;

const COLORS: Readonly<Record<string, Rgb>> = {
	b: [176, 120, 70], // fur (must match test)
	B: [215, 150, 90], // fur highlight
	d: [104, 66, 38], // ears, nose, feet, shadow
	t: [226, 190, 142], // snout and belly
	e: [20, 14, 26], // eyes & dark outline
	g: [254, 174, 52], // the balance
	s: [148, 176, 194], // its strings and pans
	w: [255, 255, 255], // white specular glint
	// Techwear Cyber-Gaucho: Boina & Rose
	k: [32, 34, 46], // boina dark charcoal
	K: [65, 72, 95], // boina highlight
	r: [255, 45, 135], // neon magenta rose
	p: [255, 121, 176], // rose light pink
	c: [0, 245, 160], // cyber green leaf & HUD visor
	// Techwear Tactical Vest
	v: [22, 24, 34], // vest dark
	V: [38, 42, 58], // vest armor plate
	x: [255, 45, 135], // neon magenta seam
};

const CAPY_WIDTH = 16;
const CAPY = [
	"..kkKKrpKKKK....", // 0: Boina with neon rose (r,p) and cyber leaf (c)
	".kkkkkrrcckkkd..", // 1: Boina lower rim & cyber leaf
	".keeeekeeeeddBb.", // 2: Capybara head top & boina band
	"ddddtt..bbbbBBb.", // 3: Snout top & eye (cols 6-7)
	"ddettt..bbbbBBb.", // 4: Nostril/mouth & cheek
	".ddddvvvvvvvBBb.", // 5: Chin & techwear collar
	"..bbvVxxxxVvvBb.", // 6: Techwear jacket with magenta seam (x)
	"..bbvVccccVvvBb.", // 7: Techwear pocket with cyber indicator (c)
	"..bbvvvvvvvvvdb.", // 8: Lower jacket & sitting haunch
	"..dd..dd..dd.dd.", // 9: Front paws & hind claws
] as const;

const INHALED_BOINA = ".kkkKKrpKKKK....";
const EYE = { col: 6, top: 3 } as const;

const BALANCE_X = 17;
const BALANCE_WIDTH = 9;
const BALANCE_HEIGHT = 10;

/** The balance drawn on a grid: `tilt` is -1 (left pan up), 0 (level) or 1 (left pan down). */
function balanceRows(tilt: -1 | 0 | 1): string[] {
	const grid = Array.from({ length: BALANCE_HEIGHT }, () => ".".repeat(BALANCE_WIDTH).split(""));
	const put = (row: number, col: number, key: string) => {
		if (grid[row]?.[col] !== undefined) grid[row]![col] = key;
	};
	for (let row = 0; row < BALANCE_HEIGHT; row++) put(row, 4, "g");
	for (const col of [3, 5]) put(1, col, "g");
	for (const col of [2, 3, 4, 5, 6]) put(BALANCE_HEIGHT - 1, col, "g");
	for (let col = 0; col < BALANCE_WIDTH; col++) put(2 + Math.round((tilt * 2 * (4 - col)) / 4), col, "g");
	const leftY = 2 + tilt * 2;
	const rightY = 2 - tilt * 2;
	for (const [y, cols, string] of [[leftY, [0, 1, 2], 0], [rightY, [6, 7, 8], 8]] as const) {
		put(y + 1, string, "s");
		put(y + 2, string, "s");
		for (const col of cols) put(y + 3, col, "s");
	}
	return grid.map(row => row.join(""));
}

interface Frame {
	/** Capybara rows' vertical offset (negative = it jumps), the eyes and the balance's tilt. */
	lift: number;
	eyes: "open" | "blink" | "happy" | "visor";
	tilt: -1 | 0 | 1;
	inhale: boolean;
}

const TILTS = [0, 1, 0, -1] as const;

function frameOf(pose: MascotPose, frame: number, animate: boolean): Frame {
	const f = Math.max(0, Math.floor(frame));
	if (!animate) return { lift: 0, eyes: pose === "happy" ? "happy" : pose === "working" ? "visor" : "open", tilt: pose === "working" ? 1 : 0, inhale: false };
	if (pose === "working") return { lift: f % 4 < 2 ? 0 : -1, eyes: "visor", tilt: TILTS[Math.floor(f / 2) % TILTS.length]!, inhale: false };
	if (pose === "happy") return { lift: f % 2 === 0 ? -1 : 0, eyes: "happy", tilt: f % 2 === 0 ? 1 : -1, inhale: false };
	return { lift: 0, eyes: f % 12 === 11 ? "blink" : "open", tilt: 0, inhale: f % 8 >= 4 };
}

const GROUND = 1;
const HEIGHT_PX = MASCOT_HEIGHT * 2;

function sprite(state: Frame): string[] {
	const grid = Array.from({ length: HEIGHT_PX }, () => ".".repeat(MASCOT_WIDTH).split(""));
	const put = (row: number, col: number, key: string) => {
		if (key !== "." && grid[row]?.[col] !== undefined) grid[row]![col] = key;
	};
	const capy = CAPY.map(row => row.split(""));

	if (state.eyes === "blink") {
		capy[EYE.top]![EYE.col] = "b";
		capy[EYE.top]![EYE.col + 1] = "b";
		capy[EYE.top + 1]![EYE.col] = "d";
		capy[EYE.top + 1]![EYE.col + 1] = "d";
	} else if (state.eyes === "happy") {
		capy[EYE.top]![EYE.col] = "e";
		capy[EYE.top]![EYE.col + 1] = "e";
		capy[EYE.top + 1]![EYE.col] = "b";
		capy[EYE.top + 1]![EYE.col + 1] = "p"; // blush
	} else if (state.eyes === "visor") {
		capy[EYE.top]![EYE.col - 1] = "c";
		capy[EYE.top]![EYE.col] = "w";
		capy[EYE.top]![EYE.col + 1] = "c";
		capy[EYE.top + 1]![EYE.col] = "c";
		capy[EYE.top + 1]![EYE.col + 1] = "c";
	} else {
		// Open
		capy[EYE.top]![EYE.col] = "e";
		capy[EYE.top]![EYE.col + 1] = "w";
		capy[EYE.top + 1]![EYE.col] = "e";
		capy[EYE.top + 1]![EYE.col + 1] = "e";
	}

	const rows = capy.map(row => row.join(""));
	if (state.inhale) rows[0] = INHALED_BOINA;
	rows.forEach((row, r) => {
		for (let c = 0; c < CAPY_WIDTH; c++) put(GROUND + r + state.lift, c, row[c]!);
	});
	balanceRows(state.tilt).forEach((row, r) => {
		for (let c = 0; c < BALANCE_WIDTH; c++) put(GROUND + r, BALANCE_X + c, row[c]!);
	});
	return grid.map(row => row.join(""));
}

const fg = (rgb: Rgb) => `38;2;${rgb.join(";")}`;
const bg = (rgb: Rgb) => `48;2;${rgb.join(";")}`;

function halfBlocks(rows: readonly string[]): string[] {
	const lines: string[] = [];
	for (let row = 0; row < rows.length; row += 2) {
		let line = "";
		for (let col = 0; col < MASCOT_WIDTH; col++) {
			const top = COLORS[rows[row]?.[col] ?? "."];
			const bottom = COLORS[rows[row + 1]?.[col] ?? "."];
			if (top && bottom) line += `\x1b[${fg(top)};${bg(bottom)}m▀\x1b[39;49m`;
			else if (top) line += `\x1b[${fg(top)}m▀\x1b[39m`;
			else if (bottom) line += `\x1b[${fg(bottom)}m▄\x1b[39m`;
			else line += " ";
		}
		lines.push(line);
	}
	return lines;
}

const EYES = { open: "o", blink: "-", happy: "^", visor: "=" } as const;
const ASCII_BALANCE = {
	"-1": ["   |   ", " \_|_  ", "  _|_\\ ", "   |   "],
	"0": ["   |   ", " _/|\\_ ", "  \\|/  ", "   |   "],
	"1": ["   |   ", "  _|_/ ", " /_|_  ", "   |   "],
} as const;

/** The fixed-width ASCII capybara for terminals without truecolor. */
function asciiLines(state: Frame): string[] {
	const eye = state.eyes === "visor" ? "o" : EYES[state.eyes];
	const hop = state.lift < 0 ? 1 : 0;
	const body = [
		"        n         ",
		state.inhale ? "  ,-----'-----,   " : "  .-----'-----.   ",
		` /            ${eye}\\_ `,
		"(              __)",
		"  \\__||____||_/   ",
	];
	const balance = ASCII_BALANCE[String(state.tilt) as keyof typeof ASCII_BALANCE];
	const lines = Array.from({ length: MASCOT_HEIGHT }, (_unused, i) => {
		const left = body[i - 1 + hop] ?? "";
		const right = balance[i - 1] ?? "";
		return padRight(`${padRight(left, 18)}${right}`, MASCOT_WIDTH);
	});
	return lines;
}

/** The mascot block: exactly `MASCOT_HEIGHT` lines of `MASCOT_WIDTH` cells in every mode, pose and frame. */
export function renderMascot(pose: MascotPose, frame: number, animate: boolean, mode: ColorMode): string[] {
	const state = frameOf(pose, frame, animate);
	if (mode === "truecolor") return halfBlocks(sprite(state)).map(line => line + " ".repeat(Math.max(0, MASCOT_WIDTH - cellWidth(line))));
	const color = pose === "happy" ? "hp" : "gold";
	return asciiLines(state).map(line => pixelText(color, line, mode));
}

/** Which pose the screen of this step calls for: working while something runs, happy when done, idle otherwise; undefined where there is no mascot. */
export function mascotPoseFor(step: string, pending: boolean): MascotPose | undefined {
	if (step === "done") return "happy";
	if (step === "installing" || step === "scan" || pending) return "working";
	if (step === "welcome") return "idle";
	return undefined;
}
