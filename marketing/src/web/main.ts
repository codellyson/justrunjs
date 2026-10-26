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
  type SharedBin,
} from "./share.ts";
import { initLessonMode, slotLoadAnnotations } from "./lesson-mode.ts";
import { initAccount } from "./account.ts";
import { wirePopover } from "./popover.ts";

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
  | { id: number; ok: false; error: string; line?: number; results?: LineResult[] };
type WorkerMessage = ReadyMessage | ReplyMessage;

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
  /** Set on the tab playing a recorded lesson; never persisted. */
  lessonSource?: string;
  /** Set on an experiment forked from a recorded lesson. */
  lesson?: { slug: string; originMs: number };
}

const STARTER = `// justrunjs in the browser — every top-level value shows up next to its line.

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

// TS IntelliSense (types, lint) only makes sense on JS/TS slots — never HTML/CSS.
function slotUsesTs(tab: Tab): boolean {
  return tab.kind !== "playground" || panelOf(tab) === "js";
}

/** Push the editor's current text back into the active tab's live slot. */
function flushEditor(): void {
  const active = getActiveTab();
  if (active) writeSlot(active, editor.state.doc.toString());
}

function persistTabs(): void {
  flushEditor();
  const kept = tabs.filter((t) => !t.lessonSource);
  const keptActive = kept.some((t) => t.id === activeId) ? activeId : kept[0]?.id;
  localStorage.setItem(TABS_KEY, JSON.stringify({ tabs: kept, activeId: keptActive }));
  account?.onPersist();
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

// Comments follow the theme: between muted and secondary text, which justui keeps at
// 4.5:1 or better on both backgrounds, so they stay quiet but readable in every theme.
const COMMENT_COLOR = "color-mix(in srgb, rgb(var(--text-muted)) 50%, rgb(var(--text-secondary)))";

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
  { tag: tags.comment, color: COMMENT_COLOR, fontStyle: "italic" },
  { tag: tags.lineComment, color: COMMENT_COLOR, fontStyle: "italic" },
  { tag: tags.blockComment, color: COMMENT_COLOR, fontStyle: "italic" },
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
  { tag: tags.comment, color: COMMENT_COLOR, fontStyle: "italic" },
  { tag: tags.lineComment, color: COMMENT_COLOR, fontStyle: "italic" },
  { tag: tags.blockComment, color: COMMENT_COLOR, fontStyle: "italic" },
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

// The loaded TS IntelliSense extensions, applied to the compartment only while a
// JS/TS slot is active (see slotUsesTs). Empty until ts-env finishes loading.
let tsExtensions: Extension = [];
function tsExtFor(tab: Tab): Extension {
  return slotUsesTs(tab) ? tsExtensions : [];
}

const FONT_SIZE_KEY = "runjs.fontSize";
const TAB_SIZE_KEY = "runjs.tabSize";
const WORD_WRAP_KEY = "runjs.wordWrap";
const AUTO_EVAL_KEY = "runjs.autoEval";
const PLAYGROUND_INLINE_KEY = "runjs.playgroundInline";
const AUTHOR_KEY = "runjs.author";

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

// Language badge colours are fixed across themes, so on some backgrounds they fall under
// WCAG AA. After a theme is applied, work out how far to push them toward black (light
// themes) or white (dark themes) to reach 4.5:1, and hand that to the CSS through
// --lang-ink-share / --lang-ink-target. (Theme text colours meet AA in justui ≥1.0.3.)
const LANG_BADGES = [[71, 137, 209], [224, 179, 40], [149, 123, 246]]; // TS, JS, playground
function ensureReadableBadges(): void {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const rgb = (name: string) => css.getPropertyValue(name).trim().split(/\s+/).map(Number);
  const lum = (c: number[]) => {
    const [r, g, b] = c.map((v) => (v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: number[], b: number[]) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
  const backgrounds = [rgb("--bg"), rgb("--bg-secondary")];
  if (backgrounds.some((c) => c.length !== 3 || c.some(Number.isNaN))) return;
  const extreme = lum(backgrounds[0]) > 0.4 ? [0, 0, 0] : [255, 255, 255];
  // A badge is its language colour on a 16% tint of itself, over either background.
  let t = 1;
  for (let i = 0; i <= 20; i++) {
    const step = i / 20;
    if (LANG_BADGES.every((lang) => backgrounds.every((bg) => ratio(mix(lang, extreme, step), mix(bg, lang, 0.16)) >= 4.5))) {
      t = step;
      break;
    }
  }
  root.style.setProperty("--lang-ink-target", extreme.join(" "));
  root.style.setProperty("--lang-ink-share", `${Math.round((1 - t) * 100)}%`);
}
ensureReadableBadges();

function currentMode(): Mode {
  return document.documentElement.dataset.themeMode === "light"
    ? "light"
    : "dark";
}

// --- inline value decorations (playground JS: RunJS-style `⇒ value` at line end) ---

class InlineValueWidget extends WidgetType {
  constructor(readonly text: string, readonly error = false) {
    super();
  }
  eq(other: InlineValueWidget): boolean {
    return other.text === this.text && other.error === this.error;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-inline-value" + (this.error ? " cm-inline-error" : "");
    const firstLine = this.text.split("\n")[0];
    span.textContent =
      (this.error ? "  ✕ " : "  ⇒ ") + firstLine + (this.text.includes("\n") ? " …" : "");
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

const setInlineValues = StateEffect.define<{ line: number; text: string; error?: boolean }[]>();

const inlineValuesField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setInlineValues)) continue;
      const ranges = [];
      for (const { line, text, error } of e.value) {
        if (line < 1 || line > tr.state.doc.lines) continue;
        const { from, to } = tr.state.doc.line(line);
        if (error) ranges.push(Decoration.line({ class: "cm-error-line" }).range(from));
        ranges.push(
          Decoration.widget({
            widget: new InlineValueWidget(text, error),
            side: 1,
          }).range(to),
        );
      }
      deco = Decoration.set(ranges, true);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

let lessonHooks: ReturnType<typeof initLessonMode> | null = null;
let account: ReturnType<typeof initAccount> | null = null;

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
      Prec.high(keymap.of([
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
      ])),
      languageCompartment.of(slotLanguageExt(_bootTab)),
      inlineValuesField,
      Prec.highest(tsCompartment.of([])),
      Prec.highest(highlightCompartment.of(highlightFor(currentMode()))),
      editorTheme,
      EditorView.updateListener.of((update) => {
        lessonHooks?.onUpdate(update);
        if (update.geometryChanged || update.heightChanged) positionResults();
        if (update.docChanged) {
          lastEditAt = performance.now();
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
let lastErrorLine = 0; // line that threw, from the worker; 0 when unknown
let lastGoodResults: LineResult[] = []; // from the last run that finished, for lines above a syntax error

// A lesson replays the instructor's typing a character at a time, so the code is briefly
// broken mid-keystroke. While it plays, an error only shows if the code is still broken
// SETTLE_MS after the last edit; until then the last good values and preview stay up.
const SETTLE_MS = 1200;
let lastEditAt = 0;
let settleTimer: ReturnType<typeof setTimeout> | undefined;
function holdErrorWhilePlaying(): boolean {
  const since = performance.now() - lastEditAt;
  if (!lessonHooks?.isPlaying() || since >= SETTLE_MS) return false;
  clearTimeout(settleTimer);
  settleTimer = setTimeout(runActive, SETTLE_MS - since + 50);
  return true;
}

// Beside the editor, each value sits at its source line's height and scrolls with it.
// Stacked under the editor (phones) that alignment means nothing, so values list in
// order instead, still labelled with their line number.
const stackedLayout = window.matchMedia("(max-width: 767px)");

function appendRow(line: number, text: string, klass: string | null, full = text): void {
  const row = document.createElement("div");
  row.className = "result-row" + (klass ? " " + klass : "");
  row.dataset.line = String(line);
  const lineEl = document.createElement("span");
  lineEl.className = "seq";
  lineEl.textContent = String(line);
  lineEl.title = `Line ${line}`;
  const value = document.createElement("span");
  value.className = "value";
  value.textContent = text;
  value.title = full;
  row.append(lineEl, value);
  resultsInner.appendChild(row);
}

function paintResults(): void {
  resultsInner.innerHTML = "";
  const stacked = stackedLayout.matches;
  // Aligned rows have one line of room, so long values show their first line; hover has the rest.
  const shown = (d: string) => (stacked || !d.includes("\n") ? d : d.split("\n")[0] + " …");

  const sourceText = editor.state.doc.toString();
  if (!lastError && lastResults.length === 0 && sourceText.trim().length === 0) {
    const ph = document.createElement("div");
    ph.className = "result-placeholder";
    ph.textContent = "Type some TS or JS. Each top-level value shows up next to its line.";
    resultsInner.appendChild(ph);
    positionResults();
    return;
  }

  // Several values from one line share its row.
  const byLine = new Map<number, LineResult[]>();
  for (const r of lastResults) byLine.set(r.line, [...(byLine.get(r.line) ?? []), r]);
  for (const [line, rs] of [...byLine].sort((x, y) => x[0] - y[0])) {
    appendRow(
      line,
      rs.map((r) => shown(r.display)).join("  ·  "),
      "v-" + classify(rs[rs.length - 1].display),
      rs.map((r) => r.display).join("\n\n"),
    );
  }

  const err = scratchError();
  if (err) appendRow(err.line, "error: " + err.message, "error", lastError ?? "");
  positionResults();
  applyInlineValues();
}

// Plain-language versions of the errors beginners hit most; the original stays on hover.
const PLAIN_ERRORS: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^Unterminated string constant/, () => "A string is missing its closing quote"],
  [/^Unterminated template/, () => "A template string is missing its closing backtick (`)"],
  [/^Unexpected token, expected "(.+)"/, (m) => `This line isn't finished: expected "${m[1]}" here (maybe a comma or a closing bracket)`],
  [/^Unexpected token/, () => "This line isn't finished or has a typo"],
  [/^Missing semicolon/, () => "Two statements run together: add a ; or a line break"],
  [/^(\S+) is not defined/, (m) => `${m[1]} isn't defined (check the spelling, or define it first)`],
  [/^Cannot read propert(?:y|ies) of (undefined|null) \(reading '(.+)'\)/, (m) => `Can't read .${m[2]} of ${m[1]}`],
  [/^(\S+) is not a function/, (m) => `${m[1]} isn't a function, so it can't be called`],
];

