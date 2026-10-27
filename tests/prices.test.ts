import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePrices, priceFor, requestCost } from "../src/prices.ts";

const TABLE = parsePrices({
	asOf: "2026-10-18",
	models: {
		"claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		"claude-haiku-5-5": {
			input: 0.1,
			output: 0.5,
			cacheRead: 0.01,
			cacheWrite: 0.125,
			longContext: { threshold: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
		},
		"gemini-3.8-flash": { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 },
		broken: { input: "x", output: 1, cacheRead: 1, cacheWrite: 1 },
	},
	subscriptions: { "claude-bridge": 20, antigravity: null },
});

function near(actual: number | undefined, expected: number): void {
	assert.ok(actual !== undefined && Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}

test("priceFor matches exact ids, dots as dashes, and suffixed ids, and drops invalid rows", () => {
	assert.equal(priceFor(TABLE, "claude-opus-5-5")?.input, 4);
	assert.equal(priceFor(TABLE, "gemini-3-8-flash")?.output, 3.75, "agy ids use dashes where the price list uses dots");
	assert.equal(priceFor(TABLE, "claude-opus-5-5-thinking")?.input, 4);
	assert.equal(priceFor(TABLE, "claude-opus-5"), undefined, "a shorter id is a different model");
	assert.equal(priceFor(TABLE, "broken"), undefined);
	assert.deepEqual(TABLE.subscriptions, { "claude-bridge": 20 });
	assert.equal(TABLE.asOf, "2026-10-18");
});

test("requestCost prices each token kind per million and switches to the long-context tier", () => {
	near(requestCost(TABLE, { model: "claude-opus-5-5", input: 1_000_000, output: 500_000, cacheRead: 1_000_000, cacheWrite: 200_000 }), 15.2);
	near(requestCost(TABLE, { model: "claude-haiku-5-5", input: 50_000, output: 10_000, cacheRead: 50_000, cacheWrite: 0 }), 0.0105);
	near(requestCost(TABLE, { model: "claude-haiku-5-5", input: 50_000, output: 10_000, cacheRead: 50_001, cacheWrite: 0 }), 0.0525000500);
	assert.equal(requestCost(TABLE, { model: "unknown-model", input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }), undefined);
});

test("the shipped prices.json prices every model the pools and the log use", () => {
	const shipped = parsePrices(JSON.parse(readFileSync(new URL("../prices.json", import.meta.url), "utf8")));
	for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "gemini-3-8-flash", "gemini-4-argon"]) {
		assert.ok(priceFor(shipped, model), `${model} has a price`);
	}
});
