import type { Project } from "../api.ts";
import { summarize } from "../summary.ts";

// RPG-style meters: the bar is a share of the projects, the number is exact.

function Meter({ label, value, max, tone }: { label: string; value: number; max: number; tone: "hp" | "mp" | "xp" }) {
	const percent = max > 0 ? Math.round((value / max) * 100) : 0;
	return (
		<div class="meter" role="group" aria-label={label}>
			<div class="meter-head">
				<span>{label}</span>
				<span class="meter-value">{value}</span>
			</div>
			<meter class={`meter-track ${tone}`} min={0} max={100} value={percent}>
				{percent}%
			</meter>
		</div>
	);
}

export function SummaryWidget({ projects }: { projects: Project[] }) {
	const summary = summarize(projects);
	const most = Math.max(summary.projects, 1);
	return (
		<div class="meters">
			<Meter label="Projects" value={summary.projects} max={most} tone="mp" />
			<Meter label="Active in the last hour" value={summary.activeLastHour} max={most} tone="hp" />
			<Meter label="Sessions" value={summary.sessions} max={summary.sessions} tone="xp" />
		</div>
	);
}
