/// <reference lib="webworker" />
import * as Babel from "@babel/standalone";
import { __inspect } from "./inspector.ts";

declare const self: DedicatedWorkerGlobalScope;

interface BabelNode {
  type: string;
  loc?: { start?: { line?: number } };
  [key: string]: unknown;
}

interface BabelPath {
  node: BabelNode;
  get(key: string): BabelPath | BabelPath[];
  isExpressionStatement(): boolean;
  isImportDeclaration(): boolean;
  insertAfter(node: BabelNode): void;
}

interface BabelTypes {
  callExpression(callee: BabelNode, args: BabelNode[]): BabelNode;
  identifier(name: string): BabelNode;
  numericLiteral(value: number): BabelNode;
  stringLiteral(value: string): BabelNode;
  ifStatement(test: BabelNode, consequent: BabelNode): BabelNode;
  binaryExpression(op: string, left: BabelNode, right: BabelNode): BabelNode;
  blockStatement(body: BabelNode[]): BabelNode;
  throwStatement(arg: BabelNode): BabelNode;
  newExpression(callee: BabelNode, args: BabelNode[]): BabelNode;
}

interface BabelPluginApi {
  types: BabelTypes;
}

interface BabelPlugin {
  visitor: Record<string, (path: BabelPath) => void>;
}

const { transform } = Babel;

type Capture = [number, string];

let captures: Capture[] = [];
let captureActive = false;

const globalAny = globalThis as unknown as {
  __inspect: (v: unknown) => string;
  __capture: (line: number, value: unknown) => unknown;
};

