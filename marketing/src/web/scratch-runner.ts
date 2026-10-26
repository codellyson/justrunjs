// Runs scratchpad code in a Web Worker and turns the outcome into per-line values and one
// plain-language error placed on its line.
import type { InlineValue } from "./inline-values.ts";

export interface LineResult {
  line: number;
  display: string;
}

interface EvalOutcome {
  results: LineResult[];
  ms: number;
}

interface Transport {
  evaluate(source: string): Promise<EvalOutcome>;
  stop(): void;
}

type ReadyMessage = { type: "ready" };
type ReplyMessage =
  | { id: number; ok: true; results: LineResult[]; ms: number }
  | { id: number; ok: false; error: string; line?: number; results?: LineResult[] };
type WorkerMessage = ReadyMessage | ReplyMessage;

export type RunStatus = "ready" | "running" | "ok" | "error";

function createWorkerTransport(): Transport {
  let worker: Worker | null = null;
  let workerReady: Promise<void> = Promise.resolve();
  const pendingReplies = new Map<
    number,
    { resolve: (v: EvalOutcome) => void; reject: (e: Error) => void }
  >();
  let evalSeq = 0;

  function spawn(): void {
    let resolveReady!: () => void;
    let rejectReady!: (e: Error) => void;
    workerReady = new Promise<void>((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    worker = new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const data = e.data;
      if (!data) return;
      if ("type" in data && data.type === "ready") {
        resolveReady();
        return;
      }
      if (!("id" in data)) return;
      const entry = pendingReplies.get(data.id);
      if (!entry) return;
      pendingReplies.delete(data.id);
      if (data.ok) entry.resolve({ results: data.results, ms: data.ms });
      else entry.reject(Object.assign(new Error(data.error || "eval failed"), { line: data.line, results: data.results }));
    };
    worker.onerror = (e: ErrorEvent) => {
      const msg =
        e.message ||
        (e.filename ? `${e.filename}:${e.lineno}` : "worker failed to start");
      rejectReady(new Error(msg));
      for (const [, entry] of pendingReplies) entry.reject(new Error(msg));
      pendingReplies.clear();
    };
    worker.onmessageerror = () => {
      rejectReady(new Error("worker message channel error"));
    };
  }
  spawn();

  return {
    async evaluate(source: string): Promise<EvalOutcome> {
      await workerReady;
      const id = ++evalSeq;
      return new Promise<EvalOutcome>((resolve, reject) => {
        pendingReplies.set(id, { resolve, reject });
        worker!.postMessage({ id, source });
      });
    },
    stop(): void {
      if (worker) {
        for (const [, entry] of pendingReplies) entry.reject(new Error("stopped"));
        pendingReplies.clear();
        worker.terminate();
      }
      spawn();
    },
  };
}

// Plain-language versions of the errors beginners hit most; the original stays on hover.
const PLAIN_ERRORS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^Unterminated string constant/, () => "A string is missing its closing quote"],
  [/^Unterminated template/, () => "A template string is missing its closing backtick (`)"],
  [/^Unexpected token, expected "(.+)"/, (m) => `This line isn't finished: expected "${m[1]}" here (maybe a comma or a closing bracket)`],
  [/^Unexpected token/, () => "This line isn't finished or has a typo"],
  [/^Missing semicolon/, () => "Two statements run together: add a ; or a line break"],
  [/^Identifier directly after number/, () => "A name runs straight into a number: add a space or an operator"],
  [/^(\S+) is not defined/, (m) => `${m[1]} isn't defined (check the spelling, or define it first)`],
  [/^Cannot read propert(?:y|ies) of (undefined|null) \(reading '(.+)'\)/, (m) => `Can't read .${m[2]} of ${m[1]}`],
  [/^(\S+) is not a function/, (m) => `${m[1]} isn't a function, so it can't be called`],
];

/** The last opening bracket left unclosed in `src` (ignoring strings and comments), or "". */
export function unclosedBracket(src: string): string {
  const stack: string[] = [];
  const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      for (i++; i < src.length && src[i] !== c && src[i] !== "\n"; i++) if (src[i] === "\\") i++;
    } else if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if ("([{".includes(c)) stack.push(c);
    else if (pairs[c] && stack[stack.length - 1] === pairs[c]) stack.pop();
  }
  return stack[stack.length - 1] ?? "";
}

export interface ScratchRunnerOptions {
  /** The code to run, read at the moment each run starts. */
  source(): string;
  /** Values or the error changed. */
  onChange(): void;
  onStatus(text: string, state: RunStatus): void;
  /** True keeps the last good values up instead of showing this error (a lesson mid-keystroke). */
  holdError?(): boolean;
}

