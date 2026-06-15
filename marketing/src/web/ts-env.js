// TypeScript IntelliSense environment.
//
// Boots a virtual TypeScript compiler on the main thread (via @typescript/vfs)
// and exposes a Promise that resolves to the env + the extensions CodeMirror
// needs to wire IntelliSense — `tsFacet`, `tsSync`, `tsLinter`, completion
// override, and `tsHover`.
//
// Why main-thread and not a worker: simpler, and the only synchronous step
// is the initial compile, which happens after the editor has already painted.
// If perf becomes an issue we can move to the worker variant later.
//
// The lib files (lib.es2022.d.ts, lib.dom.d.ts, ...) are fetched from
// jsdelivr the first time and cached in localStorage so subsequent boots
// don't re-hit the network.

import ts from "typescript";
import {
  createDefaultMapFromCDN,
  createSystem,
  createVirtualTypeScriptEnvironment,
} from "@typescript/vfs";
import { autocompletion } from "@codemirror/autocomplete";
import {
  tsFacet,
  tsSync,
  tsLinter,
  tsAutocomplete,
  tsHover,
} from "@valtown/codemirror-ts";

// Single virtual file path for the user's active buffer. When tabs switch,
// main.js updates the file content in place; we don't track per-tab virtual
// files for v1 (and won't need to until cross-file imports between tabs is
// a thing).
export const TS_PATH = "/runjs.ts";

const STARTER_DOC = "// placeholder — replaced by the editor's actual content.\n";

// NOTE: do NOT set `lib` in the compiler options. @typescript/vfs doesn't
// implement the same lib-name → file resolution that `tsc` does, so a
// `lib: ["es2022"]` entry trips `TS6231: Could not resolve '/es2022'`.
// Instead we rely on the default lib files that createDefaultMapFromCDN
// drops into the fsMap based on the target — those are picked up
// automatically when no explicit `lib` is set.
const COMPILER_OPTS = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  allowJs: true,
  checkJs: false,
  strict: false,
  noImplicitAny: false,
  skipLibCheck: true,
  isolatedModules: true,
  allowImportingTsExtensions: true,
  noEmit: true,
};

/**
 * Returns a Promise that resolves to:
 *   { env, extensions }
 * where `extensions` is the array of CodeMirror extensions that turn on
 * IntelliSense for the active editor.
 */
export async function createTsEnv() {
  const fsMap = await createDefaultMapFromCDN(
    { target: COMPILER_OPTS.target },
    ts.version,
    // Disable localStorage caching. The cached path swallows QuotaExceeded
    // errors from setItem(), and the full lib bundle (~5-8MB) blows past
    // browser quota — successfully fetched files end up dropped from the
    // fsMap entirely, then TS reports "TS6053: File '/lib.es2022.full.d.ts'
    // not found" even though the fetch worked.
    false,
    ts,
  );
  fsMap.set(TS_PATH, STARTER_DOC);

  const system = createSystem(fsMap);
  const env = createVirtualTypeScriptEnvironment(
    system,
    [TS_PATH],
    ts,
    COMPILER_OPTS,
  );

  const extensions = [
    tsFacet.of({ env, path: TS_PATH }),
    tsSync(),
    tsLinter(),
    // `override` replaces basicSetup's word-based autocomplete with the
    // TS-aware source (member completions, imports, types).
    autocompletion({ override: [tsAutocomplete()] }),
    tsHover(),
  ];

  return { env, extensions };
}