/** The current scratchpad error, placed on a line, or null. */
function scratchError(): { line: number; message: string } | null {
  if (!lastError) return null;
  // Syntax errors carry Babel's "(line:col)"; runtime errors carry the line that threw.
  const at = lastError.match(/\((\d+):\d+\)/);
  const line = at ? Number(at[1]) : lastErrorLine;
  // The line is shown separately; drop Babel's internal file name and keep the column.
  const raw = lastError.split("\n")[0].replace(/^\/?user\.\w+:\s*/, "");
  const column = raw.match(/\(\d+:(\d+)\)/)?.[1];
  const bare = raw.replace(/\s*\(\d+:\d+\)/, "");
  const plain = PLAIN_ERRORS.find(([re]) => re.test(bare));
  let message = plain ? plain[1](bare.match(plain[0])!) : bare;
  if (column) message += ` (column ${column})`;
  // A runtime error stops everything after it; say so when there's code below.
  if (!at && line && line < editor.state.doc.lines) message += ". Lines after this didn't run";
  if (line) return { line, message };
  // No line at all: say where it can't be earlier than, rather than pretending it's line 1.
  const lastGood = Math.max(0, ...lastResults.map((r) => r.line));
  return { line: lastGood + 1, message: lastGood ? `after line ${lastGood}: ${message}` : message };
}

