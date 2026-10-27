import { useEffect, useState } from "preact/hooks";
import {
	cancelSession,
	compactSession,
	deleteSession,
	fetchTrash,
	restoreTrash,
	type Project,
	type TrashedItem,
} from "../api.ts";
import { ago } from "../format.ts";
import { recentSessions } from "../summary.ts";

const LIMIT = 8;

export function RecentWidget({ projects }: { projects: Project[] }) {
	const sessions = recentSessions(projects, LIMIT);
	const [feedback, setFeedback] = useState<Record<string, { text: string; error?: boolean }>>({});
	const [busy, setBusy] = useState<Record<string, boolean>>({});
	const [confirmDelete, setConfirmDelete] = useState<Record<string, boolean>>({});
	const [hiddenSessions, setHiddenSessions] = useState<Record<string, boolean>>({});
	const [showTrash, setShowTrash] = useState(false);
	const [trashItems, setTrashItems] = useState<TrashedItem[]>([]);
	const [trashBusy, setTrashBusy] = useState(false);

	const loadTrash = () => {
		setTrashBusy(true);
		fetchTrash()
			.then(items => setTrashItems(items))
			.catch(() => setTrashItems([]))
			.finally(() => setTrashBusy(false));
	};

	useEffect(() => {
		if (showTrash) loadTrash();
	}, [showTrash]);

	const handleCompact = async (id: string) => {
		setBusy(prev => ({ ...prev, [id]: true }));
		try {
			const res = await compactSession(id);
			setFeedback(prev => ({ ...prev, [id]: { text: res.message } }));
		} catch (error) {
			setFeedback(prev => ({ ...prev, [id]: { text: error instanceof Error ? error.message : String(error), error: true } }));
		} finally {
			setBusy(prev => ({ ...prev, [id]: false }));
		}
	};

	const handleCancel = async (id: string) => {
		setBusy(prev => ({ ...prev, [id]: true }));
		try {
			const res = await cancelSession(id);
			setFeedback(prev => ({ ...prev, [id]: { text: res.message } }));
		} catch (error) {
			setFeedback(prev => ({ ...prev, [id]: { text: error instanceof Error ? error.message : String(error), error: true } }));
		} finally {
			setBusy(prev => ({ ...prev, [id]: false }));
		}
	};

	const handleDelete = async (id: string) => {
		if (!confirmDelete[id]) {
			setConfirmDelete(prev => ({ ...prev, [id]: true }));
			return;
		}
		setBusy(prev => ({ ...prev, [id]: true }));
		try {
			await deleteSession(id);
			setHiddenSessions(prev => ({ ...prev, [id]: true }));
			setFeedback(prev => ({ ...prev, [id]: { text: "Trashed (retention 10d)" } }));
			if (showTrash) loadTrash();
		} catch (error) {
			setFeedback(prev => ({ ...prev, [id]: { text: error instanceof Error ? error.message : String(error), error: true } }));
		} finally {
			setBusy(prev => ({ ...prev, [id]: false }));
			setConfirmDelete(prev => ({ ...prev, [id]: false }));
		}
	};

	const handleRestore = async (relativePath: string) => {
		setTrashBusy(true);
		try {
			await restoreTrash(relativePath);
			loadTrash();
		} catch {
			// Stay in list on error
		} finally {
			setTrashBusy(false);
		}
	};

	const visibleSessions = sessions.filter(s => !hiddenSessions[s.id]);

	return (
		<div class="recent-widget">
			{visibleSessions.length === 0 ? (
				<p class="dim">No active sessions.</p>
			) : (
				<ol class="recent">
					{visibleSessions.map(s => {
						const isBusy = busy[s.id];
						const fb = feedback[s.id];
						const isConfirming = confirmDelete[s.id];
						return (
							<li key={s.id} class="session-row">
								<div class="session-info">
									<span class="recent-title">{s.title ?? s.id}</span>
									<span class="dim">
										{s.cwd} · {ago(s.lastActivity)}
									</span>
								</div>
								<div class="session-btns">
									<button
										type="button"
										disabled={isBusy}
										onClick={() => handleCompact(s.id)}
										title="Summarize and compact session context"
									>
										Compact
									</button>
									<button
										type="button"
										disabled={isBusy}
										onClick={() => handleCancel(s.id)}
										title="Abort running live turn"
									>
										Cancel
									</button>
									<button
										type="button"
										disabled={isBusy}
										class={isConfirming ? "btn-danger" : ""}
										onClick={() => handleDelete(s.id)}
										title="Move to trash (10-day retention)"
									>
										{isConfirming ? "Confirm trash?" : "Trash"}
									</button>
									{isConfirming && (
										<button
											type="button"
											class="dim"
											onClick={() => setConfirmDelete(prev => ({ ...prev, [s.id]: false }))}
										>
											✕
										</button>
									)}
									{fb && (
										<span class={`session-feedback ${fb.error ? "text-error" : "text-ok"}`}>
											{fb.text}
										</span>
									)}
								</div>
							</li>
						);
					})}
				</ol>
			)}

			<div class="trash-toggle-bar">
				<button
					type="button"
					aria-expanded={showTrash}
					onClick={() => setShowTrash(prev => !prev)}
				>
					{showTrash ? "Hide Trash" : "Show Trash"}
				</button>
			</div>

			{showTrash && (
				<div class="trash-section">
					<div class="trash-head">
						<strong>Trash (auto-pruned after 10 days)</strong>
						{trashBusy && <span class="dim">loading...</span>}
					</div>
					{trashItems.length === 0 ? (
						<p class="dim">Trash is empty.</p>
					) : (
						<ul class="trash-list">
							{trashItems.map(item => (
								<li key={item.relativePath} class="trash-row">
									<span>
										<strong>{item.project}</strong>: {item.filename} ({item.date})
									</span>
									<button
										type="button"
										disabled={trashBusy}
										onClick={() => handleRestore(item.relativePath)}
									>
										Restore
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}
