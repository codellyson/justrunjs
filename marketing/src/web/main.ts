import { basicSetup } from "codemirror";
import {
  EditorState,
  Compartment,
  Prec,
  StateField,
  StateEffect,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  Decoration,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import { html as htmlLang } from "@codemirror/lang-html";
import { css as cssLang } from "@codemirror/lang-css";
import {
  syntaxHighlighting,
  HighlightStyle,
  indentUnit,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { findExample } from "./examples.ts";
import inspectorRaw from "./inspector.ts?raw";
import {
  PREVIEW_SOURCE,
  buildBridge,
  type PreviewMessage,
} from "./preview-bootstrap.ts";
import {
  decodeSharedBin,
  encodeShareUrl,
  clearShareHash,
  type ShareLanguage,
} from "./share.ts";

interface LineResult {
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
  | { id: number; ok: false; error: string };
type WorkerMessage = ReadyMessage | ReplyMessage;

interface TauriWindowHandle {
  minimize(): void | Promise<void>;
  toggleMaximize(): void | Promise<void>;
  close(): void | Promise<void>;
  isMaximized(): Promise<boolean>;
  onResized(cb: () => void): Promise<() => void>;
}

interface TauriCore {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

interface TauriWindowApi {
  getCurrentWindow(): TauriWindowHandle;
}

interface TauriGlobal {
  core?: TauriCore;
  window?: TauriWindowApi;
}

declare global {
  interface Window {
    __TAURI__?: TauriGlobal;
  }
}

interface ThemeVariant {
  bg?: string;
  bgSecondary?: string;
  border?: string;
  textPrimary?: string;
  textSecondary?: string;
  textMuted?: string;
  accent?: string;
  accentHover?: string;
  accentText?: string;
  danger?: string;
  success?: string;
  warning?: string;
}

interface ThemeDefinition {
  light: ThemeVariant;
  dark: ThemeVariant;
}

type LanguageId = "typescript" | "javascript";

type TabKind = "scratchpad" | "playground";
type PanelId = "html" | "css" | "js";

interface Tab {
  id: string;
  name: string;
  /** Missing on legacy persisted tabs → normalized to "scratchpad" on load. */
  kind: TabKind;
  // Scratchpad fields (also the storage for legacy tabs).
  content: string;
  language: LanguageId;
  // Playground fields.
  html?: string;
  css?: string;
  js?: string;
  jsLanguage?: LanguageId;
  /** Which sub-panel the editor is currently showing for a playground tab. */
  activePanel?: PanelId;
}

const STARTER = `// justrunjs in the browser — every top-level value shows up on the right.

const greeting: string = "hello";
greeting.toUpperCase();

const m = new Map<string, { name: string }>();
m.set("u1", { name: "Ada" });
m;

const total = await Promise.resolve(40 + 2);
total;
`;

const TABS_KEY = "runjs.tabs";

const NPM_TEMPLATE = `// Any npm package, served as ESM via esm.sh.
import _ from "npm:lodash@4";

_.chunk([1, 2, 3, 4, 5], 2);
`;

const PLAYGROUND_HTML = `<!-- Write HTML here — it renders live on the right. -->
<h1>Hello, playground 👋</h1>
<p>Edit HTML, CSS and JS in the tabs above.</p>
<button id="go">Click me</button>
`;

const PLAYGROUND_CSS = `body {
  font-family: system-ui, sans-serif;
  padding: 24px;
  color: #1a1a2e;
}
button {
  padding: 8px 16px;
  border: 0;
  border-radius: 6px;
  background: #5b6cff;
  color: white;
  cursor: pointer;
}
`;

const PLAYGROUND_JS = `console.log("Hello from the console 👋", { ready: true });

const btn = document.getElementById("go");
let count = 0;
btn.addEventListener("click", () => {
  count++;
  console.log("clicked", count, "time" + (count === 1 ? "" : "s"));
  btn.textContent = \`Clicked \${count}×\`;
});
`;

let tabs: Tab[] = [];
let activeId: string | null = null;

/** Backfill fields missing on tabs persisted before playground support. */
function normalizeTab(t: Tab): Tab {
  if (!t.kind) t.kind = "scratchpad";
  if (t.kind === "playground") {
    t.html ??= "";
    t.css ??= "";
    t.js ??= "";
    t.jsLanguage ??= "javascript";
    t.activePanel ??= "html";
  }
  return t;
}

function loadTabs(): void {
  const raw = localStorage.getItem(TABS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { tabs?: Tab[]; activeId?: string };
      if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
        tabs = parsed.tabs.map(normalizeTab);
        activeId = parsed.activeId || tabs[0].id;
      }
    } catch {
      /* fall through to defaults */
    }
  }
  if (tabs.length === 0) {
    tabs = [
      {
        id: "t-1",
        name: "untitled.ts",
        kind: "scratchpad",
        content: STARTER,
        language: "typescript",
      },
    ];
    activeId = "t-1";
  }
}
loadTabs();

function getActiveTab(): Tab {
  return tabs.find((t) => t.id === activeId) || tabs[0];
}

// --- editor "slot": the piece of a tab the single CodeMirror is showing now.
// For a scratchpad that's `content`; for a playground it's the active panel.

function panelOf(tab: Tab): PanelId {
  return tab.activePanel ?? "html";
}

function slotContent(tab: Tab): string {
  if (tab.kind !== "playground") return tab.content;
  const p = panelOf(tab);
  return (p === "html" ? tab.html : p === "css" ? tab.css : tab.js) ?? "";
}

function writeSlot(tab: Tab, value: string): void {
  if (tab.kind !== "playground") {
    tab.content = value;
    return;
  }
  const p = panelOf(tab);
  if (p === "html") tab.html = value;
  else if (p === "css") tab.css = value;
  else tab.js = value;
}

function slotLanguageExt(tab: Tab): Extension {
  if (tab.kind !== "playground") return languageExt(tab.language);
  const p = panelOf(tab);
  if (p === "html") return htmlLang();
  if (p === "css") return cssLang();
  return javascript({ typescript: (tab.jsLanguage ?? "javascript") === "typescript" });
}

/** Push the editor's current text back into the active tab's live slot. */
function flushEditor(): void {
  const active = getActiveTab();
  if (active) writeSlot(active, editor.state.doc.toString());
}

function persistTabs(): void {
  flushEditor();
  localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, activeId }));
}

