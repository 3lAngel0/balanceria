import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, isAbsolute } from "node:path";
import type { CertificateCheck, CertificateKind, TlsConfig } from "./tls-setup.ts";
import { DEFAULT_WEB_PORT, isPrivateAddress } from "./web-server.ts";

// `/balancer serve setup`: a step-by-step wizard that puts the web report on
// the LAN. It never runs sudo: the firewall commands it needs are shown for
// the user to run, and they open the port to the chosen network only.

export interface PrivateNetwork {
	address: string;
	/** CIDR network of the interface, e.g. `192.168.1.0/24`. */
	network: string;
}

function prefixFromNetmask(netmask: string): number {
	return netmask.split(".").reduce((bits, octet) => bits + (Number(octet) >>> 0).toString(2).replace(/0/g, "").length, 0);
}

function networkOf(address: string, prefix: number): string {
	const ip = address.split(".").reduce((value, octet) => (value << 8) + Number(octet), 0) >>> 0;
	const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
	const net = (ip & mask) >>> 0;
	return `${[24, 16, 8, 0].map(shift => (net >>> shift) & 255).join(".")}/${prefix}`;
}

/** The machine's private IPv4 addresses with the network each one sits on. */
export function privateIPv4Networks(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): PrivateNetwork[] {
	const networks: PrivateNetwork[] = [];
	for (const entries of Object.values(ifaces)) {
		for (const entry of entries ?? []) {
			if (entry.family !== "IPv4" || entry.internal || !isPrivateAddress(entry.address)) continue;
			const prefix = entry.cidr ? Number(entry.cidr.split("/")[1]) : prefixFromNetmask(entry.netmask);
			networks.push({ address: entry.address, network: networkOf(entry.address, prefix) });
		}
	}
	return networks;
}

export type FirewallKind = "firewalld" | "ufw" | "none" | "unknown";
export type Runner = (command: string, args: string[]) => Promise<{ stdout: string }>;

/** firewalld or ufw through systemd on Linux; any other system is unknown. */
export async function detectFirewall(run: Runner, platform: string = process.platform): Promise<FirewallKind> {
	if (platform !== "linux") return "unknown";
	for (const kind of ["firewalld", "ufw"] as const) {
		try {
			const { stdout } = await run("systemctl", ["is-active", kind]);
			if (stdout.trim() === "active") return kind;
		} catch {
			// systemctl missing or the unit unknown: not this firewall.
		}
	}
	return "none";
}

/** Commands that open `port` to `network` only; empty when there is nothing to open. */
export function firewallCommands(kind: FirewallKind, network: string, port: number): string[] {
	if (kind === "firewalld") {
		return [
			`sudo firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="${network}" port port="${port}" protocol="tcp" accept'`,
			"sudo firewall-cmd --reload",
		];
	}
	if (kind === "ufw") return [`sudo ufw allow from ${network} to any port ${port} proto tcp`];
	return [];
}

export interface AutostartConfig {
	lan: true;
	port: number;
}

/** `data/web-serve.json`: `{"autostart":{"lan":true,"port":8787},"tls":{"cert":"/abs","key":"/abs"}}`. */
function readServeFile(file: string): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(readFileSync(file, "utf8"));
		return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

