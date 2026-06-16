# Just UI — design system spec

The visual + structural language shared across `justrunjs`, `justdb`,
`justnotes`, and any future `just*` app. This file is the spec; until it
ships as `@codellyson/justui` on npm, copy these patterns by hand.

---

## Principles

1. **Restrained, not minimal.** Calm by default. No gradients, no shadows on
   marketing pages, no motion that isn't load-bearing. The product is the
   loud thing, not the chrome.
2. **Semantic tokens, never raw colors.** Every color comes from a CSS
   custom property with a name like `--text-primary` or `--accent`. Apps
   should never write `#ff79c6` inline.
3. **Themable from day one.** Multiple themes (GitHub, Espresso,
   Catppuccin Mocha, Gruvbox, Nord, Solarized) with a light + dark variant
   each. The user picks both axes independently.
4. **Density.** 13px base font. Compact controls. Justified by the fact
   that "just" apps are tools, not consumer content.
5. **Same shell, two surfaces.** Tauri desktop and browser SPA share the
   same bundled UI; only the eval/data transport differs.

---

## Typography

| Role | Family | Where |
|---|---|---|
| Sans | `Geist Variable` | All UI text, marketing copy |
| Mono | `Geist Mono Variable` | Code, terminal-style output, technical labels |

Both ship via `@fontsource-variable/geist` and `@fontsource-variable/geist-mono`.

Base font size: **13px** on `html`. Everything else cascades from there.

Headlines use `font-semibold` (weight 600) on `font-medium` (500) body, and
`text-xs` / `text-sm` aggressively in chrome — section titles in popovers,
status bars, tab labels.

Marketing pages override base back to 16px-equivalent only at the wordmark
level (`text-5xl` / `text-6xl`).

---

## Color tokens

All colors live as CSS custom properties on `<html>`. Values are stored as
**RGB triplets** (e.g. `22 20 18`, no `rgb()` wrapper, no commas), which
unlocks Tailwind's `<alpha-value>` syntax:

```css
:root {
  --bg: 22 20 18;
  --text-primary: 232 222 210;
  --accent: 168 180 220;
  /* ... */
}
```

```js
// tailwind.config.mjs
colors: {
  bg: 'rgb(var(--bg) / <alpha-value>)',
  primary: 'rgb(var(--text-primary) / <alpha-value>)',
  accent: 'rgb(var(--accent) / <alpha-value>)',
}
```

```html
<div class="bg-bg text-primary border border-border">
  <button class="bg-accent/10 hover:bg-accent/20 text-accent">…</button>
</div>
```

### The full token set

| CSS var | Tailwind name | Use |
|---|---|---|
| `--bg` | `bg` | Page / window background |
| `--bg-secondary` | `bg-secondary` | Elevated surfaces (popovers, cards, tab bars) |
| `--border` | `border` | Dividers, 1px outlines |
| `--text-primary` | `primary` | Body text, headings |
| `--text-secondary` | `secondary` | Sub-headings, less-important labels |
| `--text-muted` | `muted` | Hint text, captions, disabled |
| `--accent` | `accent` | Focal points: active states, links, primary buttons |
| `--accent-hover` | `accent-hover` | Hover on accent fills |
| `--accent-text` | (JS-only) | Text on a solid accent fill (e.g. white on a blue button) |
| `--danger` | `danger` | Errors, destructive actions |
| `--success` | `success` | Connected state, success toasts |
| `--warning` | `warning` | Caution, running/pending states |

---

## Theme plugin architecture

A **theme** is a complete palette: light + dark variants, plus a swatch
preview for the picker. The user picks a theme; the mode toggle flips
between that theme's two variants.

```ts
interface ThemeVariant {
  bg: string;            // "R G B"
  bgSecondary: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentHover: string;
  accentText: string;
  danger: string;
  success: string;
  warning: string;
}

interface ThemePlugin {
  id: string;                                   // "espresso"
  label: string;                                // "Espresso"
  description?: string;                         // shown in the picker
  swatch: { light: string; dark: string };      // 2-color preview
  light: ThemeVariant;
  dark: ThemeVariant;
}
```

### Built-in themes (v0.1)

| id | label | notes |
|---|---|---|
| `github` | GitHub | Default. Clean Primer-style. |
| `espresso` | Espresso | Warm dark with cream text. |
| `mocha` | Catppuccin Mocha | Cool dark with lavender highlights. |
| `gruvbox` | Gruvbox | Yellow-orange retro warmth. |
| `nord` | Nord | Cool arctic slate. |
| `solarized` | Solarized | Ethan Schoonover's classic. |

### Adding a theme

Drop a new entry into the `BUILT_IN_THEMES` array. No other wiring — the
picker is data-driven.

### Persistence

Two localStorage keys, both shared across surfaces of the same origin:

| Key | Value |
|---|---|
| `runjs.theme.id` | Current theme id (e.g. `"gruvbox"`) — replace `runjs` with the app's prefix |
| `runjs.theme.mode` | `"light"` or `"dark"` |

### Boot script

A no-flash boot script reads localStorage + `prefers-color-scheme` and
applies the variant's CSS vars to `<html>` BEFORE first paint. Lives in
`web/theme-boot.js`. Also stamps `window.__APP_THEMES__` with the full
catalog so the picker UI can drive runtime swaps.

