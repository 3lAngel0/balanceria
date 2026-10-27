import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LAYOUT, LAYOUT_FILE, readLayout, validateLayout, writeLayout, type Layout } from "../src/layout.ts";

function scratch(): string {
	return mkdtempSync(join(tmpdir(), "panel-layout-"));
}

const valid: Layout = {
	version: 1,
	mode: "advanced",
	widgets: [
		{ id: "summary", kind: "summary", x: 0, y: 0, w: 12, h: 2 },
		{ id: "projects-2", kind: "projects", x: 4, y: 2, w: 8, h: 6, hidden: true },
	],
};

test("the default layout is simple mode with the nine widgets", () => {
	assert.deepEqual(DEFAULT_LAYOUT, {
		version: 1,
		mode: "simple",
		widgets: [
			{ id: "summary", kind: "summary", x: 0, y: 0, w: 12, h: 2 },
			{ id: "projects", kind: "projects", x: 0, y: 2, w: 8, h: 6 },
			{ id: "recent", kind: "recent", x: 8, y: 2, w: 4, h: 6 },
			{ id: "tokens", kind: "tokens", x: 0, y: 8, w: 6, h: 6 },
			{ id: "quota", kind: "quota", x: 6, y: 8, w: 6, h: 6 },
			{ id: "decisions", kind: "decisions", x: 0, y: 14, w: 12, h: 8 },
			{ id: "rules", kind: "rules", x: 0, y: 22, w: 12, h: 8 },
			{ id: "profiles", kind: "profiles", x: 0, y: 30, w: 12, h: 8 },
			{ id: "setup", kind: "setup", x: 0, y: 38, w: 12, h: 8 },
		],
	});
	assert.deepEqual(validateLayout(DEFAULT_LAYOUT), { layout: DEFAULT_LAYOUT });
});

test("a valid layout passes unchanged", () => {
	assert.deepEqual(validateLayout(valid), { layout: valid });
});

test("a layout saved before the chart widgets existed stays valid", () => {
	const old = { version: 1, mode: "simple", widgets: DEFAULT_LAYOUT.widgets.slice(0, 3) };
	assert.deepEqual(validateLayout(old), { layout: old });
});

test("a layout saved before the decisions widget existed stays valid", () => {
	const old = { version: 1, mode: "advanced", widgets: DEFAULT_LAYOUT.widgets.slice(0, 5) };
	assert.deepEqual(validateLayout(old), { layout: old });
});

test("a layout saved before the rules widget existed stays valid", () => {
	const old = { version: 1, mode: "simple", widgets: DEFAULT_LAYOUT.widgets.slice(0, 6) };
	assert.deepEqual(validateLayout(old), { layout: old });
});

test("a layout saved before the profiles widget existed stays valid", () => {
	const old = { version: 1, mode: "simple", widgets: DEFAULT_LAYOUT.widgets.slice(0, 7) };
	assert.deepEqual(validateLayout(old), { layout: old });
});

test("a layout saved before the setup widget existed stays valid", () => {
	const old = { version: 1, mode: "simple", widgets: DEFAULT_LAYOUT.widgets.slice(0, 8) };
	assert.deepEqual(validateLayout(old), { layout: old });
});

test("every issue of an invalid layout is listed", () => {
	const result = validateLayout({
		version: 2,
		mode: "fancy",
		extra: true,
		widgets: [
			{ id: "A b", kind: "chart", x: -1, y: 201, w: 0, h: 25 },
			{ id: "dup", kind: "summary", x: 8, y: 0, w: 5, h: 1.5 },
			{ id: "dup", kind: "recent", x: 0, y: 0, w: 1, h: 1, hidden: "yes", color: "red" },
		],
	});
	assert.deepEqual(result, {
		issues: [
			"version must be 1",
			"mode must be simple or advanced",
			"unknown field extra",
			"widget 1: id must match ^[a-z0-9-]{1,32}$",
			"widget 1: kind must be one of summary, projects, recent, tokens, quota, decisions, rules, profiles, setup",
			"widget 1: x must be an integer from 0 to 11",
			"widget 1: y must be an integer from 0 to 200",
			"widget 1: w must be an integer from 1 to 12",
			"widget 1: h must be an integer from 1 to 24",
			"widget 2: x + w must be at most 12",
			"widget 2: h must be an integer from 1 to 24",
			"widget 3: id dup is used twice",
			"widget 3: hidden must be true or false",
			"widget 3: unknown field color",
		],
	});
});

test("a layout that is not an object, or has no widget list, is refused", () => {
	assert.deepEqual(validateLayout(null), { issues: ["the layout must be an object"] });
	assert.deepEqual(validateLayout([]), { issues: ["the layout must be an object"] });
	assert.deepEqual(validateLayout({ version: 1, mode: "simple", widgets: {} }), { issues: ["widgets must be a list"] });
	assert.deepEqual(validateLayout({ version: 1, mode: "simple", widgets: [7] }), { issues: ["widget 1: must be an object"] });
});

test("at most 24 widgets", () => {
	const widgets = Array.from({ length: 25 }, (_, i) => ({ id: `w${i}`, kind: "recent", x: 0, y: i, w: 1, h: 1 }));
	assert.deepEqual(validateLayout({ version: 1, mode: "simple", widgets }), { issues: ["at most 24 widgets"] });
	assert.ok("layout" in validateLayout({ version: 1, mode: "simple", widgets: widgets.slice(0, 24) }));
});

test("reading falls back to the default when the file is missing, unreadable or invalid", () => {
	const dir = scratch();
	try {
		assert.deepEqual(readLayout(dir), { layout: DEFAULT_LAYOUT });
		writeFileSync(join(dir, LAYOUT_FILE), "{nope");
		assert.equal(readLayout(dir).layout, DEFAULT_LAYOUT);
		assert.match(readLayout(dir).issue ?? "", /^web-layout.json is not readable JSON/);
		writeFileSync(join(dir, LAYOUT_FILE), JSON.stringify({ version: 1, mode: "simple", widgets: [{ id: "x" }] }));
		assert.deepEqual(readLayout(dir), { layout: DEFAULT_LAYOUT, issue: "web-layout.json is invalid: widget 1: kind must be one of summary, projects, recent, tokens, quota, decisions, rules, profiles, setup; widget 1: x must be an integer from 0 to 11; widget 1: y must be an integer from 0 to 200; widget 1: w must be an integer from 1 to 12; widget 1: h must be an integer from 1 to 24" });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("writing validates, writes 0600 through a temp file, and reads back", () => {
	const dir = scratch();
	try {
		assert.deepEqual(writeLayout(dir, valid), { ok: true, layout: valid });
		const file = join(dir, LAYOUT_FILE);
		assert.equal(statSync(file).mode & 0o777, 0o600);
		assert.deepEqual(readLayout(dir), { layout: valid });
		assert.deepEqual(readdirSync(dir), [LAYOUT_FILE]);
		const before = readFileSync(file, "utf8");
		assert.deepEqual(writeLayout(dir, { version: 1, mode: "nope", widgets: [] }), { ok: false, message: "mode must be simple or advanced" });
		assert.equal(readFileSync(file, "utf8"), before);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
