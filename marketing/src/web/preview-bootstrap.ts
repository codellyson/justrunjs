// The console + error bridge injected into the playground preview iframe.
//
// The iframe is a sandboxed opaque origin (no allow-same-origin), so it can't
// touch the parent directly — it talks back over postMessage. This module
// produces the JS string for that bridge; it's inlined into <script type="module">
// right after a transpiled copy of the inspector (so `__inspect` is in scope and
// console output matches the scratchpad's fidelity).

/** Discriminator the parent uses to tell our messages from any other postMessage. */
export const PREVIEW_SOURCE = "justrunjs-preview";

export type PreviewLevel = "log" | "info" | "warn" | "error" | "debug";

export interface PreviewMessage {
  source: typeof PREVIEW_SOURCE;
  /** Matches the render that produced this frame; stale frames are ignored. */
  nonce: string;
  type: "console" | "error";
  level: PreviewLevel | "error";
  parts: string[];
}

/**
 * Build the bridge JS for one render. `nonce` stamps every message so the parent
 * can drop output from a previous srcdoc that's still unloading.
 */
export function buildBridge(nonce: string): string {
  return `
const __N = ${JSON.stringify(nonce)};
function __post(type, level, parts) {
  try {
    parent.postMessage(
      { source: ${JSON.stringify(PREVIEW_SOURCE)}, nonce: __N, type, level, parts },
      "*",
    );
  } catch (_) {}
}
for (const __m of ["log", "info", "warn", "error", "debug"]) {
  const __orig = console[__m] ? console[__m].bind(console) : function () {};
  console[__m] = function (...args) {
    __post("console", __m, args.map((a) => {
      try { return typeof a === "string" ? a : __inspect(a); }
      catch (_) { return String(a); }
    }));
    __orig(...args);
  };
}
addEventListener("error", function (e) {
  const where = e.filename && (e.lineno || e.colno)
    ? " (" + (e.lineno || 0) + ":" + (e.colno || 0) + ")"
    : "";
  __post("error", "error", [String(e.message || e.error || "Error") + where]);
});
addEventListener("unhandledrejection", function (e) {
  const r = e.reason;
  const msg = (r && r.stack) || (r && r.message) || (function () {
    try { return __inspect(r); } catch (_) { return String(r); }
  })();
  __post("error", "error", ["Uncaught (in promise) " + msg]);
});
`;
}
