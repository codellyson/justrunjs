// runjs-rs frontend.
//
// CodeMirror 6 editor on the left, results pane on the right. Each result row
// is positioned at the same y-offset as its source line in the editor, and the
// two panes scroll in lockstep.

import { EditorState, Compartment } from "https://esm.sh/@codemirror/state@6";
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

// ---------- persisted settings ----------
const SHOW_LINE_NUMBERS_KEY = "runjs.showLineNumbers";
let showLineNumbers =
  localStorage.getItem(SHOW_LINE_NUMBERS_KEY) !== "false"; // default on

// CodeMirror compartment lets us swap the line-numbers extensions at runtime
// when the user toggles the setting — no full editor rebuild needed.
const lineNumbersCompartment = new Compartment();
function lineNumbersExtensions(show) {
  return show ? [lineNumbers(), highlightActiveLineGutter()] : [];
}

// Language extension lives in its own compartment so switching tabs (TS<->JS)
// reconfigures Lezer in place instead of rebuilding the whole editor.
const languageCompartment = new Compartment();
function languageExt(lang) {
  return javascript({ typescript: lang === "typescript" });
}

// ---------- tabs ----------
const TABS_KEY = "runjs.tabs";
let tabs = [];
let activeId = null;

function loadTabs() {
  const raw = localStorage.getItem(TABS_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
        tabs = parsed.tabs;
        activeId = parsed.activeId || tabs[0].id;
      }
    } catch {}
  }
  if (tabs.length === 0) {
    tabs = [
      {
        id: "t-1",
        name: "untitled.ts",
        content: STARTER,
        language: "typescript",
      },
    ];
    activeId = "t-1";
  }
}
loadTabs();

function getActiveTab() {
  return tabs.find((t) => t.id === activeId) || tabs[0];
}

function persistTabs() {
  const active = getActiveTab();
  if (active) active.content = editor.state.doc.toString();
  localStorage.setItem(TABS_KEY, JSON.stringify({ tabs, activeId }));
}

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

// RunJS-ish palette: pink keywords, cyan identifiers, green strings, purple
// numerics — Dracula-leaning to match RunJS's pastel feel against #1e1e1e.
const codeHighlight = HighlightStyle.define([
  { tag: tags.keyword, color: "#ff79c6" },
  { tag: tags.controlKeyword, color: "#ff79c6" },
  { tag: tags.moduleKeyword, color: "#ff79c6" },
  { tag: tags.definitionKeyword, color: "#ff79c6" },
  { tag: [tags.string, tags.special(tags.string)], color: "#50fa7b" },
  { tag: tags.number, color: "#bd93f9" },
  { tag: tags.bool, color: "#bd93f9" },
  { tag: tags.null, color: "#bd93f9" },
  { tag: tags.atom, color: "#bd93f9" },
  { tag: tags.variableName, color: "#8be9fd" },
  { tag: tags.propertyName, color: "#8be9fd" },
  { tag: tags.function(tags.variableName), color: "#50fa7b" },
  { tag: tags.function(tags.propertyName), color: "#ff79c6" },
  { tag: tags.typeName, color: "#8be9fd" },
  { tag: tags.className, color: "#8be9fd" },
  { tag: tags.comment, color: "#6272a4", fontStyle: "italic" },
  { tag: tags.lineComment, color: "#6272a4", fontStyle: "italic" },
  { tag: tags.blockComment, color: "#6272a4", fontStyle: "italic" },
  { tag: tags.operator, color: "#ff79c6" },
  { tag: tags.punctuation, color: "#f8f8f2" },
  { tag: tags.bracket, color: "#f8f8f2" },
  { tag: tags.regexp, color: "#ffb86c" },
  { tag: tags.escape, color: "#f1fa8c" },
]);

