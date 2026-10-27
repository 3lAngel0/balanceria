import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

// Node strips types without checking them, so a call to a helper whose import
// was lost (for example when two branches rewrite the same import line) only
// fails when the command runs. This catches it for every src/ export.
test("extension.ts imports every src/ function it calls", () => {
	const source = readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");
	const imported = new Set(
		[...source.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/[^"]+"/g)].flatMap(match =>
			match[1].split(",").map(name => name.replace(/^\s*type\s+/, "").split(/\s+as\s+/).pop()!.trim()).filter(Boolean),
		),
	);
	const local = new Set([...source.matchAll(/(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)].map(match => match[1]));
	const srcDir = new URL("../src/", import.meta.url);
	const missing: string[] = [];
	for (const file of readdirSync(srcDir).filter(name => name.endsWith(".ts") && name !== "extension.ts")) {
		const module = readFileSync(new URL(file, srcDir), "utf8");
		for (const [, name] of module.matchAll(/export (?:async )?function ([A-Za-z_$][\w$]*)/g)) {
			if (new RegExp(`(?<![\\w$.])${name}\\(`).test(source) && !imported.has(name) && !local.has(name)) missing.push(`${name} (${file})`);
		}
	}
	assert.deepEqual(missing, []);
});
