import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENABLE_COMMAND, installService, PANEL_PORT, parsePanelArgs, systemdUnit, unitPath } from "../src/service.ts";

test("parsePanelArgs: serve with the default or a given port, unit, install-service, help and errors", () => {
	assert.equal(PANEL_PORT, 8788);
	assert.deepEqual(parsePanelArgs([]), { command: "help" });
	assert.deepEqual(parsePanelArgs(["serve"]), { command: "serve", port: 8788 });
	assert.deepEqual(parsePanelArgs(["serve", "--port", "9000"]), { command: "serve", port: 9000 });
	assert.deepEqual(parsePanelArgs(["serve", "--port", "0"]), { command: "error", message: "pi-panel: --port needs a number from 1 to 65535" });
	assert.deepEqual(parsePanelArgs(["serve", "--port"]), { command: "error", message: "pi-panel: --port needs a number from 1 to 65535" });
	assert.deepEqual(parsePanelArgs(["serve", "--lan"]), { command: "error", message: "pi-panel: unknown option --lan" });
	assert.deepEqual(parsePanelArgs(["unit"]), { command: "unit" });
	assert.deepEqual(parsePanelArgs(["install-service"]), { command: "install-service" });
	assert.deepEqual(parsePanelArgs(["start"]), { command: "error", message: "pi-panel: unknown command start" });
});

test("systemdUnit quotes paths for systemd and escapes %", () => {
	assert.equal(
		systemdUnit({ node: "/opt/node 22/bin/node", entry: "/home/a/my repo/packages/panel/src/main.ts", dataDir: "/home/a/my repo/data%1", port: 8788 }),
		[
			"[Unit]",
			"Description=Pi control panel (ai-balancer)",
			"",
			"[Service]",
			"Type=simple",
			'ExecStart="/opt/node 22/bin/node" "/home/a/my repo/packages/panel/src/main.ts" serve --port 8788',
			'Environment="AI_BALANCER_DATA_DIR=/home/a/my repo/data%%1"',
			"Restart=on-failure",
			"RestartSec=5",
			"",
			"[Install]",
			"WantedBy=default.target",
			"",
		].join("\n"),
	);
	assert.equal(unitPath("/home/a"), "/home/a/.config/systemd/user/pi-panel.service");
	assert.equal(ENABLE_COMMAND, "systemctl --user daemon-reload && systemctl --user enable --now pi-panel");
});

test("installService writes the unit 0644, accepts the same unit again, and never overwrites a different one", () => {
	const home = mkdtempSync(join(tmpdir(), "panel-home-"));
	try {
		const path = unitPath(home);
		assert.deepEqual(installService(path, "unit A\n"), { status: "written" });
		assert.equal(readFileSync(path, "utf8"), "unit A\n");
		assert.equal(statSync(path).mode & 0o777, 0o644);
		assert.deepEqual(installService(path, "unit A\n"), { status: "unchanged" });
		assert.throws(() => installService(path, "unit B\n"), {
			message: `pi-panel: ${path} already exists with different content; remove it first or compare it with \`node packages/panel/src/main.ts unit\``,
		});
		assert.equal(readFileSync(path, "utf8"), "unit A\n", "a refused install leaves the file unchanged");
		writeFileSync(path, "");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});
