# Metrics

## Definitions (match the code)

- `turn` = input + output + cacheRead + cacheWrite (everything moved).
- `new` = input + output + cacheWrite (what was not read from cache).
- `ctx` delta = contextTokens now minus the previous response.
- `contextResend` = input + cacheRead + cacheWrite (`src/consumers.ts`).
- `% re-sent` = contextResend / total; the HUD warns from 90%
  (`RESEND_WARN` in `src/hud.ts`).
- Cache hit ratio = cacheRead / (input + cacheRead + cacheWrite).

## Thresholds in use

- Turn light: green under 50k, yellow from 50k, red from 150k.
- Context: warn at 120k, critical at 200k (suggest `/compact`).
- Switch cost defaults (design D3): cheap under 30k context; wait if the
  window resets in under 30 min and context is over 30k.

## Six dimensions

Adapted from the `tokeneconomics` skill (florianbuetow/claude-code, MIT).

| Dimension | Measure | Waste signal |
|---|---|---|
| Cost | relative burn per day, per provider, per role | one role or session dominating |
| Cache efficiency | cache hit ratio, cacheWrite share | low hit ratio, frequent rewrites (provider switches, idle >5 min) |
| Conversation sprawl | contextTokens growth, % re-sent | sessions past 120k without compaction |
| Model selection | tokens per role per model | top-tier model on mechanical roles |
| Output efficiency | output / turn | large outputs re-read every turn |
| Session patterns | window fills, quota errors, time to fill | fills before reset, repeated errors |

## Switch cost

```
switch cost   ≈ context re-sent uncached + cache write + continuity risk
switch benefit ≈ work that no longer waits for the reset
```

Cheap moments: new subagent, new session, right after compaction.
Expensive: mid session with a large context; prefer wait, compact-then-
switch, or continue from a summary.
