import { moveWidget, toggleHidden, type Layout } from "../src/layout-model.ts";
import type { Report } from "./api.ts";
import { WIDGET_TITLES, WidgetBody } from "./widgets/index.tsx";

// Simple mode: plain HTML layers stacked in layout order, each with show/hide
// and up/down. Every button is a real <button>, so the keyboard reaches it.

export function SimpleBoard({ layout, report, onChange }: { layout: Layout; report: Report; onChange(next: Layout): void }) {
	const last = layout.widgets.length - 1;
	return (
		<div class="layers">
			{layout.widgets.map((widget, index) => {
				const title = WIDGET_TITLES[widget.kind];
				return (
					<section key={widget.id} class={`pixel-card layer${widget.hidden ? " is-hidden" : ""}`} aria-label={title}>
						<header class="layer-head">
							<h2>{title}</h2>
							<div class="layer-tools">
								<button type="button" disabled={index === 0} aria-label={`Move ${title} up`} onClick={() => onChange(moveWidget(layout, widget.id, -1))}>
									▲
								</button>
								<button type="button" disabled={index === last} aria-label={`Move ${title} down`} onClick={() => onChange(moveWidget(layout, widget.id, 1))}>
									▼
								</button>
								<button type="button" aria-pressed={!widget.hidden} onClick={() => onChange(toggleHidden(layout, widget.id))}>
									{widget.hidden ? "Show" : "Hide"}
								</button>
							</div>
						</header>
						{widget.hidden ? null : <WidgetBody kind={widget.kind} report={report} />}
					</section>
				);
			})}
		</div>
	);
}