/** Sets or removes one key and keeps the others; the file goes away once empty. */
function writeServeKey(file: string, key: string, value: unknown): void {
	const config = readServeFile(file);
	if (value === undefined) delete config[key];
	else config[key] = value;
	if (Object.keys(config).length === 0) {
		rmSync(file, { force: true });
		return;
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(config, null, "\t")}\n`, "utf8");
}

/** Anything but `{"lan":true,"port":1-65535}` means off. */
export function readAutostart(file: string): AutostartConfig | undefined {
	const autostart = readServeFile(file).autostart as { lan?: unknown; port?: unknown } | undefined;
	const port = autostart?.port;
	if (autostart?.lan !== true || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
	return { lan: true, port };
}

export function writeAutostart(file: string, config: AutostartConfig | undefined): void {
	writeServeKey(file, "autostart", config);
}

/** The certificate for HTTPS on the LAN; anything but two absolute paths means plain HTTP. */
export function readTls(file: string): TlsConfig | undefined {
	const tls = readServeFile(file).tls as { cert?: unknown; key?: unknown } | undefined;
	if (typeof tls?.cert !== "string" || typeof tls.key !== "string" || !isAbsolute(tls.cert) || !isAbsolute(tls.key)) return undefined;
	return { cert: tls.cert, key: tls.key };
}

export function writeTls(file: string, config: TlsConfig | undefined): void {
	writeServeKey(file, "tls", config);
}

export interface LanSetupUI {
	confirm(title: string, message: string): Promise<boolean>;
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	notify(message: string, level?: "info" | "warning" | "error"): void;
}

export interface LanSetupDeps {
	ui: LanSetupUI;
	networks(): PrivateNetwork[];
	firewall(): Promise<FirewallKind>;
	running(): { lan: boolean; port: number; tls?: boolean } | undefined;
	stop(): Promise<unknown>;
	/** Starts on the LAN, over HTTPS with `tls`. */
	start(port: number, tls: TlsConfig | undefined): Promise<{ url: string; lanUrls: string[] }>;
	/** HTTP status of the report at `url`, or the error code when it did not answer; over https only to `tls`'s certificate. */
	probe(url: string, tls: TlsConfig | undefined): Promise<number | string>;
	saveAutostart(config: AutostartConfig | undefined): void;
	tls: {
		/** The stored certificate, if any. */
		current(): TlsConfig | undefined;
		create(kind: CertificateKind, addresses: string[]): Promise<{ config: TlsConfig; notes: string[] }>;
		inspect(config: TlsConfig, address: string): CertificateCheck;
		save(config: TlsConfig | undefined): void;
	};
}

const CANCELLED = "ai-balancer: LAN setup cancelled, nothing changed";
const EVERY_START = "Now and every time Pi starts";
const STEPS = 7;
const step = (n: number, title: string) => `LAN setup ${n}/${STEPS}: ${title}`;
const TLS_STEP = 5;
const CHOICES = {
	self: "HTTPS, self-signed certificate (recommended; each device warns once)",
	mkcert: "HTTPS, local CA from mkcert (no warning once its CA is on each device)",
	own: "HTTPS, my own certificate and key",
	plain: "Plain HTTP (no encryption; anyone on this network can read the token)",
};

/** Step 5: the certificate to serve, `undefined` for plain HTTP, `null` when cancelled. */
async function chooseTls(deps: LanSetupDeps, address: string, addresses: string[]): Promise<TlsConfig | undefined | null> {
	const { ui } = deps;
	const current = deps.tls.current();
	const keep = current ? `Keep the current certificate (${current.cert})` : undefined;
	const options = [...(keep ? [keep] : []), CHOICES.self, CHOICES.mkcert, CHOICES.own, CHOICES.plain];
	for (;;) {
		const choice = await ui.select(step(TLS_STEP, "encrypt the traffic (HTTPS)?"), options);
		if (choice === undefined) return null;
		if (choice === CHOICES.plain) return undefined;
		let candidate: TlsConfig;
		let notes: string[] = [];
		if (choice === keep && current) {
			candidate = current;
		} else if (choice === CHOICES.own) {
			const cert = await ui.input(step(TLS_STEP, "certificate file (PEM, absolute path)"));
			if (cert === undefined) return null;
			const key = await ui.input(step(TLS_STEP, "private key file (PEM, absolute path)"));
			if (key === undefined) return null;
			candidate = { cert: cert.trim(), key: key.trim() };
			if (!isAbsolute(candidate.cert) || !isAbsolute(candidate.key)) {
				ui.notify("ai-balancer: use absolute paths for the certificate and the key", "error");
				continue;
			}
		} else {
			try {
				({ config: candidate, notes } = await deps.tls.create(choice === CHOICES.mkcert ? "mkcert" : "self-signed", addresses));
			} catch (error) {
				ui.notify(error instanceof Error ? error.message : String(error), "error");
				continue;
			}
		}
		const check = deps.tls.inspect(candidate, address);
		if (check.error) {
			ui.notify(check.error, "error");
			continue;
		}
		if (check.warnings.length > 0 && !(await ui.confirm(step(TLS_STEP, "use this certificate?"), `${check.warnings.map(w => `- ${w}`).join("\n")}\n\nUse it anyway?`))) continue;
		for (const note of notes) ui.notify(note, "info");
		if (check.fingerprint) ui.notify(`ai-balancer: certificate SHA-256 fingerprint ${check.fingerprint}; when a browser warns, check that it shows this one`, "info");
		return candidate;
	}
}

function parsePort(value: string): number | undefined {
	if (value === "") return DEFAULT_WEB_PORT;
	if (!/^\d{1,5}$/.test(value)) return undefined;
	const port = Number(value);
	return port >= 1 && port <= 65535 ? port : undefined;
}

export async function runLanSetup(deps: LanSetupDeps): Promise<boolean> {
	const { ui } = deps;
	const cancel = () => {
		ui.notify(CANCELLED, "info");
		return false;
	};

	const accepted = await ui.confirm(
		step(1, "before you start"),
		"The web report will answer devices on your local network, never the internet. Over plain HTTP anyone who can sniff this network can read the access token and open sessions in Pi; step 5 offers HTTPS. Continue only on a network you trust (home, not a café or coworking).",
	);
	if (!accepted) return cancel();

	const networks = deps.networks();
	if (networks.length === 0) {
		ui.notify("ai-balancer: no private IPv4 address found on this machine; connect it to your local network and run /balancer serve setup again", "error");
		return false;
	}
	const labels = networks.map(net => `${net.address} (${net.network})`);
	const picked = await ui.select(step(2, "which network should reach the report?"), labels);
	const chosen = picked === undefined ? undefined : networks[labels.indexOf(picked)];
	if (!chosen) return cancel();

	let port: number | undefined;
	while (port === undefined) {
		const raw = await ui.input(step(3, `port (1-65535, empty for ${DEFAULT_WEB_PORT})`), String(DEFAULT_WEB_PORT));
		if (raw === undefined) return cancel();
		port = parsePort(raw.trim());
		if (port === undefined) ui.notify(`ai-balancer: invalid port "${raw.trim()}", use 1-65535`, "error");
	}

	const kind = await deps.firewall();
	const commands = firewallCommands(kind, chosen.network, port);
	let firewallOk: boolean;
	if (commands.length > 0) {
		ui.notify(`ai-balancer: run in a terminal to open the port:\n${commands.join("\n")}`, "info");
		firewallOk = await ui.confirm(
			step(4, `open TCP ${port} in ${kind}`),
			`Run these in a terminal (the wizard never runs sudo); they let only ${chosen.network} reach port ${port}:\n\n${commands.join("\n")}\n\nContinue once they ran?`,
		);
	} else {
		const detected = kind === "none" ? "No active firewalld or ufw detected, so there is nothing to open here." : "The firewall of this system could not be detected.";
		firewallOk = await ui.confirm(
			step(4, "firewall"),
			`${detected} If another firewall, or the router's client isolation, blocks other devices, allow TCP port ${port} from ${chosen.network} there. Continue?`,
		);
	}
	if (!firewallOk) return cancel();

	const tls = await chooseTls(deps, chosen.address, networks.map(net => net.address));
	if (tls === null) return cancel();

	// A certificate is loaded on start, so HTTPS before or after always restarts.
	const running = deps.running();
	if (running && (!running.lan || running.port !== port || running.tls === true || tls !== undefined)) {
		const over = (https: boolean) => (https ? " over HTTPS" : "");
		const restart = await ui.confirm(
			step(6, "restart the web report"),
			`It is running on ${running.lan ? "the LAN" : "localhost only"}, port ${running.port}${over(running.tls === true)}. Stop it and start it on the LAN, port ${port}${over(tls !== undefined)}?`,
		);
		if (!restart) return cancel();
		await deps.stop();
	}

	let lanUrl: string;
	try {
		const server = await deps.start(port, tls);
		lanUrl = server.lanUrls.find(url => new URL(url).hostname === chosen.address) ?? server.lanUrls[0] ?? server.url;
	} catch (error) {
		ui.notify(error instanceof Error ? error.message : String(error), "error");
		return false;
	}

	deps.tls.save(tls);

	const answer = await deps.probe(lanUrl, tls);
	if (answer === 200) ui.notify(`ai-balancer: the report answers at ${chosen.address}:${port} from this machine`, "info");
	else ui.notify(`ai-balancer: the report did not answer at ${chosen.address}:${port} from this machine (${answer})`, "warning");

	const every = (await ui.select(step(7, "start it on the LAN every time Pi starts?"), ["Only now", EVERY_START])) === EVERY_START;
	deps.saveAutostart(every ? { lan: true, port } : undefined);

	ui.notify(`ai-balancer: LAN web report ready. On another device in ${chosen.network} open ${lanUrl} (autostart: ${every ? "on" : "off"})`, "info");
	return true;
}