function languageExt(lang: LanguageId): Extension {
  return javascript({ typescript: lang === "typescript" });
}

const sidebarStatusEl = document.getElementById("sidebar-status") as HTMLElement;
const resultsEl = document.getElementById("results") as HTMLElement;

const resultsInner = document.createElement("div");
resultsInner.id = "results-inner";
resultsEl.appendChild(resultsInner);

const previewFrame = document.getElementById(
  "preview",
) as HTMLIFrameElement | null;
const previewPane = document.getElementById("preview-pane");
const consoleLogEl = document.getElementById("console-log");
const consoleCountEl = document.getElementById("console-count");

const panelTabsEl = document.getElementById("panel-tabs");
const PANELS: PanelId[] = ["html", "css", "js"];

type StatusState = "ready" | "running" | "ok" | "error";
const STATES: StatusState[] = ["ready", "running", "ok", "error"];
function setStatus(text: string, state?: StatusState): void {
  sidebarStatusEl.title = text;
  for (const s of STATES) sidebarStatusEl.classList.remove(s);
  if (state) sidebarStatusEl.classList.add(state);
}

const editorTheme = EditorView.theme(
  {
    "&": {
      backgroundColor: "rgb(var(--bg))",
      height: "100%",
      fontSize: "var(--editor-font-size, 14px)",
    },
    ".cm-content": {
      fontFamily: "var(--font-mono)",
      padding: "10px 0",
      caretColor: "rgb(var(--text-primary))",
    },
    ".cm-line": { lineHeight: "21px", padding: "0 10px" },
    ".cm-gutters": {
      backgroundColor: "rgb(var(--bg))",
      color: "rgb(var(--text-muted))",
      border: "none",
    },
    ".cm-gutterElement": { lineHeight: "21px", padding: "0 8px 0 12px" },
    ".cm-activeLine": { backgroundColor: "rgb(var(--text-primary) / 0.04)" },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "rgb(var(--text-primary))",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "rgb(var(--accent) / 0.25)",
    },
    ".cm-cursor": { borderLeftColor: "rgb(var(--accent))" },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      overflow: "auto",
    },
    "&.cm-focused": { outline: "none" },
  },
  {
    dark:
      typeof document !== "undefined" &&
      document.documentElement.dataset.themeMode !== "light",
  },
);

const darkHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#e879a4" },
  { tag: tags.controlKeyword, color: "#e879a4" },
  { tag: tags.moduleKeyword, color: "#e879a4" },
  { tag: tags.definitionKeyword, color: "#e879a4" },
  { tag: [tags.string, tags.special(tags.string)], color: "#b8d077" },
  { tag: tags.number, color: "#c397f5" },
  { tag: tags.bool, color: "#c397f5" },
  { tag: tags.null, color: "#c397f5" },
  { tag: tags.atom, color: "#c397f5" },
  { tag: tags.variableName, color: "#8fc1e0" },
  { tag: tags.propertyName, color: "#8fc1e0" },
  { tag: tags.function(tags.variableName), color: "#b8d077" },
  { tag: tags.function(tags.propertyName), color: "#e879a4" },
  { tag: tags.typeName, color: "#8fc1e0" },
  { tag: tags.className, color: "#8fc1e0" },
  { tag: tags.comment, color: "#7c7266", fontStyle: "italic" },
  { tag: tags.lineComment, color: "#7c7266", fontStyle: "italic" },
  { tag: tags.blockComment, color: "#7c7266", fontStyle: "italic" },
  { tag: tags.operator, color: "#e879a4" },
  { tag: tags.punctuation, color: "#e8ded2" },
  { tag: tags.bracket, color: "#e8ded2" },
  { tag: tags.regexp, color: "#f0b870" },
  { tag: tags.escape, color: "#f0b870" },
]);

const lightHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#cf222e" },
  { tag: tags.controlKeyword, color: "#cf222e" },
  { tag: tags.moduleKeyword, color: "#cf222e" },
  { tag: tags.definitionKeyword, color: "#cf222e" },
  { tag: [tags.string, tags.special(tags.string)], color: "#0a3069" },
  { tag: tags.number, color: "#0550ae" },
  { tag: tags.bool, color: "#0550ae" },
  { tag: tags.null, color: "#0550ae" },
  { tag: tags.atom, color: "#0550ae" },
  { tag: tags.variableName, color: "#24292f" },
  { tag: tags.propertyName, color: "#953800" },
  { tag: tags.function(tags.variableName), color: "#8250df" },
  { tag: tags.function(tags.propertyName), color: "#8250df" },
  { tag: tags.typeName, color: "#24292f" },
  { tag: tags.className, color: "#953800" },
  { tag: tags.comment, color: "#6e7781", fontStyle: "italic" },
  { tag: tags.lineComment, color: "#6e7781", fontStyle: "italic" },
  { tag: tags.blockComment, color: "#6e7781", fontStyle: "italic" },
  { tag: tags.operator, color: "#cf222e" },
  { tag: tags.punctuation, color: "#24292f" },
  { tag: tags.bracket, color: "#24292f" },
  { tag: tags.regexp, color: "#116329" },
  { tag: tags.escape, color: "#116329" },
]);

