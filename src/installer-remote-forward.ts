// Remote access & LAN forwarding prompt for the web installer.
// When running in a remote SSH session, this allows running an in-process LAN forwarder
// or executing firewall commands interactively in the terminal with full paste and sudo support.

import { createServer, request as httpRequest, type Server } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { t } from "./i18n/index.ts";
import { box } from "./tui-box.ts";
import { pixelText, type ColorMode } from "./pixel.ts";
import { privateIPv4Networks, detectFirewall, firewallCommands, type FirewallKind, type PrivateNetwork } from "./lan-setup.ts";

const execFileAsync = promisify(execFile);

export type RemoteForwardOption = "ssh" | "lan" | "firewall" | "skip";

export interface RemoteForwardState {
	selected: RemoteForwardOption;
	done: boolean;
	cancelled: boolean;
	forwarderRunning: boolean;
	forwarderPort?: number;
	firewallKind?: FirewallKind;
	networks: PrivateNetwork[];
}

export type RemoteForwardEvent =
	| { type: "key"; data: string }
	| { type: "mouse"; kind: "click"; y: number; x: number };

export const FORWARD_ROW_Y = { ssh: 3, lan: 4, firewall: 5, skip: 6 } as const;

export function initRemoteForwardState(networks: PrivateNetwork[] = privateIPv4Networks()): RemoteForwardState {
	return {
		selected: "ssh",
		done: false,
		cancelled: false,
		forwarderRunning: false,
		networks,
	};
}

const TOGGLE_DOWN = new Set(["\x1b[B", "\x1bOB", "j", "\t"]);
const TOGGLE_UP = new Set(["\x1b[A", "\x1bOA", "k", "\x1b[Z"]);
const CONFIRM = new Set(["\r", "\n", " ", "\x1b[13u", "\x1b[32u"]);
const ORDER: RemoteForwardOption[] = ["ssh", "lan", "firewall", "skip"];

export function remoteForwardInput(state: RemoteForwardState, event: RemoteForwardEvent): RemoteForwardState {
	if (state.done || state.cancelled) return state;
	if (event.type === "mouse") {
		const hit = (Object.keys(FORWARD_ROW_Y) as RemoteForwardOption[]).find(k => event.y === FORWARD_ROW_Y[k]);
		return hit ? { ...state, selected: hit, done: true } : state;
	}
	const raw = event.data;
	if (raw === "1") return { ...state, selected: "ssh" };
	if (raw === "2") return { ...state, selected: "lan" };
	if (raw === "3") return { ...state, selected: "firewall" };
	if (raw === "4") return { ...state, selected: "skip" };

	const idx = ORDER.indexOf(state.selected);
	if (TOGGLE_DOWN.has(raw)) {
		const next = ORDER[(idx + 1) % ORDER.length]!;
		return { ...state, selected: next };
	}
	if (TOGGLE_UP.has(raw)) {
		const prev = ORDER[(idx - 1 + ORDER.length) % ORDER.length]!;
		return { ...state, selected: prev };
	}
	if (CONFIRM.has(raw)) return { ...state, done: true };
	if (raw === "\x1b" || raw === "\x1b[27u" || raw.toLowerCase() === "q") return { ...state, cancelled: true };
	return state;
}

export function renderRemoteForwardPrompt(state: RemoteForwardState, width: number, mode: ColorMode = "none"): string[] {
	const option = (key: RemoteForwardOption, n: number) => {
		const on = state.selected === key;
		const label = `[ ${n} ] ${t(`installer.remote.opt.${key}`)}`;
		return `  ${on ? "▸ " : "  "}${on ? pixelText("sky", label, mode) : label}`;
	};
	const body = [
		t("installer.remote.choose"),
		"",
		option("ssh", 1),
		option("lan", 2),
		option("firewall", 3),
		option("skip", 4),
		"",
		pixelText("gold", t("installer.channel.hintEnter"), mode),
		pixelText("steel", t("installer.channel.hintEsc"), mode),
	];
	return box(t("installer.remote.title"), body, Math.max(48, width));
}

export interface FirewallDetails {
	kind: FirewallKind;
	network: string;
	commands: string[];
	commandString: string;
}

export async function getFirewallDetails(port: number): Promise<FirewallDetails> {
	let kind: FirewallKind = "none";
	try {
		kind = await detectFirewall(async (cmd, args) => {
			const { stdout } = await execFileAsync(cmd, args);
			return { stdout };
		});
	} catch {
		kind = "unknown";
	}
	const networks = privateIPv4Networks();
	const network = networks[0]?.network ?? "192.168.0.0/16";
	const commands = firewallCommands(kind, network, port);
	return {
		kind,
		network,
		commands,
		commandString: commands.join(" && "),
	};
}

export interface FirewallPromptState {
	selected: "run" | "back";
	done: boolean;
	cancelled: boolean;
	details: FirewallDetails;
}

export function initFirewallPromptState(details: FirewallDetails): FirewallPromptState {
	return {
		selected: "run",
		done: false,
		cancelled: false,
		details,
	};
}

export function firewallPromptInput(state: FirewallPromptState, event: RemoteForwardEvent): FirewallPromptState {
	if (state.done || state.cancelled) return state;
	const raw = event.data;
	if (raw === "1") return { ...state, selected: "run", done: true };
	if (raw === "2") return { ...state, selected: "back", done: true };
	if (TOGGLE_DOWN.has(raw) || TOGGLE_UP.has(raw)) {
		return { ...state, selected: state.selected === "run" ? "back" : "run" };
	}
	if (CONFIRM.has(raw)) return { ...state, done: true };
	if (raw === "\x1b" || raw === "\x1b[27u" || raw.toLowerCase() === "q") return { ...state, cancelled: true };
	return state;
}

