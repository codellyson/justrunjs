import ts from "typescript";
import {
  createDefaultMapFromCDN,
  createSystem,
  createVirtualTypeScriptEnvironment,
  type VirtualTypeScriptEnvironment,
} from "@typescript/vfs";
import { autocompletion } from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import {
  tsFacet,
  tsSync,
  tsLinter,
  tsAutocomplete,
  tsHover,
} from "@valtown/codemirror-ts";

export const TS_PATH = "/runjs.ts";

const STARTER_DOC = "// placeholder — replaced by the editor's actual content.\n";

// Do NOT set `lib` in the compiler options. @typescript/vfs doesn't implement
// the same lib-name → file resolution that `tsc` does, so a `lib: ["es2022"]`
// entry trips TS6231. The default lib files dropped in by
// createDefaultMapFromCDN cover the target automatically.
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

export interface TsEnvResult {
  env: VirtualTypeScriptEnvironment;
  extensions: Extension[];
}

export async function createTsEnv(): Promise<TsEnvResult> {
  // Disable localStorage caching. The cached path swallows QuotaExceeded
  // errors and the full lib bundle (~5-8MB) blows past browser quota.
  const fsMap = await createDefaultMapFromCDN(
    { target: COMPILER_OPTS.target },
    ts.version,
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

  const extensions: Extension[] = [
    tsFacet.of({ env, path: TS_PATH }),
    tsSync(),
    tsLinter(),
    autocompletion({ override: [tsAutocomplete()] }),
    tsHover(),
  ];

  return { env, extensions };
}
