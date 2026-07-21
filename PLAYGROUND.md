# Playground mode — spec (Phase 2)

Status: **proposed**. This is the design for turning justrunjs from a single-file
inline-value scratchpad into a **hybrid JSBin**: keep the scratchpad, add a
Playground tab type with HTML + CSS + JS and a live rendered preview.

The signature differentiator: **inline values *and* a rendered page at once.**
JSBin/CodePen show you the output; the scratchpad shows you each value. A
playground tab shows both — you build a visible thing *and* see what every
line evaluated to. Nothing else does that.

---

## 1. Why a new execution surface

The scratchpad runs user code in a **Web Worker** — `marketing/src/web/worker.ts`
transpiles with Babel, instruments each top-level expression with
`__capture(line, value)`, and imports the result as a blob-URL ES module. A
worker has **no DOM**: no `document`, no `window`, no rendering. That's correct
for a value scratchpad and wrong for a playground.

A playground needs a real document, so it runs in a **sandboxed `<iframe>`**
instead. This is the central architectural fact of Phase 2:

| | Scratchpad tab | Playground tab |
|---|---|---|
| Surface (web) | Web Worker | sandboxed `<iframe>` |
| Surface (desktop) | Rust/SWC + V8 core | sandboxed `<iframe>` (webview) |
| DOM | no | yes |
| Output | inline per-line values | rendered page + console + (optional) inline values |

Note the desktop row: the scratchpad uses the native Rust core, but the
**playground uses the iframe on both web and desktop** — a rendered DOM is a
browser concern, and the Tauri webview is a browser. The Rust core is not
involved in playground mode. This keeps web/desktop behavior identical for
playground and avoids reimplementing a DOM in V8.

---

## 2. Data model

Extend `Tab` with a discriminant. Today (`main.ts`):

```ts
interface Tab { id; name; content: string; language: LanguageId }
```

Proposed:

```ts
type TabKind = "scratchpad" | "playground";

interface ScratchpadTab {
  kind: "scratchpad";
  id; name; content: string; language: LanguageId;   // unchanged
}

interface PlaygroundTab {
  kind: "playground";
  id; name;
  html: string;
  css: string;
  js: string;
  jsLanguage: LanguageId;   // JS panel can still be TS
}

type Tab = ScratchpadTab | PlaygroundTab;
```

