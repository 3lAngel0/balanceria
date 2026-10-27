# Data sources

All paths relative to the repo unless absolute. `data/` may be moved with
`AI_BALANCER_DATA_DIR`.

## `data/history/<YYYY-MM-DD>.jsonl` (30-day retention)

Reader: `readHistory(dataDir, now, days)` in `src/history.ts` returns
`{ requests, samples, errors }`.

- Request row (`HistoryEntry`): `ts, session, project, provider, model,
  input, output, cacheRead, cacheWrite, contextTokens, contextWindow,
  child?, sessionName?`. One row per model response. `child: true` means a
  subagent process.
- Quota sample (`kind: "quota"`): `ts, session, limit, key?, window,
  windowSeconds, usedPercent, resetAt`. One read of a subscription window.
- Quota error (`kind: "quota-error"`): `ts, session, project, key, until`.
  A request rejected because the window was spent.
- Route decision (`kind: "route"`, in `readHistory().routes`): `ts, session,
  project, pool, role, roleSource (argv | none), reason, chosen, decidedBy
  (sticky | waterfall | direct | highest-quota | fallback), steps[{rule,
  result, why}], candidates[{provider, quotaKey, available, remaining?,
  availableAt?}], contextTokens`. Written when a session's chosen provider or
  deciding rule for a pool changes; turns in between kept that decision.

## `data/events.jsonl`

Reader: `readEvents(dataDir)`, folded by `foldEvents(events, now)` in
`src/events.ts`.

- `usage`: tokens per response (older source, superseded by history).
- `exhausted`: `key, until, reason`. A window marked spent.
- `agy-usage`: agy quota groups.
- `route`: `pool, provider, reason`. `reason` is the input
  (`user | continuation | retry | direct`), not why the candidate won; the
  why is the history `route` decision above.

## Pi session files

`~/.gentle-shell/agent/sessions/<encoded-cwd>/<session>.jsonl`, one folder
per working directory. Entry `type`s: `session` (`cwd`, `id`),
`model_change` (`provider`, `modelId`), `thinking_level_change`,
`message` with `message.role` in `system | user | assistant | toolResult`,
`custom`. Assistant messages carry `message.usage`: `input, output,
cacheRead, cacheWrite, reasoning, totalTokens, cost`.

## Roles

`src/roles.ts`: Gentle's task store
(`~/.gentle-shell/agent/gentle-agents/tasks`) maps a child session to its
agent name. `resolveRole` joins it at read time; the task file exists only
after the task ends. At routing time the child reads its agent name from its
own argv (design R1).

## Other

- `prices.json`: list prices USD per million tokens (`asOf`, `sources`).
- `pools.json`: pools, candidates, strategy.
- `~/.gentle-shell/config/gentle-ai/profiles.json`: role → model, owned by
  gentle-pi (`kind: gentle-pi.agent_model_profiles`). Read only.
