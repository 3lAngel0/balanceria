import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PANEL_DIR } from "../src/bundle.ts";
import { applyPositions, DEFAULT_LAYOUT, moveWidget, setMode, showOnBoard, toggleHidden, validateLayout, withAllKinds, type Layout } from "../src/layout-model.ts";
import { recentSessions, summarize } from "../ui/summary.ts";

/** The layout before the chart widgets: three widgets. */
const BASE: Layout = { version: 1, mode: "simple", widgets: DEFAULT_LAYOUT.widgets.slice(0, 3) };

test("withAllKinds appends every missing kind hidden below the board, and keeps a complete layout as is", () => {
	const full = withAllKinds(BASE);
	assert.deepEqual(full.widgets.slice(0, 3), BASE.widgets);
	assert.deepEqual(full.widgets.slice(3), [
		{ id: "tokens", kind: "tokens", x: 0, y: 8, w: 6, h: 6, hidden: true },
		{ id: "quota", kind: "quota", x: 6, y: 8, w: 6, h: 6, hidden: true },
		{ id: "decisions", kind: "decisions", x: 0, y: 8, w: 12, h: 8, hidden: true },
		{ id: "rules", kind: "rules", x: 0, y: 8, w: 12, h: 8, hidden: true },
		{ id: "profiles", kind: "profiles", x: 0, y: 8, w: 12, h: 8, hidden: true },
		{ id: "setup", kind: "setup", x: 0, y: 8, w: 12, h: 8, hidden: true },
	]);
	assert.ok("layout" in validateLayout(full));
	assert.equal(withAllKinds(DEFAULT_LAYOUT), DEFAULT_LAYOUT);
	assert.equal(withAllKinds(full), full);
	const taken: Layout = { version: 1, mode: "advanced", widgets: [{ id: "tokens", kind: "summary", x: 0, y: 0, w: 12, h: 2 }] };
	assert.deepEqual(
		withAllKinds(taken).widgets.map(w => [w.id, w.kind]),
		[
			["tokens", "summary"],
			["projects", "projects"],
			["recent", "recent"],
			["tokens-2", "tokens"],
			["quota", "quota"],
			["decisions", "decisions"],
			["rules", "rules"],
			["profiles", "profiles"],
			["setup", "setup"],
		],
	);
});

test("setMode switches the mode and keeps the widgets", () => {
	const next = setMode(DEFAULT_LAYOUT, "advanced");
	assert.equal(next.mode, "advanced");
	assert.deepEqual(next.widgets, DEFAULT_LAYOUT.widgets);
	assert.equal(DEFAULT_LAYOUT.mode, "simple");
	assert.ok("layout" in validateLayout(next));
});

test("toggleHidden hides a widget, shows it again, and ignores unknown ids", () => {
	const hidden = toggleHidden(DEFAULT_LAYOUT, "projects");
	assert.equal(hidden.widgets[1]!.hidden, true);
	assert.ok("layout" in validateLayout(hidden));
	const shown = toggleHidden(hidden, "projects");
	assert.deepEqual(shown.widgets[1], DEFAULT_LAYOUT.widgets[1]);
	assert.equal(toggleHidden(DEFAULT_LAYOUT, "nope"), DEFAULT_LAYOUT);
});

test("moveWidget changes the simple-mode order and stops at both ends", () => {
	const ids = (layout: typeof BASE) => layout.widgets.map(w => w.id);
	assert.deepEqual(ids(moveWidget(BASE, "recent", -1)), ["summary", "recent", "projects"]);
	assert.deepEqual(ids(moveWidget(BASE, "summary", 1)), ["projects", "summary", "recent"]);
	assert.equal(moveWidget(BASE, "summary", -1), BASE);
	assert.equal(moveWidget(BASE, "recent", 1), BASE);
	assert.equal(moveWidget(BASE, "nope", 1), BASE);
});

test("applyPositions takes the board's positions, keeps them in 12 columns, and is a no-op when nothing moved", () => {
	const moved = applyPositions(BASE, [
		{ id: "projects", x: 4, y: 3, w: 8, h: 5 },
		{ id: "recent", x: 10, y: 9, w: 6, h: 0 },
		{ id: "unknown", x: 0, y: 0, w: 1, h: 1 },
	]);
	assert.deepEqual(moved.widgets, [
		BASE.widgets[0],
		{ id: "projects", kind: "projects", x: 4, y: 3, w: 8, h: 5 },
		{ id: "recent", kind: "recent", x: 6, y: 9, w: 6, h: 1 },
	]);
	assert.ok("layout" in validateLayout(moved));
	assert.equal(applyPositions(BASE, [{ id: "summary", x: 0, y: 0, w: 12, h: 2 }]), BASE);
	assert.equal(applyPositions(BASE, [{ id: "summary" }]), BASE);
});

test("showOnBoard shows a hidden widget below every shown one, and ignores shown or unknown ids", () => {
	const hidden = toggleHidden(BASE, "summary");
	const shown = showOnBoard(hidden, "summary");
	assert.deepEqual(shown.widgets[0], { id: "summary", kind: "summary", x: 0, y: 8, w: 12, h: 2 });
	assert.ok("layout" in validateLayout(shown));
	assert.equal(showOnBoard(BASE, "summary"), BASE);
	assert.equal(showOnBoard(hidden, "nope"), hidden);
	const allHidden = toggleHidden(toggleHidden(hidden, "projects"), "recent");
	assert.equal(showOnBoard(allHidden, "recent").widgets[2]!.y, 0);
});

const now = Date.parse("2026-10-23T12:00:00Z");
const project = (dir: string, sessions: number, minutesAgo: number, title: string | null = null) => ({
	dir,
	cwd: `/home/${dir}`,
	sessions,
	lastActivity: now - minutesAgo * 60_000,
	latest: { id: `${dir}-id`, title },
	github: null,
});

test("summarize counts projects, sessions, and projects active in the last hour", () => {
	assert.deepEqual(summarize([project("a", 3, 5), project("b", 2, 60), project("c", 4, 61)], now), { projects: 3, sessions: 9, activeLastHour: 2 });
	assert.deepEqual(summarize([], now), { projects: 0, sessions: 0, activeLastHour: 0 });
});

test("recentSessions lists each project's newest session, newest first, at most the limit", () => {
	const projects = [project("old", 1, 300), project("new", 1, 1, "fix tests"), project("mid", 1, 30)];
	assert.deepEqual(recentSessions(projects, 2), [
		{ id: "new-id", title: "fix tests", cwd: "/home/new", lastActivity: now - 60_000 },
		{ id: "mid-id", title: null, cwd: "/home/mid", lastActivity: now - 30 * 60_000 },
	]);
});

test("the UI never injects HTML and never imports node modules", () => {
	const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
	const sources = [...files(join(PANEL_DIR, "ui")), join(PANEL_DIR, "src", "layout-model.ts")];
	for (const file of sources) {
		const text = readFileSync(file, "utf8");
		assert.doesNotMatch(text, /dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write/, file);
		assert.doesNotMatch(text, /from "node:/, file);
	}
});
