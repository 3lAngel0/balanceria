import type { SelectItem } from "@earendil-works/pi-tui";
import { t } from "./i18n/index.ts";
import type { ControlCenterTab } from "./panel.ts";

// `/balancer menu` (and `/` inside the Control Center) opens this list; every
// entry's value is the subcommand it runs, so the menu and the typed
// subcommands share one path.

export function balancerMenu(): SelectItem[] {
	return [
		{ value: "panel", label: t("menu.panel.label"), description: t("menu.panel.desc") },
		{ value: "usage", label: t("menu.usage.label"), description: t("menu.usage.desc") },
		{ value: "refresh", label: t("menu.refresh.label"), description: t("menu.refresh.desc") },
		{ value: "setup", label: t("menu.setup.label"), description: t("menu.setup.desc") },
		{ value: "setup classic", label: t("menu.setupClassic.label"), description: t("menu.setupClassic.desc") },
		{ value: "report", label: t("menu.report.label"), description: t("menu.report.desc") },
		{ value: "simulate", label: t("menu.simulate.label"), description: t("menu.simulate.desc") },
		{ value: "switch-cost", label: t("menu.switchCost.label"), description: t("menu.switchCost.desc") },
		{ value: "loans", label: t("menu.loans.label"), description: t("menu.loans.desc") },
		{ value: "permissions", label: t("menu.permissions.label"), description: t("menu.permissions.desc") },
		{ value: "permissions grant", label: t("menu.permissionsGrant.label"), description: t("menu.permissionsGrant.desc") },
		{ value: "permissions revoke", label: t("menu.permissionsRevoke.label"), description: t("menu.permissionsRevoke.desc") },
		{ value: "lab", label: t("menu.lab.label"), description: t("menu.lab.desc") },
		{ value: "lab new", label: t("menu.labNew.label"), description: t("menu.labNew.desc") },
		{ value: "lab diff", label: t("menu.labDiff.label"), description: t("menu.labDiff.desc") },
		{ value: "lab simulate", label: t("menu.labSimulate.label"), description: t("menu.labSimulate.desc") },
		{ value: "lab apply", label: t("menu.labApply.label"), description: t("menu.labApply.desc") },
		{ value: "lab undo", label: t("menu.labUndo.label"), description: t("menu.labUndo.desc") },
		{ value: "lab discard", label: t("menu.labDiscard.label"), description: t("menu.labDiscard.desc") },
		{ value: "serve", label: t("menu.serve.label"), description: t("menu.serve.desc") },
		{ value: "serve lan", label: t("menu.serveLan.label"), description: t("menu.serveLan.desc") },
		{ value: "serve setup", label: t("menu.serveSetup.label"), description: t("menu.serveSetup.desc") },
		{ value: "serve status", label: t("menu.serveStatus.label"), description: t("menu.serveStatus.desc") },
		{ value: "serve stop", label: t("menu.serveStop.label"), description: t("menu.serveStop.desc") },
		{ value: "serve autostart off", label: t("menu.serveAutostartOff.label"), description: t("menu.serveAutostartOff.desc") },
		{ value: "lang", label: t("menu.lang.label"), description: t("menu.lang.desc") },
		{ value: "help", label: t("menu.help.label"), description: t("menu.help.desc") },
	];
}

export const BALANCER_MENU: SelectItem[] = new Proxy([] as unknown as SelectItem[], {
	get(_target, prop, receiver) {
		const items = balancerMenu();
		if (prop === "length") return items.length;
		if (prop === Symbol.iterator) return items[Symbol.iterator].bind(items);
		if (typeof prop === "string" && !isNaN(Number(prop))) {
			return items[Number(prop)];
		}
		const val = (items as unknown as Record<string | symbol, unknown>)[prop];
		if (typeof val === "function") {
			return val.bind(items);
		}
		return Reflect.get(items, prop, receiver);
	},
});

/** Plain-language glossary shown by `/balancer help`: a title and one line per term. */
export function glossaryText(): string {
	return [t("menu.help.title"), ...["pool", "candidate", "loan", "grant", "breaker", "role", "pace", "resent"].map(term => `  ${t(`menu.help.${term}`)}`)].join("\n");
}

/** `overlay` opens the Control Center (on `tab` when given); `menu` is the flat action list. */
export type BalancerArgs =
	| { kind: "overlay"; tab?: ControlCenterTab }
	| { kind: "menu" }
	| { kind: "command"; command: string }
	| { kind: "unknown"; message: string };

const TAB_COMMANDS: readonly ControlCenterTab[] = ["overview", "roles", "pools", "advisor"];

const SIMPLE = new Set(["panel", "usage", "refresh", "setup", "setup classic", "report", "simulate", "switch-cost", "loans", "help"]);

export function resolveBalancerArgs(args: string): BalancerArgs {
	const command = args.trim();
	if (command === "") return { kind: "overlay" };
	if (command === "menu") return { kind: "menu" };
	const tab = TAB_COMMANDS.find(name => name === command);
	if (tab) return { kind: "overlay", tab };
	if (
		SIMPLE.has(command) ||
		/^(serve|open|simulate)(\s|$)/.test(command) ||
		/^permissions( grant| revoke( \S+)?)?$/.test(command) ||
		/^lab( new| diff| simulate| apply| undo| discard)?$/.test(command) ||
		/^lang(\s+(es|en|auto))?$/.test(command)
	) {
		return { kind: "command", command };
	}
	return {
		kind: "unknown",
		message: t("menu.unknownSubcommand", { command }),
	};
}
