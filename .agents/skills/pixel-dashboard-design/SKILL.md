---
name: pixel-dashboard-design
description: Use this skill when designing retro pixel-art style interactive web dashboards, single-file offline-first telemetry reports, RPG-style health/mana meters, CSS pixel grids, retro gaming aesthetics, or exportable HTML analytical reports. Activates on mentions of pixel art dashboard, retro HTML report, RPG status meters, pixel art CSS, retro gaming web design, 8-bit/16-bit web UI, offline web dashboard, or standalone HTML reporting.
---

# Pixel-Art Dashboard & Standalone Web Reporting

Design principles and implementation standards for standalone, single-file interactive web reports styled with retro pixel-art aesthetics. Prioritize self-containment, accessibility, semantic integrity, and offline execution for environments such as air-gapped VMs, developer local machines, and static exports.

## Core Architecture: Single-File & Offline-First

Analytical reports must be fully self-contained in a single `.html` document.

| Requirement | Implementation Pattern | Rationale |
|---|---|---|
| **Zero External CDNs** | All styles and scripts embedded in `<style>` and `<script>` | Reports must open immediately inside offline VMs, sandboxes, and servers without network access. |
| **System/Fallback Fonts** | Monospace stack (`ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace`) | Avoid broken layouts when external pixel web fonts fail to load or are blocked by CSP. |
| **Pixel Art Rendering** | `image-rendering: pixelated; image-rendering: crisp-edges;` | Prevents browser bilinear filtering and blurring on scaled retro assets and pixel borders. |
| **Inline Vector Assets** | Pure SVG or CSS shapes for icons, badges, and retro sprites | Zero asset dependencies; infinite sharp scaling matching pixel grid multiples (1x, 2x, 4x). |
| **Portable Data Payload** | Structured JSON embedded in a `<script id="report-data" type="application/json">` tag | Decouples reporting logic from data rendering; enables easy client-side filtering and export. |

## CSS Pixel Art Engine & Grid Rules

### 1. Stepped Pixel Borders
Avoid smooth standard CSS borders. Use stepped box-shadows or border-image to create authentic 8-bit / 16-bit container frames:

```css
/* 2px stepped pixel border without external images */
.pixel-box {
  background: var(--bg-surface);
  box-shadow:
    0 -4px 0 0 var(--border-color),
    0 4px 0 0 var(--border-color),
    -4px 0 0 0 var(--border-color),
    4px 0 0 0 var(--border-color);
  margin: 4px;
}

/* Outer bevel for retro RPG dialogue card */
.pixel-card {
  border: 4px solid var(--border-dark);
  box-shadow:
    inset -4px -4px 0 0 var(--shadow-deep),
    inset 4px 4px 0 0 var(--highlight-light);
  padding: 12px;
}
```

### 2. Typography & Pixel Grid Snapping
- Base scale on multiples of 4px or 8px (`4px, 8px, 16px, 24px, 32px`).
- Use `text-rendering: geometricPrecision;` or system monospace with `letter-spacing: -0.5px;` for a compact, readable retro terminal feel.
- Never use fractional pixel values (`1.5px`, `0.75rem` when not aligning to grid) to avoid blurry anti-aliasing.

### 3. Optional CRT Filter with Reduced Motion Guard
CRT scanlines and subtle curvature enhance the retro aesthetic but must respect user accessibility settings:

```css
.crt-overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(
    rgba(18, 16, 16, 0) 50%,
    rgba(0, 0, 0, 0.25) 50%
  );
  background-size: 100% 4px;
  z-index: 9999;
}

@media (prefers-reduced-motion: reduce) {
  .crt-overlay {
    display: none;
  }
  * {
    animation-duration: 0.001ms !important;
    transition-duration: 0.001ms !important;
  }
}
```

## RPG Telemetry & Status Gauges

Translate telemetry and quota consumption into intuitive RPG status meters:

