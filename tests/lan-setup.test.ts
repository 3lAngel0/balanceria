import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	detectFirewall,
	firewallCommands,
	privateIPv4Networks,
	readAutostart,
	readTls,
	runLanSetup,
	writeAutostart,
	writeTls,
	type LanSetupDeps,
} from "../src/lan-setup.ts";

const NET = { address: "192.168.1.20", network: "192.168.1.0/24" };
const TOKEN_URL = (host: string, port: number, scheme = "http") => `${scheme}://${host}:${port}/?token=tok`;
const SELF = { cert: "/data/tls/self-signed/cert.pem", key: "/data/tls/self-signed/key.pem" };
const OWN = { cert: "/etc/own/cert.pem", key: "/etc/own/key.pem" };
const CHOICE = {
	self: "HTTPS, self-signed certificate (recommended; each device warns once)",
	mkcert: "HTTPS, local CA from mkcert (no warning once its CA is on each device)",
	own: "HTTPS, my own certificate and key",
	plain: "Plain HTTP (no encryption; anyone on this network can read the token)",
};

test("privateIPv4Networks pairs each private IPv4 address with its network", () => {
	const ifaces = {
		lo: [{ address: "127.0.0.1", netmask: "255.0.0.0", family: "IPv4", internal: true, cidr: "127.0.0.1/8" }],
		eth0: [
			{ address: "192.168.1.20", netmask: "255.255.255.0", family: "IPv4", internal: false, cidr: "192.168.1.20/24" },
			{ address: "fe80::1", netmask: "ffff:ffff:ffff:ffff::", family: "IPv6", internal: false, cidr: "fe80::1/64" },
		],
		wlan0: [{ address: "10.1.2.3", netmask: "255.255.252.0", family: "IPv4", internal: false, cidr: null }],
		wan0: [{ address: "8.8.8.8", netmask: "255.255.255.0", family: "IPv4", internal: false, cidr: "8.8.8.8/24" }],
	};
	assert.deepEqual(privateIPv4Networks(ifaces as never), [NET, { address: "10.1.2.3", network: "10.1.0.0/22" }]);
});

test("firewall commands open the port only to the chosen network, never run by the wizard", () => {
	assert.deepEqual(firewallCommands("firewalld", "192.168.1.0/24", 8787), [
		`sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="192.168.1.0/24" port port="8787" protocol="tcp" accept'`,
		"sudo firewall-cmd --reload",
	]);
	assert.deepEqual(firewallCommands("ufw", "192.168.1.0/24", 9000), ["sudo ufw allow from 192.168.1.0/24 to any port 9000 proto tcp"]);
	assert.deepEqual(firewallCommands("none", "192.168.1.0/24", 8787), []);
	assert.deepEqual(firewallCommands("unknown", "192.168.1.0/24", 8787), []);
});

test("detectFirewall asks systemd for firewalld, then ufw; other systems are unknown", async () => {
	const runner = (active: string[]) => async (_cmd: string, args: string[]) => ({ stdout: active.includes(args[1]!) ? "active\n" : "inactive\n" });
	assert.equal(await detectFirewall(runner(["firewalld"]), "linux"), "firewalld");
	assert.equal(await detectFirewall(runner(["ufw"]), "linux"), "ufw");
	assert.equal(await detectFirewall(runner([]), "linux"), "none");
	assert.equal(await detectFirewall(async () => { throw new Error("no systemctl"); }, "linux"), "none");
	assert.equal(await detectFirewall(runner(["firewalld"]), "darwin"), "unknown");
});

test("autostart config round-trips, is cleared with undefined, and ignores bad files", () => {
	const dir = mkdtempSync(join(tmpdir(), "lan-setup-"));
	const file = join(dir, "web-serve.json");
	assert.equal(readAutostart(file), undefined);
	writeAutostart(file, { lan: true, port: 9000 });
	assert.deepEqual(readAutostart(file), { lan: true, port: 9000 });
	writeAutostart(file, undefined);
	assert.equal(readAutostart(file), undefined);
	assert.equal(existsSync(file), false);
	writeAutostart(file, undefined);
	for (const bad of ["{", "{}", '{"autostart":{"lan":true,"port":0}}', '{"autostart":{"lan":false,"port":8787}}']) {
		writeFileSync(file, bad);
		assert.equal(readAutostart(file), undefined, bad);
	}
	writeFileSync(file, '{"autostart":{"lan":true,"port":8787}}');
	assert.deepEqual(readAutostart(file), { lan: true, port: 8787 });
});

