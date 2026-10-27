# Research notes

Collected 2026-10-16 while auditing the Gentle Shell model routing.

## Environment

- Gentle Shell 4.3.0 on Pi 1.2.0, isolated home `~/.gentle-shell/agent`.
- Providers in use: `antigravity` (npm:@estebanforge/pi-antigravity-bridge 1.8.4, wraps the `agy` CLI)
  and `claude-bridge` (npm:pi-claude-bridge). Usage display: npm:@danielgap/pi-claude-usage.
- Profiles store: `~/.gentle-shell/config/gentle-ai/profiles.json` (active `mu-privado`).
  Orchestrator defaults: `~/.gentle-shell/agent/settings.json`.

## Antigravity quota

`agy --print /usage --output-format json` returns `command.data.groups[]`, each with
`buckets[]` (`id`, `window` weekly|5h, `remaining_fraction`, `reset_time`, optional `disabled`).
Groups are independent:

| Group | Models | Buckets |
|---|---|---|
| Gemini Models | Gemini Flash, Gemini Pro | `gemini-weekly`, `gemini-5h` |
| Claude and GPT models | Claude Opus, Claude Sonnet, GPT-OSS | `3p-weekly`, `3p-5h` |
| Gemini 4 Argon | Argon | `gemini-argon-wtu-weekly` |

Quota is consumed proportionally to token cost. On 2026-10-16 the `3p-weekly` bucket hit 0
(reset 2026-10-23T05:37:32Z) while Gemini and Argon stayed at 1.0.

## Claude Bridge quota

Gentle Shell docs: for Claude Pro/Max, usage arrives in the rate-limit headers of every response,
so the 5h and weekly windows appear after the first turn.

## Pi mechanisms

- `pi.registerVirtualModel({ provider, id, route(request, ctx) })` (docs/virtual-models.md):
  `route` runs before every request; `request.reason` is `user | continuation | retry | direct`;
  on `retry`, `request.failed` carries the failed assistant message (`stopReason`, `errorMessage`).
  Returning `previous`/`failed` keeps prompt caches valid. Example: `examples/extensions/jev-router.ts`.
- UI (docs/tui.md): `ctx.ui.setStatus()`, `ctx.ui.setWidget(key, lines, { placement })`,
  `ctx.ui.custom(..., { overlay: true })` with size/anchor/offset options; no native docked sidebar.
- Gentle Shell usage sources: emit `gentle-pi:usage-source/v1` on `pi.events` with
  `{ schema, provider, fetch(apiKey, fetchFn, now) }` to show a provider in the header usage table.

## T1 spike findings (2026-10-16)

- **Quota errors are not retried by Pi.** `pi-ai/dist/utils/retry.js:189` `isRetryableAssistantError`
  retries only messages matching `RETRYABLE_PROVIDER_ERROR_PATTERN` (`overloaded`, `rate.?limit`,
  `too many requests`, `429`, `5xx`, network errors) and never `NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN`
  (`quota exceeded`, `insufficient_quota`, `billing`, `GoUsageLimitError`, `Monthly usage limit reached`, ...).
  agy's "You have hit your weekly limit" matches neither, so the turn ends and a virtual model never
  sees `reason: "retry"`. Defaults: `retry.maxRetries` 3, `retry.baseDelayMs` 2000 (docs/settings.md:127).
- **Switch mechanism.** `message_end` can replace a finalized message (docs/extensions.md:106).
  For sessions on a `pool/*` model only, the extension rewrites a recognized provider quota error into
  a retryable form (must avoid the non-retryable words above), records the bucket as exhausted until
  its reset, and Pi's own retry calls `route()` with `reason: "retry"`, which picks the next provider.
- **Proactive routing.** `route()` also consults cached quota before every `user` request.
- **Subagents.** gentle-pi children inherit settings `packages` unless the launcher used a takeover
  (`lib/agents-runner.ts:324`, `lib/child-package-injection.ts`), and receive `--model provider/id:thinking`.
- **Side panel.** pi-tui `OverlayOptions`: `width`, `minWidth`, `maxHeight`, `anchor`, `offsetX/Y`,
  `row/col`, `margin`, `visible(termWidth, termHeight)`, `nonCapturing` (does not take keyboard focus);
  `OverlayHandle.setHidden()` toggles it.
- **Open for T5 (live check).** Gentle `switchLiveOrchestrator` resolves profile orchestrators with
  `ctx.modelRegistry.find` (gentle-ai.ts:4493); confirm it returns virtual models.

## OpenCode Go (future, S6)

$10/month (Go) or $40/month (Go Plus); open models (Kimi K3, GLM-5.3, DeepSeek V4 Pro, Qwen3.8,
MiniMax M3, MiMo, ...). Pi 1.2 has a native `opencode-go` provider (`OPENCODE_API_KEY`).
