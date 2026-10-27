import { useEffect, useState } from "preact/hooks";
import {
	fetchProfiles,
	saveProfiles,
	type ProfileConfig,
	type ProfilesStore,
	type RoleRoute,
} from "../api.ts";

function errText(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason);
}

const THINKING_OPTIONS = ["", "none", "low", "medium", "high", "adaptive"] as const;

export function ProfilesWidget() {
	const [store, setStore] = useState<ProfilesStore | null>(null);
	const [raw, setRaw] = useState<string>("");
	const [selectedProfile, setSelectedProfile] = useState<string>("");
	const [error, setError] = useState<string | null>(null);
	const [statusMessage, setStatusMessage] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);

	// Add role form
	const [newRole, setNewRole] = useState("");
	const [newModel, setNewModel] = useState("");
	const [newThinking, setNewThinking] = useState("");

	// Clone form
	const [isCloning, setIsCloning] = useState(false);
	const [cloneName, setCloneName] = useState("");

	const load = () => {
		setError(null);
		setStatusMessage(null);
		fetchProfiles().then(
			view => {
				if (view.error && !view.profiles) {
					setError(view.error);
					setStore(null);
					setRaw("");
				} else if (view.profiles) {
					setStore(view.profiles);
					setRaw(view.raw);
					const active = view.profiles.active ?? Object.keys(view.profiles.profiles)[0] ?? "";
					setSelectedProfile(prev => (prev && view.profiles?.profiles[prev] ? prev : active));
				}
			},
			reason => setError(errText(reason)),
		);
	};

	useEffect(load, []);

	if (error && !store) {
		return (
			<div class="profiles-widget">
				<p class="notice" role="alert">
					Cannot load profiles.json: {error}
				</p>
				<div>
					<button type="button" onClick={load}>
						Retry
					</button>
				</div>
			</div>
		);
	}

	if (!store) {
		return <p class="dim">Loading profiles…</p>;
	}

	const profileNames = Object.keys(store.profiles);
	const currentProfile: ProfileConfig = store.profiles[selectedProfile] ?? {};

	function updateRoute(role: string, field: "model" | "thinking", value: string) {
		if (!store) return;
		const existing = currentProfile[role] ?? { model: "" };
		const updatedRoute: RoleRoute = { ...existing };
		if (field === "model") {
			updatedRoute.model = value;
		} else {
			if (!value) delete updatedRoute.thinking;
			else updatedRoute.thinking = value;
		}

		const nextProfiles = {
			...store.profiles,
			[selectedProfile]: {
				...currentProfile,
				[role]: updatedRoute,
			},
		};

		setStore({ ...store, profiles: nextProfiles });
	}

	function removeRole(role: string) {
		if (!store) return;
		const nextProfile = { ...currentProfile };
		delete nextProfile[role];
		setStore({
			...store,
			profiles: {
				...store.profiles,
				[selectedProfile]: nextProfile,
			},
		});
	}

	function handleAddRole() {
		const trimmedRole = newRole.trim();
		const trimmedModel = newModel.trim();
		if (!trimmedRole || !trimmedModel || !store) return;

		const route: RoleRoute = { model: trimmedModel };
		if (newThinking) route.thinking = newThinking;

		setStore({
			...store,
			profiles: {
				...store.profiles,
				[selectedProfile]: {
					...currentProfile,
					[trimmedRole]: route,
				},
			},
		});

		setNewRole("");
		setNewModel("");
		setNewThinking("");
	}

	function handleSetActive(name: string) {
		if (!store) return;
		setStore({ ...store, active: name });
	}

	function handleClone() {
		const name = cloneName.trim();
		if (!name || !store || store.profiles[name]) return;

		setStore({
			...store,
			profiles: {
				...store.profiles,
				[name]: JSON.parse(JSON.stringify(currentProfile)),
			},
		});
		setSelectedProfile(name);
		setIsCloning(false);
		setCloneName("");
	}

	function handleDeleteProfile(name: string) {
		if (!store || profileNames.length <= 1) return;
		if (name === store.active) {
			setError("Cannot delete the active profile. Switch active profile first.");
			return;
		}
		const next = { ...store.profiles };
		delete next[name];
		const remaining = Object.keys(next);
		setStore({ ...store, profiles: next });
		setSelectedProfile(remaining[0] ?? "");
	}

	async function handleSave() {
		if (!store) return;
		setSaving(true);
		setError(null);
		setStatusMessage(null);
		try {
			const res = await saveProfiles(store, raw);
			setStore(res.profiles);
			setRaw(res.raw);
			setStatusMessage(res.backup ? `Saved! Backup: ${res.backup.split("/").pop()}` : "Saved successfully!");
		} catch (e) {
			setError(errText(e));
		} finally {
			setSaving(false);
		}
	}

	return (
		<div class="profiles-widget">
			<div class="profiles-toolbar">
				<div class="profiles-tabs" role="tablist" aria-label="Profiles list">
					{profileNames.map(name => {
						const isActive = name === store.active;
						const isSelected = name === selectedProfile;
						return (
							<button
								key={name}
								type="button"
								role="tab"
								aria-selected={isSelected}
								class={`profile-tab${isSelected ? " is-active" : ""}`}
								onClick={() => setSelectedProfile(name)}
							>
								{name}
								{isActive && <span class="profile-active-tag"> [active]</span>}
							</button>
						);
					})}
				</div>
				<div class="profiles-toolbar-actions">
					<button type="button" onClick={() => setIsCloning(c => !c)} disabled={saving}>
						{isCloning ? "Cancel clone" : "+ Clone profile"}
					</button>
					<button type="button" onClick={load} disabled={saving}>
						Reload
					</button>
				</div>
			</div>

			{isCloning && (
				<div class="profile-clone-box">
					<label>
						New profile name:{" "}
						<input
							type="text"
							value={cloneName}
							placeholder="e.g. flash-worker"
							onInput={e => setCloneName((e.target as HTMLInputElement).value)}
						/>
					</label>
					<button type="button" onClick={handleClone} disabled={!cloneName.trim() || !!store.profiles[cloneName.trim()]}>
						Create clone
					</button>
				</div>
			)}

			{statusMessage && <p class="status-badge is-ok" role="status">{statusMessage}</p>}
			{error && (
				<p class="notice" role="alert">
					{error}
				</p>
			)}

			<div class="profile-meta">
				<span class="dim">
					Profile: <strong>{selectedProfile}</strong>
					{selectedProfile === store.active ? " (Active)" : ""}
				</span>
				{selectedProfile !== store.active && (
					<button type="button" onClick={() => handleSetActive(selectedProfile)} disabled={saving}>
						Set as active profile
					</button>
				)}
				{profileNames.length > 1 && selectedProfile !== store.active && (
					<button type="button" onClick={() => handleDeleteProfile(selectedProfile)} disabled={saving}>
						Delete profile
					</button>
				)}
			</div>

			<div class="profile-roles-table-wrap">
				<table class="profile-roles-table">
					<thead>
						<tr>
							<th scope="col">Role</th>
							<th scope="col">Model (provider/model or pool/name)</th>
							<th scope="col">Thinking</th>
							<th scope="col">Action</th>
						</tr>
					</thead>
					<tbody>
						{Object.entries(currentProfile).map(([role, route]) => (
							<tr key={role}>
								<td>
									<code>{role}</code>
								</td>
								<td>
									<input
										type="text"
										class="profile-model-input"
										aria-label={`Model for ${role}`}
										value={route.model ?? ""}
										onInput={e => updateRoute(role, "model", (e.target as HTMLInputElement).value)}
										disabled={saving}
									/>
								</td>
								<td>
									<select
										aria-label={`Thinking level for ${role}`}
										value={route.thinking ?? ""}
										onChange={e => updateRoute(role, "thinking", (e.target as HTMLSelectElement).value)}
										disabled={saving}
									>
										{THINKING_OPTIONS.map(opt => (
											<option key={opt} value={opt}>
												{opt || "(default)"}
											</option>
										))}
									</select>
								</td>
								<td>
									<button
										type="button"
										aria-label={`Remove role ${role}`}
										onClick={() => removeRole(role)}
										disabled={saving}
									>
										✕
									</button>
								</td>
							</tr>
						))}
						{Object.keys(currentProfile).length === 0 && (
							<tr>
								<td colSpan={4} class="dim">
									No roles defined in this profile yet.
								</td>
							</tr>
						)}
					</tbody>
				</table>
			</div>

			<div class="profile-add-role-box">
				<h4>Add role route</h4>
				<div class="profile-add-role-row">
					<label>
						Role:{" "}
						<input
							type="text"
							placeholder="e.g. gentle-ai-worker"
							value={newRole}
							onInput={e => setNewRole((e.target as HTMLInputElement).value)}
							disabled={saving}
						/>
					</label>
					<label>
						Model:{" "}
						<input
							type="text"
							placeholder="e.g. antigravity/gemini-3-8-flash"
							value={newModel}
							onInput={e => setNewModel((e.target as HTMLInputElement).value)}
							disabled={saving}
						/>
					</label>
					<label>
						Thinking:{" "}
						<select
							value={newThinking}
							onChange={e => setNewThinking((e.target as HTMLSelectElement).value)}
							disabled={saving}
						>
							{THINKING_OPTIONS.map(opt => (
								<option key={opt} value={opt}>
									{opt || "(default)"}
								</option>
							))}
						</select>
					</label>
					<button
						type="button"
						onClick={handleAddRole}
						disabled={saving || !newRole.trim() || !newModel.trim()}
					>
						+ Add role
					</button>
				</div>
			</div>

			<div class="profile-save-bar">
				<button type="button" class="profile-save-btn" onClick={handleSave} disabled={saving}>
					{saving ? "Saving profiles…" : "Save profiles.json"}
				</button>
			</div>
		</div>
	);
}