test("the TLS config shares web-serve.json with autostart, each kept when the other changes", () => {
	const dir = mkdtempSync(join(tmpdir(), "lan-setup-"));
	const file = join(dir, "web-serve.json");
	assert.equal(readTls(file), undefined);
	writeTls(file, OWN);
	writeAutostart(file, { lan: true, port: 9000 });
	assert.deepEqual(readTls(file), OWN);
	assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { tls: OWN, autostart: { lan: true, port: 9000 } });
	writeAutostart(file, undefined);
	assert.deepEqual(readTls(file), OWN);
	writeTls(file, undefined);
	assert.equal(existsSync(file), false);
	for (const bad of ['{"tls":{"cert":"rel/cert.pem","key":"/k"}}', '{"tls":{"cert":"/c"}}', '{"tls":"yes"}']) {
		writeFileSync(file, bad);
		assert.equal(readTls(file), undefined, bad);
	}
});

interface Script {
	confirms?: boolean[];
	selects?: (string | undefined)[];
	inputs?: (string | undefined)[];
}

function fake(script: Script, overrides: Partial<LanSetupDeps> = {}) {
	const log = { notes: [] as [string, string][], titles: [] as string[], messages: [] as string[], started: [] as number[], startedTls: [] as unknown[], stopped: 0, saved: [] as unknown[], savedTls: [] as unknown[], created: [] as string[], probed: [] as string[] };
	const confirms = [...(script.confirms ?? [])];
	const selects = [...(script.selects ?? [])];
	const inputs = [...(script.inputs ?? [])];
	const deps: LanSetupDeps = {
		ui: {
			confirm: async (title, message) => {
				log.titles.push(title);
				log.messages.push(message);
				return confirms.shift() ?? false;
			},
			select: async (title, options) => {
				log.titles.push(title);
				log.messages.push(options.join(" | "));
				return selects.shift();
			},
			input: async title => {
				log.titles.push(title);
				log.messages.push("");
				return inputs.shift();
			},
			notify: (message, level = "info") => void log.notes.push([level, message]),
		},
		networks: () => [NET],
		firewall: async () => "firewalld",
		running: () => undefined,
		stop: async () => void (log.stopped += 1),
		start: async (port, tls) => {
			log.started.push(port);
			log.startedTls.push(tls);
			const scheme = tls ? "https" : "http";
			return { url: TOKEN_URL("127.0.0.1", port, scheme), lanUrls: [TOKEN_URL("192.168.1.20", port, scheme)] };
		},
		probe: async (url, tls) => {
			log.probed.push(tls ? `${url} pinned ${tls.cert}` : url);
			return 200;
		},
		saveAutostart: config => void log.saved.push(config),
		tls: {
			current: () => undefined,
			create: async (kind, addresses) => {
				log.created.push(`${kind} ${addresses.join(",")}`);
				return { config: SELF, notes: [] };
			},
			inspect: () => ({ warnings: [], fingerprint: "AA:BB" }),
			save: config => void log.savedTls.push(config),
		},
		...overrides,
	};
	return { deps, log };
}

const HAPPY: Script = { confirms: [true, true], selects: ["192.168.1.20 (192.168.1.0/24)", CHOICE.self, "Now and every time Pi starts"], inputs: [""] };
const PLAIN: Script = { ...HAPPY, selects: [HAPPY.selects![0], CHOICE.plain, HAPPY.selects![2]] };

