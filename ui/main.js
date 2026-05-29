// runjs-rs frontend.
//
// CodeMirror 6 editor on the left, results pane on the right. Each result row
// is positioned at the same y-offset as its source line in the editor, and the
// two panes scroll in lockstep.

import { EditorState } from "https://esm.sh/@codemirror/state@6";
import {
  EditorView,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  drawSelection,
  dropCursor,
} from "https://esm.sh/@codemirror/view@6";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "https://esm.sh/@codemirror/commands@6";
import { javascript } from "https://esm.sh/@codemirror/lang-javascript@6";
import {
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  indentUnit,
} from "https://esm.sh/@codemirror/language@6";
import {
  closeBrackets,
  closeBracketsKeymap,
} from "https://esm.sh/@codemirror/autocomplete@6";
import { tags } from "https://esm.sh/@lezer/highlight@1";

const { invoke } = window.__TAURI__.core;

const STARTER = `// runjs-rs — type TS/JS here; every top-level value appears on the right.

const greeting: string = "hello";
greeting.toUpperCase();

const m = new Map<string, { name: string }>();
m.set("test1", { name: "Isaac" });
m;

const s = new Set([1, 2, 2, 3]);
s;

const total = await Promise.resolve(40 + 2);
total;
`;

const sidebarStatusEl = document.getElementById("sidebar-status");
const resultsEl = document.getElementById("results");

const resultsInner = document.createElement("div");
resultsInner.id = "results-inner";
resultsEl.appendChild(resultsInner);

const STATES = ["ready", "running", "ok", "error"];
function setStatus(text, state) {
  sidebarStatusEl.title = text;
  for (const s of STATES) sidebarStatusEl.classList.remove(s);
  if (state) sidebarStatusEl.classList.add(state);
}

const LINE_HEIGHT = 21; // keep in sync with .cm-line line-height + CSS .result-row

// ---------- editor theme ----------
const editorTheme = EditorView.theme(
  {
    "&": {
      color: "#d4d4d4",
      backgroundColor: "#1e1e1e",
      height: "100%",
      fontSize: "14px",
    },
    ".cm-content": {
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      padding: "10px 0",
      caretColor: "#aeafad",
    },
    ".cm-line": { lineHeight: "21px", padding: "0 10px" },
    ".cm-gutters": {
      backgroundColor: "#1e1e1e",
      color: "#525252",
      border: "none",
    },
    ".cm-gutterElement": { lineHeight: "21px", padding: "0 8px 0 12px" },
    ".cm-activeLine": { backgroundColor: "rgba(255,255,255,0.03)" },
    ".cm-activeLineGutter": {
      backgroundColor: "transparent",
      color: "#c6c6c6",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
      backgroundColor: "#264f78",
    },
    ".cm-scroller": {
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      overflow: "auto",
    },
    "&.cm-focused": { outline: "none" },
  },
  { dark: true },
);

const codeHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#c586c0" },
  { tag: tags.controlKeyword, color: "#c586c0" },
  { tag: tags.moduleKeyword, color: "#c586c0" },
  { tag: tags.definitionKeyword, color: "#569cd6" },
  { tag: [tags.string, tags.special(tags.string)], color: "#ce9178" },
  { tag: tags.number, color: "#b5cea8" },
  { tag: tags.bool, color: "#569cd6" },
  { tag: tags.null, color: "#569cd6" },
  { tag: tags.atom, color: "#569cd6" },
  { tag: tags.variableName, color: "#9cdcfe" },
  { tag: tags.propertyName, color: "#9cdcfe" },
  { tag: tags.function(tags.variableName), color: "#dcdcaa" },
  { tag: tags.function(tags.propertyName), color: "#dcdcaa" },
  { tag: tags.typeName, color: "#4ec9b0" },
  { tag: tags.className, color: "#4ec9b0" },
  { tag: tags.comment, color: "#6a9955", fontStyle: "italic" },
  { tag: tags.lineComment, color: "#6a9955", fontStyle: "italic" },
  { tag: tags.blockComment, color: "#6a9955", fontStyle: "italic" },
  { tag: tags.operator, color: "#d4d4d4" },
  { tag: tags.punctuation, color: "#d4d4d4" },
  { tag: tags.bracket, color: "#d4d4d4" },
  { tag: tags.regexp, color: "#d16969" },
  { tag: tags.escape, color: "#d7ba7d" },
]);

// ---------- editor instance ----------
const editor = new EditorView({
  parent: document.getElementById("editor"),
  state: EditorState.create({
    doc: STARTER,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      history(),
      drawSelection(),
      dropCursor(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      indentUnit.of("  "),
      EditorState.tabSize.of(2),
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        indentWithTab,
      ]),
      javascript({ typescript: true }),
      syntaxHighlighting(codeHighlight),
      editorTheme,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) schedule();
      }),
    ],
  }),
});

