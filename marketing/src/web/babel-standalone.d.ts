declare module "@babel/standalone" {
  export interface TransformResult {
    code: string;
  }

  export interface TransformOptions {
    filename?: string;
    sourceType?: "module" | "script";
    presets?: unknown[];
    plugins?: unknown[];
    sourceMaps?: boolean;
    retainLines?: boolean;
  }

  export function transform(source: string, opts: TransformOptions): TransformResult;
}