/** Move each result row to its line's height in the editor (side-by-side layout only). */
function positionResults(): void {
  const aligned = !stackedLayout.matches && getActiveTab().kind !== "playground";
  resultsEl.classList.toggle("aligned", aligned);
  const rows = resultsInner.querySelectorAll<HTMLElement>(".result-row");
  if (!aligned) {
    resultsInner.style.height = "";
    rows.forEach((row) => (row.style.top = ""));
    return;
  }
  // Read line positions inside CodeMirror's measure cycle, after real line heights are known
  // (outside it, the height map can still hold estimates).
  editor.requestMeasure({
    key: "results-position",
    read(view) {
      const doc = view.state.doc;
      // The code starts below the tab bar while the results pane starts at the top; measure the gap.
      const offset =
        view.documentTop + view.scrollDOM.scrollTop - (resultsInner.getBoundingClientRect().top + resultsEl.scrollTop);
      const tops = [...rows].map((row) => {
        const n = Math.min(Math.max(1, Number(row.dataset.line)), doc.lines);
        return view.lineBlockAt(doc.line(n).from).top + offset;
      });
      // Extra room so the pane, which is taller than the editor, can always scroll as far as it.
      const height = view.contentHeight + Math.max(0, offset) + resultsEl.clientHeight;
      return { tops, height, scroll: view.scrollDOM.scrollTop };
    },
    write({ tops, height, scroll }) {
      rows.forEach((row, i) => (row.style.top = `${tops[i]}px`));
      resultsInner.style.height = `${height}px`;
      resultsEl.scrollTop = scroll;
    },
  });
}

