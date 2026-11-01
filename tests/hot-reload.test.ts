import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLivePools } from "../src/pools.ts";

test("getLivePools hot-reloads pools.json dynamically when modified without restarting process", () => {
	const dir = mkdtempSync(join(tmpdir(), "balancer-reload-"));
	const poolsFile = join(dir, "pools.json");

	// Initial configuration with 1 pool
	writeFileSync(poolsFile, JSON.stringify({
		pools: [
			{ id: "test-pool-1", candidates: ["antigravity/gemini-4-argon"] }
		]
	}), "utf8");

	const initial = getLivePools(dir);
	assert.equal(initial.pools.length, 1);
	assert.equal(initial.pools[0].id, "test-pool-1");

	// Update configuration on disk with a second pool and different candidates
	writeFileSync(poolsFile, JSON.stringify({
		pools: [
			{ id: "test-pool-1", candidates: ["antigravity/gemini-4-argon"] },
			{ id: "test-pool-2", candidates: ["antigravity/gemini-3-8-flash", "claude-bridge/claude-sonnet-5-5"] }
		]
	}), "utf8");

	// Ensure mtime advances so statSync detects change
	const futureTime = (Date.now() + 2000) / 1000;
	utimesSync(poolsFile, futureTime, futureTime);

	const updated = getLivePools(dir);
	assert.equal(updated.pools.length, 2);
	assert.equal(updated.pools[0].id, "test-pool-1");
	assert.equal(updated.pools[1].id, "test-pool-2");
	assert.equal(updated.pools[1].candidates.length, 2);
});
