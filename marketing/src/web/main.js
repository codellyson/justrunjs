// runjs web — main thread.
//
// CodeMirror 6 editor on the left, results pane on the right, both behind a
// thin worker bridge. Source flows to ./worker.js, which transpiles+evals and
// posts {line, display} pairs back. Stop terminates the worker; we always
// spawn a replacement so the next eval doesn't wait.
//
// Intentionally lighter than ui/main.js — no tabs, no formatter, no settings
// popover. We can layer those in once the eval pipeline is proven.

// Bundled by Vite (Astro) via NPM. Vite dedupes every CodeMirror sub-package
// and @lezer/highlight to a single instance — which is the actual fix for the
// "everything is white" failure. esm.sh's URL-based dedup couldn't guarantee
// that lang-javascript's parser tags and our HighlightStyle's tag references
// were the SAME object instance, so the highlighter silently no-op'd.
import { basicSetup } from "codemirror";
import { EditorState, Compartment, Prec } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { javascript } from "@codemirror/lang-javascript";
import {
  syntaxHighlighting,
  HighlightStyle,
  indentUnit,
} from "@codemirror/language";
import { tags } from "@lezer/highlight";

const STARTER = `// justrunjs in the browser — every top-level value shows up on the right.

const greeting: string = "hello";
greeting.toUpperCase();

const m = new Map<string, { name: string }>();
m.set("u1", { name: "Ada" });
m;

const total = await Promise.resolve(40 + 2);
total;
`;

// --- tabs ------------------------------------------------------------------
// Each tab is an independent buffer with its own language. Persisted under
// runjs.tabs as { tabs: [{id, name, content, language}], activeId }.

const TABS_KEY = "runjs.tabs";

// Pre-seed content for a fresh +npm tab — gives the user a working example
// they can immediately tweak.
const NPM_TEMPLATE = `// Any npm package, served as ESM via esm.sh.
import _ from "npm:lodash@4";

_.chunk([1, 2, 3, 4, 5], 2);
`;

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

function languageExt(lang) {
  return javascript({ typescript: lang === "typescript" });
}

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

// --- editor theme ----------------------------------------------------------

