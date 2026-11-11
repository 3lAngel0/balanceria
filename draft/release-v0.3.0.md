# ai-balancer v0.3.0 — Interactive Setup Hub & Conversational Installer

> **Release Version**: `v0.3.0`  
> **Release Date**: November 2026  
> **Milestone PR**: [#22](https://github.com/3lAngel0/balanceria/pull/22)  
> **Branch**: `feat/dummy-interactive-setup`  

---

## 🌟 Highlights

ai-balancer v0.3.0 transforms configuration from a technical chore into a guided, welcoming experience. It introduces a unified, 3-column interactive installer available simultaneously via terminal TUI and local browser at `/installer`, backed by a shared state engine, an AI-powered setup advisor, pixel-art animations, and strict non-overwriting backup guarantees.

---

## 🚀 Key Features

### 1. Dual-Channel Interactive Installer (Terminal TUI & Web `/installer`)
- **Shared State Architecture** (`src/installer-model.ts`): Identical screens, options, recommendations, and validations across CLI and web.
- **Terminal TUI**: Boxed interface with arrow/space/enter keyboard navigation, mouse click support in fullscreen terminals, and terminal wait screen when running web mode.
- **Web Interface** (`src/web-installer.ts`, `src/web-installer-page.ts`): Lightweight, accessible interface available at `http://127.0.0.1:8787/installer?token=...`.
- **Ephemeral Lifecycle & Strict Security**:
  - `/installer` route is created on demand and torn down when the session completes.
  - Zero `innerHTML`, zero inline `style="..."`, zero `eval()`.
  - Strict Content Security Policy (`default-src 'self'`, `script-src 'self'`, `style-src 'self'`).
  - Mutations accepted only over loopback (`127.0.0.1`) or HTTPS.

### 2. Conversational Guide with Capybara Mascot & Animated Scale
- **3-Column Layout**:
  - **Left Rail**: Step checklist with status markers (`✓` done, `●` current, `○` todo) and "Step N of M" counter.
  - **Center Stage**: Conversational guide featuring a pixel-art Capybara mascot and a balancing scale with procedural animations:
    - Poses: `idle` (resting), `working` (scanning, deep analysis, installing), and `happy` (success).
    - Animations: breathing, blinking, and tilting balance pans.
    - Full reduced-motion accessibility: respects `AI_BALANCER_REDUCE_MOTION=1` and `prefers-reduced-motion: reduce` by freezing to crisp static sprites.
    - Always-visible reassurance note: *"Nothing is applied until you confirm, and you can always go back."*
    - Single-flight double-click guard on all actions.
  - **Right Rail**: Dedicated, always-visible help panel explaining *"What it is"*, *"What it's for"*, *"If you pick this"*, technical name, and target configuration file.

### 3. Welcome Experience & Concept Glossary
- **Plain-Language Architecture Mapping**:
  - **Subscription** → `integrations.json` (provider credentials and quota limits).
  - **Backup** → `pools.json` (failover pools of equivalent models).
  - **Agent Task** → `profiles.json` (agent role assignments: explore, worker, verify, review).
  - **Routing Strategy** → `pools.json` (`hybrid`, `waterfall`, `highest-quota`).
  - **Main Agent Mode** → `profiles.json` (`organic` vs `full-delegation`).
- Community engagement link: [https://github.com/3lAngel0/balanceria](https://github.com/3lAngel0/balanceria).

### 4. Backup Pipeline & Granular Strategies
- Full control over candidate priority ordering (`u` / `d`) within multi-subscription pools.
- Cost-aware warnings when mixing budget models (e.g. Gemini Flash) with premium frontier models (e.g. Claude Opus).
- Strategy explanations with real-world examples:
  - **Mixed** (`hybrid`): Preserves cache and fails over when quota is nearly exhausted.
  - **In Order** (`waterfall`): Drains the primary subscription completely before touching the backup.
  - **Most Room Left** (`highest-quota`): Dynamically routes to the subscription with the highest remaining fraction.

### 5. Agent Tasks & AI Deep Analysis ("Búsqueda profunda")
- **Two Optimization Paths**:
  - **Assign recommended**: Fast, 0-quota instant assignment matching proven cost/capability tiers.
  - **Deep analysis**: Consults an AI Setup Advisor model to evaluate role allocations based on real benchmark strengths, context windows, and pricing.
- **Interactive Feedback**:
  - Animated indeterminate progress bar with a live elapsed seconds counter.
  - Single-flight concurrency lock preventing duplicate queries or wasted quota.
  - Confirmation status banner reporting exact duration (seconds), tokens consumed, and the subscription billed.

### 6. Human-Readable Summary & Safety Guarantees
- **Plain-Language Narrative**: Clear explanation of how traffic will be routed before any file is touched.
- **Backup Preservation**: Automatically retains existing pools referenced by saved profiles to prevent dangling references.
- **Per-Install Timestamped Backups**: Generates unique snapshots (`<file>.bak-installer-YYYYMMDDHHMMSS[-n]`) without overwriting previous `.bak` files.
- **Exact Undo**: Single-click *"Undo everything"* restores files to the exact pre-install state.

---

## 🛠️ Installation & Getting Started

### Launching the Installer
```bash
# Standard interactive setup (prompts for Language and Terminal vs Web)
/balancer setup

# Directly open the guided terminal installer
/balancer setup --dummy
# or shortcut:
/balancer dummy

# Fast technical stepper (for advanced users)
/balancer setup --skip
# or shortcut:
/balancer skip
```

---

## 🧪 Test Suite & Verification

- **959/959 automated tests passing** across unit, integration, and TUI/web harness suites:
  ```bash
  npm test
  ```
- Validated CSP enforcement, session authentication, and loopback restrictions.
- Zero external runtime dependencies added.

---

## 📦 What's Changed (Changelog)

- `feat(installer)`: Shared installer model, pure navigation plan, and en/es i18n (`5080d8f`).
- `feat(installer)`: Terminal installer with channel prompt and mouse support (`d6babbf`).
- `feat(installer)`: Plain model names and per-task model picker (`bbec2df`).
- `feat(installer)`: Secure web installer page with `/api/installer` and terminal wait screen (`bbd0ba4`, `4e172a5`).
- `feat(installer)`: Round 2 shared model & advisor with welcome glossary, help focus, and deep analysis (`ddec5b5`).
- `fix(installer)`: Per-install timestamped backups and referenced pool preservation (`682e8c3`).
- `feat(installer)`: Console help panel, visible shortcuts, and Capybara mascot (`9efecf9`).
- `docs(design)`: Gentle Design system sync and web conversational guide direction (`860af7f`).
- `feat(installer)`: Conversational web installer implementation with Techwear Cyber-Gaucho pixel art (`125df9a`, `226d4b9`).
- `feat(installer)`: Remote LAN web forwarding and interactive firewall configuration (`968e38d`, `ff6c48e`).
- `fix(installer)`: Full walkthrough in fresh start mode and visible assigned models per task (`5afbf82`, `a6aef32`).
- `docs`: Full bilingual documentation updates across README and guides (`acb6432`).

---

*Thank you to everyone testing and contributing to ai-balancer!*
