import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createTlsServer } from "node:https";
import { connect as tlsConnect } from "node:tls";
import { X509Certificate, createPrivateKey, randomBytes, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { dirname } from "node:path";

// The live web report. By default it listens on 127.0.0.1 only and answers
// nothing without the token, which lives in a file only the OS user can read
// (0600). Other machines reach it through an SSH tunnel, so the OS login is the gate.
//
// LAN mode (opt-in, `/balancer serve lan`) listens on every interface but only
// answers peers with a private source address (loopback, RFC 1918, link-local,
// IPv6 ULA), so a public address is refused even if a router forwards the port.
// Without TLS it is plain HTTP: anyone who can sniff the LAN can read the
// token. With TLS (a certificate from the LAN wizard) it serves HTTPS only and
// the token cookie is also Secure; a TLS setup that fails to load fails the
// start, it never falls back to plain HTTP.
//
// - The token arrives once in the URL (`/?token=...`), becomes an HttpOnly
//   SameSite=Strict cookie and is stripped from the address bar.
// - Scripts and curl may send it as `Authorization: Bearer <token>`.
// - The Host header must name a loopback host (or, in LAN mode, a private IP
//   literal, never a domain name), so a DNS-rebound page on another domain
//   cannot read the report through the browser.
// - The one action that changes something (open a session in Pi) is a POST
//   that must come from the same origin.

export const DEFAULT_WEB_PORT = 8787;
export const WEB_HOST = "127.0.0.1";
export const LAN_HOST = "0.0.0.0";
const COOKIE = "balancer_token";
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,}$/;
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

const SECURITY_HEADERS = {
	"content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
	"cache-control": "no-store",
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"x-frame-options": "DENY",
};

/** PEM contents of the certificate (chain) and its private key. */
export interface TlsMaterial {
	cert: string;
	key: string;
}

export interface OpenResult {
	ok: boolean;
	message: string;
}

export interface LayoutStore {
	get(): unknown;
	/** Validates and saves; a refused value writes nothing. */
	save(value: unknown): { ok: boolean; message?: string; layout?: unknown };
}

export interface LabStore {
	get(): unknown;
	/** Validates and saves the draft pools; the status and body go to the browser as they are. */
	save(value: unknown): { status: number; body: unknown };
}

export interface SessionActions {
	compact(id: string): Promise<{ ok: boolean; message: string }>;
	cancel(id: string): Promise<{ ok: boolean; message: string }>;
	delete(id: string): Promise<{ ok: boolean; message?: string }>;
}

export interface TrashStore {
	list(): unknown;
	restore(relativePath: string): { ok: boolean; message?: string };
}

export interface ProfilesStoreHandler {
	get(): { status: number; body: unknown };
	save(body: unknown): { status: number; body: unknown };
}

/** Largest layout body POST /api/layout accepts (and the lab pools body). */
export const LAYOUT_BODY_LIMIT = 64 * 1024;

export interface WebServerOptions {
	/** 0 picks a free port (tests). */
	port: number;
	tokenFile: string;
	page(): string;
	script(): string;
	style(): string;
	getReport(): unknown;
	/** Undefined when the session is unknown. */
	getSession(id: string): unknown;
	openSession(id: string): Promise<OpenResult>;
	/** Listen on every interface and answer private LAN peers too. */
	lan?: boolean;
	/** The machine's private IPv4 addresses for the LAN URLs (tests). */
	lanAddresses?: () => string[];
	/** Serve HTTPS with this certificate instead of plain HTTP. */
	tls?: TlsMaterial;
	/** GET and POST /api/layout; without it the path stays unknown. */
	layout?: LayoutStore;
	/** GET /api/lab and POST /api/lab/pools; without it both paths stay unknown. */
	lab?: LabStore;
	/** Session actions: compact, cancel, delete. Loopback or HTTPS only. */
	sessionActions?: SessionActions;
	/** Trash inspection and restoration. Loopback or HTTPS only. */
	trash?: TrashStore;
	/** GET and POST /api/profiles; without it both paths stay unknown. */
	profiles?: ProfilesStoreHandler;
	/** GET and POST /api/setup; without it both paths stay unknown. */
	setup?: SetupHandler;
	/** Optional alert provider. */
	getAlerts?(): unknown;
}