stackedLayout.addEventListener("change", paintResults);
editor.scrollDOM.addEventListener("scroll", () => {
  if (resultsEl.classList.contains("aligned")) resultsEl.scrollTop = editor.scrollDOM.scrollTop;
});
// The aligned pane doesn't scroll on its own; wheel over it scrolls the editor, which it follows.
resultsEl.addEventListener("wheel", (e) => {
  if (!resultsEl.classList.contains("aligned")) return;
  e.preventDefault();
  editor.scrollDOM.scrollTop += e.deltaY;
}, { passive: false });

const transport: Transport = createWorkerTransport();

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
    lastGoodResults = results;
    paintResults();
    setStatus(
      `${results.length} result${results.length === 1 ? "" : "s"} · ${ms}ms`,
      "ok",
    );
  } catch (e) {
    if (myGen !== evalGen) return;
    const msg = e instanceof Error ? e.message : String(e);
    if (holdErrorWhilePlaying()) return;
    const partial = e as { line?: number; results?: LineResult[] };
    lastError = msg;
    lastErrorLine = partial.line ?? 0;
    // Values from the lines before the throw are still true; keep them. A syntax error runs
    // nothing, so lines above it keep their values from the last run that finished.
    const syntaxLine = Number(msg.match(/\((\d+):\d+\)/)?.[1] ?? 0);
    lastResults = syntaxLine ? lastGoodResults.filter((r) => r.line > 0 && r.line < syntaxLine) : (partial.results ?? []);
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
    if (holdErrorWhilePlaying()) return;
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

/**
 * Push values into the editor at the end of their lines. Scratchpads always show them (the
 * results pane keeps the full, multi-line versions); playgrounds follow the setting.
 */
function applyInlineValues(): void {
  const t = getActiveTab();
  let values: { line: number; text: string; error?: boolean }[] = [];
  if (t.kind !== "playground") {
    const byLine = new Map<number, string[]>();
    for (const r of lastResults) if (r.line > 0) byLine.set(r.line, [...(byLine.get(r.line) ?? []), r.display.split("\n")[0]]);
    values = [...byLine].map(([line, texts]) => ({ line, text: texts.join("  ·  ") }));
    const err = scratchError();
    if (err) values.push({ line: err.line, text: err.message, error: true });
  } else if (shouldShowInline()) {
    values = [...lastValues.entries()]
      .filter(([, text]) => text !== "undefined")
      .map(([line, text]) => ({ line, text }));
  }
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
  lessonHooks?.onRun();
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
    tsExtensions = extensions;
    // Apply only if the current slot is JS/TS (not an HTML/CSS playground panel).
    editor.dispatch({
      effects: tsCompartment.reconfigure(tsExtFor(getActiveTab())),
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

if (isEmbedded) {
  const home = document.getElementById("btn-home");
  if (home) home.style.display = "none";
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
    annotations: slotLoadAnnotations,
    effects: [
      languageCompartment.reconfigure(slotLanguageExt(t)),
      tsCompartment.reconfigure(tsExtFor(t)),
    ],
  });
}

/** Toggle the panel bar / preview vs. results pane to match the active tab. */
function syncViewToActiveTab(): void {
  const t = getActiveTab();
  const isPlay = t.kind === "playground";
  panelTabsEl?.classList.toggle("hidden", !isPlay);
  previewPane?.classList.toggle("hidden", !isPlay);
  resultsInner.classList.toggle("hidden", isPlay);
  positionResults();
  renderSaveStatus();
  renderPanelTabs();
  // Values belong to whatever tab last rendered; drop them until this tab re-runs.
  lastValues.clear();
  lastResults = [];
  lastError = null;
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
  lessonHooks?.onTabChange();
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

/** Open a playground bin (from an example or a shared link) as a fresh active tab. */
function openPlaygroundTab(
  name: string,
  parts: { html: string; css: string; js: string; jsLanguage: LanguageId },
): void {
  const id = "t-" + Date.now();
  tabs.push({
    id,
    name: uniqueTabName(name),
    kind: "playground",
    content: "",
    language: "javascript",
    html: parts.html,
    css: parts.css,
    js: parts.js,
    jsLanguage: parts.jsLanguage,
    activePanel: "html",
  });
  activateTab(id);
}

function closeTab(id: string): void {
  if (tabs.length <= 1) return;
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1 || tabs[idx].lessonSource) return;
  void account?.onClose(tabs[idx]);
  tabs.splice(idx, 1);
  if (activeId === id) {
    activeId = tabs[Math.max(0, idx - 1)].id;
    loadActiveIntoEditor();
    syncViewToActiveTab();
    schedule();
  }
  renderTabs();
  persistTabs();
  lessonHooks?.onTabChange();
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
    btn.className =
      "panel-tab lang-" + p + (p === current ? " active" : "");
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
  lessonHooks?.onOpen(p);
  // Same tab/render — show its values when landing on JS, hide otherwise.
  applyInlineValues();
  persistTabs();
}

/** Keyboard on a file tab: arrows/Home/End move focus, Enter/Space opens, Delete closes. */
function onTabKey(e: KeyboardEvent, id: string): void {
  const all = [...(tabsEl?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
  const i = all.indexOf(e.currentTarget as HTMLElement);
  const moveTo = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: all.length - 1 }[e.key];
  if (moveTo !== undefined) {
    e.preventDefault();
    all[(moveTo + all.length) % all.length]?.focus();
  } else if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    activateTab(id);
  } else if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    closeTab(id);
  }
}

function renderTabs(): void {
  if (!tabsEl) return;
  // Re-rendering replaces the tab elements; keep keyboard focus on the strip if it was there.
  const hadFocus = tabsEl.contains(document.activeElement);
  tabsEl.innerHTML = "";
  for (const t of tabs) {
    const selected = t.id === activeId;
    const el = document.createElement("div");
    el.className = "tab" + (selected ? " active" : "");
    el.dataset.id = t.id;
    el.setAttribute("role", "tab");
    el.setAttribute("aria-selected", String(selected));
    el.tabIndex = selected ? 0 : -1;
    el.addEventListener("keydown", (e) => onTabKey(e, t.id));

    const lang = document.createElement("button");
    lang.tabIndex = -1;
    if (t.kind === "playground") {
      lang.className = "tab-lang lang-play";
      lang.textContent = "</>";
      lang.title = "Playground (HTML/CSS/JS)";
      lang.disabled = true;
    } else {
      lang.className =
        "tab-lang " + (t.language === "typescript" ? "lang-ts" : "lang-js");
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

    el.addEventListener("click", () => activateTab(t.id));

    el.appendChild(lang);
    el.appendChild(name);
    // A lesson tab can't be closed, so it gets no close control.
    if (!t.lessonSource) {
      const close = document.createElement("button");
      close.className = "tab-close";
      close.textContent = "×";
      close.tabIndex = -1;
      close.title = "Close (Delete)";
      close.setAttribute("aria-label", `Close ${t.name}`);
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTab(t.id);
      });
      el.appendChild(close);
    }
    tabsEl.appendChild(el);
  }
  if (hadFocus) tabsEl.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();

  // Bring the open tab into view, and fade the strip's edge when more tabs are off-screen.
  tabsEl.querySelector<HTMLElement>(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  markTabOverflow();
}

/** Where the open tab's work is saved, with a Retry when a save to the account failed. */
function renderSaveStatus(): void {
  const el = document.getElementById("save-status");
  if (!el) return;
  const t = getActiveTab();
  const s = t.lessonSource || !account ? null : account.statusFor(t);
  el.replaceChildren();
  el.classList.toggle("hidden", !s);
  el.classList.toggle("failed", !!s?.retry);
  if (!s) return;
  el.title = s.reason ?? "";
  el.append(s.text);
  if (s.retry) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "save-retry";
    retry.textContent = "Retry";
    retry.addEventListener("click", s.retry);
    el.append(retry);
  }
}