test("the happy path walks seven steps, creates a self-signed certificate, starts HTTPS on the LAN, probes it pinned and saves", async () => {
	const { deps, log } = fake(HAPPY);
	assert.equal(await runLanSetup(deps), true);
	assert.deepEqual(log.titles, [
		"LAN setup 1/7: before you start",
		"LAN setup 2/7: which network should reach the report?",
		"LAN setup 3/7: port (1-65535, empty for 8787)",
		"LAN setup 4/7: open TCP 8787 in firewalld",
		"LAN setup 5/7: encrypt the traffic (HTTPS)?",
		"LAN setup 7/7: start it on the LAN every time Pi starts?",
	]);
	assert.match(log.messages[0]!, /step 5 offers HTTPS/);
	assert.match(log.messages[3]!, /sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="192.168.1.0\/24" port port="8787" protocol="tcp" accept'/);
	assert.match(log.messages[3]!, /never runs sudo/);
	assert.equal(log.messages[4], [CHOICE.self, CHOICE.mkcert, CHOICE.own, CHOICE.plain].join(" | "));
	assert.deepEqual(log.created, ["self-signed 192.168.1.20"]);
	assert.ok(log.notes.some(([level, message]) => level === "info" && message === "ai-balancer: certificate SHA-256 fingerprint AA:BB; when a browser warns, check that it shows this one"));
	assert.deepEqual(log.started, [8787]);
	assert.deepEqual(log.startedTls, [SELF]);
	assert.deepEqual(log.probed, [`https://192.168.1.20:8787/?token=tok pinned ${SELF.cert}`]);
	assert.deepEqual(log.savedTls, [SELF]);
	assert.deepEqual(log.saved, [{ lan: true, port: 8787 }]);
	assert.deepEqual(log.notes.at(-1), ["info", "ai-balancer: LAN web report ready. On another device in 192.168.1.0/24 open https://192.168.1.20:8787/?token=tok (autostart: on)"]);
	// The firewall commands also land in the chat, to copy them.
	assert.ok(log.notes.some(([, message]) => message.includes("sudo firewall-cmd --reload")));
});

test("declining the risk notice changes nothing", async () => {
	const { deps, log } = fake({ confirms: [false] });
	assert.equal(await runLanSetup(deps), false);
	assert.deepEqual(log.started, []);
	assert.deepEqual(log.saved, []);
	assert.deepEqual(log.notes, [["info", "ai-balancer: LAN setup cancelled, nothing changed"]]);
});

test("without a private network the setup stops with how to fix it", async () => {
	const { deps, log } = fake({ confirms: [true] }, { networks: () => [] });
	assert.equal(await runLanSetup(deps), false);
	assert.deepEqual(log.started, []);
	assert.deepEqual(log.notes, [["error", "ai-balancer: no private IPv4 address found on this machine; connect it to your local network and run /balancer serve setup again"]]);
});

test("a bad port is explained and asked again; esc on any step cancels", async () => {
	const { deps, log } = fake({ ...HAPPY, inputs: ["80a", "70000", "9000"] });
	assert.equal(await runLanSetup(deps), true);
	assert.deepEqual(log.started, [9000]);
	assert.deepEqual(log.notes.slice(0, 2), [
		["error", 'ai-balancer: invalid port "80a", use 1-65535'],
		["error", 'ai-balancer: invalid port "70000", use 1-65535'],
	]);
	for (const script of [{ confirms: [true], selects: [undefined] }, { confirms: [true], selects: [HAPPY.selects![0]], inputs: [undefined] }, { confirms: [true, false], selects: [HAPPY.selects![0]], inputs: [""] }]) {
		const run = fake(script);
		assert.equal(await runLanSetup(run.deps), false);
		assert.deepEqual(run.log.started, []);
		assert.deepEqual(run.log.notes.at(-1), ["info", "ai-balancer: LAN setup cancelled, nothing changed"]);
	}
});

test("with no detected firewall it says so and what to check instead", async () => {
	const { deps, log } = fake(HAPPY, { firewall: async () => "none" });
	assert.equal(await runLanSetup(deps), true);
	assert.equal(log.titles[3], "LAN setup 4/7: firewall");
	assert.match(log.messages[3]!, /No active firewalld or ufw detected/);
	assert.match(log.messages[3]!, /TCP port 8787 from 192\.168\.1\.0\/24/);
});

test("a server running in another mode or port is restarted only after confirming", async () => {
	const running = { running: () => ({ lan: false, port: 8787 }) };
	const yes = fake({ ...PLAIN, confirms: [true, true, true] }, running);
	assert.equal(await runLanSetup(yes.deps), true);
	assert.equal(yes.log.titles[5], "LAN setup 6/7: restart the web report");
	assert.match(yes.log.messages[5]!, /running on localhost only, port 8787\. Stop it and start it on the LAN, port 8787\?/);
	assert.equal(yes.log.stopped, 1);
	assert.deepEqual(yes.log.started, [8787]);

	const no = fake({ ...PLAIN, confirms: [true, true, false] }, running);
	assert.equal(await runLanSetup(no.deps), false);
	assert.equal(no.log.stopped, 0);
	assert.deepEqual(no.log.started, []);

	const same = fake(PLAIN, { running: () => ({ lan: true, port: 8787, tls: false }) });
	assert.equal(await runLanSetup(same.deps), true);
	assert.equal(same.log.stopped, 0);

	// A new certificate is only loaded on start, so HTTPS always restarts a running server.
	const https = fake({ ...HAPPY, confirms: [true, true, true] }, { running: () => ({ lan: true, port: 8787, tls: true }) });
	assert.equal(await runLanSetup(https.deps), true);
	assert.match(https.log.messages[5]!, /running on the LAN, port 8787 over HTTPS\. Stop it and start it on the LAN, port 8787 over HTTPS\?/);
	assert.equal(https.log.stopped, 1);
});

test("a start failure is reported and nothing is saved", async () => {
	const { deps, log } = fake(HAPPY, { start: async () => { throw new Error("ai-balancer: port 8787 is already in use; try /balancer serve <port>"); } });
	assert.equal(await runLanSetup(deps), false);
	assert.deepEqual(log.saved, []);
	assert.deepEqual(log.savedTls, []);
	assert.deepEqual(log.notes.at(-1), ["error", "ai-balancer: port 8787 is already in use; try /balancer serve <port>"]);
});

test("a failed self-check warns but the setup still finishes; only-now clears autostart", async () => {
	const { deps, log } = fake({ ...HAPPY, selects: [HAPPY.selects![0], CHOICE.self, "Only now"] }, { probe: async () => "ECONNREFUSED" });
	assert.equal(await runLanSetup(deps), true);
	assert.ok(log.notes.some(([level, message]) => level === "warning" && message === "ai-balancer: the report did not answer at 192.168.1.20:8787 from this machine (ECONNREFUSED)"));
	assert.deepEqual(log.saved, [undefined]);
	assert.match(log.notes.at(-1)![1], /\(autostart: off\)$/);
});

test("plain HTTP starts without TLS and clears the stored certificate", async () => {
	const { deps, log } = fake(PLAIN);
	assert.equal(await runLanSetup(deps), true);
	assert.deepEqual(log.created, []);
	assert.deepEqual(log.startedTls, [undefined]);
	assert.deepEqual(log.probed, ["http://192.168.1.20:8787/?token=tok"]);
	assert.deepEqual(log.savedTls, [undefined]);
	assert.match(log.notes.at(-1)![1], /open http:\/\/192\.168\.1\.20:8787/);
});

test("a stored certificate can be kept, and is offered first", async () => {
	const keep = `Keep the current certificate (${OWN.cert})`;
	const { deps, log } = fake({ ...HAPPY, selects: [HAPPY.selects![0], keep, HAPPY.selects![2]] }, { running: () => undefined });
	deps.tls.current = () => OWN;
	assert.equal(await runLanSetup(deps), true);
	assert.equal(log.messages[4], [keep, CHOICE.self, CHOICE.mkcert, CHOICE.own, CHOICE.plain].join(" | "));
	assert.deepEqual(log.created, []);
	assert.deepEqual(log.startedTls, [OWN]);
});

test("an own certificate is asked by path; an unusable pair is explained and the step asked again", async () => {
	const checked: string[] = [];
	const { deps, log } = fake({ ...HAPPY, selects: [HAPPY.selects![0], CHOICE.own, CHOICE.own, HAPPY.selects![2]], inputs: ["", "/bad/cert.pem", "/bad/key.pem", OWN.cert, OWN.key] });
	deps.tls.inspect = (config, address) => {
		checked.push(`${config.cert} ${address}`);
		return config.cert === OWN.cert ? { warnings: [], fingerprint: "CC" } : { error: "ai-balancer: the TLS key /bad/key.pem does not match the certificate /bad/cert.pem", warnings: [] };
	};
	assert.equal(await runLanSetup(deps), true);
	assert.ok(log.titles.includes("LAN setup 5/7: certificate file (PEM, absolute path)"));
	assert.ok(log.titles.includes("LAN setup 5/7: private key file (PEM, absolute path)"));
	assert.deepEqual(checked, ["/bad/cert.pem 192.168.1.20", `${OWN.cert} 192.168.1.20`]);
	assert.ok(log.notes.some(([level, message]) => level === "error" && message === "ai-balancer: the TLS key /bad/key.pem does not match the certificate /bad/cert.pem"));
	assert.deepEqual(log.startedTls, [OWN]);
	assert.deepEqual(log.savedTls, [OWN]);
});

test("a relative path is refused before it is read", async () => {
	const { deps, log } = fake({ ...HAPPY, selects: [HAPPY.selects![0], CHOICE.own, CHOICE.plain, HAPPY.selects![2]], inputs: ["", "cert.pem", "key.pem"] });
	let inspected = 0;
	deps.tls.inspect = () => ((inspected += 1), { warnings: [] });
	assert.equal(await runLanSetup(deps), true);
	assert.equal(inspected, 0);
	assert.ok(log.notes.some(([level, message]) => level === "error" && message === "ai-balancer: use absolute paths for the certificate and the key"));
});

test("certificate warnings need a confirmation; declining asks the step again", async () => {
	const { deps, log } = fake({ confirms: [true, true, false, true], selects: [HAPPY.selects![0], CHOICE.self, CHOICE.self, HAPPY.selects![2]], inputs: [""] });
	deps.tls.inspect = () => ({ warnings: ["the certificate does not name 192.168.1.20, so browsers reject it at that address"], fingerprint: "AA" });
	assert.equal(await runLanSetup(deps), true);
	assert.equal(log.titles.filter(title => title === "LAN setup 5/7: use this certificate?").length, 2);
	assert.match(log.messages[log.titles.indexOf("LAN setup 5/7: use this certificate?")]!, /does not name 192\.168\.1\.20/);
	assert.deepEqual(log.created.length, 2);
});

test("a failed certificate creation is explained and the step asked again; mkcert notes reach the user; esc cancels", async () => {
	const { deps, log } = fake({ ...HAPPY, selects: [HAPPY.selects![0], CHOICE.mkcert, CHOICE.mkcert, HAPPY.selects![2]] });
	let attempts = 0;
	deps.tls.create = async kind => {
		attempts += 1;
		if (attempts === 1) throw new Error("ai-balancer: mkcert not found; install it (https://github.com/FiloSottile/mkcert) or pick another option");
		return { config: { cert: `/d/${kind}/cert.pem`, key: `/d/${kind}/key.pem` }, notes: ["ai-balancer: install /ca/rootCA.pem as a trusted CA"] };
	};
	assert.equal(await runLanSetup(deps), true);
	assert.ok(log.notes.some(([level, message]) => level === "error" && message.startsWith("ai-balancer: mkcert not found")));
	assert.ok(log.notes.some(([level, message]) => level === "info" && message === "ai-balancer: install /ca/rootCA.pem as a trusted CA"));
	assert.deepEqual(log.startedTls, [{ cert: "/d/mkcert/cert.pem", key: "/d/mkcert/key.pem" }]);

	const esc = fake({ ...HAPPY, selects: [HAPPY.selects![0], undefined] });
	assert.equal(await runLanSetup(esc.deps), false);
	assert.deepEqual(esc.log.started, []);
	assert.deepEqual(esc.log.savedTls, []);
	assert.deepEqual(esc.log.notes.at(-1), ["info", "ai-balancer: LAN setup cancelled, nothing changed"]);
});
