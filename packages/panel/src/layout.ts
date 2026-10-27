import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_LAYOUT, validateLayout, type Layout } from "./layout-model.ts";

// The panel layout, kept server side in data/web-layout.json so every browser
// sees the same board. Reading never throws (an unusable file means the
// default layout). The pure model lives in layout-model.ts.

export * from "./layout-model.ts";
export const LAYOUT_FILE = "web-layout.json";

/** The saved layout, or the default with the reason the file was not used. */
export function readLayout(dataDir: string): { layout: Layout; issue?: string } {
	let text: string;
	try {
		text = readFileSync(join(dataDir, LAYOUT_FILE), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { layout: DEFAULT_LAYOUT };
		return { layout: DEFAULT_LAYOUT, issue: `${LAYOUT_FILE} is not readable: ${(error as NodeJS.ErrnoException).code ?? String(error)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { layout: DEFAULT_LAYOUT, issue: `${LAYOUT_FILE} is not readable JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	const result = validateLayout(parsed);
	return "layout" in result ? { layout: result.layout } : { layout: DEFAULT_LAYOUT, issue: `${LAYOUT_FILE} is invalid: ${result.issues.join("; ")}` };
}

/** Validates, then writes 0600 through a temp file; an invalid layout writes nothing. */
export function writeLayout(dataDir: string, value: unknown): { ok: true; layout: Layout } | { ok: false; message: string } {
	const result = validateLayout(value);
	if (!("layout" in result)) return { ok: false, message: result.issues.join("; ") };
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });
	const temporary = join(dataDir, `${LAYOUT_FILE}.${process.pid}.tmp`);
	writeFileSync(temporary, `${JSON.stringify(result.layout, null, "\t")}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, join(dataDir, LAYOUT_FILE));
	return { ok: true, layout: result.layout };
}