export function createScratchRunner(opts: ScratchRunnerOptions) {
  const transport = createWorkerTransport();
  let results: LineResult[] = [];
  let error: string | null = null;
  let errorLine = 0; // line that threw, from the worker; 0 when unknown
  let lastGoodResults: LineResult[] = []; // from the last run that finished, for lines above a syntax error
  let inFlight = false;
  let pending = false;
  let gen = 0;

  async function run(): Promise<void> {
    if (inFlight) {
      pending = true;
      return;
    }
    const myGen = ++gen;
    inFlight = true;
    opts.onStatus("running…", "running");
    try {
      const outcome = await transport.evaluate(opts.source());
      if (myGen !== gen) return;
      error = null;
      results = outcome.results;
      lastGoodResults = outcome.results;
      opts.onChange();
      opts.onStatus(`${results.length} result${results.length === 1 ? "" : "s"} · ${outcome.ms}ms`, "ok");
    } catch (e) {
      if (myGen !== gen) return;
      const msg = e instanceof Error ? e.message : String(e);
      if (opts.holdError?.()) return;
      const partial = e as { line?: number; results?: LineResult[] };
      error = msg;
      errorLine = partial.line ?? 0;
      // Values from the lines before the throw are still true; keep them. A syntax error runs
      // nothing, so lines above it keep their values from the last run that finished.
      const syntaxLine = Number(msg.match(/\((\d+):\d+\)/)?.[1] ?? 0);
      results = syntaxLine ? lastGoodResults.filter((r) => r.line > 0 && r.line < syntaxLine) : (partial.results ?? []);
      // Values a runtime error left behind are real too; a later syntax error can fall back on them.
      if (!syntaxLine) lastGoodResults = results;
      opts.onChange();
      opts.onStatus(msg, "error");
    } finally {
      inFlight = false;
      if (pending && myGen === gen) {
        pending = false;
        void run();
      }
    }
  }

  /** The current error, placed on a line and in plain words, or null. */
  function placedError(): { line: number; message: string } | null {
    if (!error) return null;
    const src = opts.source();
    // Syntax errors carry Babel's "(line:col)"; runtime errors carry the line that threw.
    const at = error.match(/\((\d+):\d+\)/);
    const line = at ? Number(at[1]) : errorLine;
    // The line is shown separately; drop Babel's internal file name and keep the column.
    const raw = error.split("\n")[0].replace(/^\/?user\.\w+:\s*/, "");
    const column = raw.match(/\(\d+:(\d+)\)/)?.[1];
    const bare = raw.replace(/\s*\(\d+:\d+\)/, "");
    const plain = PLAIN_ERRORS.find(([re]) => re.test(bare));
    let message = plain ? plain[1](bare.match(plain[0])!) : bare;
    // "expected ','" at an unclosed ( [ or { is really "you never closed it"; say that instead.
    if (at && /^Unexpected token, expected/.test(bare)) {
      const open = unclosedBracket(src);
      if (open) message = `A ${open} is never closed`;
    }
    if (column) message += ` (column ${column})`;
    // A runtime error stops everything after it; say so when there's code below.
    if (!at && line && line < src.split("\n").length) message += ". Lines after this didn't run";
    if (line) return { line, message };
    // No line at all: say where it can't be earlier than, rather than pretending it's line 1.
    const lastGood = Math.max(0, ...results.map((r) => r.line));
    return { line: lastGood + 1, message: lastGood ? `after line ${lastGood}: ${message}` : message };
  }

  /** Values for the editor: one per line (several joined, openable in full) plus the error. */
  function inlineValues(): InlineValue[] {
    const byLine = new Map<number, string[]>();
    for (const r of results) if (r.line > 0) byLine.set(r.line, [...(byLine.get(r.line) ?? []), r.display]);
    const values: InlineValue[] = [...byLine].map(([line, texts]) => {
      const text = texts.join("\n\n");
      return texts.length > 1 || text.includes("\n") ? { line, text, expandable: true } : { line, text };
    });
    const err = placedError();
    if (err) values.push({ line: err.line, text: err.message, error: true });
    return values;
  }

  return {
    run,
    stop(): void {
      gen++;
      pending = false;
      inFlight = false;
      transport.stop();
      opts.onStatus("stopped", "ready");
    },
    /** Forget values and error (they belonged to other code). */
    clear(): void {
      results = [];
      error = null;
    },
    get results(): readonly LineResult[] {
      return results;
    },
    get error(): string | null {
      return error;
    },
    placedError,
    inlineValues,
  };
}