---

## Component patterns

These aren't a component library — they're **patterns**. Each app
implements them in its native flavor (vanilla JS in Astro pages, React in
shadcn-style apps), but the structure is the same.

### Settings popover

- Anchored to a gear icon in the chrome (sidebar bottom, header right)
- Fixed-position, 220–300px wide, opens on click
- Closes on outside click + Esc
- Sections separated by 1px `--border` rule + uppercase title
- Section headers: `text-xs uppercase text-muted`
- Rows: `flex justify-between` with label + control
- Min content: appearance section (theme picker + mode toggle) + editor
  preferences

### Theme picker (inside settings)

- Scrollable list of all themes
- Each row: 2-color swatch + label + description + `✓` if active
- Active row: `border-accent bg-accent/10`
- Mode toggle: full-width button above the list ("Switch to dark/light")

### Custom Tauri title bar

- 32px tall, full width, `bg-bg-secondary border-b border-border`
- Wordmark on left (`text-xs font-medium text-secondary`)
- Min/Max/Close buttons on right, each `w-11 h-full`
- Whole bar is `data-tauri-drag-region`
- Maximize button SVG swaps to "restore" (stacked squares) when window
  is maximized — driven by `isMaximized()` + `onResized()` listener
- Hover: `bg-accent/10 text-primary` (close button: `bg-danger text-white`)

### Marketing landing layout

- Single column, `max-w-2xl mx-auto`
- Header → How it works (numbered list) → FAQ → Footer
- No hero image, no animation, no scroll-triggered anything
- Header text sizes: `text-5xl sm:text-6xl` for wordmark, `text-xl sm:text-2xl`
  for tagline
- Numbered list: small circle in `bg-accent/10` with `text-accent` digit

---

## Tauri integration

### Base `tauri.conf.json`

```jsonc
{
  "app": {
    "windows": [
      {
        "decorations": false,            // Win/Linux: frameless
        "backgroundColor": "#161412",    // matches Espresso dark
        "width": 1280, "height": 800,
        "minWidth": 720, "minHeight": 480
      }
    ]
  }
}
```

### macOS override (`tauri.macos.conf.json`)

```jsonc
{
  "app": {
    "windows": [
      {
        "decorations": true,             // overrides false; keeps the window managed
        "titleBarStyle": "Overlay",      // traffic lights stay; content extends behind
        "hiddenTitle": true              // no native title text
      }
    ]
  }
}
```

This gives:
- **macOS**: traffic lights at top-left, no native title text, content extends behind. Pad the in-page top strip 80px on the left so it doesn't sit under the traffic lights.
- **Win/Linux**: frameless. App draws its own title bar with min/max/close + drag region.

### Capability permissions

Title bar controls need explicit Tauri 2 permissions in `capabilities/default.json`:

```json
"permissions": [
  "core:default",
  "core:window:allow-minimize",
  "core:window:allow-toggle-maximize",
  "core:window:allow-close",
  "core:window:allow-is-maximized",
  "core:window:allow-start-dragging"
]
```

---

## File structure

A new `just*` app starts with:

```
.
├── tauri.conf.json
├── tauri.macos.conf.json
├── capabilities/default.json
├── icons/  (cargo tauri icon outputs)
├── src/  (Rust)
└── marketing/   (Astro)
    ├── astro.config.mjs
    ├── tailwind.config.mjs          # token-driven colors
    ├── src/
    │   ├── lib/theme-plugins.ts     # re-exports from web/
    │   ├── layouts/Layout.astro     # head + no-flash boot script
    │   ├── styles/global.css        # @tailwind + :root fallback
    │   ├── components/
    │   │   ├── Button.astro
    │   │   └── ThemeToggle.astro
    │   ├── pages/
    │   │   ├── index.astro          # marketing landing
    │   │   └── web/index.astro      # app entry (if browser app)
    │   └── web/                     # app source (bundled into pages/web)
    │       ├── main.js
    │       ├── style.css
    │       ├── theme-plugins.js     # source of truth
    │       └── theme-boot.js
    └── public/
        ├── logo.svg                 # source
        ├── og-image.svg             # source
        └── (generated rasters)
```

---

## Quick-start checklist for a new `just*` app

1. Copy `marketing/src/web/theme-plugins.js` (full theme catalog) and
   `theme-boot.js` (boot script).
2. Copy `marketing/src/styles/global.css` (Tailwind directives + fallback `:root`).
3. Copy `marketing/tailwind.config.mjs` (token mapping).
4. Copy `marketing/src/components/{Button,ThemeToggle}.astro` for marketing chrome.
5. Mirror the Tauri base + macOS conf JSONs from this repo.
6. Run `cargo tauri icon` against a 1024×1024 PNG to fill `icons/`.
7. Set the app's localStorage key prefix (e.g. `mynewapp.theme.id`) consistently.

---

## Versioning

Just UI is at **v0.1 (this spec)**. Breaking changes (token rename,
theme structure change, etc.) bump the minor while we're <1.0.

The extracted `@codellyson/justui` npm package's `package.json` version
is the source of truth; this file is a mirror/changelog.
