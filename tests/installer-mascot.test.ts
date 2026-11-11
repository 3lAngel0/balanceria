import { test } from "node:test";
import assert from "node:assert/strict";
import { cellWidth } from "../src/tui-box.ts";
import type { ColorMode } from "../src/pixel.ts";
import { MASCOT_HEIGHT, MASCOT_WIDTH, mascotPoseFor, renderMascot, type MascotPose } from "../src/installer-mascot.ts";

const POSES: MascotPose[] = ["idle", "working", "happy"];
const MODES: ColorMode[] = ["truecolor", "ansi", "none"];
const FRAMES = Array.from({ length: 24 }, (_unused, i) => i);
const block = (pose: MascotPose, frame: number, animate: boolean, mode: ColorMode) => renderMascot(pose, frame, animate, mode).join("\n");

test("every frame of every pose has the same size in every mode", () => {
	for (const pose of POSES) {
		for (const mode of MODES) {
			for (const animate of [true, false]) {
				for (const frame of FRAMES) {
					const lines = renderMascot(pose, frame, animate, mode);
					assert.equal(lines.length, MASCOT_HEIGHT, `${pose} ${mode} ${frame}`);
					for (const line of lines) assert.equal(cellWidth(line), MASCOT_WIDTH, `${pose} ${mode} ${frame}: ${JSON.stringify(line)}`);
				}
			}
		}
	}
});

test("frames differ only when motion is on", () => {
	for (const pose of POSES) {
		for (const mode of MODES) {
			assert.ok(new Set(FRAMES.map(f => block(pose, f, true, mode))).size > 1, `${pose} ${mode} animates`);
			assert.equal(new Set(FRAMES.map(f => block(pose, f, false, mode))).size, 1, `${pose} ${mode} is still`);
		}
	}
});

test("the poses look different from each other", () => {
	for (const mode of MODES) assert.equal(new Set(POSES.map(p => block(p, 0, false, mode))).size, POSES.length, mode);
});

test("truecolor draws half-block pixel art in browns; ansi and none fall back to a fixed ASCII capybara", () => {
	const pixel = block("idle", 0, true, "truecolor");
	assert.match(pixel, /[▀▄]/);
	assert.match(pixel, /38;2;176;120;70/);
	for (const mode of ["ansi", "none"] as const) assert.doesNotMatch(block("idle", 0, true, mode), /[▀▄]/);
	const plain = block("working", 3, true, "none");
	assert.equal(plain, plain.replace(/\x1b\[[0-9;]*m/g, ""));
	assert.match(plain, /\S/);
});

test("the pose follows what the screen is doing", () => {
	assert.equal(mascotPoseFor("welcome", false), "idle");
	assert.equal(mascotPoseFor("scan", false), "working");
	assert.equal(mascotPoseFor("installing", false), "working");
	assert.equal(mascotPoseFor("tasks", true), "working");
	assert.equal(mascotPoseFor("done", false), "happy");
	assert.equal(mascotPoseFor("backups", false), undefined);
});
