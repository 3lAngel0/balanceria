# Feature: Pool Quota Balancing, Failover UX, Usage Source & Multi-Session Overview
Status: done
Branch: feat/ui-pixel-apply

## Specs

- **S1**: Fix pool quota state, stall classification, and false exhaustion lockouts when Argon (`antigravity/gemini-4-argon`) or Claude (`antigravity/claude`) hits quota or stalls while Gemini 3.8 Flash (`antigravity/gemini`) still has quota ("Argon 4 se acaba rápido y despues los que es Claude en Agy es muy chico lo que te permiten una vez que eso se acaba empiezan los problema.", "el 3.8 me anda lo probe en la web y demas, es solo para claude y argon"). Recognize `"Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 21h51m52s."`, `"Error: agy stopped responding on the resumed conversation (no response frame before the deadline; the conversation is dead). The binding was cleared, so the next antigravity turn starts a fresh conversation."`, `"Error: agy stalled for 5m with no output"`, and `"Warning: Antigravity stalled with no output; the turn was stopped"`. Ensure stall cooldown (`DEFAULT_STALL_COOLDOWN_MS` >= 6m) exceeds the 5m stall timeout so retries do not ping-pong back into a stalled model, and lift stale exhaustion when a model succeeds (`usage` event) or `agy /usage` reports positive remaining quota on `antigravity/gemini`.
- **S2**: Improve failover UX and status line readability ("si me salta un error de argon porque esta lleno poneme \"Argon se lleno se cambia a xxxx modelo\" no me tires el error porque sino no entiendo o al menos sacamelo de la pantalla principal ponelo en status (que por cierto no se entiende mucho porque esta todo seguido estaria bueno espaciarlo para que quede mas legible (ahi usa tus skills de UX|UI Etc)."). Record and display the exact `provider/model` in `route` events, notifications, and `statusLine`, and space out `statusLine` / `statusWithContext` with visual separators (`  │  `).
- **S3**: Fix `alt+u` vs `ctrl+alt+u` tab 5 and top-right USAGE bar ("por otro lado aprovechando esto el alt U no me muestra todo como si el ctrl-alt-U pestaña 5. por lo que creo que ahi tambien tenemos otro fallo y paralelamente lo que es el USAGE: mOSTRAME EL USAGE (ARRIBA PARTE DERECHA) que del modelo que estoy usando sino no me doy cuenta."). Ensure `routedKey` resolves the exact routed `provider/model` (or active `ctx.model`), `claudeSource` falls back to cached `claude-usage.json` on disk so `alt+u` always includes both Claude and Antigravity windows, and `combinePoolUsage` overlays `QuotaState` exhaustion so spent windows (such as Argon when daily quota is hit) report 100% used (`limitReached: true`) and place the active model's limit first for the top-right USAGE bar.
- **S4**: Multi-session workspace visibility and model copy/apply in `/balancer` tab 1 ("si estoy trabajando con sesiones de diferentes carpetas de shell deberías decirme en el /balancer hoja 1 en la sesión xxx estas trabajando con este modelo y permitirme copiarlo o modificarlo desde la otra sesión"). Show active sessions across shell folders/projects in Control Center tab 1 (`overview`) with their session ID, workspace folder, and active `provider/model`, and support copying/applying a session's model from the overview tab.
- **S5**: Auto-sync subagents configuration (`~/.gentle-shell/agent/subagents.json`) when saving profiles in `saveProfilesStore` ("dale sumalo al pr actual y hace una prueba con los workers para que funcione."). When roles or profile selections are saved via `saveProfilesStore`, synchronize the active profile's non-orchestrator subagent routes directly into `subagents.json` so Gentle Pi immediately picks up model and effort assignments without requiring an external command.

## Tasks