type Mode = "light" | "dark";

function highlightFor(mode: Mode): Extension {
  return syntaxHighlighting(mode === "light" ? lightHighlight : darkHighlight);
}

const highlightCompartment = new Compartment();
const languageCompartment = new Compartment();
const tabSizeCompartment = new Compartment();
const wordWrapCompartment = new Compartment();
const tsCompartment = new Compartment();

const FONT_SIZE_KEY = "runjs.fontSize";
const TAB_SIZE_KEY = "runjs.tabSize";
const WORD_WRAP_KEY = "runjs.wordWrap";
const AUTO_EVAL_KEY = "runjs.autoEval";
const PLAYGROUND_INLINE_KEY = "runjs.playgroundInline";

function readInt(key: string, fallback: number): number {
  const v = parseInt(localStorage.getItem(key) || "", 10);
  return Number.isFinite(v) ? v : fallback;
}
function readBool(key: string, fallback: boolean): boolean {
  const v = localStorage.getItem(key);
  if (v === null) return fallback;
  return v !== "false";
}

let fontSize = readInt(FONT_SIZE_KEY, 14);
let tabSize = readInt(TAB_SIZE_KEY, 2);
let wordWrap = readBool(WORD_WRAP_KEY, true);
let autoEval = readBool(AUTO_EVAL_KEY, true);
let playgroundInline = readBool(PLAYGROUND_INLINE_KEY, true);

document.documentElement.style.setProperty(
  "--editor-font-size",
  fontSize + "px",
);

function currentMode(): Mode {
  return document.documentElement.dataset.themeMode === "light"
    ? "light"
    : "dark";
}

// --- inline value decorations (playground JS: RunJS-style `⇒ value` at line end) ---

class InlineValueWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: InlineValueWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-inline-value";
    const firstLine = this.text.split("\n")[0];
    span.textContent =
      "  ⇒ " + firstLine + (this.text.includes("\n") ? " …" : "");
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

const setInlineValues = StateEffect.define<{ line: number; text: string }[]>();

const inlineValuesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setInlineValues)) continue;
      const ranges = [];
      for (const { line, text } of e.value) {
        if (line < 1 || line > tr.state.doc.lines) continue;
        const pos = tr.state.doc.line(line).to;
        ranges.push(
          Decoration.widget({
            widget: new InlineValueWidget(text),
            side: 1,
          }).range(pos),
        );
      }
      deco = Decoration.set(ranges, true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const _bootTab = getActiveTab();
const editor = new EditorView({
  parent: document.getElementById("editor-host") as HTMLElement,
  state: EditorState.create({
    doc: slotContent(_bootTab),
    extensions: [
      basicSetup,
      wordWrapCompartment.of(wordWrap ? EditorView.lineWrapping : []),
      indentUnit.of("  "),
      tabSizeCompartment.of(EditorState.tabSize.of(tabSize)),
      keymap.of([
        indentWithTab,
        {
          key: "Mod-Enter",
          run: () => {
            runActive();
            return true;
          },
        },
        {
          key: "Mod-Shift-f",
          run: () => {
            formatBuffer();
            return true;
          },
        },
      ]),
      languageCompartment.of(slotLanguageExt(_bootTab)),
      inlineValuesField,
      Prec.highest(tsCompartment.of([])),
      Prec.highest(highlightCompartment.of(highlightFor(currentMode()))),
      editorTheme,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          persistTabs();
          schedule();
        }
      }),
    ],
  }),
});

const NUMERIC = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
type ValueKind =
  | "object"
  | "null"
  | "bool"
  | "bigint"
  | "number"
  | "string"
  | "array"
  | "function"
  | "symbol";
function classify(s: string): ValueKind {
  if (!s) return "object";
  if (s === "null") return "null";
  if (s === "undefined") return "null";
  if (s === "true" || s === "false") return "bool";
  if (/^-?\d+n$/.test(s)) return "bigint";
  if (s === "NaN" || s === "Infinity" || s === "-Infinity" || s === "-0")
    return "number";
  if (NUMERIC.test(s)) return "number";
  if (s.startsWith("'") || s.startsWith('"')) return "string";
  if (s.startsWith("[")) {
    if (s.startsWith("[Function") || s.startsWith("[Class")) return "function";
    if (s.startsWith("[Circular")) return "object";
    return "array";
  }
  if (s.startsWith("Symbol(")) return "symbol";
  return "object";
}

let lastResults: LineResult[] = [];
let lastError: string | null = null;

function appendRow(seq: number, text: string, klass: string | null): HTMLSpanElement {
  const row = document.createElement("div");
  row.className = "result-row" + (klass ? " " + klass : "");
  const seqEl = document.createElement("span");
  seqEl.className = "seq";
  seqEl.textContent = String(seq);
  const value = document.createElement("span");
  value.className = "value";
  value.textContent = text;
  row.appendChild(seqEl);
  row.appendChild(value);
  resultsInner.appendChild(row);
  return value;
}

function paintResults(): void {
  resultsInner.innerHTML = "";

  if (lastError) {
    appendRow(1, "error: " + lastError.split("\n")[0], "error");
    return;
  }

  const sourceText = editor.state.doc.toString();
  if (lastResults.length === 0 && sourceText.trim().length === 0) {
    const ph = document.createElement("div");
    ph.className = "result-placeholder";
    ph.textContent = "type some TS / JS — each top-level value shows up here";
    resultsInner.appendChild(ph);
    return;
  }

  let seq = 1;
  for (const r of lastResults) {
    const klass = "v-" + classify(r.display);
    const lines = r.display.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const v = appendRow(seq++, lines[i], i === 0 ? klass : null);
      if (i === 0) v.title = r.display;
    }
  }
}

