import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// D1: the panel imports the balancer, never the other way round, so Pi loads
// only src/ and the panel can change without touching the extension.
test("no src/ module imports the panel package", () => {
	const src = join(import.meta.dirname, "..", "src");
	const offenders = (readdirSync(src, { recursive: true }) as string[])
		.filter(file => file.endsWith(".ts"))
		.filter(file => /(?:from\s+|import\s*\(\s*|import\s+)["'][^"']*packages\//.test(readFileSync(join(src, file), "utf8")));
	assert.deepEqual(offenders, []);
});
