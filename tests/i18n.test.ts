import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveLang,
	t,
	getLang,
	setLang,
	initLang,
	saveLangSetting,
} from "../src/i18n/index.ts";
import { menuMessages } from "../src/i18n/messages/menu.ts";
import { setupMessages } from "../src/i18n/messages/setup.ts";
import { hudMessages } from "../src/i18n/messages/hud.ts";
import { opsMessages } from "../src/i18n/messages/ops.ts";
import { webMessages } from "../src/i18n/messages/web.ts";

test("resolveLang order and sources", () => {
	// 1. Saved setting takes highest precedence
	assert.deepEqual(
		resolveLang({ saved: "es", env: { AI_BALANCER_LANG: "en", LANG: "en_US.UTF-8" } }),
		{ lang: "es", source: "setting" },
	);
	assert.deepEqual(
		resolveLang({ saved: "en", env: { AI_BALANCER_LANG: "es", LANG: "es_ES.UTF-8" } }),
		{ lang: "en", source: "setting" },
	);

	// Invalid saved setting is ignored
	assert.deepEqual(
		resolveLang({ saved: "fr", env: { AI_BALANCER_LANG: "es" } }),
		{ lang: "es", source: "env" },
	);

	// 2. Env priority: AI_BALANCER_LANG > LC_ALL > LC_MESSAGES > LANG > LANGUAGE
	assert.deepEqual(
		resolveLang({
			env: {
				AI_BALANCER_LANG: "es",
				LC_ALL: "en_US.UTF-8",
				LC_MESSAGES: "en_US.UTF-8",
				LANG: "en_US.UTF-8",
				LANGUAGE: "en",
			},
		}),
		{ lang: "es", source: "env" },
	);

	assert.deepEqual(
		resolveLang({
			env: {
				AI_BALANCER_LANG: "",
				LC_ALL: "es_AR.UTF-8",
				LC_MESSAGES: "en_US.UTF-8",
				LANG: "en_US.UTF-8",
			},
		}),
		{ lang: "es", source: "env" },
	);

	assert.deepEqual(
		resolveLang({
			env: {
				LC_ALL: "",
				LC_MESSAGES: "es_CL.UTF-8",
				LANG: "en_US.UTF-8",
			},
		}),
		{ lang: "es", source: "env" },
	);

	assert.deepEqual(
		resolveLang({
			env: {
				LANG: "es_ES.UTF-8",
				LANGUAGE: "en",
			},
		}),
		{ lang: "es", source: "env" },
	);

	assert.deepEqual(
		resolveLang({
			env: {
				LANGUAGE: "es",
			},
		}),
		{ lang: "es", source: "env" },
	);

	// Value starting with es (case-insensitive) -> es, any other non-empty -> en
	assert.deepEqual(
		resolveLang({ env: { LANG: "ES_MX.UTF-8" } }),
		{ lang: "es", source: "env" },
	);
	assert.deepEqual(
		resolveLang({ env: { LANG: "es_AR.UTF-8" } }),
		{ lang: "es", source: "env" },
	);
	assert.deepEqual(
		resolveLang({ env: { LANG: "en_US.UTF-8" } }),
		{ lang: "en", source: "env" },
	);
	assert.deepEqual(
		resolveLang({ env: { LANG: "fr_FR.UTF-8" } }),
		{ lang: "en", source: "env" },
	);
	assert.deepEqual(
		resolveLang({ env: { LANG: "C" } }),
		{ lang: "en", source: "env" },
	);

	// 3. Default when empty/unset
	assert.deepEqual(
		resolveLang({ env: {} }),
		{ lang: "en", source: "default" },
	);
	assert.deepEqual(
		resolveLang({ env: { LANG: "" } }),
		{ lang: "en", source: "default" },
	);
	assert.deepEqual(
		resolveLang({}),
		{ lang: "en", source: "default" },
	);
});

