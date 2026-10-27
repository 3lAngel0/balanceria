import { useEffect, useState } from "preact/hooks";
import { setMode, withAllKinds, type Layout, type Mode } from "../src/layout-model.ts";
import { fetchLayout, fetchReport, saveLayout, type Report } from "./api.ts";
import { AdvancedBoard } from "./advanced.tsx";
import { AlertsBanner } from "./alerts.tsx";
import { SimpleBoard } from "./simple.tsx";

const POLL_MS = 30_000;
const MODES: { mode: Mode; label: string }[] = [
	{ mode: "simple", label: "Simple" },
	{ mode: "advanced", label: "Advanced" },
];

function message(reason: unknown): string {
	return reason instanceof Error ? reason.message : String(reason);
}

export function App() {
	const [report, setReport] = useState<Report | null>(null);
	const [layout, setLayout] = useState<Layout | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [saveError, setSaveError] = useState<string | null>(null);

	useEffect(() => {
		const load = () =>
			fetchReport().then(
				next => {
					setReport(next);
					setError(null);
				},
				reason => setError(message(reason)),
			);
		void load();
		fetchLayout().then(l => setLayout(withAllKinds(l)), reason => setError(message(reason)));
		const timer = setInterval(load, POLL_MS);
		return () => clearInterval(timer);
	}, []);

	/** Shows the change at once; a refused save puts the saved layout back. */
	function change(next: Layout): void {
		const before = layout;
		setLayout(next);
		saveLayout(next).then(
			saved => {
				setLayout(saved);
				setSaveError(null);
			},
			reason => {
				setLayout(before);
				setSaveError(`Layout not saved: ${message(reason)}`);
			},
		);
	}

	if (error) return <p role="alert">Cannot load the panel: {error}</p>;
	if (!report || !layout) return <p>Loading the panel…</p>;
	return (
		<>
			<header class="top">
				<h1>Pi control panel // {report.projects.length} projects</h1>
				<div class="modes" role="radiogroup" aria-label="Mode">
					{MODES.map(({ mode, label }) => (
						<button key={mode} type="button" role="radio" aria-checked={layout.mode === mode} onClick={() => layout.mode !== mode && change(setMode(layout, mode))}>
							{label}
						</button>
					))}
				</div>
			</header>
			<AlertsBanner alerts={report.alerts ?? []} />
			{saveError ? (
				<p class="notice" role="alert">
					{saveError}
				</p>
			) : null}
			{layout.mode === "simple" ? (
				<SimpleBoard layout={layout} report={report} onChange={change} />
			) : (
				<AdvancedBoard layout={layout} report={report} onChange={change} />
			)}
		</>
	);
}
