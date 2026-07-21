// Shared Babel transpile pipeline.
//
// One implementation, two consumers:
//   - worker.ts (scratchpad): instrument each top-level expression with
//     __capture(line, value), then execute and collect per-line values.
//   - the playground preview (main.ts): transpile TS -> browser module JS for
//     an <iframe srcdoc>, with instrumentation optional.
//
// It handles: TypeScript type-strip, `npm:`/bare -> esm.sh import rewrite,
// top-level await (module source type), and a friendly "no default export"
// check for external imports. The `instrument` option toggles the __capture
// pass so the same pipeline serves both value-capture and plain execution.

import * as Babel from "@babel/standalone";

const { transform } = Babel;

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

// Wrap each top-level expression statement in __capture(line, expr) so the
// runtime can report per-line values. console.* calls are left alone — they're
// captured separately at execution time.
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

// After the last import, throw a readable error if an external default import
// resolved to undefined (a very common esm.sh footgun).
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

// Rewrite `npm:` and bare specifiers to esm.sh so imports resolve in the browser.
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

export type SourceType = "module" | "script";

export interface TranspileOptions {
  /** Wrap top-level expressions in __capture for per-line value collection. */
  instrument?: boolean;
}

export interface TranspileResult {
  code: string;
  sourceType: SourceType;
}

function transpileAs(
  source: string,
  sourceType: SourceType,
  instrument: boolean,
): string {
  const plugins = [
    ...(instrument ? [instrumentPlugin] : []),
    checkDefaultExportsPlugin,
    rewriteImportsPlugin,
  ];
  const result = transform(source, {
    filename: "user.ts",
    sourceType,
    presets: [["typescript", { allExtensions: true, isTSX: false }]],
    plugins,
    sourceMaps: false,
    retainLines: true,
  });
  return result.code;
}

const STRICT_MODE_ONLY =
  /Legacy octal|strict mode|with statement|delete .* in strict|implements .* reserved|let .* reserved|protected .* reserved|public .* reserved|private .* reserved/i;

/**
 * Transpile TS/JS to a browser-executable string. Tries module source type
 * first (top-level await); falls back to script for strict-mode-only syntax.
 */
export function transpile(
  source: string,
  opts: TranspileOptions = {},
): TranspileResult {
  const instrument = opts.instrument ?? false;
  try {
    return {
      code: transpileAs(source, "module", instrument),
      sourceType: "module",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (STRICT_MODE_ONLY.test(msg)) {
      return {
        code: transpileAs(source, "script", instrument),
        sourceType: "script",
      };
    }
    throw e;
  }
}
