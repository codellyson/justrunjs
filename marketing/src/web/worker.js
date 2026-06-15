// runjs web worker.
//
// Mirrors the desktop pipeline (`src/instrument.rs` + `src/runtime.rs`) using
// browser primitives:
//   1. @babel/standalone parses TypeScript and strips types.
//   2. A custom plugin wraps each top-level statement in __capture(line, expr)
//      so its value flows into the results pane — same shape as the SWC pass.
//   3. A second plugin rewrites `npm:foo` and bare specifiers to esm.sh URLs
//      so `import _ from "npm:lodash@4"` resolves in the browser.
//   4. The transformed code is turned into a Blob and dynamically imported,
//      which gives us real ES modules with top-level await for free.
//
// The desktop runtime cancels infinite loops via v8 terminate_execution(); in
// the browser the equivalent is worker.terminate(). The main thread owns that
// and respawns a fresh worker on Stop, so this file doesn't deal with it.

// @babel/standalone is a UMD bundle. Vite's interop gives us a namespace
// object — `transform` is a named export off that namespace. (Importing it
// as `default` resolves to `undefined` under Vite.)
import * as Babel from "@babel/standalone";
import { __inspect } from "./inspector.js";

const { transform } = Babel;

// Captured (line, formatted) pairs for the current eval. Line numbers are
// kept for error display only — the results pane is a flowing console
// (RunJS-style), so values render in arrival order, not at their source
// line.
let captures = [];

// Console capture only kicks in during an active eval. Without this gate,
// Vite's HMR client (and anything else that fires console.log at module
// load) shows up as a leading row in the results pane.
let captureActive = false;

// Inspector helpers live on globalThis so the imported user module finds them
// via plain identifier lookup — the AST emits `__capture(7, expr)` with no
// import on its end, so this is the channel.
globalThis.__inspect = __inspect;
globalThis.__capture = function (line, value) {
  try {
    captures.push([line, __inspect(value)]);
  } catch (e) {
    captures.push([line, "[uninspectable: " + (e && e.message) + "]"]);
  }
  return value;
};

// console.log/info/warn/error/debug also feed the results pane. The original
// console call still happens, so DevTools logging is preserved.
for (const m of ["log", "info", "warn", "error", "debug"]) {
  const orig = console[m].bind(console);
  console[m] = (...args) => {
    if (captureActive) {
      const formatted = args.map((a) => __inspect(a)).join(" ");
      // Line number isn't used for layout in flowing mode — values render
      // in arrival order. We still pass 0 so error-vs-result code paths
      // share the same shape.
      captures.push([0, formatted]);
    }
    orig(...args);
  };
}

// --- Babel plugins ----------------------------------------------------------

// Wrap bare top-level expression statements with `__capture(line, expr)` so
// their value lands in the results pane. We do NOT wrap variable declarations
// (`const x = …`) — declaring something shouldn't dump its value into the
// results pane unless the user explicitly references it on its own line.
//
// `console.X(...)` calls are skipped here because the console wrapper above
// already captures them; double-wrapping would emit a redundant `undefined`.
function instrumentPlugin({ types: t }) {
  const isConsoleCall = (node) => {
    if (!node || node.type !== "CallExpression") return false;
    const callee = node.callee;
    if (callee.type !== "MemberExpression") return false;
    if (callee.object.type !== "Identifier" || callee.object.name !== "console")
      return false;
    if (callee.property.type !== "Identifier") return false;
    return ["log", "info", "warn", "error", "debug"].includes(
      callee.property.name,
    );
  };

  const wrap = (line, expr) =>
    t.callExpression(t.identifier("__capture"), [
      t.numericLiteral(line),
      expr,
    ]);

  return {
    visitor: {
      Program(path) {
        for (const stmt of path.get("body")) {
          if (!stmt.isExpressionStatement()) continue;
          if (isConsoleCall(stmt.node.expression)) continue;
          const line = stmt.node.loc?.start?.line ?? 0;
          stmt.node.expression = wrap(line, stmt.node.expression);
        }
      },
    },
  };
}

// Catch a common footgun: `import _ from "npm:date-fns"` against a package
// with no default export silently binds `_` to undefined, and the user
// hits a confusing `Cannot read properties of undefined` later. After the
// module loads, throw a friendly error explaining what to use instead.
//
// Only checks external packages (`npm:`, bare specifiers, http(s)) — relative
// imports point at the user's own code and the "use named imports" advice
// doesn't apply.
function checkDefaultExportsPlugin({ types: t }) {
  const isExternal = (spec) =>
    spec.startsWith("npm:") ||
    spec.startsWith("http://") ||
    spec.startsWith("https://") ||
    /^[a-zA-Z@]/.test(spec) &&
      !spec.startsWith("./") &&
      !spec.startsWith("../") &&
      !spec.startsWith("/");

  const friendlyMsg = (name, source) =>
    `"${source}" has no default export. Try \`import { /* names */ } from "${source}"\` or \`import * as ${name} from "${source}"\` instead.`;

  return {
    visitor: {
      Program(path) {
        const checks = [];
        let lastImportIdx = -1;
        const body = path.get("body");
        for (let i = 0; i < body.length; i++) {
          const stmt = body[i];
          if (!stmt.isImportDeclaration()) continue;
          lastImportIdx = i;
          const source = stmt.node.source.value;
          if (!isExternal(source)) continue;
          for (const specifier of stmt.node.specifiers) {
            if (specifier.type !== "ImportDefaultSpecifier") continue;
            const name = specifier.local.name;
            checks.push(
              t.ifStatement(
                t.binaryExpression(
                  "===",
                  t.identifier(name),
                  t.identifier("undefined"),
                ),
                t.blockStatement([
                  t.throwStatement(
                    t.newExpression(t.identifier("Error"), [
                      t.stringLiteral(friendlyMsg(name, source)),
                    ]),
                  ),
                ]),
              ),
            );
          }
        }
        if (checks.length === 0 || lastImportIdx < 0) return;
        // Insert in reverse so each `insertAfter` lands at the right index.
        for (let i = checks.length - 1; i >= 0; i--) {
          body[lastImportIdx].insertAfter(checks[i]);
        }
      },
    },
  };
}