// ---------- editor instance ----------
const _bootTab = getActiveTab();
const editor = new EditorView({
  parent: document.getElementById("editor-host"),
  state: EditorState.create({
    doc: _bootTab.content,
    extensions: [
      lineNumbersCompartment.of(lineNumbersExtensions(showLineNumbers)),
      highlightActiveLine(),
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
        {
          key: "Mod-Shift-f",
          run: () => {
            formatBuffer();
            return true;
          },
        },
      ]),
      languageCompartment.of(languageExt(_bootTab.language)),
      syntaxHighlighting(codeHighlight),
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

// Pull a source line out of the Rust error string. Runtime errors carry a
// V8 stack frame like `at file:///cwd/runjs_input.js:7:3` — grab the 7.
const ERR_LINE_RE = /runjs_input\.js:(\d+):/;

function paintResults() {
  resultsInner.innerHTML = "";
  const totalLines = editor.state.doc.lines;

  if (lastError) {
    const m = lastError.match(ERR_LINE_RE);
    const errLine = m ? parseInt(m[1], 10) : 0;
    const slot = errLine > 0 ? errLine : 1;

    const row = document.createElement("div");
    row.className = "result-row error";
    row.style.top = (slot - 1) * LINE_HEIGHT + "px";
    const lineno = document.createElement("span");
    lineno.className = "lineno";
    lineno.textContent = errLine > 0 ? String(errLine) : "!";
    const value = document.createElement("span");
    value.className = "value";
    value.textContent = "error: " + lastError.split("\n")[0];
    row.appendChild(lineno);
    row.appendChild(value);
    resultsInner.appendChild(row);
    resultsInner.style.height =
      Math.max(totalLines, slot) * LINE_HEIGHT + 200 + "px";
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
// Generation counter: Stop bumps this so any in-flight result is discarded
// instead of repainting after the user cancelled.
let evalGen = 0;

async function runEval() {
  if (inFlight) {
    pending = true;
    return;
  }
  const myGen = ++evalGen;
  inFlight = true;
  const source = editor.state.doc.toString();
  setStatus("running…", "running");
  const t0 = performance.now();
  try {
    const results = await invoke("evaluate_source", { source });
    if (myGen !== evalGen) return; // Stop cancelled this eval mid-flight.
    const ms = Math.round(performance.now() - t0);
    lastError = null;
    lastResults = results;
    paintResults();
    setStatus(
      `${results.length} result${results.length === 1 ? "" : "s"} · ${ms}ms`,
      "ok",
    );
  } catch (e) {
    if (myGen !== evalGen) return;
    const msg = typeof e === "string" ? e : (e && e.message) || String(e);
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

function stopEval() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  evalGen++; // poison any in-flight or queued result
  pending = false;
  // Reach across to V8 and actually terminate execution — without this, an
  // infinite loop keeps the worker thread pinned even after the user clicks
  // Stop, and every subsequent keystroke queues another doomed eval behind it.
  invoke("stop_eval").catch(() => {});
  setStatus("stopped", "ready");
}

function schedule() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(runEval, 300);
}

// ---------- formatter ----------
// Prettier (and its TS/estree plugins) are pulled in only on the first format
// to keep cold-start cheap. Bound to Cmd/Ctrl+Shift+F in the editor keymap.
let prettierPromise = null;
function getPrettier() {
  if (!prettierPromise) {
    prettierPromise = Promise.all([
      import("https://esm.sh/prettier@3/standalone"),
      import("https://esm.sh/prettier@3/plugins/typescript"),
      import("https://esm.sh/prettier@3/plugins/estree"),
    ]).then(([std, ts, estree]) => ({
      format: (code) =>
        std.format(code, {
          parser: "typescript",
          plugins: [ts.default, estree.default],
          printWidth: 80,
          tabWidth: 2,
          useTabs: false,
          semi: true,
          singleQuote: false,
          trailingComma: "all",
        }),
    }));
  }
  return prettierPromise;
}

async function formatBuffer() {
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
    const msg = e && e.message ? e.message.split("\n")[0] : String(e);
    setStatus("format failed: " + msg, "error");
  }
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

// Stop: cancel pending and in-flight evals.
document.getElementById("btn-stop").addEventListener("click", stopEval);

// ---------- fullscreen toggle ----------
const mainEl = document.querySelector("main");
document.getElementById("btn-expand").addEventListener("click", () => {
  mainEl.classList.toggle("results-full");
});

// ---------- settings popover ----------
const settingsBtn = document.getElementById("btn-settings");
const popover = document.getElementById("settings-popover");
const lineNumbersToggle = document.getElementById("opt-line-numbers");

lineNumbersToggle.checked = showLineNumbers;

settingsBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  popover.classList.toggle("hidden");
});

document.addEventListener("click", (e) => {
  if (popover.classList.contains("hidden")) return;
  if (popover.contains(e.target) || settingsBtn.contains(e.target)) return;
  popover.classList.add("hidden");
});

lineNumbersToggle.addEventListener("change", () => {
  showLineNumbers = lineNumbersToggle.checked;
  localStorage.setItem(SHOW_LINE_NUMBERS_KEY, String(showLineNumbers));
  editor.dispatch({
    effects: lineNumbersCompartment.reconfigure(
      lineNumbersExtensions(showLineNumbers),
    ),
  });
});

// ---------- tab bar ----------
const tabsEl = document.getElementById("tabs");

function activateTab(id) {
  if (id === activeId) return;
  const out = getActiveTab();
  if (out) out.content = editor.state.doc.toString();
  activeId = id;
  const incoming = getActiveTab();
  editor.dispatch({
    changes: { from: 0, to: editor.state.doc.length, insert: incoming.content },
    effects: languageCompartment.reconfigure(languageExt(incoming.language)),
  });
  renderTabs();
  persistTabs();
  schedule();
}

function nextUntitled(lang) {
  const ext = lang === "typescript" ? "ts" : "js";
  for (let n = 1; ; n++) {
    const name = n === 1 ? `untitled.${ext}` : `untitled${n}.${ext}`;
    if (!tabs.some((t) => t.name === name)) return name;
  }
}

// Pre-seed content for a fresh +npm tab — gives the user a working example
// they can immediately tweak. Uses lodash because it's tiny on esm.sh and
// makes for an obvious before/after when chunking an array.
const NPM_TEMPLATE = `// Any npm package, served as ESM via esm.sh.
import _ from "npm:lodash@4";

_.chunk([1, 2, 3, 4, 5], 2);
`;

function newTab(lang = "typescript", content = "") {
  const id = "t-" + Date.now();
  tabs.push({ id, name: nextUntitled(lang), content, language: lang });
  activateTab(id);
}

function closeTab(id) {
  if (tabs.length <= 1) return; // always keep one tab open
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  tabs.splice(idx, 1);
  if (activeId === id) {
    activeId = tabs[Math.max(0, idx - 1)].id;
    const incoming = getActiveTab();
    editor.dispatch({
      changes: {
        from: 0,
        to: editor.state.doc.length,
        insert: incoming.content,
      },
      effects: languageCompartment.reconfigure(languageExt(incoming.language)),
    });
    schedule();
  }
  renderTabs();
  persistTabs();
}

function toggleTabLang(id) {
  const t = tabs.find((tab) => tab.id === id);
  if (!t) return;
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

function renderTabs() {
  tabsEl.innerHTML = "";
  for (const t of tabs) {
    const el = document.createElement("div");
    el.className = "tab" + (t.id === activeId ? " active" : "");
    el.dataset.id = t.id;
    el.setAttribute("role", "tab");

    const lang = document.createElement("button");
    lang.className = "tab-lang";
    lang.textContent = t.language === "typescript" ? "TS" : "JS";
    lang.title = "Toggle language";
    lang.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTabLang(t.id);
    });

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
}

renderTabs();

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
