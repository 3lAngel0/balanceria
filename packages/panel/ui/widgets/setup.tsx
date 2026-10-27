import { useEffect, useState } from "preact/hooks";
import {
	fetchSetup,
	saveSetupAction,
	type SetupViewUi,
	type EffectiveRoleRowUi,
	type AdvisorReportUi,
} from "../api.ts";

function categoryBadgeClass(cat: string): string {
	switch (cat) {
		case "read":
			return "badge-read";
		case "write":
			return "badge-write";
		case "audit":
			return "badge-audit";
		default:
			return "badge-orch";
	}
}

export function SetupWidget() {
	const [data, setData] = useState<SetupViewUi | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [loadingAi, setLoadingAi] = useState(false);

	const load = () => {
		setError(null);
		fetchSetup().then(
			view => setData(view),
			err => setError(err instanceof Error ? err.message : String(err)),
		);
	};

	useEffect(load, []);

	if (error && !data) {
		return (
			<div class="setup-widget">
				<p class="notice" role="alert">Cannot load setup view: {error}</p>
				<button type="button" onClick={load}>Retry</button>
			</div>
		);
	}

	if (!data) {
		return <p class="dim">Loading setup and role advisor…</p>;
	}

	const handleRoleModelChange = async (role: string, model: string) => {
		setNotice(null);
		try {
			const res = await saveSetupAction({ type: "set-role", role, model });
			if (res.setup) setData(res.setup);
			setNotice(`Updated ${role} → ${model}`);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleRoleThinkingChange = async (role: string, thinking: string) => {
		setNotice(null);
		try {
			const currentRole = data.roleRows.find(r => r.role === role);
			const model = currentRole?.configuredModel ?? "pool/orchestrator";
			const res = await saveSetupAction({ type: "set-role", role, model, thinking });
			if (res.setup) setData(res.setup);
			setNotice(`Updated ${role} thinking → ${thinking}`);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleToggleStrategy = async (poolId: string) => {
		setNotice(null);
		try {
			const res = await saveSetupAction({ type: "toggle-strategy", poolId });
			if (res.setup) setData(res.setup);
			setNotice(`Toggled strategy for pool/${poolId}`);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleQueryAi = async () => {
		setLoadingAi(true);
		setNotice("Querying lightweight AI advisor (~350 tokens)…");
		try {
			const res = await saveSetupAction({ type: "query-ai" });
			if (res.advisor) {
				setData(prev => (prev ? { ...prev, advisor: res.advisor! } : prev));
				setNotice(`AI Advisor updated: ${res.advisor.summary} (~${res.advisor.estimatedTokens} tokens)`);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setLoadingAi(false);
		}
	};

	const handleApplyAllAdvisor = async () => {
		setNotice(null);
		try {
			const res = await saveSetupAction({ type: "apply-advisor" });
			if (res.setup) setData(res.setup);
			setNotice("Applied all advisor recommendations to active profile!");
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	const handleApplySingleRecommendation = async (role: string, model: string, thinking: string) => {
		setNotice(null);
		try {
			const res = await saveSetupAction({ type: "set-role", role, model, thinking });
			if (res.setup) setData(res.setup);
			setNotice(`Applied recommendation for ${role} → ${model} (${thinking})`);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	};

	return (
		<div class="setup-widget">
			{notice && <p class="notice info-notice" role="status">{notice}</p>}
			{error && <p class="notice" role="alert">{error}</p>}

			<div class="setup-top-bar">
				<div>
					<strong>Active Profile: </strong>
					<span class="badge">{data.activeProfile ?? "(none)"}</span>
				</div>
				<div class="setup-bridges-pills">
					{data.providers.map(p => (
						<span key={p.id} class={`pill ${p.detected ? "pill-active" : "pill-dim"}`}>
							{p.label}: {p.detected ? "Detected" : "Missing"}
						</span>
					))}
				</div>
			</div>

			<div class="setup-section">
				<h3>Configured Pools & Routing Strategy</h3>
				<div class="pools-grid">
					{data.pools.map(pool => (
						<div key={pool.id} class="pool-card">
							<div class="pool-card-header">
								<strong>pool/{pool.id}</strong>
								<button
									type="button"
									class="btn-small"
									onClick={() => handleToggleStrategy(pool.id)}
									title="Click to toggle between hybrid and waterfall"
								>
									strategy: {pool.strategy ?? "hybrid"}
								</button>
							</div>
							<div class="pool-candidates-flow">
								{pool.candidates.join(" → ")}
							</div>
						</div>
					))}
				</div>
			</div>

			<div class="setup-section">
				<div class="section-header-actions">
					<h3>Agent Roles & Model Assignment</h3>
				</div>
				<table class="roles-table">
					<thead>
						<tr>
							<th>Agent Role</th>
							<th>Category</th>
							<th>Assigned Target (Pool or Bridge)</th>
							<th>Thinking</th>
							<th>Effective Route</th>
						</tr>
					</thead>
					<tbody>
						{data.roleRows.map(row => (
							<tr key={row.role}>
								<td>
									<strong>{row.role}</strong>
									<div class="row-purpose dim">{row.purpose}</div>
								</td>
								<td>
									<span class={`badge ${categoryBadgeClass(row.category)}`}>
										{row.category.toUpperCase()}
									</span>
								</td>
								<td>
									<select
										value={row.configuredModel}
										onChange={e => handleRoleModelChange(row.role, (e.target as HTMLSelectElement).value)}
									>
										{data.availableTargets.map(target => (
											<option key={target} value={target}>
												{target}
											</option>
										))}
									</select>
								</td>
								<td>
									<select
										value={row.thinking}
										onChange={e => handleRoleThinkingChange(row.role, (e.target as HTMLSelectElement).value)}
									>
										<option value="low">low</option>
										<option value="medium">medium</option>
										<option value="high">high</option>
									</select>
								</td>
								<td class="effective-col dim">{row.effectiveTarget}</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>

			<div class="setup-section advisor-section">
				<div class="advisor-header">
					<div>
						<h3>Role & Model Advisor</h3>
						<div class="dim">
							Source: {data.advisor.source === "ai+heuristic" ? `AI + Heuristic (~${data.advisor.estimatedTokens} tokens)` : "Telemetry Heuristic (0 tokens)"} · {data.advisor.summary}
						</div>
					</div>
					<div class="advisor-actions">
						<button
							type="button"
							class="btn-primary"
							disabled={loadingAi}
							onClick={handleQueryAi}
						>
							{loadingAi ? "Analyzing…" : "Run AI Analysis (~350 tokens)"}
						</button>
						<button
							type="button"
							class="btn-accent"
							onClick={handleApplyAllAdvisor}
						>
							Apply All Recommendations
						</button>
					</div>
				</div>

				<div class="recommendations-list">
					{data.advisor.recommendations.map(rec => {
						const current = data.roleRows.find(r => r.role === rec.role);
						const matches = current?.configuredModel === rec.recommendedModel && current?.thinking === rec.thinking;
						return (
							<div key={rec.role} class={`rec-card ${matches ? "rec-matches" : ""}`}>
								<div class="rec-card-main">
									<strong>{rec.role}</strong>
									<span class={`badge ${categoryBadgeClass(rec.category)}`}>{rec.category}</span>
									<span class="rec-arrow">→</span>
									<span class="rec-target">{rec.recommendedModel} [{rec.thinking}]</span>
								</div>
								<div class="rec-reason dim">{rec.reason}</div>
								{!matches && (
									<button
										type="button"
										class="btn-small"
										onClick={() => handleApplySingleRecommendation(rec.role, rec.recommendedModel, rec.thinking)}
									>
										Apply
									</button>
								)}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