// ---------- value type classifier ----------
// Infer a type class from the inspector-formatted string so the UI can color
// values without the Rust side shipping one. The inspector grammar is stable:
// 'hello' = string, 5 = number, [..] = array, Map(..) {..} = object, etc.
const NUMERIC = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
function classify(s) {
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

// ---------- results painter ----------
let lastResults = [];
let lastError = null;

function paintResults() {
  resultsInner.innerHTML = "";
  const totalLines = editor.state.doc.lines;

  if (lastError) {
    const row = document.createElement("div");
    row.className = "result-row error";
    row.style.top = "0px";
    const lineno = document.createElement("span");
    lineno.className = "lineno";
    lineno.textContent = "!";
    const value = document.createElement("span");
    value.className = "value";
    value.textContent = "error: " + lastError.split("\n")[0];
    row.appendChild(lineno);
    row.appendChild(value);
    resultsInner.appendChild(row);
    resultsInner.style.height = LINE_HEIGHT + "px";
    return;
  }

  const sourceText = editor.state.doc.toString();
  if (lastResults.length === 0 && sourceText.trim().length === 0) {
    const ph = document.createElement("div");
    ph.className = "result-placeholder";
    ph.textContent = "type some TS / JS — each top-level value shows up here";
    resultsInner.appendChild(ph);
    resultsInner.style.height = "auto";
    return;
  }

  // Source-line alignment: each row sits at the same y as its source line.
  // If multiple results share a line (e.g. two console.logs on one line),
  // cascade later ones into the next free slot below.
  const occupied = new Set();
  const sorted = [...lastResults].sort((a, b) => a.line - b.line);
  let maxSlot = 0;
  for (const r of sorted) {
    let slot = Math.max(r.line, 1);
    while (occupied.has(slot)) slot++;
    occupied.add(slot);
    if (slot > maxSlot) maxSlot = slot;

    const row = document.createElement("div");
    row.className = "result-row";
    row.style.top = (slot - 1) * LINE_HEIGHT + "px";

    const lineno = document.createElement("span");
    lineno.className = "lineno";
    lineno.textContent = r.line > 0 ? String(r.line) : "·";

    const value = document.createElement("span");
    value.className = "value v-" + classify(r.display);
    value.textContent = r.display;
    value.title = r.display;

    row.appendChild(lineno);
    row.appendChild(value);
    resultsInner.appendChild(row);
  }

  const tail = 200;
  const minHeight = Math.max(totalLines, maxSlot) * LINE_HEIGHT + tail;
  resultsInner.style.height = minHeight + "px";
}

// ---------- scroll sync ----------
// CM6 owns its own scrollDOM (.cm-scroller). Mirror scrollTop onto #results
// and back, so the line-aligned rows track the editor exactly.
const editorScroller = editor.scrollDOM;
let syncing = false;
editorScroller.addEventListener("scroll", () => {
  if (syncing) return;
  syncing = true;
  resultsEl.scrollTop = editorScroller.scrollTop;
  syncing = false;
});
resultsEl.addEventListener("scroll", () => {
  if (syncing) return;
  syncing = true;
  if (Math.abs(editorScroller.scrollTop - resultsEl.scrollTop) > 1) {
    editorScroller.scrollTop = resultsEl.scrollTop;
  }
  syncing = false;
});

// ---------- eval pipeline ----------
let timer = null;
let inFlight = false;
let pending = false;

async function runEval() {
  if (inFlight) {
    pending = true;
    return;
  }
  inFlight = true;
  const source = editor.state.doc.toString();
  setStatus("running…", "running");
  const t0 = performance.now();
  try {
    const results = await invoke("evaluate_source", { source });
    const ms = Math.round(performance.now() - t0);
    lastError = null;
    lastResults = results;
    paintResults();
    setStatus(
      `${results.length} result${results.length === 1 ? "" : "s"} · ${ms}ms`,
      "ok",
    );
  } catch (e) {
    const msg = typeof e === "string" ? e : (e && e.message) || String(e);
    lastError = msg;
    lastResults = [];
    paintResults();
    setStatus(msg, "error");
  } finally {
    inFlight = false;
    if (pending) {
      pending = false;
      runEval();
    }
  }
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(runEval, 300);
}

runEval();

// ---------- sidebar wiring ----------
// Run: skip the debounce; eval right now.
document.getElementById("btn-run").addEventListener("click", () => {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  runEval();
});

// ---------- fullscreen toggle ----------
const mainEl = document.querySelector("main");
document.getElementById("btn-expand").addEventListener("click", () => {
  mainEl.classList.toggle("results-full");
});

// ---------- draggable splitter ----------
(function setupSplitter() {
  const splitter = document.getElementById("splitter");
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
    mainEl.style.gridTemplateColumns = `1fr 4px ${rightWidth}px`;
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    document.body.style.cursor = "";
  });
})();
