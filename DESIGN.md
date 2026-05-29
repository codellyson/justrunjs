# Design: AST instrumentation for inline evaluation

This document explains the core trick behind a RunJS-style scratchpad: how we
take a user's TypeScript, figure out the value of every top-level line, and map
those values back to gutter positions in the editor — **without** asking the
user to write `console.log`.

The whole pipeline lives in three files:

| File                | Responsibility                                            |
| ------------------- | --------------------------------------------------------- |
| `src/instrument.rs` | parse TS → rewrite AST → strip types → emit JS (all SWC)   |
| `src/runtime.rs`    | run the JS in V8 (deno_core), collect `(line, value)` ops  |
| `src/inspector.js`  | the `util.inspect`-style formatter + the `__capture` shim |

---

## 1. Why instrument at all?

A naive scratchpad evaluates the whole snippet and shows the final value. RunJS
shows *every* top-level statement's value next to *its own line*, live. To do
that we need two things the raw V8 result doesn't give us:

1. **The value of each top-level statement**, individually.
2. **The source line** that value belongs to.

The reliable way to get both is to rewrite the program before running it, so
that each interesting value passes through a function call that records
`(line, value)`. That function is `__capture`.

```js
globalThis.__capture = function (line, value) {
  Deno.core.ops.op_capture(line, globalThis.__inspect(value)); // record
  return value;                                                // stay transparent
};
```

`__capture` **returns its second argument unchanged**, so wrapping an expression
never changes program behavior — it's a transparent tap. That property is what
lets us wrap a `const` initializer or a bare expression without breaking
semantics or evaluation order.

---

## 2. Walking the SWC AST

SWC parses the source into a `Module` whose `body` is a `Vec<ModuleItem>`. We
only instrument **top-level** items (RunJS shows values for top-level statements,
not for every line inside a function body), so we iterate `module.body` once and
never recurse into nested blocks.

```rust
for item in module.body.iter_mut() {
    if let ModuleItem::Stmt(stmt) = item {
        instrument_stmt(stmt, &source_map);
    }
}
```

Two node types matter for a minimal-but-useful POC:

### a. Expression statements — `Stmt::Expr`

A bare expression like `x + y;` or `m;` or `'hi'.toUpperCase();`. We replace the
inner expression `E` with `__capture(line, E)`:

```rust
Stmt::Expr(expr_stmt) => {
    let line = line_of(cm, expr_stmt.span);              // original source line
    let inner = std::mem::replace(&mut expr_stmt.expr, undefined_expr());
    expr_stmt.expr = Box::new(capture_call(line, inner)); // __capture(line, inner)
}
```

### b. Variable declarations — `Stmt::Decl(Decl::Var(..))`

`const x = 5;` has no "value" as a statement, but RunJS still shows `5`. We wrap
the **initializer** of each declarator so the assigned value is captured (and
still assigned, because `__capture` returns it):

```rust
Stmt::Decl(Decl::Var(var)) => {
    for decl in var.decls.iter_mut() {
        if let Some(init) = decl.init.take() {
            let line = line_of(cm, decl.span);
            decl.init = Some(Box::new(capture_call(line, init)));
        }
    }
}
```

Wrapping per-declarator (not per-statement) means `const a = 1, b = 2;` records
both `a`'s and `b`'s values, each at its declarator's line.

### What we deliberately *don't* wrap

- **Function / class declarations, imports, type aliases** — they have no
  meaningful inline value. They fall through the `match` untouched.
- **Statements inside blocks, loops, functions** — out of scope for a top-level
  scratchpad; we never recurse past `module.body`.

Extending coverage later is purely additive: handle `Stmt::Return`,
assignment expressions, the last expression of a block, etc., by adding match
arms. Nothing else in the pipeline changes.

---

## 3. Line numbers: read from the *original* span, baked in as a literal

Every SWC node carries a `Span { lo, hi }` of byte positions. A `SourceMap`
turns a byte position into a 1-based line:

```rust
fn line_of(cm: &Lrc<SourceMap>, span: Span) -> u32 {
    cm.lookup_char_pos(span.lo()).line as u32
}
```

The key ordering decision: **we compute the line and bake it into the AST as a
numeric literal *before* any other transform runs.** That way, when the
TypeScript strip pass later deletes type annotations and shifts every byte
offset around, our line numbers are already frozen as `__capture(2, …)` — they
don't depend on post-transform spans at all.

`__capture` is built like this:

```rust
fn capture_call(line: u32, expr: Box<Expr>) -> Expr {
    Expr::Call(CallExpr {
        callee: Callee::Expr(Box::new(Expr::Ident(ident("__capture")))),
        args: vec![
            num_literal(line),          // <-- frozen line number
            ExprOrSpread { spread: None, expr },
        ],
        ..
    })
}
```

