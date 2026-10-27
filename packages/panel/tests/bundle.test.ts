import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PANEL_DIR, readBundle, sourceHash, STALE_HINT } from "../src/bundle.ts";

test("the committed bundle was built from the current ui sources and lockfile", () => {
	const recorded = JSON.parse(readFileSync(join(PANEL_DIR, "dist", "build.json"), "utf8")) as { sourceHash: string };
	assert.equal(recorded.sourceHash, sourceHash(PANEL_DIR), STALE_HINT);
});

test("the source hash covers every ui file path and content and the lockfile", () => {
	const dir = mkdtempSync(join(tmpdir(), "panel-bundle-"));
	try {
		mkdirSync(join(dir, "ui", "widgets"), { recursive: true });
		writeFileSync(join(dir, "ui", "main.tsx"), "a");
		writeFileSync(join(dir, "package-lock.json"), "{}");
		const first = sourceHash(dir);
		assert.match(first, /^[0-9a-f]{64}$/);
		writeFileSync(join(dir, "ui", "widgets", "x.tsx"), "");
		const added = sourceHash(dir);
		assert.notEqual(added, first);
		writeFileSync(join(dir, "ui", "main.tsx"), "b");
		assert.notEqual(sourceHash(dir), added);
		writeFileSync(join(dir, "ui", "main.tsx"), "a");
		assert.equal(sourceHash(dir), added);
		writeFileSync(join(dir, "package-lock.json"), "{ }");
		assert.notEqual(sourceHash(dir), added);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a missing bundle fails with the build hint", () => {
	const dir = mkdtempSync(join(tmpdir(), "panel-bundle-"));
	try {
		assert.throws(() => readBundle(dir), { message: `pi-panel: the panel bundle is missing in ${join(dir, "dist")}: run \`npm run build\` in packages/panel` });
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("every data: image in the bundled CSS is overridden later, since img-src 'self' refuses it", () => {
	const css = readBundle().style.replace(/\/\*[\s\S]*?\*\//g, "");
	const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({ selectors: m[1]!.split(",").map(s => s.replace(/\s+/g, "").trim()), body: m[2]! }));
	const offenders = rules.flatMap((rule, index) => {
		if (!/url\(\s*['"]?data:/.test(rule.body)) return [];
		return rule.selectors.filter(selector => !rules.slice(index + 1).some(later => later.selectors.includes(selector) && /background(-image)?:\s*(none|linear-gradient)/.test(later.body)));
	});
	assert.ok(rules.some(rule => /url\(\s*['"]?data:/.test(rule.body)), "the check found no data: image to look at");
	assert.deepEqual(offenders, []);
});

test("PANEL_DIR is the packages/panel directory", () => {
	assert.equal(PANEL_DIR, fileURLToPath(new URL("../", import.meta.url)));
});
