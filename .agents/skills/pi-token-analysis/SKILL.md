---
name: pi-token-analysis
description: "Trigger: analyze token usage, token consumption, burn rate, cache efficiency, quota window, context re-sent, why is my quota draining, optimize spend, routing decision analysis. Analyze Pi session and ai-balancer data and recommend measured optimizations."
license: Apache-2.0
metadata:
  author: gentleman-programming
  version: "1.0"
---

## Activation Contract

Use when analyzing token consumption, quota drain, cache efficiency, model choice or routing decisions from Pi sessions and ai-balancer data. Not for writing prompts (use `prompt-optimizer`).

## Hard Rules

- Read data only; never edit session files, `data/` or `profiles.json` while analyzing.
- Every claim cites a number and its source file; label estimates as estimates.
- Subscription windows are not billing: report API list price only as "relative token burn".
- How cached tokens count against a subscription window is provider specific; never assume it.
- Quality cannot be measured from tokens; a cheaper model gets a warning, never a "no impact".
- Reuse `src/` readers (`readHistory`, `readEvents`, `foldEvents`, `topConsumers`) before writing new parsing.
- Never print or copy the web token (`data/web-token`) or credentials.

## Decision Gates

| Question | Source | See |
|---|---|---|
| Who/what spent tokens | `data/history/*.jsonl` requests | `references/data-sources.md` |
| Why a window filled | history `quota` samples + `quota-error` rows | `references/data-sources.md` |
| Why a provider was chosen | `data/events.jsonl` `route` events | `references/data-sources.md` |
| Per-turn detail of one session | `~/.gentle-shell/agent/sessions/<project>/<id>.jsonl` | `references/data-sources.md` |
| Is switching models worth it | switch-cost model | `references/metrics.md` |

## Execution Steps

1. Fix scope (project or all) and window (default 30 days; history keeps 30).
2. Load data through the `src/` readers; join roles with `src/roles.ts`.
3. Score the six dimensions in `references/metrics.md`.
4. Rank waste by tokens saved, not by count of findings.
5. For each recommendation give: lever, expected saving (estimate), risk, how to verify after.

## Output Contract

Return: scope and window; a table of the six dimensions with value, source and verdict; the top 3 levers ranked by saving; risks and quality warnings; what data was missing.

## References

- `references/data-sources.md`: files, fields and readers.
- `references/metrics.md`: definitions, thresholds, six dimensions, switch cost.
- `docs/design/control-plane.md`: routing, loans and switch-cost design.