function markTabOverflow(): void {
  if (!tabsEl) return;
  const more = tabsEl.scrollWidth - tabsEl.clientWidth - tabsEl.scrollLeft > 1;
  tabsEl.classList.toggle("more-right", more);
}
tabsEl?.addEventListener("scroll", markTabOverflow);
window.addEventListener("resize", markTabOverflow);

const newTabBtn = document.getElementById("btn-new-tab");
const newTabMenu = document.getElementById("new-tab-menu");
if (newTabBtn && newTabMenu) {
  // Anchor under the + button; on phones the sheet rules position it instead.
  newTabBtn.addEventListener("click", () => {
    const r = newTabBtn.getBoundingClientRect();
    const sheet = window.matchMedia("(max-width: 767px)").matches;
    newTabMenu.style.top = sheet ? "" : `${r.bottom + 4}px`;
    newTabMenu.style.left = sheet ? "" : `${Math.max(8, r.right - 260)}px`;
  });
  const menu = wirePopover(newTabBtn, newTabMenu);
  newTabMenu.querySelectorAll<HTMLElement>(".new-tab-option").forEach((opt) =>
    opt.addEventListener("click", () => {
      menu.close(false);
      const kind = opt.dataset.new;
      if (kind === "playground") newPlayground();
      else if (kind === "npm") newTab("typescript", NPM_TEMPLATE);
      else newTab(kind === "javascript" ? "javascript" : "typescript");
      editor.focus();
    }),
  );
}