export function renderFirewallPrompt(state: FirewallPromptState, width: number, mode: ColorMode = "none"): string[] {
	const opt = (key: "run" | "back", label: string) => {
		const on = state.selected === key;
		return `  ${on ? "▸ " : "  "}${on ? pixelText("sky", label, mode) : label}`;
	};
	const cmds = state.details.commands.length > 0 ? state.details.commands : [state.details.commandString || "sudo firewall-cmd ..."];
	const body = [
		`${t("installer.firewall.intro")} (${state.details.kind}, ${state.details.network}):`,
		"",
		pixelText("gold", "  Command to execute:", mode),
		...cmds.map(c => `    ${c}`),
		"",
		opt("run", t("installer.firewall.opt.run")),
		opt("back", t("installer.firewall.opt.back")),
		"",
		pixelText("gold", t("installer.channel.hintEnter"), mode),
		pixelText("steel", t("installer.channel.hintEsc"), mode),
	];
	return box(t("installer.firewall.title"), body, Math.max(56, width));
}

/** Executes an interactive command in the terminal with normal cooked mode so password pasting works natively. */
export async function runInteractiveCommand(cmd: string): Promise<{ success: boolean; code: number }> {
	const stdin = process.stdin;
	const stdout = process.stdout;
	const wasRaw = Boolean((stdin as any).isRaw);

	stdout.write("\x1b[2J\x1b[0;0H");
	stdout.write("\n================================================================================\n");
	stdout.write(` ai-balancer: Executing Linux firewall command with sudo:\n`);
	stdout.write(` > ${cmd}\n`);
	stdout.write("================================================================================\n\n");

	if (typeof (stdin as any).setRawMode === "function") {
		(stdin as any).setRawMode(false);
	}
	stdin.pause();

	return new Promise(resolve => {
		const child = spawn(cmd, { stdio: "inherit", shell: true });
		child.on("close", code => {
			stdout.write("\n--------------------------------------------------------------------------------\n");
			if (code === 0) {
				stdout.write(" ✓ Firewall rule applied successfully!\n");
			} else {
				stdout.write(` ✗ Command exited with code ${code}.\n`);
			}
			stdout.write(" Press Enter to return to ai-balancer...");

			stdin.resume();
			const onData = () => {
				stdin.removeListener("data", onData);
				if (typeof (stdin as any).setRawMode === "function" && wasRaw) {
					(stdin as any).setRawMode(true);
				}
				resolve({ success: code === 0, code: code ?? 1 });
			};
			stdin.once("data", onData);
		});
		child.on("error", err => {
			stdout.write(`\n Error launching process: ${err.message}\n`);
			stdin.resume();
			if (typeof (stdin as any).setRawMode === "function" && wasRaw) {
				(stdin as any).setRawMode(true);
			}
			resolve({ success: false, code: 1 });
		});
	});
}

/** Starts a lightweight HTTP reverse proxy listening on 0.0.0.0 that rewrites the Host header to 127.0.0.1:targetPort. */
export async function startLanForwarder(targetPort: number, requestedPort = 0): Promise<{ port: number; lanUrls: (token: string) => string[]; close: () => Promise<void> }> {
	const networks = privateIPv4Networks();
	return new Promise((resolve, reject) => {
		const server: Server = createServer((req, res) => {
			const options = {
				hostname: "127.0.0.1",
				port: targetPort,
				path: req.url,
				method: req.method,
				headers: {
					...req.headers,
					host: `127.0.0.1:${targetPort}`,
				},
			};
			const proxyReq = httpRequest(options, proxyRes => {
				res.writeHead(proxyRes.statusCode ?? 500, proxyRes.headers);
				proxyRes.pipe(res);
			});
			proxyReq.on("error", err => {
				if (!res.headersSent) {
					res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
				}
				res.end(`ai-balancer LAN forwarder error: ${err.message}\n`);
			});
			req.pipe(proxyReq);
		});

		server.listen(requestedPort, "0.0.0.0", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : targetPort;
			resolve({
				port,
				lanUrls: (token: string) =>
					networks.map(n => `http://${n.address}:${port}/installer?token=${token}`),
				close: () => new Promise<void>(res => server.close(() => res())),
			});
		});
		server.on("error", reject);
	});
}

/** Applies firewall rule if on Linux (firewalld / ufw) for the LAN network (non-interactive fallback). */
export async function applyLanFirewall(port: number): Promise<{ success: boolean; command?: string; message: string }> {
	try {
		const details = await getFirewallDetails(port);
		if (details.kind === "none" || details.kind === "unknown") {
			return { success: true, message: "No active firewalld or ufw detected." };
		}
		if (details.commands.length === 0) return { success: true, message: "No firewall commands needed." };

		try {
			await execFileAsync("sh", ["-c", details.commandString]);
			return { success: true, command: details.commandString, message: "Firewall rule applied successfully." };
		} catch (err) {
			return { success: false, command: details.commandString, message: err instanceof Error ? err.message : String(err) };
		}
	} catch (err) {
		return { success: false, message: err instanceof Error ? err.message : String(err) };
	}
}

