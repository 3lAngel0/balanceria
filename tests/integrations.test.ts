import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyProvider, loadIntegrations, parseIntegrations } from "../src/integrations.ts";

const REPO_FILE = join(import.meta.dirname, "..", "integrations.json");

const claude = { provider: "claude-bridge", kind: "subscription", label: "Claude Pro (claude-bridge)" };
const anthropic = { provider: "anthropic", kind: "api", label: "Anthropic API" };

test("parseIntegrations reads the documented shape", () => {
	assert.deepEqual(parseIntegrations({ integrations: [claude, anthropic] }), [claude, anthropic]);
});

test("parseIntegrations returns [] for input that is not the documented shape", () => {
	assert.deepEqual(parseIntegrations(null), []);
	assert.deepEqual(parseIntegrations("x"), []);
	assert.deepEqual(parseIntegrations({}), []);
	assert.deepEqual(parseIntegrations({ integrations: "nope" }), []);
});

test("parseIntegrations skips entries with a missing or empty provider or label", () => {
	const parsed = parseIntegrations({
		integrations: [
			{ kind: "api", label: "No provider" },
			{ provider: "", kind: "api", label: "Empty provider" },
			{ provider: "a", kind: "api" },
			{ provider: "b", kind: "api", label: "" },
			{ provider: 3, kind: "api", label: "Numeric provider" },
			null,
			anthropic,
		],
	});
	assert.deepEqual(parsed, [anthropic]);
});

test("parseIntegrations skips a kind other than subscription or api", () => {
	const parsed = parseIntegrations({
		integrations: [
			{ provider: "x", kind: "unclassified", label: "X" },
			{ provider: "y", kind: "free", label: "Y" },
			{ provider: "z", label: "Z" },
			claude,
		],
	});
	assert.deepEqual(parsed, [claude]);
});

test("parseIntegrations keeps the first entry when a provider repeats", () => {
	const parsed = parseIntegrations({ integrations: [claude, { ...claude, kind: "api", label: "Other" }] });
	assert.deepEqual(parsed, [claude]);
});

test("loadIntegrations returns [] for a missing file and for invalid JSON", () => {
	const dir = mkdtempSync(join(tmpdir(), "integrations-"));
	try {
		assert.deepEqual(loadIntegrations(join(dir, "missing.json")), []);
		const bad = join(dir, "bad.json");
		writeFileSync(bad, "{ not json");
		assert.deepEqual(loadIntegrations(bad), []);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("loadIntegrations reads a valid file", () => {
	const dir = mkdtempSync(join(tmpdir(), "integrations-"));
	try {
		const file = join(dir, "integrations.json");
		writeFileSync(file, JSON.stringify({ integrations: [claude] }));
		assert.deepEqual(loadIntegrations(file), [claude]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("classifyProvider returns the matching integration", () => {
	const list = parseIntegrations({ integrations: [claude, anthropic] });
	assert.deepEqual(classifyProvider("anthropic", list), anthropic);
});

test("classifyProvider never guesses a kind for an unknown provider", () => {
	const list = parseIntegrations({ integrations: [claude, anthropic] });
	assert.deepEqual(classifyProvider("opencode-go", list), { provider: "opencode-go", kind: "unclassified", label: "opencode-go" });
	assert.deepEqual(classifyProvider("claude-bridge-2", list).kind, "unclassified");
});

test("the committed integrations.json holds exactly the four seed entries", () => {
	assert.deepEqual(loadIntegrations(REPO_FILE), [
		{ provider: "claude-bridge", kind: "subscription", label: "Claude Pro (claude-bridge)" },
		{ provider: "antigravity", kind: "subscription", label: "Google AI Pro (agy)" },
		{ provider: "anthropic", kind: "api", label: "Anthropic API" },
		{ provider: "google", kind: "api", label: "Gemini API" },
	]);
});
