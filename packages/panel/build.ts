import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { PANEL_DIR, sourceHash } from "./src/bundle.ts";

// npm run build: ui/ → dist/app.js + dist/app.css + dist/build.json. The
// output is committed; rerun after any ui/ or dependency change.

const dist = join(PANEL_DIR, "dist");
mkdirSync(dist, { recursive: true });

await build({
	entryPoints: { app: join(PANEL_DIR, "ui", "main.tsx") },
	outdir: dist,
	bundle: true,
	minify: true,
	format: "iife",
	target: "es2022",
	jsx: "automatic",
	jsxImportSource: "preact",
	legalComments: "eof",
	logLevel: "warning",
});
writeFileSync(join(dist, "build.json"), `${JSON.stringify({ sourceHash: sourceHash(PANEL_DIR) }, null, "\t")}\n`);
process.stdout.write(`pi-panel: built ${dist}\n`);
