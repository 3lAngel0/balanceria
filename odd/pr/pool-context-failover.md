# fix(pool): proactive compaction, stall loop, failover UX and usage accuracy

## Summary

Fixes the long stalls and `Prompt is too long` errors seen when a `pool/*` session fails over from Antigravity to claude-bridge, and the related failover, status, usage, and profile path resolution issues.

### 1. Proactive compaction (root cause of the multi-minute waits)
- Antigravity resumes its own server-side conversation, so the usage it reports covers only that conversation (~157k-181k), not pi's real history.
- Pi decides when to compact from that usage, and pool models register a 1M window, so sessions grew to ~1M tokens without compacting (measured: `tokensBefore` 964,379 and 1,255,669).
- The first switch to claude-bridge sent the whole history and failed with `Prompt is too long`; the recovery compaction then took ~8.5 minutes.
- New `src/context-guard.ts` estimates the real history (chars / 4, same heuristic as pi) and compacts at **180k** estimated tokens on `pool` and `antigravity` models, when the agent settles. On the real mu-web session the estimate was 1,227,704 vs 1,255,669 measured by pi.

### 2. Stall loop and false lockouts
- Recognizes dead resumed conversations, 5m stalls and individual quota resets.
- Stall cooldown raised to 6m (above pi's 5m stall timeout) so retries do not bounce back into a stalled model.
- A successful turn lifts stale exhaustion; `agy /usage` with margin lifts false `antigravity/gemini` blocks.

### 3. Failover UX and status line
- Localized notices such as "Argon se llenó, se cambia a ..." instead of raw provider errors.
- `route` events record the exact `provider/model`; the status line uses spaced `│` separators.

### 4. Usage accuracy (`alt+u` and the top-right USAGE bar)
- Shows the routed model's window first, falls back to cached `claude-usage.json`, and overlays known exhaustion.

### 5. Multi-session overview, subagent sync and dynamic profile path resolution
- `/balancer` tab 1 lists sessions in other folders with their model, with copy/apply.
- Dynamic path resolution for `profiles.json` and `subagents.json` honoring `GENTLE_SHELL_PREFIX`, `GENTLE_PI_CONFIG_HOME`, `GENTLE_SHELL_CONFIG_HOME`, and `~/.pi/gentle-ai` fallbacks, so profiles save and read reliably across both bundled and standalone environments.
- Saving a profile syncs `subagents.json` automatically.
- `pools.json` is hot-reloaded, and a picker appears when every candidate is exhausted.

## Verification

- `AI_BALANCER_LANG=en node --test tests/*.test.ts packages/panel/tests/*.test.ts`: 771/771 pass.
- Context guard replayed against the real mu-web session that failed.

## Risk

Risk: item 6 (proactive compaction runs inside pi's lifecycle; unit tests cover the estimate and the decision, but the `ctx.compact()` call in `agent_settled` is only verified manually in a live session).