// Rewrite `npm:foo` and bare specifiers to esm.sh URLs. Mirrors the desktop
// loader's npm: handling and adds bare-specifier resolution as a convenience.
// Absolute http(s):, ./relative, and data: URLs pass through.
function rewriteImportsPlugin() {
  const rewrite = (spec) => {
    if (spec.startsWith("npm:")) return "https://esm.sh/" + spec.slice(4);
    if (spec.startsWith("http://") || spec.startsWith("https://")) return spec;
    if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/"))
      return spec;
    if (spec.startsWith("data:") || spec.startsWith("blob:")) return spec;
    // Treat anything else as a bare specifier: lodash, react, @scope/pkg
    return "https://esm.sh/" + spec;
  };
  return {
    visitor: {
      ImportDeclaration(path) {
        const s = path.node.source;
        s.value = rewrite(s.value);
      },
    },
  };
}

// --- transpile + run --------------------------------------------------------

function transpileAs(source, sourceType) {
  const result = transform(source, {
    filename: "user.ts",
    sourceType, // "module" or "script"
    presets: [["typescript", { allExtensions: true, isTSX: false }]],
    // Order matters: checkDefaultExportsPlugin needs to see the original
    // `npm:foo` / bare specifier in the error message, so it runs BEFORE
    // rewriteImportsPlugin replaces those with esm.sh URLs.
    plugins: [instrumentPlugin, checkDefaultExportsPlugin, rewriteImportsPlugin],
    sourceMaps: false,
    retainLines: true,
  });
  return result.code;
}

// Try module first (so `import`, `export`, and top-level `await` keep
// working). Fall back to script mode when the failure is strict-mode-only —
// playground-style code like `let t = 09` is invalid in strict mode but
// fine in script mode. Returns the chosen sourceType so the runtime knows
// whether to dynamically import (modules, always strict) or wrap in a
// non-strict Function (scripts).
const STRICT_MODE_ONLY =
  /Legacy octal|strict mode|with statement|delete .* in strict|implements .* reserved|let .* reserved|protected .* reserved|public .* reserved|private .* reserved/i;

function transpile(source) {
  try {
    return { code: transpileAs(source, "module"), sourceType: "module" };
  } catch (e) {
    const msg = (e && e.message) || "";
    if (STRICT_MODE_ONLY.test(msg)) {
      return { code: transpileAs(source, "script"), sourceType: "script" };
    }
    throw e;
  }
}

// Native dynamic import, smuggled past Vite's bundler. Vite rewrites
// `import(...)` literals into its own runtime helper, which can't load
// `blob:` URLs from inside a worker — the result is the cryptic
// "Failed to fetch dynamically imported module: blob:..." we kept hitting.
// Building the import expression via `new Function` keeps it invisible to
// Vite's static analysis, so the browser's real dynamic import runs at
// runtime.
const nativeImport = new Function("u", "return import(u);");

async function evalSnippet(source) {
  captures = [];
  const { code, sourceType } = transpile(source);
  captureActive = true;
  try {
    if (sourceType === "module") {
      // Dynamic import of a blob URL — forced strict, but supports `import`,
      // `export`, and top-level `await`.
      const blob = new Blob([code], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      try {
        await nativeImport(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    } else {
      // Script mode — non-strict, so legacy octals and other sloppy-mode
      // playground bits work. Wrapped in an async function so the body can
      // still use `await` inside async constructs (just not top-level
      // await, which requires module mode).
      const fn = new Function(`return (async()=>{\n${code}\n})()`);
      await fn();
    }
  } finally {
    captureActive = false;
  }
  // Arrival order — flowing console matches execution order, so a result
  // from line 2 appears above a console.log on line 3 (the line numbers
  // are kept only for error display, never as a sort key).
  return captures.map(([line, display]) => ({ line, display }));
}

// --- message bridge ---------------------------------------------------------

// Announce we made it through module init — Babel + inspector loaded OK.
// The main thread uses this to flip status from "starting" to ready and to
// distinguish an honest "no eval yet" state from a worker that died on boot.
self.postMessage({ type: "ready" });

self.onmessage = async (e) => {
  const { id, source } = e.data || {};
  if (typeof source !== "string") return;
  const t0 = performance.now();
  try {
    const results = await evalSnippet(source);
    const ms = Math.round(performance.now() - t0);
    self.postMessage({ id, ok: true, results, ms });
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    self.postMessage({ id, ok: false, error: msg });
  }
};
