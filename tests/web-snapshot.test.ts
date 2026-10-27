import { test } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { webPageScript, webPageStyle, webSnapshotHtml } from "../src/web-page.ts";
import { snapshotSessionIds } from "../src/web-data.ts";

const report = {
	generatedAt: "2026-10-21T12:00:00.000Z",
	roles: [
		{ role: "orchestrator", sessions: [{ session: "s1" }, { session: "s2" }] },
		{ role: "gentle-ai-worker", sessions: [{ session: "s2" }, { session: "s3" }] },
	],
	suggestions: [{ rule: "large-context", title: "Compact it", session: "s4", alias: null }, { rule: "x", title: "y", session: null, alias: null }],
};

test("the snapshot is one self-contained file: style and script inline, nothing loaded from a server", () => {
	const html = webSnapshotHtml({ report, sessions: {} });
	assert.match(html, /^<!DOCTYPE html>/);
	assert.ok(html.includes(`<style>${webPageStyle()}</style>`));
	assert.ok(html.includes(webPageScript({ snapshot: true })));
	assert.doesNotMatch(html, /src="\/app\.js"|href="\/app\.css"/);
	assert.match(html, /<script type="application\/json" id="snapshot-data">/);
	assert.match(html, /AI-BALANCER \/\/ SNAPSHOT/);
});

test("embedded data cannot close its script tag or become markup", () => {
	const hostile = { report: { ...report, title: "</script><script>alert(1)</script><!--" }, sessions: {} };
	const html = webSnapshotHtml(hostile);
	const start = html.indexOf('<script type="application/json" id="snapshot-data">') + '<script type="application/json" id="snapshot-data">'.length;
	const json = html.slice(start, html.indexOf("</script>", start));
	assert.doesNotMatch(json, /</);
	assert.deepEqual(JSON.parse(json), hostile);
});

test("the live script stays unchanged and the snapshot script compiles", () => {
	assert.equal(webPageScript(), webPageScript({ snapshot: false }));
	assert.doesNotThrow(() => new Script(webPageScript({ snapshot: true })));
	assert.doesNotMatch(webPageScript({ snapshot: true }), /<\/script/i);
	assert.doesNotMatch(webPageStyle(), /<\/style/i);
});

test("the snapshot captures every session the overview links to, once each", () => {
	assert.deepEqual(snapshotSessionIds(report as never), ["s1", "s2", "s3", "s4"]);
});
