# Handover Note — RunJS-style Scratchpad in Rust (`runjs-rs`)

**Project location:** `/Users/lukmanisiaka/Desktop/workfolder/personal-projects/runjs-rs`

**Goal:** A RunJS-style desktop JavaScript/TypeScript scratchpad. You type TS/JS on the left; each top-level expression's evaluated value appears inline on the right, live as you type. No `console.log` needed, TypeScript built in, no `tsconfig`, real npm, top-level await, and a proper object inspector (Maps/Sets/class instances/BigInt/symbols/circular refs formatted like Node's `util.inspect` — e.g. `Map(1) { 'test1' => { name: 'Isaac' } }`, NOT JSON-stringified to `{}`).

---

## Agreed tech stack

- **Tauri** — desktop shell (Rust backend + webview frontend).
- **Monaco** — the code editor, hosted in the webview (left pane).
- **deno_core (rusty_v8)** — JS execution engine. Real V8 + Node-compatible APIs + `npm:` specifier support + lets you reuse Deno-style inspector formatting.
- **SWC** — Rust-native; used both for TypeScript→JS transpilation AND for AST parsing/instrumentation.
- **Core differentiator: the AST-instrumentation pass** — walk the SWC AST, wrap each top-level statement/expression so its evaluated value is captured along with its source line, run the code, then map captured values back to editor gutter positions.

---

## Status as of this handover

### DONE and verified (the hard core)
A working backend core was built and verified before the UI work started:

- Library: `evaluate(src) -> Vec<LineResult>` plus a CLI.
- Full loop works: **TS source → SWC transpile + AST instrument → deno_core (V8) execute → per-line value capture → `util.inspect`-style formatting.**
- `cargo build` — clean, no warnings (V8 downloads and links fine).
- `cargo test` — **7/7 passing**, covering: Map, Set, nested objects, BigInt, Symbol, class instances, circular refs, TS type-stripping, and top-level await.
- `cargo run` produced verified inline output, including the headline case:
  ```
  const m = new Map<string, { name: string }>();  // => Map(0) {}
  m.set("test1", { name: "Isaac" });              // => Map(1) { 'test1' => { name: 'Isaac' } }
  const s = new Set([1, 2, 2, 3]);                // => Set(3) { 1, 2, 3 }
  const total = await Promise.resolve(40 + 2);    // => 42
  ```
  i.e. the Map-inspection gap (vs a `JSON.stringify` approach that prints `{}`) is closed.

### Documentation already written
- `DESIGN.md` — end-to-end walkthrough of the AST-instrumentation approach: which SWC node types get wrapped (`Stmt::Expr`, `Decl::Var` declarators) and which deliberately don't; how `__capture(line, value)` stays semantically transparent by returning its argument; why line numbers are read from the *original* span and baked in as literals *before* type-stripping shifts byte offsets; how top-level await is handled by running as an ES module; how `(line, value)` pairs flow back through a Rust op into `Vec<LineResult>`. Includes real before/after snippets.
- `README.md` — quickstart, example output, and a guide to extending to the Tauri/Monaco shell.

### IN PROGRESS (was running when this note was written — verify its state first)
A follow-up task was started to build the full desktop app end to end:

1. **Tauri + Monaco UI** — scaffold Tauri shell, host Monaco as the left pane, expose `evaluate()` as a Tauri command, call it on each keystroke (debounced ~300ms), render per-line results in a right-hand pane / gutter decorations aligned to each source line. Keep the V8 isolate warm between runs for responsiveness.
2. **npm + import module loader** — replace `NoopModuleLoader` with a real loader so `import` statements and `npm:` specifiers resolve and execute.

This build was still compiling at handover (Tauri + V8 from scratch is a multi-minute cargo build). **Its completion state is unconfirmed** — see "First steps" below.

---

## First steps when you resume

1. **Check what actually landed.** `cd` into the project and run `git status` / `git log` to see what the in-progress task committed. Then:
   - `cargo build` — does the whole thing (including any Tauri crate) compile?
   - `cargo test` — do the original 7 tests still pass, and were module-loader tests added?
2. **Try to launch the app:** `cargo tauri dev` (install the Tauri CLI if needed: `cargo install tauri-cli`). Confirm a window opens with a Monaco editor and live inline results.
3. **Reconcile the README** — the original README had caveats about "no-op module loader" and "UI is a follow-up". If those are now addressed, remove them; if not, leave them accurate.

## Known gaps / watch-items

- **Module loader was the last big unknown.** If the in-progress task didn't finish, `NoopModuleLoader` is still in place and `import`/`npm:` snippets won't resolve. Wiring a real `ModuleLoader` (resolve + load + transpile imported TS via SWC) is the key remaining backend piece.
- **GUI verification in a headless/agent environment is limited** — the app may compile but not be screenshot-verifiable automatically; you may need to launch it yourself to confirm the editor + live results actually render.
- **Production hardening (noted in README):** swap the hand-rolled inspector for Deno's real `ext/console` inspector, add execution timeouts (runaway loops), and debounce/cancel in-flight evals on new keystrokes.

## Quick orientation pointers

- The instrumentation logic and the inspector are the crown jewels — read `DESIGN.md` first, then the library entry point (`evaluate`).
- The `line → display` shape returned by `evaluate` is exactly what the UI consumes as gutter decorations; the Rust↔frontend contract flows through a Tauri command wrapping that function.