globalAny.__inspect = __inspect;
globalAny.__capture = function (line: number, value: unknown): unknown {
  try {
    captures.push([line, __inspect(value)]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    captures.push([line, "[uninspectable: " + msg + "]"]);
  }
  return value;
};

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";
for (const m of ["log", "info", "warn", "error", "debug"] as ConsoleMethod[]) {
  const orig = console[m].bind(console);
  console[m] = (...args: unknown[]) => {
    if (captureActive) {
      const formatted = args.map((a) => __inspect(a)).join(" ");
      captures.push([0, formatted]);
    }
    orig(...args);
  };
}

function instrumentPlugin({ types: t }: BabelPluginApi): BabelPlugin {
  const isConsoleCall = (node: BabelNode | undefined): boolean => {
    if (!node || node.type !== "CallExpression") return false;
    const callee = node.callee as BabelNode | undefined;
    if (!callee || callee.type !== "MemberExpression") return false;
    const object = callee.object as BabelNode | undefined;
    const property = callee.property as BabelNode | undefined;
    if (!object || object.type !== "Identifier" || (object as { name?: string }).name !== "console")
      return false;
    if (!property || property.type !== "Identifier") return false;
    const propName = (property as { name?: string }).name;
    return !!propName && ["log", "info", "warn", "error", "debug"].includes(propName);
  };

  const wrap = (line: number, expr: BabelNode): BabelNode =>
    t.callExpression(t.identifier("__capture"), [
      t.numericLiteral(line),
      expr,
    ]);

  return {
    visitor: {
      Program(path: BabelPath) {
        const body = path.get("body") as BabelPath[];
        for (const stmt of body) {
          if (!stmt.isExpressionStatement()) continue;
          const expr = stmt.node.expression as BabelNode | undefined;
          if (isConsoleCall(expr)) continue;
          const line = stmt.node.loc?.start?.line ?? 0;
          stmt.node.expression = wrap(line, expr as BabelNode);
        }
      },
    },
  };
}

function checkDefaultExportsPlugin({ types: t }: BabelPluginApi): BabelPlugin {
  const isExternal = (spec: string): boolean =>
    spec.startsWith("npm:") ||
    spec.startsWith("http://") ||
    spec.startsWith("https://") ||
    (/^[a-zA-Z@]/.test(spec) &&
      !spec.startsWith("./") &&
      !spec.startsWith("../") &&
      !spec.startsWith("/"));

  const friendlyMsg = (name: string, source: string): string =>
    `"${source}" has no default export. Try \`import { /* names */ } from "${source}"\` or \`import * as ${name} from "${source}"\` instead.`;

  return {
    visitor: {
      Program(path: BabelPath) {
        const checks: BabelNode[] = [];
        let lastImportIdx = -1;
        const body = path.get("body") as BabelPath[];
        for (let i = 0; i < body.length; i++) {
          const stmt = body[i];
          if (!stmt.isImportDeclaration()) continue;
          lastImportIdx = i;
          const source = (stmt.node.source as { value: string }).value;
          if (!isExternal(source)) continue;
          const specifiers = stmt.node.specifiers as BabelNode[];
          for (const specifier of specifiers) {
            if (specifier.type !== "ImportDefaultSpecifier") continue;
            const name = (specifier.local as { name: string }).name;
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
        for (let i = checks.length - 1; i >= 0; i--) {
          body[lastImportIdx].insertAfter(checks[i]);
        }
      },
    },
  };
}

function rewriteImportsPlugin(): BabelPlugin {
  const rewrite = (spec: string): string => {
    if (spec.startsWith("npm:")) return "https://esm.sh/" + spec.slice(4);
    if (spec.startsWith("http://") || spec.startsWith("https://")) return spec;
    if (spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("/"))
      return spec;
    if (spec.startsWith("data:") || spec.startsWith("blob:")) return spec;
    return "https://esm.sh/" + spec;
  };
  return {
    visitor: {
      ImportDeclaration(path: BabelPath) {
        const s = path.node.source as { value: string };
        s.value = rewrite(s.value);
      },
    },
  };
}

type SourceType = "module" | "script";

function transpileAs(source: string, sourceType: SourceType): string {
  const result = transform(source, {
    filename: "user.ts",
    sourceType,
    presets: [["typescript", { allExtensions: true, isTSX: false }]],
    plugins: [instrumentPlugin, checkDefaultExportsPlugin, rewriteImportsPlugin],
    sourceMaps: false,
    retainLines: true,
  });
  return result.code;
}

const STRICT_MODE_ONLY =
  /Legacy octal|strict mode|with statement|delete .* in strict|implements .* reserved|let .* reserved|protected .* reserved|public .* reserved|private .* reserved/i;

function transpile(source: string): { code: string; sourceType: SourceType } {
  try {
    return { code: transpileAs(source, "module"), sourceType: "module" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (STRICT_MODE_ONLY.test(msg)) {
      return { code: transpileAs(source, "script"), sourceType: "script" };
    }
    throw e;
  }
}

// Vite rewrites `import(...)` literals into its own runtime helper which can't
// load blob: URLs from a worker. Building the import expression via
// `new Function` keeps it invisible to Vite's static analysis so the browser's
// real dynamic import runs at runtime.
const nativeImport = new Function("u", "return import(u);") as (
  url: string,
) => Promise<unknown>;

interface LineResult {
  line: number;
  display: string;
}

async function evalSnippet(source: string): Promise<LineResult[]> {
  captures = [];
  const { code, sourceType } = transpile(source);
  captureActive = true;
  try {
    if (sourceType === "module") {
      const blob = new Blob([code], { type: "application/javascript" });
      const url = URL.createObjectURL(blob);
      try {
        await nativeImport(url);
      } finally {
        URL.revokeObjectURL(url);
      }
    } else {
      const fn = new Function(`return (async()=>{\n${code}\n})()`) as () => Promise<void>;
      await fn();
    }
  } finally {
    captureActive = false;
  }
  return captures.map(([line, display]) => ({ line, display }));
}

interface EvalRequest {
  id: number;
  source: string;
}

self.postMessage({ type: "ready" });

self.onmessage = async (e: MessageEvent<EvalRequest>) => {
  const { id, source } = e.data || ({} as EvalRequest);
  if (typeof source !== "string") return;
  const t0 = performance.now();
  try {
    const results = await evalSnippet(source);
    const ms = Math.round(performance.now() - t0);
    self.postMessage({ id, ok: true, results, ms });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    self.postMessage({ id, ok: false, error: msg });
  }
};
