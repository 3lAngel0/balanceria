import { useEffect, useRef, useState } from "preact/hooks";
import type { Alert } from "./api.ts";

export function AlertsBanner({ alerts }: { alerts: Alert[] }) {
	const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
	const [perm, setPerm] = useState<NotificationPermission>(() => {
		if (typeof window !== "undefined" && "Notification" in window) {
			return Notification.permission;
		}
		return "denied";
	});
	const notifiedRef = useRef<Set<string>>(new Set());

	// Browser notification dispatch
	useEffect(() => {
		if (perm !== "granted" || typeof window === "undefined" || !("Notification" in window)) {
			return;
		}

		for (const alert of alerts) {
			if (!notifiedRef.current.has(alert.id) && !dismissed.has(alert.id)) {
				notifiedRef.current.add(alert.id);
				try {
					new Notification(alert.title, {
						body: alert.message,
						tag: alert.id,
					});
				} catch {
					// Notification constructor blocked or failed in insecure context
				}
			}
		}
	}, [alerts, perm, dismissed]);

	const activeAlerts = alerts.filter(a => !dismissed.has(a.id));
	if (activeAlerts.length === 0) return null;

	function dismiss(id: string) {
		setDismissed(prev => new Set([...prev, id]));
	}

	function requestBrowserPermission() {
		if (typeof window !== "undefined" && "Notification" in window) {
			Notification.requestPermission().then(res => setPerm(res));
		}
	}

	const hasNotificationSupport = typeof window !== "undefined" && "Notification" in window;

	return (
		<aside class="alerts-banner" aria-label="Active system alerts">
			<div class="alerts-header">
				<span class="alerts-title">
					<strong>Alerts ({activeAlerts.length})</strong>
				</span>
				<div class="alerts-actions">
					{hasNotificationSupport && perm === "default" && (
						<button type="button" class="alerts-perm-btn" onClick={requestBrowserPermission}>
							Enable browser notifications
						</button>
					)}
					{hasNotificationSupport && perm === "granted" && (
						<span class="alerts-perm-status dim">[Browser notifications active]</span>
					)}
				</div>
			</div>
			<ul class="alerts-list">
				{activeAlerts.map(alert => (
					<li key={alert.id} class={`alert-item is-${alert.level}`}>
						<span class={`alert-badge is-${alert.level}`}>[{alert.level.toUpperCase()}]</span>
						<div class="alert-content">
							<span class="alert-item-title">
								<strong>{alert.title}</strong>
							</span>
							<span class="alert-item-msg">{alert.message}</span>
						</div>
						<button
							type="button"
							class="alert-dismiss-btn"
							aria-label={`Dismiss alert ${alert.title}`}
							onClick={() => dismiss(alert.id)}
						>
							✕
						</button>
					</li>
				))}
			</ul>
		</aside>
	);
}
