import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	detectSystemProviders,
	generateRecommendedConfig,
	generateConfigPreview,
	writeConfigSafely,
	resolveAgentDir,
	normalizePackageName,
	runSetupWizard,
	mergeIntegrations,
	buildBalancerProfileName,
	type DetectedProvider,
} from "../src/setup.ts";

test("normalizePackageName strips npm: prefix and @version suffixes for regular and scoped packages", () => {
	assert.equal(normalizePackageName("npm:pi-claude-bridge"), "pi-claude-bridge");
	assert.equal(normalizePackageName("npm:@estebanforge/pi-antigravity-bridge"), "@estebanforge/pi-antigravity-bridge");
	assert.equal(normalizePackageName("npm:@danielgap/pi-claude-usage@0.2.2"), "@danielgap/pi-claude-usage");
	assert.equal(normalizePackageName("npm:gentle-engram@0.4.2"), "gentle-engram");
	assert.equal(normalizePackageName("pi-claude-bridge@1.0.0"), "pi-claude-bridge");
	assert.equal(normalizePackageName("../../proyectos_ia/balancingIa"), "../../proyectos_ia/balancingIa");
});

test("resolveAgentDir resolves in priority order (explicit > env > .gentle-shell > .pi)", () => {
	const dir = mkdtempSync(join(tmpdir(), "agent-dir-test-"));
	try {
		// 1. Explicit options.agentDir
		assert.equal(resolveAgentDir({ agentDir: "/custom/agent" }), "/custom/agent");

		// 2. Environment variable PI_CODING_AGENT_DIR
		assert.equal(resolveAgentDir({ env: { PI_CODING_AGENT_DIR: "/env/agent" } }), "/env/agent");

		// 3. ~/.gentle-shell/agent if directory exists
		const gentleShellAgent = join(dir, ".gentle-shell", "agent");
		mkdirSync(gentleShellAgent, { recursive: true });
		assert.equal(resolveAgentDir({ homeDir: dir, env: {} }), gentleShellAgent);

		// 4. ~/.pi/agent if gentle-shell does not exist but .pi does
		const piOnlyDir = mkdtempSync(join(tmpdir(), "pi-only-test-"));
		try {
			const piAgent = join(piOnlyDir, ".pi", "agent");
			mkdirSync(piAgent, { recursive: true });
			assert.equal(resolveAgentDir({ homeDir: piOnlyDir, env: {} }), piAgent);
		} finally {
			rmSync(piOnlyDir, { recursive: true, force: true });
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("detectSystemProviders reads settings.json packages fixture correctly", () => {
	const settingsFixture = {
		packages: [
			"npm:gentle-engram@0.4.2",
			"npm:pi-claude-bridge",
			"npm:@estebanforge/pi-antigravity-bridge",
			"npm:@danielgap/pi-claude-usage@0.2.2",
		],
	};

	const providers = detectSystemProviders({
		settings: settingsFixture,
		execWhich: () => false,
	});

	const bridge = providers.find(p => p.id === "claude-bridge");
	assert.ok(bridge, "claude-bridge should be present");
	assert.equal(bridge.detected, true, "claude-bridge should be detected via settings package");
	assert.match(bridge.source, /package/i);

	const agy = providers.find(p => p.id === "antigravity");
	assert.ok(agy, "antigravity should be present");
	assert.equal(agy.detected, true, "antigravity should be detected via settings package");
});

test("detectSystemProviders handles empty packages and no binaries", () => {
	const providers = detectSystemProviders({
		settings: { packages: [] },
		execWhich: () => false,
		env: {},
		homeDir: "/nonexistent-dir",
	});

	const subs = providers.filter(p => p.detected && p.kind === "subscription");
	assert.equal(subs.length, 0, "No subscription providers should be detected");
});

test("generateRecommendedConfig creates pools containing ONLY selected providers", () => {
	// 1. Only claude-bridge selected
	const onlyBridge: DetectedProvider[] = [
		{
			id: "claude-bridge",
			label: "Claude Pro (claude-bridge)",
			kind: "subscription",
			detected: true,
			source: "package",
			availableModels: ["claude-opus-5-5", "claude-sonnet-5-5"],
		},
	];

	const bridgeConfig = generateRecommendedConfig(onlyBridge);
	assert.equal(bridgeConfig.integrations.length, 1);
	assert.equal(bridgeConfig.integrations[0].provider, "claude-bridge");
	for (const pool of bridgeConfig.pools) {
		for (const cand of pool.candidates) {
			assert.ok(cand.startsWith("claude-bridge/"), `Candidate ${cand} must only use claude-bridge`);
			assert.ok(!cand.startsWith("antigravity/"), `Candidate ${cand} must not use antigravity`);
		}
	}

	// 2. Only antigravity selected
	const onlyAgy: DetectedProvider[] = [
		{
			id: "antigravity",
			label: "Google AI Pro (agy)",
			kind: "subscription",
			detected: true,
			source: "binary",
			availableModels: ["claude-opus-5-5", "claude-sonnet-5-5", "gemini-4-argon", "gemini-3-8-flash"],
		},
	];

	const agyConfig = generateRecommendedConfig(onlyAgy);
	assert.equal(agyConfig.integrations.length, 1);
	assert.equal(agyConfig.integrations[0].provider, "antigravity");
	for (const pool of agyConfig.pools) {
		for (const cand of pool.candidates) {
			assert.ok(cand.startsWith("antigravity/"), `Candidate ${cand} must only use antigravity`);
			assert.ok(!cand.startsWith("claude-bridge/"), `Candidate ${cand} must not use claude-bridge`);
		}
	}
});

test("generateConfigPreview shows pool candidates and file differences", () => {
	const nextConfig = {
		integrations: [
			{ provider: "claude-bridge", kind: "subscription" as const, label: "Claude Pro (claude-bridge)" },
			{ provider: "antigravity", kind: "subscription" as const, label: "Google AI Pro (agy)" },
		],
		pools: [
			{
				id: "claude-opus-5-5",
				name: "Opus 5.5 (pool)",
				candidates: ["antigravity/claude-opus-5-5", "claude-bridge/claude-opus-5-5"],
			},
		],
	};

	// When current is null (new files)
	const previewNew = generateConfigPreview(null, nextConfig);
	assert.match(previewNew, /claude-opus-5-5/);
	assert.match(previewNew, /antigravity\/claude-opus-5-5 → claude-bridge\/claude-opus-5-5/);
	assert.match(previewNew, /pools\.json: Will create new file/i);

	// When current has changes
	const currentExisting = {
		pools: {
			pools: [
				{
					id: "claude-opus-5-5",
					candidates: ["claude-bridge/claude-opus-5-5"],
				},
			],
		},
		integrations: {
			integrations: [
				{ provider: "claude-bridge", kind: "subscription", label: "Claude Pro" },
			],
		},
	};
	const previewDiff = generateConfigPreview(currentExisting, nextConfig);
	assert.match(previewDiff, /Update pool 'claude-opus-5-5'/i);
	assert.match(previewDiff, /add antigravity/i);
});

test("runSetupWizard cancels and writes nothing when user declines detection", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wizard-cancel-1-"));
	try {
		const poolsPath = join(dir, "pools.json");
		const intPath = join(dir, "integrations.json");
		writeFileSync(poolsPath, '{"initial":true}', "utf8");
		writeFileSync(intPath, '{"initial":true}', "utf8");

		const notifications: string[] = [];
		const mockUi = {
			confirm: async () => false, // User declines at step 1
			select: async () => "dummy",
			notify: (msg: string) => { notifications.push(msg); },
		};

		const completed = await runSetupWizard({ ui: mockUi }, dir, {
			detectOptions: {
				settings: { packages: ["npm:pi-claude-bridge"] },
			},
		});

		assert.equal(completed, false);
		assert.equal(readFileSync(poolsPath, "utf8"), '{"initial":true}', "pools.json must not be modified");
		assert.equal(readFileSync(intPath, "utf8"), '{"initial":true}', "integrations.json must not be modified");
		assert.ok(notifications.some(n => n.includes("setup cancelled, nothing written")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runSetupWizard cancels and writes nothing when user escapes provider selection", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wizard-cancel-2-"));
	try {
		const poolsPath = join(dir, "pools.json");
		writeFileSync(poolsPath, '{"initial":true}', "utf8");

		const notifications: string[] = [];
		let confirmCallCount = 0;
		const mockUi = {
			confirm: async () => { confirmCallCount++; return true; },
			select: async () => undefined, // User presses Escape on provider select
			notify: (msg: string) => { notifications.push(msg); },
		};

		const completed = await runSetupWizard({ ui: mockUi }, dir, {
			detectOptions: {
				settings: { packages: ["npm:pi-claude-bridge", "npm:@estebanforge/pi-antigravity-bridge"] },
			},
		});

		assert.equal(completed, false);
		assert.equal(readFileSync(poolsPath, "utf8"), '{"initial":true}', "pools.json must not be modified");
		assert.ok(notifications.some(n => n.includes("setup cancelled, nothing written")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runSetupWizard cancels and writes nothing when user escapes strategy selection", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wizard-cancel-3-"));
	try {
		const poolsPath = join(dir, "pools.json");
		writeFileSync(poolsPath, '{"initial":true}', "utf8");

		const notifications: string[] = [];
		let selectCallCount = 0;
		const mockUi = {
			confirm: async () => true,
			select: async (_title: string, options: string[]) => {
				selectCallCount++;
				if (selectCallCount === 1) return options[0]; // Pick providers
				return undefined; // Escape strategy
			},
			notify: (msg: string) => { notifications.push(msg); },
		};

		const completed = await runSetupWizard({ ui: mockUi }, dir, {
			detectOptions: {
				settings: { packages: ["npm:pi-claude-bridge"] },
			},
		});

		assert.equal(completed, false);
		assert.equal(readFileSync(poolsPath, "utf8"), '{"initial":true}');
		assert.ok(notifications.some(n => n.includes("setup cancelled, nothing written")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runSetupWizard cancels and writes nothing when user declines final confirmation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wizard-cancel-4-"));
	try {
		const poolsPath = join(dir, "pools.json");
		writeFileSync(poolsPath, '{"initial":true}', "utf8");

		const notifications: string[] = [];
		let confirmCallCount = 0;
		const mockUi = {
			confirm: async () => {
				confirmCallCount++;
				return confirmCallCount === 1; // Approve detection, decline confirmation
			},
			select: async (_title: string, options: string[]) => options[0],
			notify: (msg: string) => { notifications.push(msg); },
		};

		const completed = await runSetupWizard({ ui: mockUi }, dir, {
			detectOptions: {
				settings: { packages: ["npm:pi-claude-bridge"] },
			},
		});

		assert.equal(completed, false);
		assert.equal(readFileSync(poolsPath, "utf8"), '{"initial":true}');
		assert.ok(notifications.some(n => n.includes("setup cancelled, nothing written")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runSetupWizard notifies and writes nothing if no subscription providers detected", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wizard-no-subs-"));
	try {
		const notifications: string[] = [];
		const mockUi = {
			confirm: async () => true,
			select: async () => "dummy",
			notify: (msg: string) => { notifications.push(msg); },
		};

		const completed = await runSetupWizard({ ui: mockUi }, dir, {
			detectOptions: {
				settings: { packages: [] },
				execWhich: () => false,
				env: {},
				homeDir: "/nonexistent-dir",
			},
		});

		assert.equal(completed, false);
		assert.equal(existsSync(join(dir, "pools.json")), false);
		assert.equal(existsSync(join(dir, "integrations.json")), false);
		assert.ok(notifications.some(n => n.includes("No subscription providers detected")));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runSetupWizard completes and creates backups on confirmation", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wizard-confirm-"));
	try {
		const poolsPath = join(dir, "pools.json");
		const intPath = join(dir, "integrations.json");
		writeFileSync(poolsPath, '{"pools":[{"id":"initial-pool","name":"Initial","candidates":["claude-bridge/claude-sonnet-5-5"]}]}', "utf8");
		writeFileSync(intPath, '{"integrations":[{"provider":"claude-bridge","kind":"subscription","label":"Initial"}]}', "utf8");

		const notifications: string[] = [];
		const mockUi = {
			confirm: async () => true,
			select: async (_title: string, options: string[]) => options[0],
			notify: (msg: string) => { notifications.push(msg); },
		};

		const completed = await runSetupWizard({ ui: mockUi }, dir, {
			detectOptions: {
				settings: { packages: ["npm:pi-claude-bridge", "npm:@estebanforge/pi-antigravity-bridge"] },
			},
		});

		assert.equal(completed, true);
		assert.ok(existsSync(poolsPath));
		assert.ok(existsSync(intPath));
		assert.ok(existsSync(`${poolsPath}.bak`), "Backup of pools.json must exist");
		assert.ok(existsSync(`${intPath}.bak`), "Backup of integrations.json must exist");

		// Final notification mentions written files and backup locations
		const successNotify = notifications.find(n => n.includes("Setup complete"));
		assert.ok(successNotify, "Success notification must be fired");
		assert.match(successNotify, /pools\.json/);
		assert.match(successNotify, /integrations\.json/);
		assert.match(successNotify, /backups created/i);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// Preserved existing tests
test("detectSystemProviders scans standard provider CLI tools and environment", () => {
	const providers = detectSystemProviders();
	assert.ok(providers.length >= 5);
	assert.ok(providers.some(p => p.id === "antigravity"));
	assert.ok(providers.some(p => p.id === "claude-bridge"));
	assert.ok(providers.some(p => p.id === "claude-code"));
	assert.ok(providers.some(p => p.id === "opencode"));
	assert.ok(providers.some(p => p.id === "ollama"));
});

test("generateRecommendedConfig creates valid integrations and pools", () => {
	const detected = [
		{
			id: "antigravity",
			label: "Google AI Pro (agy)",
			kind: "subscription" as const,
			detected: true,
			source: "CLI",
			availableModels: ["claude-opus-5-5", "claude-sonnet-5-5"],
		},
		{
			id: "claude-bridge",
			label: "Claude Pro (claude-bridge)",
			kind: "subscription" as const,
			detected: true,
			source: "bridge",
			availableModels: ["claude-opus-5-5"],
		},
	];

	const config = generateRecommendedConfig(detected);
	assert.ok(config.integrations.length >= 2);
	assert.ok(config.pools.length >= 3);
	assert.ok(config.pools.some(p => p.id === "claude-opus-5-5"));
	assert.ok(config.pools.some(p => p.id === "claude-sonnet-5-5"));
	assert.ok(config.pools.some(p => p.id === "orchestrator"));
});

test("writeConfigSafely validates schemas, creates backup, and writes files", () => {
	const dir = mkdtempSync(join(tmpdir(), "setup-test-"));
	try {
		const validConfig = {
			integrations: {
				integrations: [
					{ provider: "claude-bridge", kind: "subscription", label: "Claude Bridge" },
				],
			},
			pools: {
				pools: [
					{
						id: "sonnet-pool",
						name: "Sonnet Pool",
						candidates: ["claude-bridge/claude-sonnet-5-5"],
					},
				],
			},
		};

		const res1 = writeConfigSafely(dir, validConfig);
		assert.equal(res1.success, true);
		assert.equal(res1.backupCreated, false);
		assert.ok(existsSync(join(dir, "integrations.json")));
		assert.ok(existsSync(join(dir, "pools.json")));

		// Second write creates backup
		const res2 = writeConfigSafely(dir, validConfig);
		assert.equal(res2.backupCreated, true);
		assert.ok(existsSync(join(dir, "integrations.json.bak")));
		assert.ok(existsSync(join(dir, "pools.json.bak")));

		// Invalid schema throws
		assert.throws(() => {
			writeConfigSafely(dir, {
				integrations: { invalid: true },
				pools: { pools: [] },
			});
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

const BOTH: DetectedProvider[] = [
	{ id: "antigravity", label: "Google AI Pro (agy)", kind: "subscription", detected: true, source: "test", availableModels: [] },
	{ id: "claude-bridge", label: "Claude Pro (claude-bridge)", kind: "subscription", detected: true, source: "test", availableModels: [] },
	{ id: "ollama", label: "Ollama (Local LLM)", kind: "local", detected: true, source: "test", availableModels: [] },
];

test("generateRecommendedConfig writes the chosen strategy on every pool", () => {
	const waterfall = generateRecommendedConfig(BOTH, { strategy: "waterfall" });
	assert.ok(waterfall.pools.length > 0);
	assert.ok(waterfall.pools.every(pool => pool.strategy === "waterfall"));
	assert.ok(generateRecommendedConfig(BOTH).pools.every(pool => pool.strategy === "hybrid"), "hybrid by default");
});

test("generateRecommendedConfig keeps only candidates whose model Pi has, drops empty pools and reports what it skipped", () => {
	const known = new Set(["antigravity/claude-opus-5-5", "claude-bridge/claude-opus-5-5", "antigravity/gemini-3-8-flash"]);
	const config = generateRecommendedConfig(BOTH, { hasModel: (provider, model) => known.has(`${provider}/${model}`) });
	for (const pool of config.pools) assert.ok(pool.candidates.every(ref => known.has(ref)), `${pool.id} has only known models`);
	assert.deepEqual(config.pools.find(pool => pool.id === "claude-opus-5-5")?.candidates, ["antigravity/claude-opus-5-5", "claude-bridge/claude-opus-5-5"]);
	assert.ok(config.skipped.includes("ollama/qwen2.5-coder"));
	assert.ok(config.skipped.includes("antigravity/gemini-4-argon"));
	const none = generateRecommendedConfig(BOTH, { hasModel: () => false });
	assert.deepEqual(none.pools, []);
});

test("mergeIntegrations keeps every current integration and only adds the new providers", () => {
	const current = { integrations: [
		{ provider: "claude-bridge", kind: "subscription", label: "My Claude" },
		{ provider: "anthropic", kind: "api", label: "Anthropic API" },
	] };
	const merged = mergeIntegrations(current, [
		{ provider: "claude-bridge", kind: "subscription", label: "Claude Pro (claude-bridge)" },
		{ provider: "antigravity", kind: "subscription", label: "Google AI Pro (agy)" },
	]);
	assert.deepEqual(merged, [
		{ provider: "claude-bridge", kind: "subscription", label: "My Claude" },
		{ provider: "anthropic", kind: "api", label: "Anthropic API" },
		{ provider: "antigravity", kind: "subscription", label: "Google AI Pro (agy)" },
	]);
	assert.deepEqual(mergeIntegrations(null, [{ provider: "x", kind: "api", label: "X" }]), [{ provider: "x", kind: "api", label: "X" }]);
});

test("runSetupWizard offers only the strategies the router has, writes the chosen one, keeps current integrations and skips unknown models", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wizard-strategy-"));
	try {
		writeFileSync(join(dir, "integrations.json"), JSON.stringify({ integrations: [{ provider: "anthropic", kind: "api", label: "Anthropic API" }] }), "utf8");
		const strategyOptions: string[][] = [];
		const confirms: string[] = [];
		const ui = {
			confirm: async (_title: string, message: string) => { confirms.push(message); return true; },
			select: async (title: string, options: string[]) => {
				if (title === "Select Routing Strategy") { strategyOptions.push(options); return options.find(option => option.startsWith("waterfall")); }
				return options[0];
			},
			notify: () => {},
		};
		const known = new Set(["antigravity/claude-opus-5-5", "claude-bridge/claude-opus-5-5"]);
		const completed = await runSetupWizard({ ui }, dir, {
			detectOptions: { settings: { packages: ["npm:pi-claude-bridge", "npm:@estebanforge/pi-antigravity-bridge"] }, execWhich: () => false, homeDir: dir, env: {} },
			hasModel: (provider, model) => known.has(`${provider}/${model}`),
		});
		assert.equal(completed, true);
		assert.deepEqual(strategyOptions, [[
			"hybrid (Recommended) - start each new turn on the candidate with the most free quota, stay on it for follow-ups",
			"waterfall - always use the first candidate in the list until it is spent, then the next",
		]]);
		const pools = JSON.parse(readFileSync(join(dir, "pools.json"), "utf8"));
		assert.deepEqual(pools, { pools: [{ id: "claude-opus-5-5", name: "Opus 5.5 (pool)", candidates: ["antigravity/claude-opus-5-5", "claude-bridge/claude-opus-5-5"], strategy: "waterfall" }] });
		const integrations = JSON.parse(readFileSync(join(dir, "integrations.json"), "utf8"));
		assert.deepEqual(integrations.integrations.map((entry: { provider: string }) => entry.provider), ["anthropic", "antigravity", "claude-bridge"]);
		assert.match(confirms.at(-1) ?? "", /claude-opus-5-5 \[waterfall\]: antigravity\/claude-opus-5-5 → claude-bridge\/claude-opus-5-5/);
		assert.match(confirms.at(-1) ?? "", /Skipped \(model not available in Pi\): .*antigravity\/gemini-4-argon/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runSetupWizard keeps the names of existing pools, adds only providers that ended up in a pool, and the preview reports a strategy change", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wizard-names-"));
	try {
		writeFileSync(join(dir, "pools.json"), JSON.stringify({ pools: [{ id: "claude-opus-5-5", name: "Opus (my order)", candidates: ["antigravity/claude-opus-5-5", "claude-bridge/claude-opus-5-5"] }] }), "utf8");
		writeFileSync(join(dir, "integrations.json"), JSON.stringify({ integrations: [] }), "utf8");
		const confirms: string[] = [];
		const ui = {
			confirm: async (_title: string, message: string) => { confirms.push(message); return true; },
			select: async (title: string, options: string[]) => (title === "Select Routing Strategy" ? options[1] : options[0]),
			notify: () => {},
		};
		const known = new Set(["antigravity/claude-opus-5-5", "claude-bridge/claude-opus-5-5"]);
		await runSetupWizard({ ui }, dir, {
			detectOptions: { settings: { packages: ["npm:pi-claude-bridge"] }, execWhich: bin => bin === "agy" || bin === "claude", homeDir: dir, env: {} },
			hasModel: (provider, model) => known.has(`${provider}/${model}`),
		});
		const pools = JSON.parse(readFileSync(join(dir, "pools.json"), "utf8")).pools;
		assert.deepEqual(pools.map((pool: { id: string; name: string }) => [pool.id, pool.name]), [["claude-opus-5-5", "Opus (my order)"]]);
		const providers = JSON.parse(readFileSync(join(dir, "integrations.json"), "utf8")).integrations.map((entry: { provider: string }) => entry.provider);
		assert.deepEqual(providers, ["antigravity", "claude-bridge"], "claude-code has no usable model, so it is not added");
		assert.match(confirms.at(-1) ?? "", /~ Update pool 'claude-opus-5-5': strategy hybrid → waterfall/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runSetupWizard allows custom provider combination toggling, per-pool candidate editing/reordering, and role assignment to profiles.json", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wizard-interactive-hub-"));
	try {
		const profilesPath = join(dir, "profiles.json");
		writeFileSync(
			profilesPath,
			JSON.stringify({
				kind: "gentle-pi.agent_model_profiles",
				version: 1,
				active: "default",
				profiles: {
					default: {
						"gentle-ai-explore": { model: "pool/orchestrator", thinking: "medium" },
					},
				},
			}),
			"utf8",
		);

		const selectTitles: string[] = [];
		let hubVisits = 0;
		let poolMenuVisits = 0;
		let poolEditVisits = 0;
		let roleMenuVisits = 0;

		const ui = {
			confirm: async () => true,
			select: async (title: string, options: string[]) => {
				selectTitles.push(title);

				if (title === "Select Providers for Pools") {
					return options.find(o => o.includes("Custom")) ?? options[0];
				}
				if (title.startsWith("Toggle Active Bridges")) {
					// Toggle off claude-code if active, then continue
					const claudeCodeOpt = options.find(o => o.includes("(claude-code)") && o.includes("[✓]"));
					if (claudeCodeOpt) return claudeCodeOpt;
					return options[0]; // Continue with selected providers
				}
				if (title === "Select Routing Strategy") {
					return options[0]; // hybrid
				}
				if (title.includes("Tenés un perfil activo")) {
					return options.find(o => o.includes("Mantener perfil")) ?? options[0];
				}
				if (title.startsWith("ai-balancer Setup: Customize")) {
					hubVisits++;
					if (hubVisits === 1) {
						return options.find(o => o.includes("Customize Pool Candidates"));
					}
					if (hubVisits === 2) {
						return options.find(o => o.includes("Customize Agent Roles"));
					}
					if (hubVisits === 3) {
						return options.find(o => o.includes("Role & Model Advisor"));
					}
					return options[0]; // Finish & review configuration summary
				}
				if (title.startsWith("Customize Pools")) {
					poolMenuVisits++;
					if (poolMenuVisits === 1) {
						return options.find(o => o.includes("pool/claude-opus-5-5"));
					}
					return options[0]; // Back to Setup Hub
				}
				if (title.startsWith("Edit pool/claude-opus-5-5")) {
					poolEditVisits++;
					if (poolEditVisits === 1) {
						// Move second candidate up to #1
						return options.find(o => o.includes("↑ Move up") && o.includes("claude-bridge/claude-opus-5-5"));
					}
					if (poolEditVisits === 2) {
						// Toggle strategy on this single pool
						return options.find(o => o.includes("Toggle strategy"));
					}
					return options[0]; // Done editing pool
				}
				if (title.startsWith("Customize Agent Roles")) {
					roleMenuVisits++;
					if (roleMenuVisits === 1) {
						return options.find(o => o.includes("gentle-ai-explore"));
					}
					return options[0]; // Back to Setup Hub
				}
				if (title.startsWith("Select Model or Pool for gentle-ai-explore")) {
					return options.find(o => o.startsWith("antigravity/gemini-3-8-flash")) ?? options[0];
				}
				if (title.startsWith("Select Thinking Level for gentle-ai-explore")) {
					return options.find(o => o.startsWith("low")) ?? options[0];
				}
				if (title.startsWith("Role & Model Advisor")) {
					// Apply single recommendation for gentle-ai-worker
					const workerRec = options.find(o => o.includes("gentle-ai-worker"));
					if (workerRec && !selectTitles.filter(t => t.startsWith("Role & Model Advisor")).slice(0, -1).length) {
						return workerRec;
					}
					return options.find(o => o.includes("Back to Setup Hub")) ?? options[0];
				}
				return options[0];
			},
			notify: () => {},
		};

		const completed = await runSetupWizard({ ui }, dir, {
			detectOptions: {
				settings: { packages: ["npm:pi-claude-bridge", "npm:@estebanforge/pi-antigravity-bridge"] },
				execWhich: bin => bin === "claude",
				homeDir: dir,
				env: {},
			},
			profilesPath,
		});

		assert.equal(completed, true);

		const savedPools = JSON.parse(readFileSync(join(dir, "pools.json"), "utf8")).pools;
		const opusPool = savedPools.find((p: { id: string }) => p.id === "claude-opus-5-5");
		assert.ok(opusPool);
		assert.equal(opusPool.strategy, "waterfall", "per-pool strategy toggle must persist");
		assert.equal(opusPool.candidates[0], "claude-bridge/claude-opus-5-5", "reordered candidate must be first");

		const savedProfiles = JSON.parse(readFileSync(profilesPath, "utf8"));
		assert.equal(savedProfiles.profiles.default["gentle-ai-explore"].model, "antigravity/gemini-3-8-flash");
		assert.equal(savedProfiles.profiles.default["gentle-ai-explore"].thinking, "low");
		assert.ok(savedProfiles.profiles.default["gentle-ai-worker"]?.model, "advisor recommendation for worker must be saved");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("buildBalancerProfileName formats profile names with balanceador_ prefix and sanitizes identifier", () => {
	assert.equal(buildBalancerProfileName("dev"), "balanceador_dev");
	assert.equal(buildBalancerProfileName("balanceador_personal"), "balanceador_personal");
	assert.equal(buildBalancerProfileName("Mi Perfil 2026!"), "balanceador_mi_perfil_2026");
	assert.equal(buildBalancerProfileName(""), "balanceador_default");
	assert.equal(buildBalancerProfileName("   "), "balanceador_default");
	assert.equal(buildBalancerProfileName(undefined), "balanceador_default");
});

test("runSetupWizard offers to create profile when no profiles exist and saves with balanceador_<id>", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wizard-new-profile-"));
	try {
		const profilesPath = join(dir, "profiles.json");
		// profiles.json does not exist initially

		let promptedCreate = false;
		let inputPrompted = false;

		const ui = {
			confirm: async () => true,
			select: async (title: string, options: string[]) => {
				if (title.includes("¿Creamos un perfil para vos?")) {
					promptedCreate = true;
					return options.find(o => o.includes("Sí, crear perfil")) ?? options[0];
				}
				return options[0];
			},
			input: async (title: string) => {
				if (title.includes("Identificador")) {
					inputPrompted = true;
					return "mi_entorno";
				}
				return "";
			},
			notify: () => {},
		};

		const completed = await runSetupWizard({ ui }, dir, {
			detectOptions: {
				settings: { packages: ["npm:pi-claude-bridge", "npm:@estebanforge/pi-antigravity-bridge"] },
				execWhich: bin => bin === "claude",
				homeDir: dir,
				env: {},
			},
			profilesPath,
		});

		assert.equal(completed, true);
		assert.equal(promptedCreate, true, "Must offer to create profile when missing");
		assert.equal(inputPrompted, true, "Must ask user for profile identifier");

		const saved = JSON.parse(readFileSync(profilesPath, "utf8"));
		assert.equal(saved.kind, "gentle-pi.agent_model_profiles");
		assert.equal(saved.version, 1);
		assert.equal(saved.active, "balanceador_mi_entorno");
		assert.ok(saved.profiles["balanceador_mi_entorno"], "Profile balanceador_mi_entorno must exist");
		assert.ok(saved.profiles["balanceador_mi_entorno"]["gentle-ai-worker"]?.model, "Profile must have roles assigned");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runSetupWizard allows creating a new balanceador_<id> profile from the hub and sets it active", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wizard-hub-profile-"));
	try {
		const profilesPath = join(dir, "profiles.json");
		writeFileSync(
			profilesPath,
			JSON.stringify({
				kind: "gentle-pi.agent_model_profiles",
				version: 1,
				active: "initial_profile",
				profiles: {
					initial_profile: {
						"gentle-ai-explore": { model: "pool/orchestrator", thinking: "medium" },
					},
				},
			}),
			"utf8",
		);

		let hubVisits = 0;
		const ui = {
			confirm: async () => true,
			select: async (title: string, options: string[]) => {
				if (title.startsWith("ai-balancer Setup: Customize")) {
					hubVisits++;
					if (hubVisits === 1) {
						return options.find(o => o.includes("¿Creamos un perfil para vos?"));
					}
					return options[0]; // Finish
				}
				return options[0];
			},
			input: async () => "trabajo",
			notify: () => {},
		};

		const completed = await runSetupWizard({ ui }, dir, {
			detectOptions: {
				settings: { packages: ["npm:pi-claude-bridge", "npm:@estebanforge/pi-antigravity-bridge"] },
				execWhich: bin => bin === "claude",
				homeDir: dir,
				env: {},
			},
			profilesPath,
		});

		assert.equal(completed, true);

		const saved = JSON.parse(readFileSync(profilesPath, "utf8"));
		assert.equal(saved.active, "balanceador_trabajo");
		assert.ok(saved.profiles.initial_profile, "Existing profile must be preserved");
		assert.ok(saved.profiles.balanceador_trabajo, "New profile balanceador_trabajo must be created");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("runSetupWizard prompts when an active profile exists and offers to create custom balanceador_<id>", async () => {
	const dir = mkdtempSync(join(tmpdir(), "wizard-active-profile-prompt-"));
	try {
		const profilesPath = join(dir, "profiles.json");
		writeFileSync(
			profilesPath,
			JSON.stringify({
				kind: "gentle-pi.agent_model_profiles",
				version: 1,
				active: "perfil_existente",
				profiles: {
					perfil_existente: {
						"gentle-ai-explore": { model: "pool/orchestrator", thinking: "medium" },
					},
				},
			}),
			"utf8",
		);

		let promptedActiveProfile = false;
		let inputPrompted = false;

		const ui = {
			confirm: async () => true,
			select: async (title: string, options: string[]) => {
				if (title.includes("Tenés un perfil activo: 'perfil_existente'")) {
					promptedActiveProfile = true;
					return options.find(o => o.includes("Sí, armar perfil")) ?? options[0];
				}
				return options[0];
			},
			input: async (title: string) => {
				if (title.includes("Identificador")) {
					inputPrompted = true;
					return "equipo";
				}
				return "";
			},
			notify: () => {},
		};

		const completed = await runSetupWizard({ ui }, dir, {
			detectOptions: {
				settings: { packages: ["npm:pi-claude-bridge", "npm:@estebanforge/pi-antigravity-bridge"] },
				execWhich: bin => bin === "claude",
				homeDir: dir,
				env: {},
			},
			profilesPath,
		});

		assert.equal(completed, true);
		assert.equal(promptedActiveProfile, true, "Must prompt about existing active profile");
		assert.equal(inputPrompted, true, "Must ask for identifier for custom balancer profile");

		const saved = JSON.parse(readFileSync(profilesPath, "utf8"));
		assert.equal(saved.active, "balanceador_equipo");
		assert.ok(saved.profiles.perfil_existente, "Original profile must be preserved");
		assert.ok(saved.profiles.balanceador_equipo, "New custom profile must be created and active");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

