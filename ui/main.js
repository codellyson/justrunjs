// runjs-rs frontend.
//
// Layout: Monaco editor on the left, a right-hand "results" pane whose rows are
// absolutely positioned at the same pixel y-offset as their source line in the
// editor. Scrolling the editor scrolls the results pane in lockstep.
//
// On every edit (debounced ~300ms), the buffer is sent to the Rust
// `evaluate_source` Tauri command, which returns Vec<LineResult>. Each result
// is drawn as one absolutely-positioned row in the results pane.

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

const statusEl = document.getElementById("status");
const resultsEl = document.getElementById("results");

const resultsInner = document.createElement("div");
resultsInner.id = "results-inner";
resultsEl.appendChild(resultsInner);

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle("error", isError);
}

const editor = monaco.editor.create(document.getElementById("editor"), {
  value: STARTER,
  language: "typescript",
  theme: "vs-dark",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
  fontSize: 14,
  lineHeight: 21,
  lineNumbers: "on",
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  automaticLayout: true,
  renderLineHighlight: "gutter",
  tabSize: 2,
});

// We don't typecheck in-editor; the Rust side does type stripping. Monaco's TS
// service is here only for syntax highlighting.
monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions({
  noSemanticValidation: true,
  noSyntaxValidation: false,
});
monaco.languages.typescript.typescriptDefaults.setCompilerOptions({
  target: monaco.languages.typescript.ScriptTarget.ESNext,
  allowNonTsExtensions: true,
  module: monaco.languages.typescript.ModuleKind.ESNext,
  noEmit: true,
});

const LINE_HEIGHT = 21; // keep in sync with editor.lineHeight + CSS

let lastResults = [];
let lastError = null;

function paintResults() {
  resultsInner.innerHTML = "";
  const model = editor.getModel();
  const totalLines = model.getLineCount();
  resultsInner.style.height = totalLines * LINE_HEIGHT + 200 + "px";

  if (lastError) {
    const row = document.createElement("div");
    row.className = "result-row error";
    row.style.top = "0px";
    row.textContent = "error: " + lastError.split("\n")[0];
    resultsInner.appendChild(row);
    return;
  }

  if (lastResults.length === 0 && model.getValue().trim().length === 0) {
    const ph = document.createElement("div");
    ph.className = "result-placeholder";
    ph.textContent = "type some TS / JS — each top-level value shows up here";
    resultsInner.appendChild(ph);
    return;
  }

  for (const r of lastResults) {
    if (r.line < 1 || r.line > totalLines) continue;
    const row = document.createElement("div");
    row.className = "result-row";
    row.style.top = (r.line - 1) * LINE_HEIGHT + "px";
    row.textContent = r.display;
    row.title = r.display; // hover for the full value if truncated
    resultsInner.appendChild(row);
  }
}

// Keep the results pane's scroll position aligned with the editor's.
editor.onDidScrollChange((e) => {
  resultsEl.scrollTop = e.scrollTop;
});
// And vice-versa, so wheel-on-results scrolls the editor too.
resultsEl.addEventListener("scroll", () => {
  if (Math.abs(editor.getScrollTop() - resultsEl.scrollTop) > 1) {
    editor.setScrollTop(resultsEl.scrollTop);
  }
});

let timer = null;
let inFlight = false;
let pending = false;

async function runEval() {
  if (inFlight) {
    pending = true;
    return;
  }
  inFlight = true;
  const source = editor.getValue();
  setStatus("running…");
  const t0 = performance.now();
  try {
    const results = await invoke("evaluate_source", { source });
    const ms = Math.round(performance.now() - t0);
    lastError = null;
    lastResults = results;
    paintResults();
    setStatus(`${results.length} result${results.length === 1 ? "" : "s"} · ${ms}ms`);
  } catch (e) {
    const msg = typeof e === "string" ? e : (e && e.message) || String(e);
    lastError = msg;
    lastResults = [];
    paintResults();
    setStatus(msg, true);
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

editor.onDidChangeModelContent(schedule);
// Repaint result-row positions when the model changes line count (between
// debounced evals, so result rows stay roughly aligned while typing).
editor.onDidChangeModelContent(() => paintResults());

// Run once on load.
runEval();

// Simple draggable splitter between editor and results pane.
(function setupSplitter() {
  const splitter = document.getElementById("splitter");
  const main = document.querySelector("main");
  let dragging = false;
  splitter.addEventListener("mousedown", (e) => {
    dragging = true;
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const rect = main.getBoundingClientRect();
    const rightWidth = Math.max(200, Math.min(rect.width - 200, rect.right - e.clientX));
    main.style.gridTemplateColumns = `1fr 4px ${rightWidth}px`;
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
    document.body.style.cursor = "";
  });
})();
