import { readFileSync } from "node:fs";
import {
	DEFAULT_PROFILES_PATH,
	readProfiles,
	saveProfilesStore,
	type ProfilesStore,
} from "../../../src/profiles.ts";

export interface ProfilesView {
	profiles: ProfilesStore | null;
	raw: string;
	error?: string;
}

export function readProfilesView(path = DEFAULT_PROFILES_PATH): ProfilesView {
	const read = readProfiles(path);
	if ("error" in read) {
		return { profiles: null, raw: "", error: read.error };
	}
	return { profiles: read.store, raw: read.raw };
}

export interface SaveProfilesViewPaths {
	path?: string;
	hasModel?: (provider: string, model: string) => boolean;
	now?: number;
}

export interface SaveProfilesViewResponse {
	status: number;
	body: {
		ok: boolean;
		message?: string;
		backup?: string;
		profiles?: ProfilesStore;
		raw?: string;
	};
}

export function saveProfilesView(paths: SaveProfilesViewPaths, body: unknown): SaveProfilesViewResponse {
	if (
		typeof body !== "object" ||
		body === null ||
		Array.isArray(body) ||
		!("profiles" in body) ||
		!("raw" in body) ||
		typeof (body as { raw: unknown }).raw !== "string"
	) {
		return {
			status: 400,
			body: { ok: false, message: "send { profiles, raw }" },
		};
	}

	const { profiles, raw } = body as { profiles: unknown; raw: string };
	if (typeof profiles !== "object" || profiles === null || Array.isArray(profiles)) {
		return {
			status: 400,
			body: { ok: false, message: "profiles must be a valid object" },
		};
	}

	const filePath = paths.path ?? DEFAULT_PROFILES_PATH;
	const currentRead = readProfiles(filePath);
	if ("error" in currentRead) {
		return {
			status: 404,
			body: { ok: false, message: currentRead.error },
		};
	}

	try {
		const result = saveProfilesStore(
			profiles as ProfilesStore,
			{ store: currentRead.store, raw },
			{
				path: filePath,
				now: paths.now,
				hasModel: paths.hasModel ?? (() => true),
			},
		);
		const freshRaw = readFileSync(filePath, "utf8");
		return {
			status: 200,
			body: {
				ok: true,
				backup: result.backup,
				profiles: profiles as ProfilesStore,
				raw: freshRaw,
			},
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const status = message.includes("changed since it was read") ? 409 : 400;
		return {
			status,
			body: { ok: false, message },
		};
	}
}