---

## 4. Stripping TypeScript (order matters)

After instrumentation we run two SWC passes on the `Program`:

```rust
let unresolved_mark = Mark::new();
let top_level_mark = Mark::new();
program.mutate(resolver(unresolved_mark, top_level_mark, /* typescript */ true));
program.mutate(strip(unresolved_mark, top_level_mark)); // erase types
```

- `resolver` assigns hygiene contexts. Because we created the `__capture`
  identifier with an *empty* syntax context, the resolver treats it as an
  unresolved global — exactly what we want, since `__capture` lives on
  `globalThis`.
- `strip` removes interfaces, type annotations, `as` casts, generics, etc.

We instrument **before** stripping so the AST still has its original spans when
we read line numbers. We strip **after** so the emitted code is valid JS. (All
of this runs inside `GLOBALS.set(..)` because SWC's `Mark`s are thread-global.)

Then `swc_ecma_codegen::Emitter` turns the AST back into a JS string.

---

## 5. Before / after

**User types:**

```ts
const m = new Map<string, number>();
m.set("a", 1);
const v = await Promise.resolve(42);
```

**After transpile + instrument (what actually runs in V8):**

```js
const m = __capture(1, new Map());
__capture(2, m.set("a", 1));
const v = __capture(3, await Promise.resolve(42));
```

Note three things in that output:

- The generic `<string, number>` is gone (TS stripped).
- Line `3`'s `await` is wrapped *inside* `__capture` — `__capture` receives the
  already-awaited value `42`, not the promise. Top-level `await` works because
  we run the snippet as an **ES module** (`load_main_es_module_from_code` +
  `mod_evaluate`), where TLA is legal.
- Each call's first argument is the frozen source line.

---

## 6. Top-level await

deno_core evaluates the snippet as a real ES module, so `await` at the top level
is valid JavaScript — no rewriting into an async IIFE needed. The capture for a
line like `const v = await foo();` records the resolved value because `await`
binds inside the `__capture(line, await foo())` argument and resolves before the
call executes. `runtime.run_event_loop()` then drives any pending microtasks to
completion before we read the store.

---

## 7. Mapping values back to the gutter

At runtime, every `__capture` call invokes the `op_capture` Rust op, which
pushes `(line, formatted_string)` into a shared `Vec` living in the V8 runtime's
`OpState`:

```rust
#[op2(fast)]
fn op_capture(state: &mut OpState, #[smi] line: u32, #[string] formatted: &str) {
    state.borrow::<CaptureStore>().borrow_mut().push((line, formatted.to_string()));
}
```

Formatting happens in JS (`__inspect`) *before* the value crosses into Rust, so
we ship a finished string over the op boundary rather than trying to serialize a
live V8 handle.

Back in `lib.rs`, captures are grouped by line into `Vec<LineResult { line,
display }>`. A line that fired more than once (e.g. inside a re-run) joins its
values in execution order. That vector is the contract a UI consumes: **line N →
this string goes in the gutter next to line N.** The CLI's `print_inline` is a
trivial consumer of exactly that mapping; Monaco decorations would be another
(see README §"Extending to Tauri + Monaco").

---

## 8. The inspector — why not `JSON.stringify`?

`JSON.stringify(new Map([["a", 1]]))` is `"{}"`. Sets, class instances, BigInt,
symbols, functions, circular references — JSON either drops them, throws, or
lies. RunJS's value comes largely from rendering these *correctly*, the way
Node's `util.inspect` does.

`src/inspector.js` is a focused, dependency-free reimplementation of that
behavior. It handles, with depth limiting and a `seen` set for cycles:

| Input                                  | Output                                    |
| -------------------------------------- | ----------------------------------------- |
| `new Map([["test1", {name:"Isaac"}]])` | `Map(1) { 'test1' => { name: 'Isaac' } }` |
| `new Set([1,2,3])`                     | `Set(3) { 1, 2, 3 }`                      |
| `10n`                                  | `10n`                                     |
| `Symbol('tag')`                        | `Symbol(tag)`                             |
| `new Point()` (class instance)         | `Point { x: 1, y: 2 }`                    |
| `{a:1}` with `a.self = a`              | `{ a: 1, self: [Circular *1] }`           |

In a production build you'd swap this hand-rolled inspector for Deno's actual
`ext/console` `inspect` (the same code that backs `Deno.inspect`) to get
100% Node-compatible output, color, and width-aware wrapping. The shim here
keeps the POC self-contained while proving the formatting-fidelity point that
motivated the design.
