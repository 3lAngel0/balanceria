import { hostname, userInfo } from "node:os";
import { DEFAULT_WEB_PORT, startWebServer, type OpenResult, type TlsMaterial, type WebServer } from "./web-server.ts";
import { webPageHtml, webPageScript, webPageStyle } from "./web-page.ts";

// One web server per Pi process. Switching sessions tears the extension down
// and loads a new instance, so the server lives on globalThis and every new
// instance re-binds its handlers on session_start; the server itself only
// stops on `/balancer serve stop` or when Pi quits.

export interface WebHandlers {
	getReport(): unknown;
	getSession(id: string): unknown;
	openSession(id: string): Promise<OpenResult>;
}

interface ServeState {
	server: WebServer;
	handlers: WebHandlers;
}

const STATE = Symbol.for("ai-balancer.web-serve");
type Holder = { [STATE]?: ServeState };
const holder = globalThis as Holder;

export function runningWebServer(): WebServer | undefined {
	return holder[STATE]?.server;
}

/** The latest extension instance answers; a no-op while nothing is served. */
export function bindWebHandlers(handlers: WebHandlers): void {
	const state = holder[STATE];
	if (state) state.handlers = handlers;
}

export async function startServing(options: { port: number; lan?: boolean; tls?: TlsMaterial; tokenFile: string; handlers: WebHandlers }): Promise<{ server: WebServer; started: boolean }> {
	const running = holder[STATE];
	if (running) {
		const lan = options.lan === true;
		if (lan !== running.server.lan) {
			throw new Error(`ai-balancer: already serving ${running.server.lan ? "on the LAN" : "on localhost only"}; run /balancer serve stop first`);
		}
		if ((options.tls !== undefined) !== running.server.tls) {
			throw new Error(`ai-balancer: already serving over ${running.server.tls ? "HTTPS" : "plain HTTP"}; run /balancer serve stop first`);
		}
		if (options.port !== 0 && options.port !== running.server.port) {
			throw new Error(`ai-balancer: already serving on port ${running.server.port}; run /balancer serve stop first`);
		}
		running.handlers = options.handlers;
		return { server: running.server, started: false };
	}
	const pending: { handlers: WebHandlers } = { handlers: options.handlers };
	const current = () => holder[STATE]?.handlers ?? pending.handlers;
	const server = await startWebServer({
		port: options.port,
		lan: options.lan === true,
		tls: options.tls,
		tokenFile: options.tokenFile,
		page: webPageHtml,
		script: webPageScript,
		style: webPageStyle,
		getReport: () => current().getReport(),
		getSession: id => current().getSession(id),
		openSession: id => current().openSession(id),
	});
	holder[STATE] = { server, handlers: options.handlers };
	return { server, started: true };
}

export async function stopServing(): Promise<boolean> {
	const state = holder[STATE];
	if (!state) return false;
	delete holder[STATE];
	await state.server.close();
	return true;
}

export type ServeArgs = { action: "start"; port: number; lan?: true } | { action: "stop" } | { action: "status" } | { action: "setup" } | { action: "autostart-off" } | { action: "error"; message: string };

const USAGE = "ai-balancer: usage: /balancer serve [lan] [port] | setup | stop | status | autostart off, port 1-65535";

function parsePort(value: string): number | undefined {
	if (!/^\d{1,5}$/.test(value)) return undefined;
	const port = Number(value);
	return port >= 1 && port <= 65535 ? port : undefined;
}

export function parseServeArgs(args: string): ServeArgs {
	const value = args.trim();
	if (value === "") return { action: "start", port: DEFAULT_WEB_PORT };
	if (value === "stop") return { action: "stop" };
	if (value === "status") return { action: "status" };
	if (value === "setup") return { action: "setup" };
	if (/^autostart\s+off$/.test(value)) return { action: "autostart-off" };
	const lan = /^lan(?:\s+(\S+))?$/.exec(value);
	if (lan) {
		const port = lan[1] === undefined ? DEFAULT_WEB_PORT : parsePort(lan[1]);
		if (port !== undefined) return { action: "start", port, lan: true };
		return { action: "error", message: USAGE };
	}
	const port = parsePort(value);
	if (port !== undefined) return { action: "start", port };
	return { action: "error", message: USAGE };
}

const SESSION_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** Pi session ids: letters, digits, `.`, `_` and `-`; anything else never reaches the session lookup. */
export function isValidSessionId(id: string): boolean {
	return SESSION_ID_PATTERN.test(id);
}

function currentUser(): string {
	try {
		return userInfo().username || process.env.USER || "user";
	} catch {
		return process.env.USER || "user";
	}
}

/** The command that forwards the port from another machine; the SSH login is the OS gate. */
export function sshTunnelHint(port: number, user = currentUser(), host = hostname() || "localhost"): string {
	return `ssh -L ${port}:127.0.0.1:${port} ${user}@${host}`;
}

/** With `lanUrls` (LAN mode) the LAN addresses replace the SSH tunnel hint. */
export function formatServeStart(url: string, port: number, user?: string, host?: string, lanUrls?: string[]): string {
	if (lanUrls) {
		const lan = lanUrls.length > 0 ? lanUrls.join(", ") : "no private IPv4 address found on this machine";
		return `ai-balancer: web report at ${url} (LAN: ${lan})`;
	}
	return `ai-balancer: web report at ${url} (remote: ${sshTunnelHint(port, user, host)})`;
}
