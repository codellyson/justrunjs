# runjs-rs

A minimal proof-of-concept of a [RunJS](https://runjs.app)-style desktop
JS/TS scratchpad **core**, written in Rust.

You give it a TypeScript snippet; it shows the evaluated value of every
top-level line inline — live, no `console.log`, no `tsconfig`, with a proper
object inspector (so a `Map` reads as `Map(1) { 'test1' => { name: 'Isaac' } }`,
not the `{}` that `JSON.stringify` would produce).

The stack is the one agreed up front:

- **[SWC](https://swc.rs)** (Rust-native) — TypeScript transpilation **and** the
  AST parse/instrument pass.
- **[deno_core](https://crates.io/crates/deno_core)** (rusty_v8) — a real V8
  engine to execute the JS, with ES-module evaluation for top-level `await`.
- A `util.inspect`-style **object inspector** for output fidelity.
- A **Tauri + Monaco** shell is the intended UI (see [below](#extending-to-tauri--monaco)); this POC ships the
  working backend core plus a CLI, which is the part that's hard to get right.

> The core differentiator — the AST-instrumentation pass — is documented in
> depth in **[DESIGN.md](./DESIGN.md)**. Read that for *how* it works; this
> README is *how to run it*.

## What's here

```
src/
  instrument.rs   parse TS → instrument AST → strip types → emit JS   (SWC)
  runtime.rs      execute JS in V8, collect (line, value) captures    (deno_core)
  inspector.js    util.inspect-style formatter + the __capture shim   (JS)
  lib.rs          public API: evaluate(src) -> Vec<LineResult>  + tests
  main.rs         CLI: prints source with inline `// => value`
DESIGN.md         the AST-instrumentation deep dive (deliverable #1)
```

The public API is one function:

```rust
pub fn evaluate(source: &str) -> anyhow::Result<Vec<LineResult>>;
pub struct LineResult { pub line: u32, pub display: String }
```

`Vec<LineResult>` is the editor-agnostic contract: *line N → put this string in
the gutter*. The CLI and (eventually) Monaco are just consumers of it.

## Build & run

Requires a recent Rust toolchain (built with 1.95). The first build downloads a
prebuilt V8 and compiles the SWC tree, so it takes a few minutes; later builds
are seconds.

```sh
cargo build          # build the library + CLI
cargo test           # run the test suite (7 tests, incl. the Map case)
cargo run            # run the CLI on a built-in demo snippet
```

Feed it your own code via stdin or a file:

```sh
echo 'const m = new Map(); m.set("a", {x:1}); m;' | cargo run -q
cargo run -- snippet.ts
cargo run -- snippet.ts --show-instrumented   # also dump the rewritten JS
```

## Example: input → inline output

Running the CLI on the built-in demo (`cargo run`) produces exactly this — the
left column is the user's source, the right column is each line's evaluated
value:

```
const greeting: string = "hello";               // => 'hello'
greeting.toUpperCase();                         // => 'HELLO'

const m = new Map<string, { name: string }>();  // => Map(0) {}
m.set("test1", { name: "Isaac" });              // => Map(1) { 'test1' => { name: 'Isaac' } }
m;                                              // => Map(1) { 'test1' => { name: 'Isaac' } }

const s = new Set([1, 2, 2, 3]);                // => Set(3) { 1, 2, 3 }
s;                                              // => Set(3) { 1, 2, 3 }

const total = await Promise.resolve(40 + 2);    // => 42
total;                                          // => 42
```

Note the headline case: **`Map(1) { 'test1' => { name: 'Isaac' } }`**, not `{}`.
That's the whole reason we use a real inspector instead of `JSON.stringify`.
Top-level `await` (last two lines) works because the snippet runs as an ES
module. The TS generic `<string, { name: string }>` is stripped before
execution.

### What runs under the hood

`--show-instrumented` reveals the rewritten JS that V8 actually executes:

```js
// input:
const m = new Map<string, number>();
m.set("a", 1);
const v = await Promise.resolve(42);

// instrumented (types stripped, each value tapped by __capture):
const m = __capture(1, new Map());
__capture(2, m.set("a", 1));
const v = __capture(3, await Promise.resolve(42));
```

`__capture(line, value)` records `(line, inspect(value))` and returns `value`
unchanged, so the tap is semantically invisible. See **[DESIGN.md](./DESIGN.md)**
for the full walk of which AST nodes get wrapped and why.

## Tests

`cargo test` covers the cases that distinguish this approach from a naive one:

- primitives & expression results mapped to the right lines
- **`Map` inspected, not JSON-ified** (`Map(1) { 'test1' => { name: 'Isaac' } }`)
- `Set`, nested arrays/objects
- BigInt (`20n`), `Symbol(tag)`, class instances (`Point { x: 1, y: 2 }`)
- circular references (`{ name: 'a', self: [Circular *1] }`)
- TypeScript types stripped (interfaces, annotations, `number[]`)
- top-level `await`

```
running 7 tests
test tests::primitives_and_expressions ... ok
test tests::map_is_inspected_not_jsonified ... ok
test tests::set_and_array_and_nested ... ok
test tests::bigint_symbol_class_instance ... ok
test tests::circular_reference ... ok
test tests::typescript_types_are_stripped ... ok
test tests::top_level_await ... ok
test result: ok. 7 passed; 0 failed
```

## Extending to Tauri + Monaco

The backend already returns the exact shape a UI needs (`line → display`).
Wiring the full desktop app on top is mechanical:

1. **Tauri command.** Wrap `evaluate` in a `#[tauri::command]`:

   ```rust
   #[tauri::command]
   fn run_snippet(source: String) -> Result<Vec<LineResult>, String> {
       runjs_rs::evaluate(&source).map_err(|e| e.to_string())
   }
   ```

   Add `#[derive(serde::Serialize)]` to `LineResult` so it crosses the IPC
   boundary as JSON. (`serde` is already a transitive dep.) Register it with
   `.invoke_handler(tauri::generate_handler![run_snippet])`.

2. **Monaco in the webview.** Host a Monaco editor in the Tauri frontend with
   `language: "typescript"`. On a debounced `onDidChangeModelContent`, call
   `invoke("run_snippet", { source })`.

3. **Gutter decorations.** Map each `LineResult` to a Monaco decoration on its
   line, rendered with an `after` content widget (the same mechanism RunJS uses):

   ```ts
   editor.deltaDecorations(prev, results.map(r => ({
     range: new monaco.Range(r.line, 1, r.line, 1),
     options: { after: { content: `  ${r.display}`, inlineClassName: "runjs-result" } },
   })));
   ```

4. **Keep the runtime warm.** Today `evaluate` spins up a fresh V8 isolate per
   call. For live typing, hold a long-lived `JsRuntime` (or a worker thread that
   owns one) in Tauri-managed state and reset module state between runs, so
   keystroke-to-result latency stays low.

### Production hardening beyond the POC

- **Inspector fidelity / scale.** Swap the hand-rolled `inspector.js` for Deno's
  real `ext/console` `inspect` to get fully Node-compatible output (colors,
  width-aware wrapping, getters, typed arrays, `Promise` resolution state).
- **npm + Node APIs.** The agreed stack calls for `deno_core` + the Node compat
  layer so `import { x } from "npm:..."` and built-ins work. This POC uses a
  `NoopModuleLoader` (snippets have no imports); add a module loader (the
  `deno_core` `ts_module_loader` example is the starting point) to enable it.
- **Cancellation & timeouts.** Give the isolate a deadline / `terminate_execution`
  handle so an infinite loop in the scratchpad doesn't hang the UI.
- **Wider instrumentation.** Add AST arms for assignments, `return`, and the
  trailing expression of a block to show more inline values (see DESIGN.md §2).
```
