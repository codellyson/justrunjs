/// <reference lib="webworker" />
import { __inspect } from "./inspector.ts";
import { transpile } from "./transpile.ts";

declare const self: DedicatedWorkerGlobalScope;

type Capture = [number, string];

let captures: Capture[] = [];
let captureActive = false;

let currentLine = 0; // the top-level statement running now (set by __line)

const globalAny = globalThis as unknown as {
  __inspect: (v: unknown) => string;
  __capture: (line: number, value: unknown) => unknown;
  __line: (line: number) => void;
};
globalAny.__line = (line) => {
  currentLine = line;
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
      captures.push([currentLine, formatted]); // the line whose statement called console.*
    }
    orig(...args);
  };
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
  currentLine = 0;
  const { code, sourceType } = transpile(source, { instrument: true, trackLines: true });
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
    // Values from the lines that ran before the throw still count; `line` is where it threw
    // (0 when it never started running, e.g. a syntax error).
    const results = captures.map(([line, display]) => ({ line, display }));
    self.postMessage({ id, ok: false, error: msg, line: currentLine, results });
  }
};
