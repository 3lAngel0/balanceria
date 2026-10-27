import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The panel may read and edit the lab draft, never apply, undo, create or
// discard it, and never grant permissions: those stay in Pi (design §10.1).

const PANEL = fileURLToPath(new URL("..", import.meta.url));
const FORBIDDEN = /\b(applyDraft|undoApply|createDraft|discardDraft)\b|permissions\.ts/;

function files(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
		entry.isDirectory() ? files(join(dir, entry.name)) : /\.tsx?$/.test(entry.name) ? [join(dir, entry.name)] : [],
	);
}

test("the panel never applies, undoes, creates or discards a lab draft, nor touches permissions", () => {
	const offenders = ["src", "ui"].flatMap(dir => files(join(PANEL, dir))).filter(file => FORBIDDEN.test(readFileSync(file, "utf8")));
	assert.deepEqual(offenders, []);
});