const tauriCore: TauriCore | undefined =
  typeof window !== "undefined" && window.__TAURI__
    ? window.__TAURI__.core
    : undefined;

const transport: Transport = tauriCore
  ? createTauriTransport(tauriCore)
  : createWorkerTransport();

function createTauriTransport(core: TauriCore): Transport {
  return {
    async evaluate(source: string): Promise<EvalOutcome> {
      const t0 = performance.now();
      const results = await core.invoke<LineResult[]>("evaluate_source", { source });
      return { results, ms: Math.round(performance.now() - t0) };
    },
    stop(): void {
      core.invoke("stop_eval").catch(() => {});
    },
  };
}

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
      else entry.reject(new Error(data.error || "eval failed"));
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

let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight = false;
let pending = false;
let evalGen = 0;

async function runEval(): Promise<void> {
  if (inFlight) {
    pending = true;
    return;
  }
  const myGen = ++evalGen;
  inFlight = true;
  const source = editor.state.doc.toString();
  setStatus("running…", "running");
  try {
    const { results, ms } = await transport.evaluate(source);
    if (myGen !== evalGen) return;
    lastError = null;
    lastResults = results;
    paintResults();
    setStatus(
      `${results.length} result${results.length === 1 ? "" : "s"} · ${ms}ms`,
      "ok",
    );
  } catch (e) {
    if (myGen !== evalGen) return;
    const msg = e instanceof Error ? e.message : String(e);
    lastError = msg;
    lastResults = [];
    paintResults();
    setStatus(msg, "error");
  } finally {
    inFlight = false;
    if (pending && myGen === evalGen) {
      pending = false;
      runEval();
    }
  }
}