Migration: existing persisted tabs have no `kind` → treat missing as
`"scratchpad"` in `loadTabs()`. localStorage auto-save then persists playground
tabs for free (they're just serialized tab objects).

---

## 3. Layout

Reuse the existing `#editor | #splitter | #results` shell. What changes per
tab kind:

**Editor pane (left).** For a playground tab, the single CodeMirror is replaced
by a **three-way panel switcher** — HTML / CSS / JS sub-tabs, one editor visible
at a time. This fits the narrow-first layout better than three stacked editors
and keeps a single CodeMirror instance we reconfigure (language + doc) on
sub-tab switch, mirroring how `activateTab` already swaps docs.

  - Alternative considered: three stacked editors (classic JSBin). Rejected for
    the default because vertical space is scarce next to the preview; can be a
    later layout option.

**Results pane (right).** For a playground tab it becomes:
  - the **live preview** `<iframe>` (fills the pane), and
  - a collapsible **console drawer** docked to the bottom of the pane.
  - If "inline values" is on (§6), a thin gutter overlay on the JS sub-tab shows
    per-line values exactly like the scratchpad.

Tab strip: a playground tab gets a distinct affordance (e.g. a `</>` glyph
instead of the TS/JS badge). A new "+Playground" add-button sits beside
`+TS / +JS / +npm`.

---

## 4. Execution — the sandboxed iframe

On run (debounced, reusing the existing auto-eval setting), assemble a document
and set it as the iframe's `srcdoc`. A fresh `srcdoc` reloads the frame, giving
clean global state every run — no stale timers/listeners.

```html
<iframe
  class="preview"
  sandbox="allow-scripts allow-modals allow-popups allow-forms"
></iframe>
```

**Security: deliberately no `allow-same-origin`.** With `allow-scripts` alone
the frame is a unique opaque origin: it cannot read the parent's
localStorage/cookies, and — critically — cannot reach in and remove its own
sandbox attribute (which `allow-scripts` + `allow-same-origin` together would
allow). Cross-origin `postMessage` still works for the console bridge, and
`fetch`/`import` to the network still work (CORS permitting). This is the whole
reason to keep them separate.

Assembled `srcdoc`:

```
<!doctype html>
<html>
  <head><style>/* user CSS */</style></head>
  <body>
    /* user HTML */
    <script>/* injected bootstrap: console + error bridge (§5) */</script>
    <script type="module">/* transpiled user JS */</script>
  </body>
</html>
```

The user JS goes through the **same Babel pipeline** as the scratchpad
(`transpile()` in `worker.ts`), so: TypeScript strip, `npm:`→esm.sh rewrite,
top-level `await` (module script), and — when inline values are enabled — the
`__capture` instrumentation. The pipeline is factored out of `worker.ts` into a
shared `transpile.ts` so both the worker and the playground use one
implementation. (Keeps the "web and Rust core stay in sync" contract intact —
this only touches the web side.)

---

## 5. Console + error bridge

The scratchpad captures `console.*` in-worker (`worker.ts` overrides them and
pushes `[0, formatted]`). The iframe is a separate context, so we bridge:

Injected bootstrap script (runs first in the frame):
  - override `console.log/info/warn/error/debug` to
    `parent.postMessage({ source: "justrunjs-preview", type: "console", level, parts }, "*")`
    then call through to the original;
  - `window.onerror` and `window.onunhandledrejection` →
    `postMessage({ ..., type: "error", ... })`.

`parts` are formatted **in the frame** with a copy of the `__inspect` formatter
(`inspector.ts`) inlined into the bootstrap, so object fidelity
(`Map(1) { … }`, class instances, circular refs) matches the scratchpad exactly.
The parent listens on `message`, filters by `source: "justrunjs-preview"`, and
renders into the console drawer.

Guards:
  - stamp each run with a nonce; drop messages whose nonce ≠ current run
    (kills late messages from a previous `srcdoc`);
  - only accept messages whose `event.source` is the preview iframe's
    contentWindow.

---

## 6. Inline values in playground JS (the differentiator)

Optional, on by default, toggle in settings. When on, the JS panel is
instrumented with `__capture` just like the scratchpad, `__capture` posts
`{ type: "value", line, display }` to the parent, and the parent paints them in
the JS sub-tab's gutter. Result: you edit markup, watch the page render live,
*and* see every JS line's value — the hybrid superpower.

When off, playground JS runs uninstrumented (pure JSBin behavior) for people who
just want a rendered sandbox.

---

## 7. Share + save

`SharedBin` (`share.ts`) becomes a versioned discriminated union:

```ts
type SharedBin =
  | { v: 1; kind: "scratchpad"; name; language; code }      // current shape
  | { v: 1; kind: "playground"; name; html; css; js; jsLanguage };
```

Decoder: missing `kind`/`v` → the current scratchpad shape (back-compat with
links already shared). Encoding stays base64url-in-`#bin=`, still no backend;
if playground payloads push URL length, swap the encoder's core to
`CompressionStream` gzip behind the same `encodeShareUrl`/`decodeSharedBin` API.

Auto-save: playground tabs persist through the existing localStorage tab
serialization once `Tab` is extended — no extra work.

Example library: add a `Playground` category to `examples.ts` (e.g. "DOM: build
a list", "A CSS animation", "Canvas bouncing ball", "Fetch → render") whose
entries carry `{ html, css, js }` and open as playground tabs.

---

## 8. Desktop (Tauri) parity

The frontend is shared, so the UI ships to desktop automatically. Two things to
verify/adjust in the shell:
  - **CSP** in `tauri.conf.json` must allow the preview iframe to run inline
    `<script>`/`<style>` in `srcdoc` and to `import` from `https://esm.sh`.
    Likely needs `frame-src`, `script-src` and `connect-src` entries. Verify on
    a real `cargo tauri dev` build.
  - Confirm `postMessage` from a sandboxed `srcdoc` frame reaches the parent in
    the WebView2 (Windows) / WKWebView (macOS) runtimes.

---

## 9. Delivery slices

- **2a — Render loop.** Playground `Tab` kind, 3-panel editor switcher, iframe
  `srcdoc` preview, shared `transpile.ts`. No console yet. Ship-able: you can
  build a page and see it render.
- **2b — Console + errors.** Bootstrap bridge, console drawer, run nonce guard.
- **2c — Inline values.** `__capture` → `value` messages → JS gutter overlay +
  settings toggle.
- **2d — Share/save/examples.** Versioned `SharedBin`, playground example
  category, desktop CSP verification.

---

## 10. Decisions (resolved 2026-07-21)

1. **Editor layout:** HTML/CSS/JS **sub-tabs** — one editor at a time, one
   reconfigured CodeMirror. (Stacked editors deferred to a later layout option.)
2. **Run trigger:** **live auto-run on type**, debounced, reusing the existing
   auto-eval setting. Each run reloads the frame for clean state (§4).
3. **Inline values in playground JS:** **on by default**, with a settings
   toggle. The rendered-page-plus-per-line-values combo is the differentiator
   (§6); people who want a plain sandbox can switch it off.
