import { test } from "node:test";
import assert from "node:assert/strict";
import { BALANCER_MENU, balancerMenu, glossaryText, resolveBalancerArgs } from "../src/balancer-menu.ts";
import { setLang } from "../src/i18n/index.ts";

test("the menu offers every action with a label and a description, in a stable order", () => {
	setLang("en");
	assert.deepEqual(
		BALANCER_MENU.map(item => item.value),
		["panel", "usage", "refresh", "setup", "report", "simulate", "switch-cost", "loans", "permissions", "permissions grant", "permissions revoke", "lab", "lab new", "lab diff", "lab simulate", "lab apply", "lab undo", "lab discard", "serve", "serve lan", "serve setup", "serve status", "serve stop", "serve autostart off", "lang", "help"],
	);
	for (const item of BALANCER_MENU) {
		assert.ok(item.label.length > 0, item.value);
		assert.ok((item.description ?? "").length > 0, item.value);
	}
});

test("no arguments opens the Control Center and `menu` keeps the action list", () => {
	assert.deepEqual(resolveBalancerArgs(""), { kind: "overlay" });
	assert.deepEqual(resolveBalancerArgs("   "), { kind: "overlay" });
	assert.deepEqual(resolveBalancerArgs(" menu "), { kind: "menu" });
});

test("tab names open the Control Center on that tab", () => {
	for (const tab of ["overview", "roles", "pools", "advisor"]) {
		assert.deepEqual(resolveBalancerArgs(tab), { kind: "overlay", tab }, tab);
	}
	assert.deepEqual(resolveBalancerArgs("  pools "), { kind: "overlay", tab: "pools" });
	assert.equal(resolveBalancerArgs("roles extra").kind, "unknown");
	assert.deepEqual(resolveBalancerArgs("panel"), { kind: "command", command: "panel" });
});

test("known subcommands still run directly", () => {
	for (const command of ["panel", "usage", "refresh", "setup", "report", "simulate", "simulate pools.draft.json", "switch-cost", "loans", "serve", "serve 9000", "serve lan", "serve lan 9000", "serve stop", "serve status", "open abc", "permissions", "permissions grant", "permissions revoke", "permissions revoke g-abc-123", "permissions revoke all", "lang", "lang es", "lang en", "lang auto", "help"]) {
		assert.deepEqual(resolveBalancerArgs(command), { kind: "command", command }, command);
	}
	assert.deepEqual(resolveBalancerArgs("  serve lan  "), { kind: "command", command: "serve lan" });
	assert.deepEqual(resolveBalancerArgs("  simulate pools.draft.json  "), { kind: "command", command: "simulate pools.draft.json" });
	assert.deepEqual(resolveBalancerArgs("  lang es  "), { kind: "command", command: "lang es" });
});

test("an unknown subcommand is reported instead of opening the panel", () => {
	setLang("en");
	assert.deepEqual(resolveBalancerArgs("serv"), {
		kind: "unknown",
		message: 'ai-balancer: unknown subcommand "serv". Run /balancer for the Control Center, /balancer menu for every action, or one of: overview, roles, pools, advisor, panel, usage, refresh, setup, report, simulate [file], switch-cost, loans, permissions [grant | revoke [id|all]], lab [new | diff | simulate | apply | undo | discard], serve [lan] [port] | setup | stop | status | autostart off, open <id>, lang [es|en|auto]',
	});
	assert.equal(resolveBalancerArgs("servefoo").kind, "unknown");
	assert.equal(resolveBalancerArgs("opener").kind, "unknown");
	assert.equal(resolveBalancerArgs("lang fr").kind, "unknown");
});

test("permissions takes only grant or revoke [id|all]", () => {
	for (const command of ["permission", "permissionsx", "permissions list", "permissions grant auto", "permissions revoke a b"]) {
		assert.equal(resolveBalancerArgs(command).kind, "unknown", command);
	}
});

test("Spanish menu labels differ from English while values are identical", () => {
	setLang("en");
	const enItems = balancerMenu();
	setLang("es");
	const esItems = balancerMenu();

	assert.equal(enItems.length, esItems.length);
	assert.deepEqual(enItems.map(i => i.value), esItems.map(i => i.value));

	// Values are identical, but labels differ
	let differentCount = 0;
	for (let i = 0; i < enItems.length; i++) {
		assert.equal(enItems[i].value, esItems[i].value);
		if (enItems[i].label !== esItems[i].label) {
			differentCount++;
		}
	}
	assert.ok(differentCount > 0, "Expected Spanish menu labels to differ from English");

	// Reset
	setLang("en");
});

test("the glossary explains each term in English and Spanish", () => {
	const terms = ["pool", "candidate", "loan", "grant", "circuit breaker", "role", "window pace", "context re-sent"];
	for (const lang of ["en", "es"] as const) {
		setLang(lang);
		const text = glossaryText();
		for (const term of terms) assert.ok(lang === "es" || text.includes(term), `${lang}: ${term}`);
		assert.equal(text.split("\n").length, terms.length + 1, lang);
	}
	setLang("en");
	assert.match(glossaryText(), /loan: a temporary fallback/);
	setLang("es");
	assert.match(glossaryText(), /préstamo/);
	setLang("en");
});