| Metric | RPG Metaphor | Color Theme | Semantic Mapping |
|---|---|---|---|
| **Primary Provider Quota** | **HP (Hit Points)** | 🟢 Green (`#38b764`) → 🟡 Yellow (`#f77622`) → 🔴 Red (`#b13e53`) | `<meter min="0" max="100" value="..">` |
| **Secondary / Fallback Quota** | **MP (Mana Points)** | 🔵 Cyan / Mana Blue (`#257179` / `#3b5dc9`) | `<meter>` with custom mana gradient |
| **Prompt Cache Efficiency** | **XP (Experience / Shield)** | 🟣 Purple / Gold (`#a363d9` / `#ef7d57`) | Progress towards optimal cache reuse |
| **Active Session State** | **Character Class / Level** | Status badges (e.g. `LVL 2: mu-privado`) | Metadata chip with pixel border |

### Accessible RPG Meter Component

```html
<div class="rpg-meter" role="region" aria-label="Claude Subscription Quota">
  <div class="rpg-meter-header">
    <span class="label">HP [Claude 3.5 Sonnet]</span>
    <span class="value" aria-live="polite">84 / 100%</span>
  </div>
  <div class="meter-track">
    <div class="meter-fill hp-fill" style="width: 84%;" aria-hidden="true"></div>
  </div>
  <meter class="sr-only" min="0" max="100" value="84">84% remaining</meter>
</div>
```

```css
.meter-track {
  height: 16px;
  background: #181425;
  box-shadow: inset 2px 2px 0 0 #000;
  padding: 2px;
  display: flex;
}

.meter-fill.hp-fill {
  background: repeating-linear-gradient(
    90deg,
    #38b764 0px,
    #38b764 8px,
    #257179 8px,
    #257179 10px
  );
  height: 100%;
}
```

## W3C & WCAG 2.1 AA Compliance Standards

1. **Contrast Ratio (Level AA)**:
   - Text vs. Background: Minimum 4.5:1 for normal text (e.g. `#e4a672` on `#181425` gives ~7.8:1 contrast).
   - UI Components / Graphic Controls: Minimum 3:1 against adjacent background.
   - Never rely on hue alone: combine color with text status (`[OK]`, `[WARN]`, `[DEPLETED]`).

2. **Keyboard Navigation & Focus Management**:
   - Every interactive control (filters, tabs, search inputs, modal triggers) must be reachable via `Tab`.
   - Distinct, visible pixel-art focus ring:
     ```css
     :focus-visible {
       outline: 3px solid #ffcd75;
       outline-offset: 2px;
     }
     ```

3. **Screen Reader Optimization**:
   - Hide decorative ASCII art and purely visual pixel sprites using `aria-hidden="true"`.
   - Provide `.sr-only` class for descriptive text summaries.
   - Dynamic filter updates and telemetry refreshes must announce status changes using `aria-live="polite"`.

## Interactive Features for Developer VM Analysis

The generated report must offer rich local analytical tools without external dependencies:

1. **Ledger Table with Filtering**:
   - Filter transactions by provider (`antigravity`, `claude-bridge`, `direct`).
   - Filter by reason (`continuation`, `retry`, `user`).
   - Quick search input filtering rows in vanilla JavaScript (`input` event with debouncing).

2. **Native SVG Micro-Charts (Sparklines)**:
   - Generate timeline charts directly into `<svg viewBox="0 0 400 60">` without Chart.js or D3.
   - Use stepped polyline (`shape-rendering="crispEdges"`) to maintain the pixel aesthetic.

3. **Export & Re-import Mechanism**:
   - `Export JSON` button triggering browser download (`data:application/json;charset=utf-8,...`).
   - `Load JSON` drag-and-drop or file picker allowing developers to import past session runs or compare two environments side-by-side.

## Anti-Patterns

| Anti-Pattern | Reason | Better Action |
|---|---|---|
| External Google Fonts / FontAwesome | Fails in offline environments, VMs, or enterprise proxies | Monospace system font stack with CSS pixel borders and inline SVGs |
| Canvas-only rendering | Breaks screen readers, copy-paste, and keyboard navigation | Semantic HTML5 structure styled with CSS pixel art rules |
| Blurry scaling | Default browser smoothing softens pixel edges | Explicit `image-rendering: pixelated;` on containers and images |
| Low contrast neon colors | Fails WCAG 2.1 AA readability on dark backgrounds | Curated 16/32-color palette verified with contrast checkers (>= 4.5:1) |
| Continuous intense animations | Causes visual fatigue and triggers vestibular disorders | Static by default; transient animations; strict `prefers-reduced-motion` |
