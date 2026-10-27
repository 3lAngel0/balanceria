import { join } from "node:path";
import { DEFAULT_PROFILES_PATH } from "../../../src/profiles.ts";
import { startWebServer, type WebServer } from "../../../src/web-server.ts";
import { cancelSession, compactSession, deleteSessionToTrash, findSessionLocation, listTrash, restoreSessionFromTrash, type LiveSessionManager } from "./actions.ts";
import { buildPanelAlerts, dispatchDesktopAlerts, type CommandRunner } from "./alerts.ts";
import { readBundle } from "./bundle.ts";
import { readLabView, saveLabPools } from "./lab.ts";
import { readLayout, writeLayout } from "./layout.ts";
import { panelHtml } from "./page.ts";
import { readProfilesView, saveProfilesView } from "./profiles.ts";
import { readSetupView, saveSetupView } from "./setup.ts";
import { cachedGithub, listProjects, sessionDetail } from "./projects.ts";
import { buildPanelHistory } from "./usage.ts";

// The panel server: the balancer's web server (token, CSP, host check) with the
// panel's bundle, data and layout. Loopback only until the panel gets its LAN
// setup.

export interface PanelOptions {
	/** 0 picks a free port (tests). */
	port: number;
	/** The Pi sessions root. */
	root: string;
	tokenFile: string;
	/** Where web-layout.json lives. */
	dataDir: string;
	/** The live pools.json; the rule editor edits the lab draft in `<dataDir>/lab` against it. */
	poolsPath?: string;
	/** The live profiles.json (defaults to DEFAULT_PROFILES_PATH). */
	profilesPath?: string;
	hasModel?: (provider: string, model: string) => boolean;
	github?: (cwd: string) => string | null;
	rpcRunner?: (sessionPath: string) => Promise<{ ok: boolean; message?: string }>;
	liveManager?: LiveSessionManager;
	/** Send notify-send alerts on Linux (default true). */
	desktopAlerts?: boolean;
	alertRunner?: CommandRunner;
}

export function startPanel(options: PanelOptions): Promise<WebServer> {
	const github = options.github ?? cachedGithub();
	const bundle = readBundle();
	const lab = { labDir: join(options.dataDir, "lab"), poolsPath: options.poolsPath ?? "" };
	const profilesPath = options.profilesPath ?? DEFAULT_PROFILES_PATH;
	const desktopAlertsSeen = new Map<string, number>();

	const generateAlerts = (projects: ReturnType<typeof listProjects>, history: ReturnType<typeof buildPanelHistory>, now: number) => {
		const alerts = buildPanelAlerts({
			dataDir: options.dataDir,
			root: options.root,
			projects,
			quotaSeries: history.usage.quota,
			now,
			liveManager: options.liveManager,
		});
		if (options.desktopAlerts !== false) {
			void dispatchDesktopAlerts(alerts, { seen: desktopAlertsSeen, runner: options.alertRunner, now });
		}
		return alerts;
	};

	return startWebServer({
		port: options.port,
		tokenFile: options.tokenFile,
		page: panelHtml,
		script: () => bundle.script,
		style: () => bundle.style,
		getReport: () => {
			const now = Date.now();
			const projects = listProjects(options.root, github);
			const history = buildPanelHistory(options.dataDir, now);
			const alerts = generateAlerts(projects, history, now);
			return { generatedAt: now, projects, ...history, alerts };
		},
		getAlerts: () => {
			const now = Date.now();
			const projects = listProjects(options.root, github);
			const history = buildPanelHistory(options.dataDir, now);
			return generateAlerts(projects, history, now);
		},
		getSession: id => sessionDetail(options.root, id),
		openSession: async () => ({ ok: false, message: "the panel cannot open sessions yet" }),
		layout: {
			get: () => readLayout(options.dataDir).layout,
			save: value => writeLayout(options.dataDir, value),
		},
		lab: {
			get: () => readLabView(lab),
			save: value => saveLabPools(lab, value),
		},
		sessionActions: {
			compact: async id => {
				const loc = findSessionLocation(options.root, id);
				if (!loc) return { ok: false, message: `session "${id}" not found` };
				return compactSession({ sessionPath: loc.path, rpcRunner: options.rpcRunner });
			},
			cancel: id => cancelSession(id, options.liveManager),
			delete: async id => deleteSessionToTrash({ root: options.root, dataDir: options.dataDir, sessionId: id }),
		},
		trash: {
			list: () => listTrash(options.dataDir),
			restore: relativePath => restoreSessionFromTrash({ root: options.root, dataDir: options.dataDir, trashRelativePath: relativePath }),
		},
		profiles: {
			get: () => ({ status: 200, body: readProfilesView(profilesPath) }),
			save: body => saveProfilesView({ path: profilesPath, hasModel: options.hasModel }, body),
		},
		setup: {
			get: () => ({ status: 200, body: readSetupView({ root: options.root, poolsPath: options.poolsPath, profilesPath }) }),
			save: body => saveSetupView({ root: options.root, poolsPath: options.poolsPath, profilesPath, hasModel: options.hasModel }, body),
		},
	});
}
