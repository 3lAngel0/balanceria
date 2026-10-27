import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The panel's command line and its systemd user unit. Installing writes the
// unit file only; enabling it stays the user's command.

export const PANEL_PORT = 8788;
export const UNIT_NAME = "pi-panel.service";
export const ENABLE_COMMAND = "systemctl --user daemon-reload && systemctl --user enable --now pi-panel";

export type PanelArgs =
	| { command: "serve"; port: number }
	| { command: "unit" }
	| { command: "install-service" }
	| { command: "help" }
	| { command: "error"; message: string };

const PORT_ERROR = "pi-panel: --port needs a number from 1 to 65535";

export function parsePanelArgs(argv: readonly string[]): PanelArgs {
	const [command, ...rest] = argv;
	if (command === undefined || command === "help" || command === "--help") return { command: "help" };
	if (command === "unit" || command === "install-service") return { command };
	if (command !== "serve") return { command: "error", message: `pi-panel: unknown command ${command}` };
	let port = PANEL_PORT;
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] !== "--port") return { command: "error", message: `pi-panel: unknown option ${rest[i]}` };
		const value = rest[++i];
		if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) return { command: "error", message: PORT_ERROR };
		port = Number(value);
	}
	return { command: "serve", port };
}

/** A systemd word: double-quoted, with `\`, `"` and the specifier `%` escaped. */
const quote = (text: string) => `"${text.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%")}"`;

export function systemdUnit(input: { node: string; entry: string; dataDir: string; port: number }): string {
	return [
		"[Unit]",
		"Description=Pi control panel (ai-balancer)",
		"",
		"[Service]",
		"Type=simple",
		`ExecStart=${quote(input.node)} ${quote(input.entry)} serve --port ${input.port}`,
		`Environment=${quote(`AI_BALANCER_DATA_DIR=${input.dataDir}`)}`,
		"Restart=on-failure",
		"RestartSec=5",
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

export function unitPath(home: string): string {
	return join(home, ".config", "systemd", "user", UNIT_NAME);
}

/** Writes the unit; the same content again is a no-op, different content is refused. */
export function installService(path: string, unit: string): { status: "written" | "unchanged" } {
	if (existsSync(path)) {
		if (readFileSync(path, "utf8") === unit) return { status: "unchanged" };
		throw new Error(`pi-panel: ${path} already exists with different content; remove it first or compare it with \`node packages/panel/src/main.ts unit\``);
	}
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, unit, { mode: 0o644, flag: "wx" });
	chmodSync(path, 0o644);
	return { status: "written" };
}