renderTabs();

account = initAccount({
  tabs: () => tabs,
  addTabs: (list) => {
    tabs.push(...list.map(normalizeTab));
    renderTabs();
    persistTabs();
  },
  persist: persistTabs,
  showToast,
});

account.onChange(renderSaveStatus);
renderSaveStatus();

lessonHooks = initLessonMode({
  account,
  editor,
  tabs: () => tabs,
  activeTab: getActiveTab,
  setActiveId: (id) => {
    activeId = id;
  },
  activateTab,
  switchPanel,
  loadActiveIntoEditor,
  refreshChrome: () => {
    renderTabs();
    syncViewToActiveTab();
  },
  runActive,
  uniqueTabName,
  showToast,
});

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
  const examples = wirePopover(examplesBtn, examplesPopover);

  for (const item of examplesPopover.querySelectorAll<HTMLElement>(
    ".example-item",
  )) {
    item.addEventListener("click", () => {
      const id = item.dataset.exampleId;
      const ex = id ? findExample(id) : undefined;
      if (!ex) return;
      if (ex.kind === "playground") {
        openPlaygroundTab(`${ex.id}.html`, {
          html: ex.html,
          css: ex.css,
          js: ex.js,
          jsLanguage: "javascript",
        });
      } else {
        const ext = ex.language === "typescript" ? "ts" : "js";
        openBinTab(`${ex.id}.${ext}`, ex.language, ex.code);
      }
      examples.close(false);
      editor.focus();
    });
  }
}