function stopEval(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  evalGen++;
  pending = false;
  inFlight = false;
  transport.stop();
  setStatus("stopped", "ready");
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

// Babel is heavy; keep it out of the initial bundle and load it the first time
// a playground actually renders. Cached across renders after that.
let transpileMod: typeof import("./transpile.ts") | null = null;

// The inspector, transpiled to plain JS once, inlined into the preview so its
// console output matches the scratchpad's fidelity (Map(1) {…} etc.).
let inspectorJs: string | null = null;
async function getInspectorJs(): Promise<string> {
  if (inspectorJs !== null) return inspectorJs;
  if (!transpileMod) transpileMod = await import("./transpile.ts");
  inspectorJs = transpileMod.transpile(inspectorRaw, { instrument: false }).code;
  return inspectorJs;
}

// Each render gets a fresh nonce; console/error messages tagged with a stale
// nonce (from a previous srcdoc still unloading) are dropped by the listener.
let previewNonce = 0;
let currentPreviewNonce = "";

const escapeScriptClose = (code: string): string =>
  code.replace(/<\/script/gi, "<\\/script");

/** Assemble the playground document and load it into the sandboxed iframe. */
async function renderPreview(): Promise<void> {
  const t = getActiveTab();
  if (t.kind !== "playground" || !previewFrame) return;
  flushEditor();
  const { html: htmlSrc = "", css: cssSrc = "", js: jsSrc = "" } = t;

  const instrument = playgroundInline;
  let userBody: string;
  try {
    if (!transpileMod) transpileMod = await import("./transpile.ts");
    const { code } = transpileMod.transpile(jsSrc, { instrument });
    userBody = `<script type="module">\n${escapeScriptClose(code)}\n</script>`;
    setStatus("rendered", "ok");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    userBody = `<pre style="margin:16px;color:#b00020;font:13px ui-monospace,monospace;white-space:pre-wrap">${escapeHtml(msg)}</pre>`;
    setStatus(msg, "error");
  }

  const inspector = await getInspectorJs();

  // The active tab may have changed while Babel/JS loaded — don't clobber.
  if (getActiveTab().id !== t.id) return;

  const nonce = String(++previewNonce);
  currentPreviewNonce = nonce;
  clearConsole();
  lastValues.clear();
  applyInlineValues();

  const bootstrap =
    `<script type="module">\n${escapeScriptClose(inspector)}\n${escapeScriptClose(buildBridge(nonce, instrument))}\n</script>`;

  previewFrame.srcdoc =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<style>${cssSrc}</style>${bootstrap}</head><body>\n${htmlSrc}\n${userBody}\n</body></html>`;
}

// ---------- inline values (playground JS) ----------

// Values from the current render, keyed by source line. Painted into the JS
// editor only while the JS panel of a playground is active and the setting is on.
const lastValues = new Map<number, string>();

function shouldShowInline(): boolean {
  const t = getActiveTab();
  return playgroundInline && t.kind === "playground" && panelOf(t) === "js";
}

/** Push the collected values (or nothing) into the editor's decoration field. */
function applyInlineValues(): void {
  const show = shouldShowInline();
  const values = show
    ? [...lastValues.entries()]
        .filter(([, text]) => text !== "undefined")
        .map(([line, text]) => ({ line, text }))
    : [];
  editor.dispatch({ effects: setInlineValues.of(values) });
}

// ---------- console drawer ----------

let consoleCount = 0;
const CONSOLE_MAX = 200;

function clearConsole(): void {
  consoleCount = 0;
  if (consoleLogEl) consoleLogEl.innerHTML = "";
  if (consoleCountEl) consoleCountEl.textContent = "";
}

function appendConsole(level: string, text: string): void {
  if (!consoleLogEl) return;
  if (consoleCount >= CONSOLE_MAX) return;
  consoleCount++;
  const row = document.createElement("div");
  row.className = "console-entry level-" + level;
  row.textContent = text;
  consoleLogEl.appendChild(row);
  consoleLogEl.scrollTop = consoleLogEl.scrollHeight;
  if (consoleCountEl) consoleCountEl.textContent = String(consoleCount);
}

window.addEventListener("message", (e: MessageEvent) => {
  const d = e.data as PreviewMessage | undefined;
  if (!d || d.source !== PREVIEW_SOURCE) return;
  // Only trust the current preview frame, and only its current render.
  if (previewFrame && e.source !== previewFrame.contentWindow) return;
  if (d.nonce !== currentPreviewNonce) return;
  if (d.type === "value") {
    if (typeof d.line === "number") {
      lastValues.set(d.line, (d.parts || [])[0] ?? "");
      if (shouldShowInline()) applyInlineValues();
    }
    return;
  }
  appendConsole(d.level, (d.parts || []).join(" "));
});

document.getElementById("console-clear")?.addEventListener("click", clearConsole);
document.getElementById("console-toggle")?.addEventListener("click", () => {
  document.getElementById("console-drawer")?.classList.toggle("collapsed");
});

/** Route a run/render to the right engine based on the active tab kind. */
function runActive(): void {
  if (getActiveTab().kind === "playground") void renderPreview();
  else void runEval();
}

function schedule(): void {
  if (timer) clearTimeout(timer);
  if (!autoEval) return;
  timer = setTimeout(runActive, 300);
}

syncViewToActiveTab();
runActive();

(async () => {
  setStatus("loading IntelliSense…", "running");
  try {
    const { createTsEnv } = await import("./ts-env.ts");
    const { extensions } = await createTsEnv();
    editor.dispatch({
      effects: tsCompartment.reconfigure(extensions),
    });
    setStatus("IntelliSense ready", "ok");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus("IntelliSense failed: " + msg, "error");
    throw e;
  }
})();

document.getElementById("btn-run")!.addEventListener("click", () => {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  runActive();
});

document.getElementById("btn-stop")!.addEventListener("click", stopEval);

const isEmbedded =
  new URLSearchParams(window.location.search).get("embed") === "1" ||
  window.parent !== window;

if (isEmbedded || tauriCore) {
  const home = document.getElementById("btn-home");
  if (home) home.style.display = "none";
}

const isMac =
  !!tauriCore && typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);

if (tauriCore && isMac) {
  const tabsEl = document.getElementById("tabs");
  if (tabsEl) {
    tabsEl.setAttribute("data-tauri-drag-region", "");
    document.body.classList.add("titlebar-mac");
  }
}

if (tauriCore && !isMac) {
  const titlebar = document.getElementById("titlebar");
  if (titlebar) {
    titlebar.classList.remove("hidden");
    document.body.classList.add("has-titlebar");

    const win = window.__TAURI__ && window.__TAURI__.window;
    const withWindow = (method: "minimize" | "toggleMaximize" | "close"): void => {
      if (!win || !win.getCurrentWindow) return;
      try {
        const w = win.getCurrentWindow();
        const fn = w[method];
        if (typeof fn === "function") fn.call(w);
      } catch {
        /* ignore */
      }
    };
    const minBtn = document.getElementById("btn-tb-min");
    const maxBtn = document.getElementById("btn-tb-max");
    const closeBtn = document.getElementById("btn-tb-close");
    if (minBtn) minBtn.addEventListener("click", () => withWindow("minimize"));
    if (maxBtn) maxBtn.addEventListener("click", () => withWindow("toggleMaximize"));
    if (closeBtn) closeBtn.addEventListener("click", () => withWindow("close"));

    (async () => {
      if (!win || !win.getCurrentWindow) return;
      try {
        const w = win.getCurrentWindow();
        const refresh = async (): Promise<void> => {
          const m = await w.isMaximized();
          titlebar.classList.toggle("is-maximized", m);
        };
        await refresh();
        await w.onResized(refresh);
      } catch {
        /* ignore */
      }
    })();
  }
}

if (isEmbedded) {
  const expand = document.getElementById("btn-expand");
  if (expand) {
    expand.classList.remove("hidden");
    expand.addEventListener("click", () => {
      try {
        window.parent.postMessage({ type: "toggle" }, "*");
      } catch {
        /* ignore */
      }
    });
  }
}

window.addEventListener("message", (e: MessageEvent) => {
  const data = e.data as { type?: string } | null;
  if (!data || typeof data !== "object") return;
  const expand = document.getElementById("btn-expand");
  if (!expand) return;
  if (data.type === "expanded") expand.classList.add("is-expanded");
  else if (data.type === "collapsed") expand.classList.remove("is-expanded");
});

let lastMode = currentMode();
function syncHighlight(): void {
  const mode = currentMode();
  if (mode === lastMode) return;
  lastMode = mode;
  editor.dispatch({
    effects: highlightCompartment.reconfigure(highlightFor(mode)),
  });
}
new MutationObserver(syncHighlight).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["data-theme-mode"],
});

const tabsEl = document.getElementById("tabs");

/** Load the active tab's current slot (content + language) into the editor. */
function loadActiveIntoEditor(): void {
  const t = getActiveTab();
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: slotContent(t) },
    effects: languageCompartment.reconfigure(slotLanguageExt(t)),
  });
}

/** Toggle the panel bar / preview vs. results pane to match the active tab. */
function syncViewToActiveTab(): void {
  const t = getActiveTab();
  const isPlay = t.kind === "playground";
  panelTabsEl?.classList.toggle("hidden", !isPlay);
  previewPane?.classList.toggle("hidden", !isPlay);
  resultsInner.classList.toggle("hidden", isPlay);
  renderPanelTabs();
  // Values belong to whatever tab last rendered; drop them until this tab re-runs.
  lastValues.clear();
  applyInlineValues();
}

function activateTab(id: string): void {
  if (id === activeId) return;
  flushEditor();
  activeId = id;
  loadActiveIntoEditor();
  renderTabs();
  syncViewToActiveTab();
  persistTabs();
  schedule();
}

function nextUntitled(lang: LanguageId): string {
  const ext = lang === "typescript" ? "ts" : "js";
  for (let n = 1; ; n++) {
    const name = n === 1 ? `untitled.${ext}` : `untitled${n}.${ext}`;
    if (!tabs.some((t) => t.name === name)) return name;
  }
}

function newTab(lang: LanguageId = "typescript", content = ""): void {
  const id = "t-" + Date.now();
  tabs.push({ id, name: nextUntitled(lang), kind: "scratchpad", content, language: lang });
  activateTab(id);
}

function newPlayground(): void {
  const id = "t-" + Date.now();
  tabs.push({
    id,
    name: uniqueTabName("playground.html"),
    kind: "playground",
    content: "",
    language: "javascript",
    html: PLAYGROUND_HTML,
    css: PLAYGROUND_CSS,
    js: PLAYGROUND_JS,
    jsLanguage: "javascript",
    activePanel: "html",
  });
  activateTab(id);
}

/** Ensure a tab name is unique by suffixing " 2", " 3", … before the extension. */
function uniqueTabName(name: string): string {
  if (!tabs.some((t) => t.name === name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot === -1 ? name : name.slice(0, dot);
  const ext = dot === -1 ? "" : name.slice(dot);
  for (let n = 2; ; n++) {
    const candidate = `${base} ${n}${ext}`;
    if (!tabs.some((t) => t.name === candidate)) return candidate;
  }
}

/** Open a named bin (from an example or a shared link) as a fresh active tab. */
function openBinTab(
  name: string,
  lang: LanguageId,
  content: string,
): void {
  const id = "t-" + Date.now();
  tabs.push({ id, name: uniqueTabName(name), kind: "scratchpad", content, language: lang });
  activateTab(id);
}

function closeTab(id: string): void {
  if (tabs.length <= 1) return;
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  tabs.splice(idx, 1);
  if (activeId === id) {
    activeId = tabs[Math.max(0, idx - 1)].id;
    loadActiveIntoEditor();
    syncViewToActiveTab();
    schedule();
  }
  renderTabs();
  persistTabs();
}

function toggleTabLang(id: string): void {
  const t = tabs.find((tab) => tab.id === id);
  if (!t || t.kind === "playground") return;
  t.language = t.language === "typescript" ? "javascript" : "typescript";
  const ext = t.language === "typescript" ? "ts" : "js";
  t.name = t.name.replace(/\.(ts|js)$/i, "." + ext);
  if (id === activeId) {
    editor.dispatch({
      effects: languageCompartment.reconfigure(languageExt(t.language)),
    });
    schedule();
  }
  renderTabs();
  persistTabs();
}

// --- playground sub-tab bar (HTML / CSS / JS) ---

function renderPanelTabs(): void {
  if (!panelTabsEl) return;
  const t = getActiveTab();
  panelTabsEl.innerHTML = "";
  if (t.kind !== "playground") return;
  const current = panelOf(t);
  for (const p of PANELS) {
    const btn = document.createElement("button");
    btn.className = "panel-tab" + (p === current ? " active" : "");
    btn.textContent = p;
    btn.setAttribute("role", "tab");
    btn.addEventListener("click", () => switchPanel(p));
    panelTabsEl.appendChild(btn);
  }
}

function switchPanel(p: PanelId): void {
  const t = getActiveTab();
  if (t.kind !== "playground" || panelOf(t) === p) return;
  flushEditor();
  t.activePanel = p;
  loadActiveIntoEditor();
  renderPanelTabs();
  // Same tab/render — show its values when landing on JS, hide otherwise.
  applyInlineValues();
  persistTabs();
}

function renderTabs(): void {
  if (!tabsEl) return;
  tabsEl.innerHTML = "";
  for (const t of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (t.id === activeId ? " active" : "");
    el.dataset.id = t.id;
    el.setAttribute("role", "tab");

    const lang = document.createElement("button");
    lang.className = "tab-lang";
    if (t.kind === "playground") {
      lang.textContent = "</>";
      lang.title = "Playground (HTML/CSS/JS)";
      lang.disabled = true;
    } else {
      lang.textContent = t.language === "typescript" ? "TS" : "JS";
      lang.title = "Toggle language";
      lang.addEventListener("click", (e) => {
        e.stopPropagation();
        toggleTabLang(t.id);
      });
    }

    const name = document.createElement("span");
    name.className = "tab-name";
    name.textContent = t.name;

    const close = document.createElement("span");
    close.className = "tab-close";
    close.textContent = "×";
    close.title = "Close";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      closeTab(t.id);
    });

    el.addEventListener("click", () => activateTab(t.id));

    el.appendChild(lang);
    el.appendChild(name);
    el.appendChild(close);
    tabsEl.appendChild(el);
  }

  const addTs = document.createElement("button");
  addTs.className = "tab-add";
  addTs.textContent = "+TS";
  addTs.title = "New TypeScript tab";
  addTs.addEventListener("click", () => newTab("typescript"));
  tabsEl.appendChild(addTs);

  const addJs = document.createElement("button");
  addJs.className = "tab-add";
  addJs.textContent = "+JS";
  addJs.title = "New JavaScript tab";
  addJs.addEventListener("click", () => newTab("javascript"));
  tabsEl.appendChild(addJs);

  const addNpm = document.createElement("button");
  addNpm.className = "tab-add npm";
  addNpm.textContent = "+npm";
  addNpm.title = "New tab with an npm: import template";
  addNpm.addEventListener("click", () => newTab("typescript", NPM_TEMPLATE));
  tabsEl.appendChild(addNpm);

  const addPlay = document.createElement("button");
  addPlay.className = "tab-add play";
  addPlay.textContent = "+Play";
  addPlay.title = "New playground (HTML/CSS/JS with live preview)";
  addPlay.addEventListener("click", () => newPlayground());
  tabsEl.appendChild(addPlay);
}

renderTabs();

// ---------- toast ----------

let toastTimer: number | undefined;
function showToast(message: string): void {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.add("hidden"), 2200);
}

// ---------- examples library ----------

const examplesBtn = document.getElementById("btn-examples");
const examplesPopover = document.getElementById("examples-popover");

if (examplesBtn && examplesPopover) {
  examplesBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    examplesPopover.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (examplesPopover.classList.contains("hidden")) return;
    const target = e.target as Node | null;
    if (!target) return;
    if (examplesPopover.contains(target) || examplesBtn.contains(target)) return;
    examplesPopover.classList.add("hidden");
  });

  for (const item of examplesPopover.querySelectorAll<HTMLElement>(
    ".example-item",
  )) {
    item.addEventListener("click", () => {
      const id = item.dataset.exampleId;
      const ex = id ? findExample(id) : undefined;
      if (!ex) return;
      const ext = ex.language === "typescript" ? "ts" : "js";
      openBinTab(`${ex.id}.${ext}`, ex.language, ex.code);
      examplesPopover.classList.add("hidden");
    });
  }
}

// ---------- share by URL ----------

const shareBtn = document.getElementById("btn-share");
if (shareBtn) {
  shareBtn.addEventListener("click", async () => {
    const active = getActiveTab();
    active.content = editor.state.doc.toString();
    const url = encodeShareUrl({
      name: active.name,
      language: active.language as ShareLanguage,
      code: active.content,
    });
    try {
      await navigator.clipboard.writeText(url);
      showToast("Share link copied to clipboard");
    } catch {
      // Clipboard can be blocked (insecure context / permissions) — fall back
      // to putting the link in the address bar so it's still shareable.
      history.replaceState(null, "", url);
      showToast("Share link is in your address bar");
    }
  });
}

// Import a shared bin from the URL hash, if the page was opened via a link.
(function importSharedBin(): void {
  const shared = decodeSharedBin();
  if (!shared) return;
  openBinTab(shared.name, shared.language as LanguageId, shared.code);
  clearShareHash();
})();

const SHOW_LINE_NUMBERS_KEY = "runjs.showLineNumbers";
let showLineNumbers = readBool(SHOW_LINE_NUMBERS_KEY, true);
document.body.classList.toggle("hide-line-numbers", !showLineNumbers);

const settingsBtn = document.getElementById("btn-settings");
const popover = document.getElementById("settings-popover");

if (settingsBtn && popover) {
  settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    popover.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (popover.classList.contains("hidden")) return;
    const target = e.target as Node | null;
    if (!target) return;
    if (popover.contains(target) || settingsBtn.contains(target)) return;
    popover.classList.add("hidden");
  });

  const VAR_MAP: Record<keyof ThemeVariant, string> = {
    bg: "--bg",
    bgSecondary: "--bg-secondary",
    border: "--border",
    textPrimary: "--text-primary",
    textSecondary: "--text-secondary",
    textMuted: "--text-muted",
    accent: "--accent",
    accentHover: "--accent-hover",
    accentText: "--accent-text",
    danger: "--danger",
    success: "--success",
    warning: "--warning",
  };
  const getThemes = (): Record<string, ThemeDefinition> =>
    window.__JUSTUI__?.themes || {};
  const currentThemeId = (): string =>
    document.documentElement.dataset.themeId || "espresso";
  const currentThemeMode = (): Mode =>
    document.documentElement.dataset.themeMode === "light" ? "light" : "dark";
  const applyVariant = (variant: ThemeVariant, mode: Mode): void => {
    const root = document.documentElement;
    for (const k in VAR_MAP) {
      const key = k as keyof ThemeVariant;
      const val = variant[key];
      if (val) root.style.setProperty(VAR_MAP[key], val);
    }
    if (mode === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
  };
  const applyTheme = (themeId: string, mode: Mode): void => {
    const themes = getThemes();
    const theme = themes[themeId];
    if (!theme) return;
    applyVariant(mode === "dark" ? theme.dark : theme.light, mode);
    document.documentElement.dataset.themeId = themeId;
    document.documentElement.dataset.themeMode = mode;
    try {
      const ctx = window.__JUSTUI__;
      localStorage.setItem(ctx?.idKey ?? "runjs.theme.id", themeId);
      localStorage.setItem(ctx?.modeKey ?? "runjs.theme.mode", mode);
    } catch {
      /* ignore */
    }
    refreshAppearanceUI();
  };
  const refreshAppearanceUI = (): void => {
    const id = currentThemeId();
    const mode = currentThemeMode();
    popover.querySelectorAll<HTMLElement>("[data-mode-label]").forEach((el) => {
      el.classList.toggle("hidden", el.dataset.modeLabel !== mode);
    });
    popover.querySelectorAll<HTMLElement>(".theme-option").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.themeOption === id);
    });
  };

  const modeToggleBtn = document.getElementById("settings-mode-toggle");
  if (modeToggleBtn) {
    modeToggleBtn.addEventListener("click", () => {
      const next: Mode = currentThemeMode() === "dark" ? "light" : "dark";
      applyTheme(currentThemeId(), next);
    });
  }
  popover.querySelectorAll<HTMLElement>(".theme-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.themeOption;
      if (id) applyTheme(id, currentThemeMode());
    });
  });
  refreshAppearanceUI();

  const fontSizeInput = document.getElementById("opt-font-size") as HTMLInputElement | null;
  if (fontSizeInput) {
    fontSizeInput.value = String(fontSize);
    fontSizeInput.addEventListener("change", () => {
      const v = Math.max(10, Math.min(24, parseInt(fontSizeInput.value, 10) || 14));
      fontSize = v;
      fontSizeInput.value = String(v);
      localStorage.setItem(FONT_SIZE_KEY, String(v));
      document.documentElement.style.setProperty("--editor-font-size", v + "px");
    });
  }

  popover.querySelectorAll<HTMLInputElement>('input[name="opt-tab-size"]').forEach((radio) => {
    radio.checked = parseInt(radio.value, 10) === tabSize;
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      tabSize = parseInt(radio.value, 10);
      localStorage.setItem(TAB_SIZE_KEY, String(tabSize));
      editor.dispatch({
        effects: tabSizeCompartment.reconfigure(EditorState.tabSize.of(tabSize)),
      });
    });
  });

  const lineNumbersToggle = document.getElementById("opt-line-numbers") as HTMLInputElement | null;
  if (lineNumbersToggle) {
    lineNumbersToggle.checked = showLineNumbers;
    lineNumbersToggle.addEventListener("change", () => {
      showLineNumbers = lineNumbersToggle.checked;
      localStorage.setItem(SHOW_LINE_NUMBERS_KEY, String(showLineNumbers));
      document.body.classList.toggle("hide-line-numbers", !showLineNumbers);
    });
  }

  const wordWrapToggle = document.getElementById("opt-word-wrap") as HTMLInputElement | null;
  if (wordWrapToggle) {
    wordWrapToggle.checked = wordWrap;
    wordWrapToggle.addEventListener("change", () => {
      wordWrap = wordWrapToggle.checked;
      localStorage.setItem(WORD_WRAP_KEY, String(wordWrap));
      editor.dispatch({
        effects: wordWrapCompartment.reconfigure(
          wordWrap ? EditorView.lineWrapping : [],
        ),
      });
    });
  }

  const autoEvalToggle = document.getElementById("opt-auto-eval") as HTMLInputElement | null;
  if (autoEvalToggle) {
    autoEvalToggle.checked = autoEval;
    autoEvalToggle.addEventListener("change", () => {
      autoEval = autoEvalToggle.checked;
      localStorage.setItem(AUTO_EVAL_KEY, String(autoEval));
      if (!autoEval && timer) {
        clearTimeout(timer);
        timer = null;
      }
    });
  }

  const inlineToggle = document.getElementById("opt-playground-inline") as HTMLInputElement | null;
  if (inlineToggle) {
    inlineToggle.checked = playgroundInline;
    inlineToggle.addEventListener("change", () => {
      playgroundInline = inlineToggle.checked;
      localStorage.setItem(PLAYGROUND_INLINE_KEY, String(playgroundInline));
      // Re-render so the instrumentation (and thus the values) match the setting.
      if (getActiveTab().kind === "playground") runActive();
      else applyInlineValues();
    });
  }
}

interface PrettierStandalone {
  format(code: string, opts: Record<string, unknown>): Promise<string>;
}
interface PrettierWrapper {
  format(code: string): Promise<string>;
}

let prettierPromise: Promise<PrettierWrapper> | null = null;
async function getPrettier(): Promise<PrettierWrapper> {
  if (!prettierPromise) {
    prettierPromise = (async (): Promise<PrettierWrapper> => {
      const [std, ts, estree] = await Promise.all([
        import("prettier/standalone") as Promise<PrettierStandalone>,
        import("prettier/plugins/typescript"),
        import("prettier/plugins/estree"),
      ]);
      return {
        format: (code: string): Promise<string> =>
          std.format(code, {
            parser: "typescript",
            plugins: [(ts as { default: unknown }).default, (estree as { default: unknown }).default],
            printWidth: 80,
            tabWidth: 2,
            useTabs: false,
            semi: true,
            singleQuote: false,
            trailingComma: "all",
          }),
      };
    })();
  }
  return prettierPromise;
}

async function formatBuffer(): Promise<void> {
  setStatus("formatting…", "running");
  try {
    const prettier = await getPrettier();
    const oldCode = editor.state.doc.toString();
    const newCode = await prettier.format(oldCode);
    if (newCode === oldCode) {
      setStatus("already formatted", "ok");
      return;
    }
    editor.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: newCode },
    });
    setStatus("formatted", "ok");
  } catch (e) {
    const msg = e instanceof Error ? e.message.split("\n")[0] : String(e);
    setStatus("format failed: " + msg, "error");
  }
}

(function setupSplitter() {
  const splitter = document.getElementById("splitter");
  const mainEl = document.querySelector("main");
  if (!splitter || !mainEl) return;
  let dragging = false;
  splitter.addEventListener("mousedown", (e) => {
    dragging = true;
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = mainEl.getBoundingClientRect();
    const rightWidth = Math.max(
      200,
      Math.min(rect.width - 200, rect.right - e.clientX),
    );
    (mainEl as HTMLElement).style.gridTemplateColumns = `1fr 4px ${rightWidth}px`;
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    document.body.style.cursor = "";
  });
})();
