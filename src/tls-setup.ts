import { X509Certificate } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Runner } from "./lan-setup.ts";
import { loadTlsFiles } from "./web-server.ts";

// The certificate behind HTTPS on the LAN. The wizard can create one with
// openssl (self-signed: every device warns once) or mkcert (signed by a local
// CA the user installs on each device), or take the user's own pair. It never
// installs a CA: that changes the system trust store, so the user runs it.

/** Paths of the certificate and its private key, as stored in `data/web-serve.json`. */
export interface TlsConfig {
	cert: string;
	key: string;
}

export type CertificateKind = "self-signed" | "mkcert";

const DAY_MS = 86_400_000;
const EXPIRY_WARNING_DAYS = 30;

function names(addresses: readonly string[]): string[] {
	return [...new Set([...addresses, "127.0.0.1"])];
}

export function selfSignedArgs(cert: string, key: string, addresses: readonly string[]): string[] {
	const san = [...names(addresses).map(address => `IP:${address}`), "DNS:localhost"].join(",");
	return [
		"req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "825",
		"-subj", "/CN=ai-balancer", "-addext", `subjectAltName=${san}`, "-addext", "extendedKeyUsage=serverAuth",
		"-keyout", key, "-out", cert,
	];
}

export function mkcertArgs(cert: string, key: string, addresses: readonly string[]): string[] {
	return ["-cert-file", cert, "-key-file", key, ...names(addresses), "localhost"];
}

const MISSING: Record<CertificateKind, string> = {
	"self-signed": "ai-balancer: openssl not found; install it or pick another option",
	mkcert: "ai-balancer: mkcert not found; install it (https://github.com/FiloSottile/mkcert) or pick another option",
};

async function runTool(kind: CertificateKind, command: string, args: string[], run: Runner): Promise<string> {
	try {
		return (await run(command, args)).stdout;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(MISSING[kind]);
		throw new Error(`ai-balancer: ${command} failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Creates `<dir>/<kind>/cert.pem` and a 0600 `key.pem`, replacing an earlier pair; notes say what the user must do. */
export async function createCertificate(kind: CertificateKind, dir: string, addresses: readonly string[], run: Runner): Promise<{ config: TlsConfig; notes: string[] }> {
	const folder = join(dir, kind);
	mkdirSync(folder, { recursive: true, mode: 0o700 });
	chmodSync(folder, 0o700);
	const config = { cert: join(folder, "cert.pem"), key: join(folder, "key.pem") };
	const notes: string[] = [];
	if (kind === "self-signed") {
		await runTool(kind, "openssl", selfSignedArgs(config.cert, config.key, addresses), run);
	} else {
		await runTool(kind, "mkcert", mkcertArgs(config.cert, config.key, addresses), run);
		const caRoot = (await runTool(kind, "mkcert", ["-CAROOT"], run)).trim();
		notes.push(`ai-balancer: install ${join(caRoot, "rootCA.pem")} as a trusted CA on each device that opens the report (on this machine: mkcert -install). Never copy rootCA-key.pem.`);
	}
	chmodSync(config.key, 0o600);
	return { config, notes };
}

export interface CertificateCheck {
	/** Set when the pair cannot be served. */
	error?: string;
	warnings: string[];
	/** SHA-256 fingerprint, to compare with the one a browser shows. */
	fingerprint?: string;
}

/** Whether the pair can be served at `address`, and what the user should know first. */
export function inspectCertificate(config: TlsConfig, address: string, now = Date.now()): CertificateCheck {
	let x509: X509Certificate;
	try {
		x509 = new X509Certificate(loadTlsFiles(config).cert);
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error), warnings: [] };
	}
	const validFrom = Date.parse(x509.validFrom);
	const validTo = Date.parse(x509.validTo);
	const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
	if (now < validFrom) return { error: `ai-balancer: the certificate is not valid before ${day(validFrom)}`, warnings: [] };
	if (now >= validTo) return { error: `ai-balancer: the certificate expired on ${day(validTo)}`, warnings: [] };
	const warnings: string[] = [];
	if (!x509.checkIP(address)) warnings.push(`the certificate does not name ${address}, so browsers reject it at that address`);
	const daysLeft = Math.floor((validTo - now) / DAY_MS);
	if (daysLeft < EXPIRY_WARNING_DAYS) warnings.push(`the certificate expires on ${day(validTo)} (in ${daysLeft} days)`);
	return { warnings, fingerprint: x509.fingerprint256 };
}