// ---------- share by URL ----------

const shareBtn = document.getElementById("btn-share");
if (shareBtn) {
  shareBtn.addEventListener("click", async () => {
    flushEditor();
    const active = getActiveTab();
    const bin: SharedBin =
      active.kind === "playground"
        ? {
            kind: "playground",
            name: active.name,
            html: active.html ?? "",
            css: active.css ?? "",
            js: active.js ?? "",
            jsLanguage: (active.jsLanguage ?? "javascript") as ShareLanguage,
          }
        : {
            kind: "scratchpad",
            name: active.name,
            language: active.language as ShareLanguage,
            code: active.content,
          };
    const url = encodeShareUrl(bin);
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
  if (shared.kind === "playground") {
    openPlaygroundTab(shared.name, {
      html: shared.html,
      css: shared.css,
      js: shared.js,
      jsLanguage: shared.jsLanguage as LanguageId,
    });
  } else {
    openBinTab(shared.name, shared.language as LanguageId, shared.code);
  }
  clearShareHash();
})();

const SHOW_LINE_NUMBERS_KEY = "runjs.showLineNumbers";
let showLineNumbers = readBool(SHOW_LINE_NUMBERS_KEY, true);
document.body.classList.toggle("hide-line-numbers", !showLineNumbers);

const settingsBtn = document.getElementById("btn-settings");
const popover = document.getElementById("settings-popover");

if (settingsBtn && popover) {
  wirePopover(settingsBtn, popover);

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
    ensureReadableBadges();
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

  // Recording is for the lesson author; students don't see the button unless they opt in.
  const authorToggle = document.getElementById("opt-author") as HTMLInputElement | null;
  const showRecord = (on: boolean) => document.getElementById("btn-record")?.classList.toggle("author-only", !on);
  if (authorToggle) {
    authorToggle.checked = readBool(AUTHOR_KEY, false);
    showRecord(authorToggle.checked);
    authorToggle.addEventListener("change", () => {
      localStorage.setItem(AUTHOR_KEY, String(authorToggle.checked));
      showRecord(authorToggle.checked);
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
  // Pointer capture keeps the drag alive while the cursor is over the preview iframe,
  // which would otherwise swallow the move and release events.
  splitter.addEventListener("pointerdown", (e) => {
    splitter.setPointerCapture(e.pointerId);
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  });
  splitter.addEventListener("pointermove", (e) => {
    if (!splitter.hasPointerCapture(e.pointerId)) return;
    const rect = mainEl.getBoundingClientRect();
    const rightWidth = Math.max(
      200,
      Math.min(rect.width - 200, rect.right - e.clientX),
    );
    // A variable rather than gridTemplateColumns, so the phone layout's media query still wins.
    (mainEl as HTMLElement).style.setProperty("--results-width", `${rightWidth}px`);
  });
  const endDrag = () => {
    document.body.style.cursor = "";
  };
  splitter.addEventListener("pointerup", endDrag);
  splitter.addEventListener("lostpointercapture", endDrag);
})();
