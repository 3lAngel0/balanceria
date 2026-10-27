import { test } from "node:test";
import assert from "node:assert/strict";
import { Script } from "node:vm";
import { webPageHtml, webPageScript, webPageStyle, WEB_REFRESH_MS } from "../src/web-page.ts";

test("the page loads its script and style from the server, with nothing inline the CSP would block", () => {
	const html = webPageHtml();
	assert.match(html, /^<!DOCTYPE html>/);
	assert.match(html, /<script src="\/app\.js" defer><\/script>/);
	assert.match(html, /<link rel="stylesheet" href="\/app\.css">/);
	assert.doesNotMatch(html, /<script>(?!<\/script>)/);
	assert.doesNotMatch(html, /<style/);
	assert.doesNotMatch(html, /\sstyle="/);
	assert.doesNotMatch(html, /\son[a-z]+="/);
});

test("the script compiles and never writes HTML from data", () => {
	const script = webPageScript();
	assert.doesNotThrow(() => new Script(script));
	assert.doesNotMatch(script, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/);
});

test("the script polls the report and the open session detail on the refresh interval", () => {
	const script = webPageScript();
	assert.equal(WEB_REFRESH_MS, 5_000);
	assert.match(script, /fetch\("\/api\/report"/);
	assert.match(script, /"\/api\/sessions\/" \+ encodeURIComponent\(/);
	assert.match(script, new RegExp(`setInterval\\(refresh, ${WEB_REFRESH_MS}\\)`));
	assert.match(script, /document\.hidden/);
});

test("opening a session in Pi asks first and posts to the open route", () => {
	const script = webPageScript();
	assert.match(script, /confirm\(/);
	assert.match(script, /method: "POST"/);
	assert.match(script, /\/open"/);
	assert.match(script, /navigator\.clipboard\.writeText/);
});

test("an expired or missing token tells the user how to get the address again", () => {
	assert.match(webPageScript(), /\/balancer serve status/);
});

test("the style keeps the pixel report palette", () => {
	const style = webPageStyle();
	assert.match(style, /--bg-deep: #0e0c15/);
	assert.match(style, /\.meter-fill/);
});
