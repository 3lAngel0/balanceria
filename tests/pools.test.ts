import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePools } from "../src/pools.ts";

test("parsePools reads an optional routing strategy and ignores unknown ones", () => {
	const pools = parsePools({ pools: [
		{ id: "a", candidates: ["claude-bridge/claude-opus-5-5"], strategy: "waterfall" },
		{ id: "b", candidates: ["claude-bridge/claude-opus-5-5"], strategy: "fastest" },
		{ id: "c", candidates: ["claude-bridge/claude-opus-5-5"] },
	] });
	assert.deepEqual(pools.map(pool => [pool.id, pool.strategy]), [["a", "waterfall"], ["b", undefined], ["c", undefined]]);
});
