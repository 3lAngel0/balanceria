import { readFileSync } from "node:fs";

// How each provider is paid for. A subscription (bridge or plugin) has quota
// windows; an API integration is billed in USD per token. The HUD shows one
// view for each, so the kind is declared in integrations.json and never guessed.

export type IntegrationKind = "subscription" | "api";

export interface Integration {
	provider: string;
	kind: IntegrationKind;
	label: string;
}

/** A provider missing from integrations.json: shown as is, in neither HUD. */
export interface UnclassifiedIntegration {
	provider: string;
	kind: "unclassified";
	label: string;
}

export function parseIntegrations(raw: unknown): Integration[] {
	if (typeof raw !== "object" || raw === null) return [];
	const list = (raw as { integrations?: unknown }).integrations;
	if (!Array.isArray(list)) return [];
	const seen = new Set<string>();
	const integrations: Integration[] = [];
	for (const item of list) {
		if (typeof item !== "object" || item === null) continue;
		const { provider, kind, label } = item as Record<string, unknown>;
		if (typeof provider !== "string" || provider === "") continue;
		if (typeof label !== "string" || label === "") continue;
		if (kind !== "subscription" && kind !== "api") continue;
		// First entry wins so a later duplicate cannot change a provider's kind.
		if (seen.has(provider)) continue;
		seen.add(provider);
		integrations.push({ provider, kind, label });
	}
	return integrations;
}

/** A missing, unreadable or invalid file gives no integrations. */
export function loadIntegrations(path: string): Integration[] {
	try {
		return parseIntegrations(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return [];
	}
}

export function classifyProvider(provider: string, integrations: readonly Integration[]): Integration | UnclassifiedIntegration {
	return integrations.find(integration => integration.provider === provider) ?? { provider, kind: "unclassified", label: provider };
}
