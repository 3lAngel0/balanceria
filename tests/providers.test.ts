import test from "node:test";
import assert from "node:assert/strict";
import {
	AntigravityAdapter,
	ClaudeBridgeAdapter,
	ClaudeCodeAdapter,
	GenericApiAdapter,
	LocalAdapter,
	OpenCodeAdapter,
} from "../src/providers/adapters.ts";
import {
	ProviderRegistry,
	getProviderAdapter,
	registerProviderAdapter,
} from "../src/providers/registry.ts";
import {
	validateIntegrationsConfig,
	validatePoolsConfig,
} from "../src/config-schema.ts";

test("ProviderRegistry provides built-in adapters and fallback for unknown", () => {
	const registry = new ProviderRegistry();
	assert.equal(registry.get("antigravity").label, "Antigravity");
	assert.equal(registry.get("claude-bridge").label, "Claude Bridge");
	assert.equal(registry.get("claude-code").label, "Claude Code");
	assert.equal(registry.get("opencode").label, "OpenCode");
	assert.equal(registry.get("ollama").label, "Ollama (Local)");
	assert.equal(registry.get("local").label, "Local Runner");

	const fallback = registry.get("my-custom-llm");
	assert.equal(fallback.kind, "api");
	assert.equal(fallback.quotaKey("llama-3"), "my-custom-llm/llama-3");
});

test("Custom provider registration extends the registry", () => {
	const registry = new ProviderRegistry();
	registry.register({
		id: "custom-sub",
		label: "Custom Subscription",
		kind: "subscription",
		quotaKey: (m) => `custom-sub/${m}`,
		matchQuotaError: () => null,
	});
	assert.equal(registry.has("custom-sub"), true);
	assert.equal(registry.get("custom-sub").label, "Custom Subscription");
});

test("AntigravityAdapter maps models and parses quota errors", () => {
	const adapter = new AntigravityAdapter();
	assert.equal(adapter.quotaKey("gemini-4-argon"), "antigravity/gemini-4-argon");
	assert.equal(adapter.quotaKey("gemini-3-8-flash"), "antigravity/gemini");
	assert.equal(adapter.quotaKey("claude-opus-5-5"), "antigravity/claude");

	const errMatch = adapter.matchQuotaError("Individual quota reached. Resets in 2h30m.");
	assert.ok(errMatch);
	assert.equal(errMatch.isQuotaExceeded, true);
	assert.equal(errMatch.resetsInMs, (2 * 60 + 30) * 60 * 1000);
});

test("ClaudeBridgeAdapter and ClaudeCodeAdapter handle respective quota keys and errors", () => {
	const bridge = new ClaudeBridgeAdapter();
	assert.equal(bridge.quotaKey("claude-sonnet-5-5"), "claude-bridge/claude");
	const bridgeErr = bridge.matchQuotaError("Claude quota exceeded — rate limit (five hour limit) — resets 5:00pm");
	assert.ok(bridgeErr);
	assert.equal(bridgeErr.isQuotaExceeded, true);

	const code = new ClaudeCodeAdapter();
	assert.equal(code.quotaKey("claude-3-7-sonnet"), "claude-code/main");
	const codeErr = code.matchQuotaError("You're out of extra usage · resets 6:30pm");
	assert.ok(codeErr);
	assert.equal(codeErr.isQuotaExceeded, true);
});

test("LocalAdapter never reports quota errors", () => {
	const local = new LocalAdapter();
	assert.equal(local.matchQuotaError("any error message"), null);
});

test("validateIntegrationsConfig validates correct schema and catches issues", () => {
	const valid = {
		integrations: [
			{ provider: "claude-bridge", kind: "subscription", label: "Claude Pro" },
			{ provider: "anthropic", kind: "api", label: "Anthropic API" },
		],
	};
	const validRes = validateIntegrationsConfig(valid);
	assert.equal(validRes.valid, true);
	assert.equal(validRes.issues.length, 0);
	assert.equal(validRes.data?.length, 2);

	const invalid = {
		integrations: [
			{ provider: "", kind: "unknown-kind", label: "Bad" },
			{ provider: "dupe", kind: "api", label: "First" },
			{ provider: "dupe", kind: "api", label: "Second" },
		],
	};
	const invalidRes = validateIntegrationsConfig(invalid);
	assert.equal(invalidRes.valid, false);
	assert.ok(invalidRes.issues.some((i) => i.path.includes("provider")));
	assert.ok(invalidRes.issues.some((i) => i.path.includes("kind")));
	assert.ok(invalidRes.issues.some((i) => i.message.includes("Duplicate")));
});

test("validatePoolsConfig validates candidate syntax and structure", () => {
	const valid = {
		pools: [
			{
				id: "dev-pool",
				name: "Dev Pool",
				candidates: ["antigravity/gemini-4-argon", "claude-bridge/claude-sonnet-5-5"],
			},
		],
	};
	const validRes = validatePoolsConfig(valid);
	assert.equal(validRes.valid, true);
	assert.equal(validRes.issues.length, 0);
	assert.equal(validRes.data?.length, 1);

	const invalid = {
		pools: [
			{
				id: "INVALID_ID_UPPERCASE",
				candidates: ["not-a-valid-slash-ref", 123],
			},
		],
	};
	const invalidRes = validatePoolsConfig(invalid);
	assert.equal(invalidRes.valid, false);
	assert.ok(invalidRes.issues.some((i) => i.path.includes("id")));
	assert.ok(invalidRes.issues.some((i) => i.path.includes("candidates")));
});
