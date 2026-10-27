import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SESSIONS_ROOT } from "../../../src/session-index.ts";
import { startPanel } from "./server.ts";
import { ENABLE_COMMAND, installService, PANEL_PORT, parsePanelArgs, systemdUnit, unitPath } from "./service.ts";

// pi-panel: serve | unit | install-service. Runs with Pi open or closed.

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const DATA_DIR = process.env.AI_BALANCER_DATA_DIR || join(REPO_ROOT, "data");
const ENTRY = fileURLToPath(import.meta.url);

const HELP = `Usage: node packages/panel/src/main.ts <command>
  serve [--port N]   serve the panel on 127.0.0.1 (default port ${PANEL_PORT})
  unit               print the systemd user unit
  install-service    write ~/.config/systemd/user/pi-panel.service (does not enable it)
`;

const unit = () => systemdUnit({ node: process.execPath, entry: ENTRY, dataDir: DATA_DIR, port: PANEL_PORT });

async function main(): Promise<number> {
	const args = parsePanelArgs(process.argv.slice(2));
	switch (args.command) {
		case "help":
			process.stdout.write(HELP);
			return 0;
		case "error":
			process.stderr.write(`${args.message}\n${HELP}`);
			return 2;
		case "unit":
			process.stdout.write(unit());
			return 0;
		case "install-service": {
			const path = unitPath(homedir());
			const { status } = installService(path, unit());
			process.stdout.write(`pi-panel: ${status === "written" ? "wrote" : "already installed:"} ${path}\nEnable it with: ${ENABLE_COMMAND}\n`);
			return 0;
		}
		case "serve": {
			const server = await startPanel({ port: args.port, root: DEFAULT_SESSIONS_ROOT, tokenFile: join(DATA_DIR, "web-token"), dataDir: DATA_DIR, poolsPath: join(REPO_ROOT, "pools.json") });
			process.stdout.write(`pi-panel: serving ${server.url}\n`);
			const stop = () => void server.close().then(() => process.exit(0));
			process.once("SIGTERM", stop);
			process.once("SIGINT", stop);
			return -1;
		}
	}
}

main().then(
	code => {
		if (code >= 0) process.exitCode = code;
	},
	(error: unknown) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	},
);