test("t() placeholder substitution, Spanish fallback, and unknown keys", () => {
	setLang("en");
	assert.equal(
		t("menu.unknownSubcommand", { command: "foo" }),
		'ai-balancer: unknown subcommand "foo". Run /balancer for the Control Center, /balancer menu for every action, or one of: overview, roles, pools, advisor, panel, usage, refresh, setup, report, simulate [file], switch-cost, loans, permissions [grant | revoke [id|all]], lab [new | diff | simulate | apply | undo | discard], serve [lan] [port] | setup | stop | status | autostart off, open <id>, lang [es|en|auto]',
	);

	// Unknown key returns key itself
	assert.equal(t("non.existent.key"), "non.existent.key");
	assert.equal(t("non.existent.key", { foo: "bar" }), "non.existent.key");

	setLang("es");
	assert.equal(
		t("menu.unknownSubcommand", { command: "foo" }),
		'ai-balancer: comando desconocido "foo". Ejecuta /balancer para abrir el Centro de control, /balancer menu para ver todas las acciones, o uno de: overview, roles, pools, advisor, panel, usage, refresh, setup, report, simulate [file], switch-cost, loans, permissions [grant | revoke [id|all]], lab [new | diff | simulate | apply | undo | discard], serve [lan] [port] | setup | stop | status | autostart off, open <id>, lang [es|en|auto]',
	);

	// Reset back to en
	setLang("en");
});

test("catalog parity: en and es have same key set and same {placeholder} set per key", () => {
	const areas = [
		{ name: "menu", catalog: menuMessages },
		{ name: "setup", catalog: setupMessages },
		{ name: "hud", catalog: hudMessages },
		{ name: "ops", catalog: opsMessages },
		{ name: "web", catalog: webMessages },
	];

	const extractPlaceholders = (str: string): string[] => {
		const matches = str.match(/\{(\w+)\}/g) || [];
		return matches.sort();
	};

	for (const { name, catalog } of areas) {
		const enKeys = Object.keys(catalog.en).sort();
		const esKeys = Object.keys(catalog.es).sort();
		assert.deepEqual(esKeys, enKeys, `Area ${name} keys differ between en and es`);

		for (const key of enKeys) {
			const enPlaceholders = extractPlaceholders((catalog.en as Record<string, string>)[key]);
			const esPlaceholders = extractPlaceholders((catalog.es as Record<string, string>)[key]);
			assert.deepEqual(
				esPlaceholders,
				enPlaceholders,
				`Area ${name} key "${key}" placeholders differ: en=${JSON.stringify(enPlaceholders)} es=${JSON.stringify(esPlaceholders)}`,
			);
		}
	}
});

test("saveLangSetting preserves other keys and auto removes lang", () => {
	const tmpDir = mkdtempSync(join(tmpdir(), "ai-balancer-i18n-test-"));
	try {
		const settingsPath = join(tmpDir, "settings.json");

		// Initialize with other settings
		writeFileSync(settingsPath, JSON.stringify({ otherKey: 123, theme: "dark" }, null, 2));

		// Save lang es
		saveLangSetting(settingsPath, "es");
		const read1 = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(read1.lang, "es");
		assert.equal(read1.otherKey, 123);
		assert.equal(read1.theme, "dark");

		// Save lang en
		saveLangSetting(settingsPath, "en");
		const read2 = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(read2.lang, "en");
		assert.equal(read2.otherKey, 123);

		// Auto (undefined) removes lang key
		saveLangSetting(settingsPath, undefined);
		const read3 = JSON.parse(readFileSync(settingsPath, "utf8"));
		assert.equal(read3.lang, undefined);
		assert.equal(read3.otherKey, 123);
		assert.equal(read3.theme, "dark");

		// initLang loads from settings.json
		saveLangSetting(settingsPath, "es");
		const res = initLang(settingsPath);
		assert.equal(res.lang, "es");
		assert.equal(res.source, "setting");
		assert.equal(getLang(), "es");
	} finally {
		rmSync(tmpDir, { recursive: true, force: true });
		setLang("en");
	}
});