export interface SetupHandler {
	get(): { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
	save(body: unknown): { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
}

export interface WebServer {
	host: string;
	lan: boolean;
	tls: boolean;
	/** The LAN addresses with the token; empty in loopback mode. */
	lanUrls: string[];
	port: number;
	/** The address with the token, for the owner only. */
	url: string;
	close(): Promise<void>;
}

/** Reads the token, or writes a fresh one; the file always ends up 0600. */
export function loadOrCreateToken(file: string): string {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	let existing: string | undefined;
	try {
		const stat = lstatSync(file);
		if (!stat.isFile()) throw new Error(`ai-balancer: ${file} is not a regular file; remove it to create a new token`);
		if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`ai-balancer: ${file} belongs to another user; remove it to create a new token`);
		existing = readFileSync(file, "utf8").trim();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (existing !== undefined && TOKEN_PATTERN.test(existing)) {
		chmodSync(file, 0o600);
		return existing;
	}
	const token = randomBytes(32).toString("base64url");
	writeFileSync(file, token, { mode: 0o600 });
	chmodSync(file, 0o600);
	return token;
}

function readPem(kind: string, file: string): string {
	try {
		return readFileSync(file, "utf8");
	} catch (error) {
		throw new Error(`ai-balancer: cannot read the TLS ${kind} ${file}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
	}
}

/** Reads a certificate and its key, and checks that the key belongs to the certificate. */
export function loadTlsFiles(paths: { cert: string; key: string }): TlsMaterial {
	const cert = readPem("certificate", paths.cert);
	const key = readPem("key", paths.key);
	let x509: X509Certificate;
	try {
		x509 = new X509Certificate(cert);
	} catch {
		throw new Error(`ai-balancer: ${paths.cert} is not a PEM certificate`);
	}
	let matches = false;
	try {
		matches = x509.checkPrivateKey(createPrivateKey(key));
	} catch {
		throw new Error(`ai-balancer: ${paths.key} is not a PEM private key`);
	}
	if (!matches) throw new Error(`ai-balancer: the TLS key ${paths.key} does not match the certificate ${paths.cert}`);
	return { cert, key };
}

function sameToken(candidate: string | undefined, token: string): boolean {
	if (!candidate) return false;
	const a = Buffer.from(candidate);
	const b = Buffer.from(token);
	return a.length === b.length && timingSafeEqual(a, b);
}

function cookieToken(req: IncomingMessage): string | undefined {
	for (const part of (req.headers.cookie ?? "").split(";")) {
		const [name, ...value] = part.trim().split("=");
		if (name === COOKIE) return value.join("=");
	}
	return undefined;
}

function bearerToken(req: IncomingMessage): string | undefined {
	const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
	return match?.[1];
}

/** `127.0.0.1:8787` → `127.0.0.1`, `[::1]:8787` → `[::1]`. */
function hostName(host: string): string {
	const match = /^(\[[^\]]+\]|[^:]+)(?::\d+)?$/.exec(host.trim().toLowerCase());
	return match?.[1] ?? "";
}

function isLoopbackHost(host: string | undefined): boolean {
	return host !== undefined && LOOPBACK_HOSTS.has(hostName(host));
}

function ipv4Octets(ip: string): number[] | undefined {
	if (isIP(ip) !== 4) return undefined;
	return ip.split(".").map(Number);
}

/** Loopback, RFC 1918, link-local and IPv6 unique-local addresses; never a name. */
export function isPrivateAddress(address: string | undefined): boolean {
	if (!address) return false;
	const ip = address.toLowerCase().replace(/^\[|\]$/g, "");
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(ip);
	const v4 = ipv4Octets(mapped ? mapped[1]! : ip);
	if (v4) {
		const [a, b] = v4 as [number, number];
		return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
	}
	if (isIP(ip) !== 6) return false;
	return ip === "::1" || /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe[89ab][0-9a-f]:/.test(ip);
}

/** Loopback names always; in LAN mode also private IP literals. */
function isAllowedHost(host: string | undefined, lan: boolean): boolean {
	if (isLoopbackHost(host)) return true;
	return lan && host !== undefined && isPrivateAddress(hostName(host));
}

function isSameOriginPost(req: IncomingMessage, lan: boolean, tls: boolean): boolean {
	const origin = req.headers.origin;
	// No Origin header: not a browser (curl with the bearer token).
	if (origin === undefined) return true;
	try {
		const url = new URL(origin);
		if (url.protocol !== (tls ? "https:" : "http:")) return false;
		if (isLoopbackHost(url.host)) return true;
		// A LAN page may only post to the very address it was loaded from.
		return lan && isAllowedHost(url.host, lan) && url.host === req.headers.host?.trim().toLowerCase();
	} catch {
		return false;
	}
}

/** The machine's private IPv4 addresses, for the LAN URLs. */
export function privateIPv4Addresses(ifaces: ReturnType<typeof networkInterfaces> = networkInterfaces()): string[] {
	const addresses: string[] = [];
	for (const entries of Object.values(ifaces)) {
		for (const entry of entries ?? []) {
			if (entry.family === "IPv4" && !entry.internal && isPrivateAddress(entry.address)) addresses.push(entry.address);
		}
	}
	return addresses;
}

function send(res: ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}): void {
	res.writeHead(status, { ...SECURITY_HEADERS, "content-type": type, ...extra });
	res.end(body);
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
	send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
}

function sendText(res: ServerResponse, status: number, text: string): void {
	send(res, status, "text/plain; charset=utf-8", text);
}

const UNAUTHORIZED = "ai-balancer: token required. Run `/balancer serve status` in Pi for the address with the token.\n";

/** The body as text, or null when it passes `limit` bytes (the rest is drained). */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size <= limit) chunks.push(chunk);
		});
		req.on("end", () => resolve(size > limit ? null : Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}

/** A JSON body up to 64 KiB, or null once the refusal was sent; `what` and `is` word the messages. */
async function readJsonBody(req: IncomingMessage, res: ServerResponse, what: string, is: "is" | "are"): Promise<{ value: unknown } | null> {
	const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
	if (type !== "application/json") {
		sendJson(res, 415, { ok: false, message: `send ${what} as application/json` });
		return null;
	}
	const body = await readBody(req, LAYOUT_BODY_LIMIT);
	if (body === null) {
		sendJson(res, 413, { ok: false, message: `${what} ${is} larger than 64 KiB` });
		return null;
	}
	try {
		return { value: JSON.parse(body) };
	} catch {
		sendJson(res, 400, { ok: false, message: `${what} ${is} not valid JSON` });
		return null;
	}
}

async function saveLayout(req: IncomingMessage, res: ServerResponse, store: LayoutStore): Promise<void> {
	const body = await readJsonBody(req, res, "the layout", "is");
	if (!body) return;
	const result = store.save(body.value);
	sendJson(res, result.ok ? 200 : 400, result);
}

async function saveLabPools(req: IncomingMessage, res: ServerResponse, store: LabStore): Promise<void> {
	const body = await readJsonBody(req, res, "the pools", "are");
	if (!body) return;
	const result = store.save(body.value);
	sendJson(res, result.status, result.body);
}

export function sessionId(raw: string): string | undefined {
	try {
		const id = decodeURIComponent(raw);
		return SESSION_ID.test(id) ? id : undefined;
	} catch {
		return undefined;
	}
}

async function route(req: IncomingMessage, res: ServerResponse, options: WebServerOptions, token: string): Promise<void> {
	const lan = options.lan === true;
	const tls = options.tls !== undefined;
	if (!isPrivateAddress(req.socket.remoteAddress)) {
		sendText(res, 403, "ai-balancer: this server only answers the local network.\n");
		return;
	}
	if (!isAllowedHost(req.headers.host, lan)) {
		sendText(res, 403, lan ? "ai-balancer: this server only answers loopback or private IP addresses.\n" : "ai-balancer: this server only answers loopback addresses.\n");
		return;
	}
	const url = new URL(req.url ?? "/", "http://localhost");
	const queryToken = url.searchParams.get("token");
	if (queryToken !== null) {
		if (!sameToken(queryToken, token)) {
			sendText(res, 401, UNAUTHORIZED);
			return;
		}
		url.searchParams.delete("token");
		send(res, 303, "text/plain; charset=utf-8", "", {
			location: url.pathname + url.search,
			"set-cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/${tls ? "; Secure" : ""}`,
		});
		return;
	}
	if (!sameToken(cookieToken(req), token) && !sameToken(bearerToken(req), token)) {
		sendText(res, 401, UNAUTHORIZED);
		return;
	}

	const path = url.pathname;
	const open = /^\/api\/sessions\/([^/]+)\/open$/.exec(path);
	if (open) {
		if (req.method !== "POST") {
			send(res, 405, "text/plain; charset=utf-8", "ai-balancer: use POST.\n", { allow: "POST" });
			return;
		}
		if (!isSameOriginPost(req, lan, tls)) {
			sendText(res, 403, "ai-balancer: cross-origin request refused.\n");
			return;
		}
		const id = sessionId(open[1]!);
		if (!id) {
			sendJson(res, 400, { ok: false, message: "invalid session id" });
			return;
		}
		const result = await options.openSession(id);
		sendJson(res, result.ok ? 200 : 409, result);
		return;
	}

	const compact = /^\/api\/sessions\/([^/]+)\/compact$/.exec(path);
	if (compact) {
		if (req.method !== "POST") {
			send(res, 405, "text/plain; charset=utf-8", "ai-balancer: use POST.\n", { allow: "POST" });
			return;
		}
		if (!isSameOriginPost(req, lan, tls)) {
			sendText(res, 403, "ai-balancer: cross-origin request refused.\n");
			return;
		}
		if (!tls && !isLoopbackHost(req.headers.host)) {
			sendJson(res, 403, { ok: false, message: "actions are permitted only over loopback or HTTPS" });
			return;
		}
		if (!options.sessionActions) {
			sendText(res, 404, "ai-balancer: not found.\n");
			return;
		}
		const id = sessionId(compact[1]!);
		if (!id) {
			sendJson(res, 400, { ok: false, message: "invalid session id" });
			return;
		}
		const result = await options.sessionActions.compact(id);
		sendJson(res, result.ok ? 200 : 409, result);
		return;
	}

	const cancel = /^\/api\/sessions\/([^/]+)\/cancel$/.exec(path);
	if (cancel) {
		if (req.method !== "POST") {
			send(res, 405, "text/plain; charset=utf-8", "ai-balancer: use POST.\n", { allow: "POST" });
			return;
		}
		if (!isSameOriginPost(req, lan, tls)) {
			sendText(res, 403, "ai-balancer: cross-origin request refused.\n");
			return;
		}
		if (!tls && !isLoopbackHost(req.headers.host)) {
			sendJson(res, 403, { ok: false, message: "actions are permitted only over loopback or HTTPS" });
			return;
		}
		if (!options.sessionActions) {
			sendText(res, 404, "ai-balancer: not found.\n");
			return;
		}
		const id = sessionId(cancel[1]!);
		if (!id) {
			sendJson(res, 400, { ok: false, message: "invalid session id" });
			return;
		}
		const result = await options.sessionActions.cancel(id);
		sendJson(res, result.ok ? 200 : 409, result);
		return;
	}

	const del = /^\/api\/sessions\/([^/]+)\/delete$/.exec(path);
	if (del) {
		if (req.method !== "POST") {
			send(res, 405, "text/plain; charset=utf-8", "ai-balancer: use POST.\n", { allow: "POST" });
			return;
		}
		if (!isSameOriginPost(req, lan, tls)) {
			sendText(res, 403, "ai-balancer: cross-origin request refused.\n");
			return;
		}
		if (!tls && !isLoopbackHost(req.headers.host)) {
			sendJson(res, 403, { ok: false, message: "actions are permitted only over loopback or HTTPS" });
			return;
		}
		if (!options.sessionActions) {
			sendText(res, 404, "ai-balancer: not found.\n");
			return;
		}
		const id = sessionId(del[1]!);
		if (!id) {
			sendJson(res, 400, { ok: false, message: "invalid session id" });
			return;
		}
		const result = await options.sessionActions.delete(id);
		sendJson(res, result.ok ? 200 : 409, result);
		return;
	}

	if (path === "/api/trash" && options.trash) {
		if (req.method !== "GET" && req.method !== "HEAD") {
			send(res, 405, "text/plain; charset=utf-8", "ai-balancer: use GET.\n", { allow: "GET" });
			return;
		}
		if (!tls && !isLoopbackHost(req.headers.host)) {
			sendJson(res, 403, { ok: false, message: "actions are permitted only over loopback or HTTPS" });
			return;
		}
		sendJson(res, 200, { trash: options.trash.list() });
		return;
	}

	if (path === "/api/trash/restore" && options.trash && req.method === "POST") {
		if (!isSameOriginPost(req, lan, tls)) {
			sendText(res, 403, "ai-balancer: cross-origin request refused.\n");
			return;
		}
		if (!tls && !isLoopbackHost(req.headers.host)) {
			sendJson(res, 403, { ok: false, message: "actions are permitted only over loopback or HTTPS" });
			return;
		}
		const body = await readJsonBody(req, res, "the restore request", "is");
		if (!body) return;
		const rel = typeof body.value === "object" && body.value && "relativePath" in body.value ? String((body.value as { relativePath: unknown }).relativePath) : "";
		const result = options.trash.restore(rel);
		sendJson(res, result.ok ? 200 : 400, result);
		return;
	}

	if (path === "/api/layout" && options.layout && req.method === "POST") {
		if (!isSameOriginPost(req, lan, tls)) {
			sendText(res, 403, "ai-balancer: cross-origin request refused.\n");
			return;
		}
		return saveLayout(req, res, options.layout);
	}

	if (path === "/api/lab/pools" && options.lab && req.method === "POST") {
		if (!isSameOriginPost(req, lan, tls)) {
			sendText(res, 403, "ai-balancer: cross-origin request refused.\n");
			return;
		}
		return saveLabPools(req, res, options.lab);
	}

	if (path === "/api/profiles" && options.profiles && req.method === "POST") {
		if (!isSameOriginPost(req, lan, tls)) {
			sendText(res, 403, "ai-balancer: cross-origin request refused.\n");
			return;
		}
		if (!tls && !isLoopbackHost(req.headers.host)) {
			sendJson(res, 403, { ok: false, message: "actions are permitted only over loopback or HTTPS" });
			return;
		}
		const body = await readJsonBody(req, res, "the profiles save request", "is");
		if (!body) return;
		const result = options.profiles.save(body.value);
		sendJson(res, result.status, result.body);
		return;
	}

	if (path === "/api/setup" && options.setup && req.method === "POST") {
		if (!isSameOriginPost(req, lan, tls)) {
			sendText(res, 403, "ai-balancer: cross-origin request refused.\n");
			return;
		}
		if (!tls && !isLoopbackHost(req.headers.host)) {
			sendJson(res, 403, { ok: false, message: "actions are permitted only over loopback or HTTPS" });
			return;
		}
		const body = await readJsonBody(req, res, "the setup request", "is");
		if (!body) return;
		const result = await Promise.resolve(options.setup.save(body.value));
		sendJson(res, result.status, result.body);
		return;
	}

	if (req.method !== "GET" && req.method !== "HEAD") {
		send(res, 405, "text/plain; charset=utf-8", "ai-balancer: use GET.\n", { allow: "GET" });
		return;
	}
	if (path === "/") return send(res, 200, "text/html; charset=utf-8", options.page());
	if (path === "/app.js") return send(res, 200, "text/javascript; charset=utf-8", options.script());
	if (path === "/app.css") return send(res, 200, "text/css; charset=utf-8", options.style());
	if (path === "/api/report") return sendJson(res, 200, options.getReport());
	if (path === "/api/alerts") {
		const reportObj = options.getReport() as { alerts?: unknown } | null;
		const alerts = options.getAlerts ? options.getAlerts() : (reportObj && Array.isArray(reportObj.alerts) ? reportObj.alerts : []);
		return sendJson(res, 200, { alerts });
	}
	if (path === "/api/layout" && options.layout) return sendJson(res, 200, { layout: options.layout.get() });
	if (path === "/api/lab" && options.lab) return sendJson(res, 200, options.lab.get());
	if (path === "/api/profiles" && options.profiles) {
		const result = options.profiles.get();
		return sendJson(res, result.status, result.body);
	}
	if (path === "/api/setup" && options.setup) {
		const result = await Promise.resolve(options.setup.get());
		return sendJson(res, result.status, result.body);
	}
	const detail = /^\/api\/sessions\/([^/]+)$/.exec(path);
	if (detail) {
		const id = sessionId(detail[1]!);
		if (!id) return sendJson(res, 400, { message: "invalid session id" });
		const session = options.getSession(id);
		if (session === undefined) return sendJson(res, 404, { message: "unknown session" });
		return sendJson(res, 200, session);
	}
	sendText(res, 404, "ai-balancer: not found.\n");
}

/**
 * GET the report at a token URL with its token; the HTTP status, or the error
 * code when nothing answered. Over https the token is sent only after the
 * server proved it holds `pinnedCert` (`ECERTMISMATCH` otherwise, also when
 * no certificate is given), so a self-signed certificate needs no CA.
 */
export function probeReport(tokenUrl: string, timeoutMs = 3000, pinnedCert?: string): Promise<number | string> {
	const url = new URL(tokenUrl);
	const token = url.searchParams.get("token") ?? "";
	return new Promise(resolve => {
		const timer = setTimeout(() => finish("ETIMEDOUT"), timeoutMs);
		let done = false;
		const cleanups: (() => void)[] = [];
		function finish(result: number | string): void {
			if (done) return;
			done = true;
			clearTimeout(timer);
			for (const cleanup of cleanups) cleanup();
			resolve(result);
		}
		const get = (createConnection?: () => import("node:net").Socket) => {
			// Node ignores createConnection when an agent option is given, even `false`.
			const connection = createConnection ? { createConnection } : { agent: false as const };
			const req = request({ host: url.hostname, port: url.port, path: "/api/report", ...connection, headers: { authorization: `Bearer ${token}` } }, res => {
				res.resume();
				finish(res.statusCode ?? 0);
			});
			cleanups.push(() => req.destroy());
			req.on("error", (error: NodeJS.ErrnoException) => finish(error.code ?? error.message));
			req.end();
		};
		if (url.protocol !== "https:") {
			get();
			return;
		}
		const expected = pinnedFingerprint(pinnedCert);
		const socket = tlsConnect({ host: url.hostname, port: Number(url.port), rejectUnauthorized: false, servername: isIP(url.hostname) ? undefined : url.hostname });
		cleanups.push(() => socket.destroy());
		socket.on("error", (error: NodeJS.ErrnoException) => finish(error.code ?? error.message));
		socket.once("secureConnect", () => {
			if (!expected || socket.getPeerCertificate().fingerprint256 !== expected) {
				finish("ECERTMISMATCH");
				return;
			}
			get(() => socket);
		});
	});
}

function pinnedFingerprint(cert: string | undefined): string | undefined {
	if (!cert) return undefined;
	try {
		return new X509Certificate(cert).fingerprint256;
	} catch {
		return undefined;
	}
}

export function startWebServer(options: WebServerOptions): Promise<WebServer> {
	const token = loadOrCreateToken(options.tokenFile);
	const handler = (req: IncomingMessage, res: ServerResponse) => {
		route(req, res, options, token).catch(() => {
			if (!res.headersSent) sendText(res, 500, "ai-balancer: internal error.\n");
			else res.end();
		});
	};
	const tls = options.tls !== undefined;
	const server = options.tls ? createTlsServer({ cert: options.tls.cert, key: options.tls.key, minVersion: "TLSv1.2" }, handler) : createServer(handler);
	const scheme = tls ? "https" : "http";
	return new Promise((resolve, reject) => {
		server.once("error", (error: NodeJS.ErrnoException) => {
			reject(error.code === "EADDRINUSE" ? new Error(`ai-balancer: port ${options.port} is already in use; try /balancer serve <port>`) : error);
		});
		const lan = options.lan === true;
		const host = lan ? LAN_HOST : WEB_HOST;
		server.listen(options.port, host, () => {
			const port = (server.address() as { port: number }).port;
			const lanAddresses = lan ? (options.lanAddresses ?? privateIPv4Addresses)() : [];
			resolve({
				host,
				lan,
				tls,
				port,
				url: `${scheme}://${WEB_HOST}:${port}/?token=${token}`,
				lanUrls: lanAddresses.map(address => `${scheme}://${address}:${port}/?token=${token}`),
				close: () =>
					new Promise<void>(done => {
						server.close(() => done());
						server.closeAllConnections();
					}),
			});
		});
	});
}
