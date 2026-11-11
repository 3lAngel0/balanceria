---
name: pixel-art
description: "Trigger: pixel art, pixelart, sprite design, character sprite, mascot pixel art, 8-bit, 16-bit, game assets, retro graphics, pixel face expressions. Design crisp, readable, high-contrast 2D pixel art sprites with expressive facial features and clean color ramps."
license: MIT
metadata:
  author: gentleman-programming
  version: "1.0"
---

# Pixel Art Design & Character Sprite Crafting

Rules and techniques for crafting readable, expressive 2D character sprites at low resolutions (16×16, 24×24, 32×32).

## Core Principles

### 1. Cluster Integrity vs. Orphan Pixels (Noise)
- **Never place isolated 1-pixel color spots** in open fur or skin. They read as rendering noise or dirt, not texture.
- Group colors in deliberate, connected **clusters** (2 to 8 pixels) that define volumes, lighting, and planes.
- Keep edges clean: avoid "jaggies" (inconsistent staircase steps like 1-2-1-3; use harmonious curves like 1-1-2-2-3 or 1-2-3).

### 2. High-Contrast 4-Tone Palette Ramp
Every material (fur, cloth, petals) requires a disciplined 3-to-4 color ramp with strong contrast between steps:
1. **Outline / Deep Crease**: Darkest tone (e.g., `#2b141e` espresso or `#1b1630` navy, never pure `#000000` unless retro 1-bit).
2. **Shadow Tone**: Defines underside, neck crease, snout depth, and grounding (`#7a3b19`).
3. **Base Midtone**: Dominant recognizable body color (`#b86c2e`).
4. **Highlight / Light Rim**: Top light on skull, snout bridge, and back curve (`#e59e56`).

### 3. Mascot Facial Readability & Expressiveness
In sprites under 32×32, features must be stylized and exaggerated for instant readability:
- **Snout Separation (Mandatory)**: Capybara snouts are large and blunt. Separate the snout from the neck/body with a dark shadow crease or outline step. If the snout and chest share the same midtone without a shadow boundary, the head disappears into a flat blob.
- **Eyes & Expression States**:
  - **Tranquil / Chill (Default)**: 2px horizontal or vertical slit in outline dark, topped with a 1px lighter brow or highlight.
  - **Happy / Joyful (`^^`)**: Inverted crescent or upward slant (`# #` with highlight cheek below), optional cheek blush (`#ff79b0`).
  - **Alert / Working**: Open eye with dark pupil (`#1a0b06`) and 1px bright specular reflection (`#ffffff`).
  - **Wink / Smug**: One eye open with specular dot, the other a clean horizontal crescent.
- **Muzzle / Mouth**: A subtle 2px nostril line and a small shadow dot for the mouth corner creates an endearing, serene smile.

### 4. Selective Outlining (Sel-Out)
- Use dark outlines around the external silhouette to separate the character from the background.
- Inside the character, use softer shadow tones for interior lines (e.g. neck fold, ear crease) instead of black outlines to avoid a "coloring book" look.

### 5. Crisp Rendering Contract
- Always specify `image-rendering: pixelated; image-rendering: crisp-edges;` on HTML/CSS elements.
- In SVG: `shape-rendering="crispEdges"`.
- ViewBox coordinates must match exact integer pixel units (`width: 1`, `height: 1`).