// The editor surface reads the same theme tokens as the page chrome (set on
// <html> by theme-boot.js), so picking Gruvbox / Mocha / Solarized flows all
// the way down into the CodeMirror background, gutter, caret, and selection.
//
// `EditorView.theme` ships the rules as a real stylesheet so `var(--bg)` is
// resolved at use-time — the browser picks up the current value of the
// custom property even when it changes after first paint.
const editorTheme = EditorView.theme(
  {
    // Note: we deliberately do NOT set `color` here. EditorView.theme
    // scopes its selectors under the editor's generated class, which
    // outranks the unscoped `.tok-keyword` / `.tok-string` selectors that
    // HighlightStyle ships — so any `color` declared here clobbers the
    // entire syntax palette. Background + size only; text colour falls
    // through from the body's `color: rgb(var(--text-primary))` and is
    // overridden per-token by HighlightStyle.
    "&": {
      backgroundColor: "rgb(var(--bg))",
      height: "100%",
      // Read from a CSS custom property so the settings popover can change
      // the font size without rebuilding the editor's theme.
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
  // `dark` is a hint to CodeMirror's default extensions about selection
  // colors etc. The picked theme might be light, so flip the hint at
  // construction time by reading the data attribute the boot script set.
  {
    dark: (typeof document !== "undefined" &&
      document.documentElement.dataset.themeMode !== "light"),
  },
);

// Two syntax-highlight palettes — one tuned for dark backgrounds (the warm
// punched-up tones), one for light (GitHub-like saturated tones that read
// against white). We swap between them at runtime via a Compartment when the
// user toggles theme mode in the marketing picker.
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

function highlightFor(mode) {
  return syntaxHighlighting(mode === "light" ? lightHighlight : darkHighlight);
}

// --- editor ---------------------------------------------------------------

const highlightCompartment = new Compartment();
const languageCompartment = new Compartment();
const tabSizeCompartment = new Compartment();
const wordWrapCompartment = new Compartment();
// Empty until the async TS environment finishes booting (lib files load
// from the CDN); then reconfigured with tsFacet/tsSync/tsLinter/...
const tsCompartment = new Compartment();

// --- persisted settings (read at boot, written by settings popover) -------
const FONT_SIZE_KEY = "runjs.fontSize";
const TAB_SIZE_KEY = "runjs.tabSize";
const WORD_WRAP_KEY = "runjs.wordWrap";
const AUTO_EVAL_KEY = "runjs.autoEval";

function readInt(key, fallback) {
  const v = parseInt(localStorage.getItem(key) || "", 10);
  return Number.isFinite(v) ? v : fallback;
}
function readBool(key, fallback) {
  const v = localStorage.getItem(key);
  if (v === null) return fallback;
  return v !== "false";
}

let fontSize = readInt(FONT_SIZE_KEY, 14);
let tabSize = readInt(TAB_SIZE_KEY, 2);
let wordWrap = readBool(WORD_WRAP_KEY, true);
let autoEval = readBool(AUTO_EVAL_KEY, true);

// Apply font size before editor mount so first paint is at the right size.
document.documentElement.style.setProperty(
  "--editor-font-size",
  fontSize + "px",
);

function currentMode() {
  return document.documentElement.dataset.themeMode === "light"
    ? "light"
    : "dark";
}

const _bootTab = getActiveTab();
const editor = new EditorView({
  parent: document.getElementById("editor-host"),
  state: EditorState.create({
    doc: _bootTab.content,
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
            runEval();
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
      languageCompartment.of(languageExt(_bootTab.language)),
      // Prec.highest so the TS extensions outrank basicSetup's bundled
      // `autocompletion()` (otherwise its config — no `override` — wins the
      // facet merge and tsAutocomplete never gets called). Same reason for
      // why we wrap the highlight compartment in Prec.highest above.
      Prec.highest(tsCompartment.of([])),
      // Prec.highest forces our palette ahead of the editor theme's scoped
      // colour rules (the theme is .cm-editor.ͼXYZ-scoped, syntax tags are
      // unscoped class selectors at lower default specificity).
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

// --- value type classifier ------------------------------------------------

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

// --- results painter ------------------------------------------------------
//
// Flowing console (RunJS-style): captures stack top-to-bottom in arrival
// order. Each visual line gets a sequential row number. Multi-line values
// (pretty-printed objects/arrays) split across multiple DOM rows so the
// numbering and hover affordances apply per line.

let lastResults = [];
let lastError = null;

function appendRow(seq, text, klass) {
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

function paintResults() {
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
      // Only the first line of a multi-line value carries the type accent
      // class — continuation lines inherit the default colour so the
      // structural braces/commas aren't tinted as if they were the value.
      const v = appendRow(seq++, lines[i], i === 0 ? klass : null);
      if (i === 0) v.title = r.display;
    }
  }
}

// --- eval transport ------------------------------------------------------
// The editor talks to the eval engine through a thin `{ evaluate, stop }`
// interface. Two implementations:
//   - Tauri: routes through #[tauri::command] invoke('evaluate_source') and
//     invoke('stop_eval') — the long-lived V8 worker thread on the Rust side.
//   - Browser: posts to a Web Worker that runs @babel/standalone + dynamic
//     import on a Blob URL.
// The desktop and web surfaces now share one editor; only this transport
// changes.

const tauriCore =
  typeof window !== "undefined" && window.__TAURI__ && window.__TAURI__.core;

const transport = tauriCore
  ? createTauriTransport(tauriCore)
  : createWorkerTransport();

function createTauriTransport(core) {
  return {
    async evaluate(source) {
      const t0 = performance.now();
      const results = await core.invoke("evaluate_source", { source });
      return { results, ms: Math.round(performance.now() - t0) };
    },
    stop() {
      // Fire-and-forget — the V8 worker calls terminate_execution()
      // synchronously from another thread; we don't need to await it.
      core.invoke("stop_eval").catch(() => {});
    },
  };
}

function createWorkerTransport() {
  let worker = null;
  let workerReady = null;
  const pendingReplies = new Map();
  let evalSeq = 0;

  function spawn() {
    let resolveReady, rejectReady;
    workerReady = new Promise((res, rej) => {
      resolveReady = res;
      rejectReady = rej;
    });
    worker = new Worker(new URL("./worker.js", import.meta.url), {
      type: "module",
    });
    worker.onmessage = (e) => {
      const data = e.data || {};
      if (data.type === "ready") {
        resolveReady();
        return;
      }
      const { id, ok, results, error, ms } = data;
      const entry = pendingReplies.get(id);
      if (!entry) return;
      pendingReplies.delete(id);
      if (ok) entry.resolve({ results, ms });
      else entry.reject(new Error(error || "eval failed"));
    };
    worker.onerror = (e) => {
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
    async evaluate(source) {
      await workerReady;
      const id = ++evalSeq;
      return new Promise((resolve, reject) => {
        pendingReplies.set(id, { resolve, reject });
        worker.postMessage({ id, source });
      });
    },
    stop() {
      // The browser equivalent of v8 terminate_execution(): nuke the worker
      // and immediately spawn a replacement so the next keystroke doesn't
      // wait for a cold start.
      if (worker) {
        for (const [, entry] of pendingReplies) entry.reject(new Error("stopped"));
        pendingReplies.clear();
        worker.terminate();
      }
      spawn();
    },
  };
}

// --- eval pipeline -------------------------------------------------------

let timer = null;
let inFlight = false;
let pending = false;
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
  try {
    const { results, ms } = await transport.evaluate(source);
    if (myGen !== evalGen) return; // Stop cancelled this eval mid-flight.
    lastError = null;
    lastResults = results;
    paintResults();
    setStatus(
      `${results.length} result${results.length === 1 ? "" : "s"} · ${ms}ms`,
      "ok",
    );
  } catch (e) {
    if (myGen !== evalGen) return;
    const msg = e && e.message ? e.message : String(e);
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
  evalGen++;
  pending = false;
  inFlight = false;
  transport.stop();
  setStatus("stopped", "ready");
}

function schedule() {
  if (timer) clearTimeout(timer);
  // Auto-evaluate can be turned off in settings — typing still updates the
  // buffer, but the user has to hit Run / Cmd+Enter to evaluate.
  if (!autoEval) return;
  timer = setTimeout(runEval, 300);
}

runEval();

// --- IntelliSense (async boot) -------------------------------------------
// Load TypeScript + lib.*.d.ts files in the background; once the virtual
// environment is ready, swap in the IntelliSense extensions through the
// pre-installed Compartment. The editor stays fully usable during boot —
// the user just doesn't get type info / autocomplete until this resolves.
(async () => {
  setStatus("loading IntelliSense…", "running");
  try {
    const { createTsEnv } = await import("./ts-env.js");
    const { extensions } = await createTsEnv();
    editor.dispatch({
      effects: tsCompartment.reconfigure(extensions),
    });
    setStatus("IntelliSense ready", "ok");
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    setStatus("IntelliSense failed: " + msg, "error");
    // Re-throw so the boot-error overlay shows the full stack — this is the
    // only way we can debug remote failures right now.
    throw e;
  }
})();

// --- sidebar wiring ------------------------------------------------------

document.getElementById("btn-run").addEventListener("click", () => {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  runEval();
});

document.getElementById("btn-stop").addEventListener("click", stopEval);

// --- embed mode ----------------------------------------------------------
// When this page is loaded inside an iframe on the marketing site, we hide
// the home/back button (the parent already provides chrome) and surface a
// fullscreen toggle that posts to the parent. Detection: `?embed=1`, OR a
// parent window that isn't us. Also hide the home button when running under
// Tauri — the desktop shell has no marketing page to navigate back to.
const isEmbedded =
  new URLSearchParams(window.location.search).get("embed") === "1" ||
  window.parent !== window;

if (isEmbedded || tauriCore) {
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
      } catch (_) {}
    });
  }
}

// Parent tells us its current state so we can flip the icon between expand
// and collapse. Posted right after the parent toggles its CSS class.
window.addEventListener("message", (e) => {
  const data = e.data;
  if (!data || typeof data !== "object") return;
  const expand = document.getElementById("btn-expand");
  if (!expand) return;
  if (data.type === "expanded") expand.classList.add("is-expanded");
  else if (data.type === "collapsed") expand.classList.remove("is-expanded");
});

// --- live theme-mode swap ------------------------------------------------
// theme-boot.js writes data-theme-mode on <html> at boot AND on cross-tab
// storage events; the marketing picker writes it on local clicks. Both paths
// trigger this observer, which swaps the highlight palette without a reload.
let lastMode = currentMode();
function syncHighlight() {
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

// --- tab bar -------------------------------------------------------------

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

function newTab(lang = "typescript", content = "") {
  const id = "t-" + Date.now();
  tabs.push({ id, name: nextUntitled(lang), content, language: lang });
  activateTab(id);
}

function closeTab(id) {
  if (tabs.length <= 1) return;
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
  if (!tabsEl) return;
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

// --- settings popover ----------------------------------------------------
// Single panel: Appearance (theme picker + light/dark mode) and Editor
// (font size, tab size, line numbers, word wrap, auto-evaluate). All values
// persist to localStorage under runjs.* keys.

const SHOW_LINE_NUMBERS_KEY = "runjs.showLineNumbers";
let showLineNumbers = readBool(SHOW_LINE_NUMBERS_KEY, true);
document.body.classList.toggle("hide-line-numbers", !showLineNumbers);

const settingsBtn = document.getElementById("btn-settings");
const popover = document.getElementById("settings-popover");

if (settingsBtn && popover) {
  // Open/close
  settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    popover.classList.toggle("hidden");
  });
  document.addEventListener("click", (e) => {
    if (popover.classList.contains("hidden")) return;
    if (popover.contains(e.target) || settingsBtn.contains(e.target)) return;
    popover.classList.add("hidden");
  });

  // --- Appearance: theme picker + mode toggle -----------------------------
  const VAR_MAP = {
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
  function getThemes() { return window.__RUNJS_THEMES__ || {}; }
  function currentThemeId() {
    return document.documentElement.dataset.themeId || "espresso";
  }
  function currentThemeMode() {
    return document.documentElement.dataset.themeMode === "light"
      ? "light"
      : "dark";
  }
  function applyVariant(variant, mode) {
    const root = document.documentElement;
    for (const k in VAR_MAP) {
      if (variant[k]) root.style.setProperty(VAR_MAP[k], variant[k]);
    }
    if (mode === "dark") root.classList.add("dark");
    else root.classList.remove("dark");
  }
  function applyTheme(themeId, mode) {
    const themes = getThemes();
    const theme = themes[themeId];
    if (!theme) return;
    applyVariant(mode === "dark" ? theme.dark : theme.light, mode);
    document.documentElement.dataset.themeId = themeId;
    document.documentElement.dataset.themeMode = mode;
    try {
      localStorage.setItem("runjs.theme.id", themeId);
      localStorage.setItem("runjs.theme.mode", mode);
    } catch {}
    refreshAppearanceUI();
  }
  function refreshAppearanceUI() {
    const id = currentThemeId();
    const mode = currentThemeMode();
    popover.querySelectorAll("[data-mode-label]").forEach((el) => {
      el.classList.toggle("hidden", el.dataset.modeLabel !== mode);
    });
    popover.querySelectorAll(".theme-option").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.themeOption === id);
    });
  }

  const modeToggleBtn = document.getElementById("settings-mode-toggle");
  if (modeToggleBtn) {
    modeToggleBtn.addEventListener("click", () => {
      const next = currentThemeMode() === "dark" ? "light" : "dark";
      applyTheme(currentThemeId(), next);
    });
  }
  popover.querySelectorAll(".theme-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      applyTheme(btn.dataset.themeOption, currentThemeMode());
    });
  });
  refreshAppearanceUI();

  // --- Editor: font size --------------------------------------------------
  const fontSizeInput = document.getElementById("opt-font-size");
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

  // --- Editor: tab size ---------------------------------------------------
  popover.querySelectorAll('input[name="opt-tab-size"]').forEach((radio) => {
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

  // --- Editor: line numbers -----------------------------------------------
  const lineNumbersToggle = document.getElementById("opt-line-numbers");
  if (lineNumbersToggle) {
    lineNumbersToggle.checked = showLineNumbers;
    lineNumbersToggle.addEventListener("change", () => {
      showLineNumbers = lineNumbersToggle.checked;
      localStorage.setItem(SHOW_LINE_NUMBERS_KEY, String(showLineNumbers));
      document.body.classList.toggle("hide-line-numbers", !showLineNumbers);
    });
  }

  // --- Editor: word wrap --------------------------------------------------
  const wordWrapToggle = document.getElementById("opt-word-wrap");
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

  // --- Editor: auto-evaluate ----------------------------------------------
  const autoEvalToggle = document.getElementById("opt-auto-eval");
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
}

// --- formatter (Prettier) -----------------------------------------------
// Lazy-loaded on first use so cold start stays cheap. Bound to Cmd/Ctrl+Shift+F.

let prettierPromise = null;
async function getPrettier() {
  if (!prettierPromise) {
    prettierPromise = (async () => {
      const [std, ts, estree] = await Promise.all([
        import("prettier/standalone"),
        import("prettier/plugins/typescript"),
        import("prettier/plugins/estree"),
      ]);
      return {
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
      };
    })();
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

// --- draggable splitter --------------------------------------------------

(function setupSplitter() {
  const splitter = document.getElementById("splitter");
  const mainEl = document.querySelector("main");
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
