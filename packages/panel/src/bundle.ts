import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The UI is bundled by `npm run build` (build.ts) into dist/, which is
// committed: the service serves those files and never needs `npm install`.
// dist/build.json records the hash of the sources it was built from, so a test
// catches a bundle that was not rebuilt after a ui/ or lockfile change.

export const PANEL_DIR = fileURLToPath(new URL("../", import.meta.url));
export const STALE_HINT = "the panel bundle is stale: run `npm run build` in packages/panel";

function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.flatMap(entry => (entry.isDirectory() ? files(join(dir, entry.name)) : entry.isFile() ? [join(dir, entry.name)] : []));
}

/** sha256 over every ui/ file (relative path and content, sorted) and the lockfile. */
export function sourceHash(panelDir: string): string {
	const hash = createHash("sha256");
	const inputs = [...files(join(panelDir, "ui")), join(panelDir, "package-lock.json")]
		.map(file => ({ name: relative(panelDir, file).split(sep).join("/"), file }))
		.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const { name, file } of inputs) {
		const content = readFileSync(file);
		hash.update(`${name}\0${content.length}\0`);
		hash.update(content);
	}
	return hash.digest("hex");
}

/** The bundled script and style. */
export function readBundle(panelDir: string = PANEL_DIR): { script: string; style: string } {
	const dist = join(panelDir, "dist");
	try {
		return { script: readFileSync(join(dist, "app.js"), "utf8"), style: readFileSync(join(dist, "app.css"), "utf8") };
	} catch {
		throw new Error(`pi-panel: the panel bundle is missing in ${dist}: run \`npm run build\` in packages/panel`);
	}
}
