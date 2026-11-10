import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setLang } from "../src/i18n/index.ts";
import { cellWidth } from "../src/tui-box.ts";
import {
	FORWARD_ROW_Y,
	initRemoteForwardState,
	remoteForwardInput,
	renderRemoteForwardPrompt,
	startLanForwarder,
	applyLanFirewall,
	getFirewallDetails,
	initFirewallPromptState,
	firewallPromptInput,
	renderFirewallPrompt,
} from "../src/installer-remote-forward.ts";

const key = (data: string) => ({ type: "key" as const, data });
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\uE000[\uE010-\uE01F]|\uE001/g, "");

test("remote forward prompt starts on ssh, not done", () => {
	const s = initRemoteForwardState([]);
	assert.equal(s.selected, "ssh");
	assert.equal(s.done, false);
	assert.equal(s.cancelled, false);
});

test("remote forward prompt input: 1/2/3/4, arrows, j/k and Tab navigate options", () => {
	let s = initRemoteForwardState([]);
	s = remoteForwardInput(s, key("2"));
	assert.equal(s.selected, "lan");
	s = remoteForwardInput(s, key("3"));
	assert.equal(s.selected, "firewall");
	s = remoteForwardInput(s, key("4"));
	assert.equal(s.selected, "skip");
	s = remoteForwardInput(s, key("1"));
	assert.equal(s.selected, "ssh");

	// Arrow down
	s = remoteForwardInput(s, key("\x1b[B"));
	assert.equal(s.selected, "lan");
	s = remoteForwardInput(s, key("\x1b[B"));
	assert.equal(s.selected, "firewall");
	s = remoteForwardInput(s, key("\x1b[A"));
	assert.equal(s.selected, "lan");
});

test("remote forward prompt confirms on Enter/Space, cancels on Esc/q", () => {
	assert.equal(remoteForwardInput(initRemoteForwardState([]), key("\r")).done, true);
	assert.equal(remoteForwardInput(initRemoteForwardState([]), key(" ")).done, true);
	assert.equal(remoteForwardInput(initRemoteForwardState([]), key("\x1b")).cancelled, true);
	assert.equal(remoteForwardInput(initRemoteForwardState([]), key("q")).cancelled, true);
});

test("remote forward mouse click confirms clicked option", () => {
	const s = remoteForwardInput(initRemoteForwardState([]), { type: "mouse", kind: "click", x: 5, y: FORWARD_ROW_Y.lan });
	assert.equal(s.selected, "lan");
	assert.equal(s.done, true);
});

test("remote forward renders in English and Spanish at exact widths", () => {
	for (const [lang, title, sshOpt] of [
		["en", "Remote Web Access & Port Forwarding", "SSH Tunnel"],
		["es", "Acceso Web Remoto y Reenvío de Puertos", "Túnel SSH"],
	] as const) {
		setLang(lang);
		const lines = renderRemoteForwardPrompt(initRemoteForwardState([]), 70, "none");
		const text = lines.map(strip).join("\n");
		assert.ok(text.includes(title), `missing title in ${lang}`);
		assert.ok(text.includes(sshOpt), `missing ssh option in ${lang}`);
		for (const l of lines) assert.equal(cellWidth(l), 70);
	}
	setLang("en");
});

test("startLanForwarder proxies requests to target port and rewrites Host to loopback", async () => {
	let receivedHost = "";
	let receivedUrl = "";

	const targetServer = createServer((req, res) => {
		receivedHost = req.headers.host ?? "";
		receivedUrl = req.url ?? "";
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ ok: true }));
	});

	await new Promise<void>(resolve => targetServer.listen(0, "127.0.0.1", resolve));
	const targetPort = (targetServer.address() as any).port;

	const forwarder = await startLanForwarder(targetPort, 0);
	try {
		assert.ok(forwarder.port > 0);
		const resp = await fetch(`http://127.0.0.1:${forwarder.port}/installer?token=secret123`, {
			headers: { host: "192.168.1.100:9999" }
		});
		assert.equal(resp.status, 200);
		const data = await resp.json();
		assert.deepEqual(data, { ok: true });
		assert.equal(receivedHost, `127.0.0.1:${targetPort}`);
		assert.equal(receivedUrl, "/installer?token=secret123");
	} finally {
		await forwarder.close();
		await new Promise<void>(resolve => targetServer.close(() => resolve()));
	}
});

test("applyLanFirewall returns safe result without crashing", async () => {
	const res = await applyLanFirewall(8787);
	assert.equal(typeof res.success, "boolean");
	assert.ok(res.message.length > 0);
});

test("firewall prompt state navigation and confirmation", () => {
	const details = {
		kind: "firewalld" as const,
		network: "192.168.1.0/24",
		commands: ["sudo firewall-cmd ..."],
		commandString: "sudo firewall-cmd ...",
	};
	let s = initFirewallPromptState(details);
	assert.equal(s.selected, "run");
	assert.equal(s.done, false);

	// Toggle down
	s = firewallPromptInput(s, key("\x1b[B"));
	assert.equal(s.selected, "back");

	// Key 1 selects run and marks done
	s = firewallPromptInput(s, key("1"));
	assert.equal(s.selected, "run");
	assert.equal(s.done, true);

	// Key 2 selects back and marks done
	s = initFirewallPromptState(details);
	s = firewallPromptInput(s, key("2"));
	assert.equal(s.selected, "back");
	assert.equal(s.done, true);

	// Esc cancels
	s = initFirewallPromptState(details);
	s = firewallPromptInput(s, key("\x1b"));
	assert.equal(s.cancelled, true);
});

test("firewall prompt renders commands and options in EN and ES", () => {
	const details = {
		kind: "firewalld" as const,
		network: "192.168.68.0/24",
		commands: ["sudo firewall-cmd --permanent --add-port=8787/tcp", "sudo firewall-cmd --reload"],
		commandString: "sudo firewall-cmd --permanent --add-port=8787/tcp && sudo firewall-cmd --reload",
	};
	for (const [lang, title, runLabel] of [
		["en", "Linux Firewall Configuration", "Run command now"],
		["es", "Configuración de Firewall Linux", "Ejecutar comando ahora"],
	] as const) {
		setLang(lang);
		const lines = renderFirewallPrompt(initFirewallPromptState(details), 72, "none");
		const text = lines.map(strip).join("\n");
		assert.ok(text.includes(title), `missing title in ${lang}`);
		assert.ok(text.includes(runLabel), `missing run label in ${lang}`);
		assert.ok(text.includes("sudo firewall-cmd --reload"));
		for (const l of lines) assert.equal(cellWidth(l), 72);
	}
	setLang("en");
});

test("getFirewallDetails returns valid network and command string", async () => {
	const details = await getFirewallDetails(8787);
	assert.ok(details.kind);
	assert.ok(details.network.includes("/"));
	assert.equal(typeof details.commandString, "string");
});

