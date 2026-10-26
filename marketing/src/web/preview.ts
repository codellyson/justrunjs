// Renders a playground (HTML, CSS, JS) into a sandboxed iframe and reports back what its
// script logs and, per source line, the values it produces.
import inspectorRaw from "./inspector.ts?raw";
import { PREVIEW_SOURCE, buildBridge, type PreviewMessage } from "./preview-bootstrap.ts";
import type { RunStatus } from "./scratch-runner.ts";

export interface PreviewOptions {
  onStatus(text: string, state: RunStatus): void;
  /** True keeps the current preview up instead of showing this error (a lesson mid-keystroke). */
  holdError?(): boolean;
  /** A new render is about to load: earlier console output and values no longer apply. */
  onReset(): void;
  onValue(line: number, text: string): void;
  onConsole(level: string, text: string): void;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
}

const escapeScriptClose = (code: string): string =>
  code.replace(/<\/script/gi, "<\\/script");

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

export function createPreview(frame: HTMLIFrameElement, opts: PreviewOptions) {
  // Each render gets a fresh nonce; console/error messages tagged with a stale
  // nonce (from a previous srcdoc still unloading) are dropped by the listener.
  let previewNonce = 0;
  let currentPreviewNonce = "";

  window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as PreviewMessage | undefined;
    if (!d || d.source !== PREVIEW_SOURCE) return;
    // Only trust this preview frame, and only its current render.
    if (e.source !== frame.contentWindow) return;
    if (d.nonce !== currentPreviewNonce) return;
    if (d.type === "value") {
      if (typeof d.line === "number") opts.onValue(d.line, (d.parts || [])[0] ?? "");
      return;
    }
    opts.onConsole(d.level, (d.parts || []).join(" "));
  });

  return {
    /**
     * Assemble the page and load it. `instrument` adds per-line values for the JS; `isCurrent`
     * is checked once the slow parts have loaded, so a stale render doesn't replace a newer one.
     */
    async render(
      src: { html?: string; css?: string; js?: string },
      instrument: boolean,
      isCurrent: () => boolean = () => true,
    ): Promise<void> {
      const { html: htmlSrc = "", css: cssSrc = "", js: jsSrc = "" } = src;
      let userBody: string;
      try {
        if (!transpileMod) transpileMod = await import("./transpile.ts");
        const { code } = transpileMod.transpile(jsSrc, { instrument });
        userBody = `<script type="module">\n${escapeScriptClose(code)}\n</script>`;
        opts.onStatus("rendered", "ok");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (opts.holdError?.()) return;
        userBody = `<pre style="margin:16px;color:#b00020;font:13px ui-monospace,monospace;white-space:pre-wrap">${escapeHtml(msg)}</pre>`;
        opts.onStatus(msg, "error");
      }

      const inspector = await getInspectorJs();
      if (!isCurrent()) return;

      const nonce = String(++previewNonce);
      currentPreviewNonce = nonce;
      opts.onReset();

      const bootstrap =
        `<script type="module">\n${escapeScriptClose(inspector)}\n${escapeScriptClose(buildBridge(nonce, instrument))}\n</script>`;

      frame.srcdoc =
        `<!doctype html><html><head><meta charset="utf-8">` +
        `<style>${cssSrc}</style>${bootstrap}</head><body>\n${htmlSrc}\n${userBody}\n</body></html>`;
    },
  };
}
