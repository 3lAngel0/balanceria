import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { menuMessages } from "./messages/menu.ts";
import { setupMessages } from "./messages/setup.ts";
import { hudMessages } from "./messages/hud.ts";
import { opsMessages } from "./messages/ops.ts";
import { webMessages } from "./messages/web.ts";

export type Lang = "en" | "es";

export interface ResolveLangInput {
	saved?: string | null;
	env?: Record<string, string | undefined>;
}

export interface ResolveLangResult {
	lang: Lang;
	source: "setting" | "env" | "default";
}

const ENV_VARS = ["AI_BALANCER_LANG", "LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"] as const;

export function resolveLang({ saved, env }: ResolveLangInput): ResolveLangResult {
	if (saved === "es" || saved === "en") {
		return { lang: saved, source: "setting" };
	}

	if (env) {
		for (const key of ENV_VARS) {
			const val = env[key];
			if (val !== undefined && val.trim() !== "") {
				const trimmed = val.trim().toLowerCase();
				if (trimmed.startsWith("es")) {
					return { lang: "es", source: "env" };
				}
				return { lang: "en", source: "env" };
			}
		}
	}

	return { lang: "en", source: "default" };
}

let activeLang: Lang = "en";

export function getLang(): Lang {
	return activeLang;
}

export function setLang(lang: Lang | undefined): void {
	if (lang === "es" || lang === "en") {
		activeLang = lang;
	} else {
		// If undefined (e.g. auto), re-resolve from environment
		activeLang = resolveLang({ env: process.env }).lang;
	}
}

export function initLang(settingsPath: string): ResolveLangResult {
	let saved: string | null = null;
	try {
		const raw = readFileSync(settingsPath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed && (parsed.lang === "es" || parsed.lang === "en")) {
			saved = parsed.lang;
		}
	} catch {
		// File missing or invalid JSON -> no saved setting
	}

	const result = resolveLang({ saved, env: process.env });
	activeLang = result.lang;
	return result;
}

export function saveLangSetting(settingsPath: string, lang: Lang | undefined): void {
	let settings: Record<string, unknown> = {};
	try {
		const raw = readFileSync(settingsPath, "utf8");
		settings = JSON.parse(raw);
		if (typeof settings !== "object" || settings === null || Array.isArray(settings)) {
			settings = {};
		}
	} catch {
		settings = {};
	}

	if (lang === undefined) {
		delete settings.lang;
	} else {
		settings.lang = lang;
	}

	mkdirSync(dirname(settingsPath), { recursive: true });
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
}

// Catalog compilation
const catalogs: Record<Lang, Record<string, string>> = {
	en: {
		...menuMessages.en,
		...setupMessages.en,
		...hudMessages.en,
		...opsMessages.en,
		...webMessages.en,
	},
	es: {
		...menuMessages.es,
		...setupMessages.es,
		...hudMessages.es,
		...opsMessages.es,
		...webMessages.es,
	},
};

export function t(key: string, params?: Record<string, string | number>): string {
	const current = activeLang;
	let text = catalogs[current]?.[key];
	if (text === undefined && current !== "en") {
		text = catalogs.en?.[key];
	}
	if (text === undefined) {
		return key;
	}

	if (!params) return text;

	return text.replace(/\{(\w+)\}/g, (match, paramKey) => {
		if (paramKey in params) {
			return String(params[paramKey]);
		}
		return match;
	});
}
