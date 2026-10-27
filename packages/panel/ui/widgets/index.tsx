import type { WidgetKind } from "../../src/layout-model.ts";
import type { Report } from "../api.ts";
import { DecisionsWidget } from "./decisions.tsx";
import { ProfilesWidget } from "./profiles.tsx";
import { ProjectsWidget } from "./projects.tsx";
import { QuotaWidget } from "./quota.tsx";
import { RecentWidget } from "./recent.tsx";
import { RulesWidget } from "./rules.tsx";
import { SummaryWidget } from "./summary.tsx";
import { TokensWidget } from "./tokens.tsx";
import { SetupWidget } from "./setup.tsx";

export const WIDGET_TITLES: Record<WidgetKind, string> = {
	summary: "Summary",
	projects: "Projects",
	recent: "Recent sessions",
	tokens: "Tokens per day",
	quota: "Quota windows",
	decisions: "Routing decisions",
	rules: "Rule editor",
	profiles: "Profiles editor",
	setup: "Setup & Role Advisor",
};

export function WidgetBody({ kind, report }: { kind: WidgetKind; report: Report }) {
	switch (kind) {
		case "summary":
			return <SummaryWidget projects={report.projects} />;
		case "projects":
			return <ProjectsWidget projects={report.projects} />;
		case "recent":
			return <RecentWidget projects={report.projects} />;
		case "tokens":
			return <TokensWidget usage={report.usage} />;
		case "quota":
			return <QuotaWidget usage={report.usage} />;
		case "decisions":
			return <DecisionsWidget decisions={report.decisions} />;
		case "rules":
			return <RulesWidget decisions={report.decisions} />;
		case "profiles":
			return <ProfilesWidget />;
		case "setup":
			return <SetupWidget />;
	}
}