- [x] **T1** (`S1`, `S2`) — Fix stall/dead-conversation classification, cooldowns, quota state recovery on live usage/success, and `model` tracking in `route` events (`src/quota-errors.ts`, `src/state.ts`, `src/events.ts`, `tests/*.test.ts`) — route: inline (`gentle-ai-worker` timed out on `pool/claude-sonnet-5-5`) — commit: 18deff0
- [x] **T2** (`S3`) — Fix `routedKey`, cached Claude fallback, `QuotaState` exhaustion overlay in `usage-source.ts`, and live usage source refresh on model/route change (`src/usage-source.ts`, `src/extension.ts`, `tests/usage-source.test.ts`) — route: inline — commit: 18deff0
- [x] **T3** (`S2`, `S4`) — Implement clear localized failover message, spaced readable `statusLine`, and multi-session workspace overview with model copy/apply in `/balancer` tab 1 (`src/panel.ts`, `src/extension.ts`, `src/i18n/messages/setup.ts`, `tests/panel.test.ts`) — route: inline — commit: 18deff0
- [x] **T4** (`S5`) — Implement automatic `subagents.json` synchronization on profile saves and verify with live `gentle-ai-worker` execution (`src/profiles.ts`, `tests/profiles.test.ts`) — route: inline + subagent_run verified — commit: working-tree

## Log

- **L1**:
```
❯ igue tirando error que pasa?! creo que tenemos un problema grave con el pool de blanaceo de las suscricpiones de Agy Claude + el plan de Claude con el bridge, ahi viene
 todo el problema, creo que estamos haciendo mal esa parte,porque:
   Argon 4 se acaba rápido y despues los que es Claude en Agy es muy chico lo que te permiten una vez que eso se acaba empiezan los problema.

 pensemos un segundo en la experiencia de usuario si me salta un error de argon porque esta lleno poneme "Argon se lleno se cambia a xxxx modelo" no me tires el error
  porque sino no entiendo o al menos sacamelo de la pantalla principal ponelo en status (que por cierto no se entiende mucho porque esta todo seguido estaria bueno espaciarlo
  para que quede mas legible (ahi usa tus skills de UX|UI Etc). por otro lado aprovechando esto el alt U no me muestra todo como si el ctrl-alt-U pestaña 5. por lo que creo
 que   ahi tambien tenemos otro fallo y paralelamente lo que es el USAGE: mOSTRAME EL USAGE (ARRIBA PARTE DERECHA) que del modelo que estoy usando sino no me doy cuenta.
  Te pido que recapacitemos sobre esto, no puede seguir pasando.
  Otro tema si estoy trabajando con sesiones de diferentes carpetas de shell deberías decirme en el /balancer hoja 1 en la sesión xxx estas trabajando con este modelo y
 permitirme copiarlo o modificarlo desde la otra sesión esto te lo dejo para pensar.
 Ayer no pude hacer consultas por estos errore 5m de working sin ahcer nada:
   ❯ Error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 21h51m52s.

   Error: agy stopped responding on the resumed conversation (no response frame before the deadline; the conversation is dead). The binding was cleared, so the next
 antigravity
   turn starts a fresh conversation.

   Error: agy stalled for 5m with no output

   Reloaded keybindings, extensions, skills, prompts, themes, and context files

   Error: agy stalled for 5m with no output

   Warning: Antigravity stalled with no output; the turn was stopped

   Warning: Antigravity warning: turn-end s
```
- **L2**:
```
parte 1 punto 3 no es asi, el 3.8 me anda lo probe en la web y demas, es solo para claude y argon te puedo demostrar aca: GEMINI MODELS
  Models within this group: Gemini Flash, Gemini Pro

  Weekly Limit Remaining
    [███████████████████████████████████████████████░░░] 94.96%
    Refreshes in 132h 9m

  Five Hour Limit Remaining
    [████████████████████████████████████████████████░░] 95.49%
    Refreshes in 4h 48m


CLAUDE AND GPT MODELS
  Models within this group: Claude Opus, Claude Sonnet, GPT-OSS

  Weekly Limit Remaining
    [░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░] 0.00%
    Refreshes in 85h 49m

  Five Hour Limit Remaining
    Disabled: You have hit your weekly limit, the 5-hour limit does not currently apply. Your weekly limit will fully refresh in 3 days, 13 hours.


GEMINI 4 ARGON
  For paid Pro plans, Argon quota is separate. Higher Argon quota (included as part of the larger Gemini quota bucket) is available on Ultra plans.

  Gemini 4 Argon Weekly Limit
    [██████████████████████████████████████████████████] 100.00%
    Quota available
 parte 2 - ok parte 3 - si aplicado pero antes fijate mi comentario de la parte 1 para hacer todo el budget de trabajo junto.
```
- **L3**:
```
dale sumalo al pr actual y hace una prueba con los workers para que funcione.
```
