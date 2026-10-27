import type { Project } from "../api.ts";
import { ago } from "../format.ts";

export function ProjectsWidget({ projects }: { projects: Project[] }) {
	if (projects.length === 0) return <p class="dim">No Pi sessions found yet.</p>;
	return (
		<table>
			<thead>
				<tr>
					<th>Project</th>
					<th>Sessions</th>
					<th>Last activity</th>
					<th>Newest session</th>
					<th>GitHub</th>
				</tr>
			</thead>
			<tbody>
				{projects.map(p => (
					<tr key={p.dir}>
						<td>{p.cwd ?? p.dir}</td>
						<td>{p.sessions}</td>
						<td>{ago(p.lastActivity)}</td>
						<td>{p.latest.title ?? p.latest.id}</td>
						<td>
							{p.github ? (
								<a href={p.github} rel="noopener noreferrer" target="_blank">
									{p.github.replace("https://github.com/", "")}
								</a>
							) : (
								<span class="dim">-</span>
							)}
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}
