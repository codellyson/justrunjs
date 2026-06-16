const MAX_DEPTH = 4;
const BREAK_LENGTH = 72;
const INDENT = "  ";

function quoteString(s: string): string {
  return (
    "'" +
    s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n") +
    "'"
  );
}

function isPlainKey(k: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);
}

function joinWithBreak(
  prefix: string,
  open: string,
  close: string,
  parts: string[],
  depth: number,
): string {
  if (parts.length === 0) return `${prefix}${open}${close}`;

  const inlineSpacer = open === "[" ? " " : " ";
  const inline = `${prefix}${open}${inlineSpacer}${parts.join(", ")}${inlineSpacer}${close}`;
  if (inline.length <= BREAK_LENGTH && !parts.some((p) => p.includes("\n"))) {
    return inline;
  }

  const inner = INDENT.repeat(depth + 1);
  const outer = INDENT.repeat(depth);
  const indented = parts.map((p) => p.replace(/\n/g, "\n" + inner));
  return `${prefix}${open}\n${inner}${indented.join(",\n" + inner)},\n${outer}${close}`;
}

function inspect(value: unknown, depth: number, seen: Set<object>): string {
  const t = typeof value;

  if (value === null) return "null";
  if (t === "undefined") return "undefined";
  if (t === "string") return quoteString(value as string);
  if (t === "number") return Object.is(value, -0) ? "-0" : String(value);
  if (t === "boolean") return String(value);
  if (t === "bigint") return String(value) + "n";
  if (t === "symbol") return (value as symbol).toString();
  if (t === "function") {
    const fn = value as Function;
    const name = fn.name;
    const kind = /^class[\s{]/.test(Function.prototype.toString.call(fn))
      ? "class"
      : "Function";
    return name ? `[${kind}: ${name}]` : `[${kind} (anonymous)]`;
  }

  const obj = value as object;
  if (seen.has(obj)) return "[Circular *1]";
  if (depth > MAX_DEPTH) return Array.isArray(value) ? "[Array]" : "[Object]";

  seen.add(obj);
  try {
    if (value instanceof Map) {
      if (value.size === 0) return `Map(0) {}`;
      const parts: string[] = [];
      for (const [k, v] of value) {
        parts.push(
          `${inspect(k, depth + 1, seen)} => ${inspect(v, depth + 1, seen)}`,
        );
      }
      return joinWithBreak(`Map(${value.size}) `, "{", "}", parts, depth);
    }

    if (value instanceof Set) {
      if (value.size === 0) return `Set(0) {}`;
      const parts: string[] = [];
      for (const v of value) parts.push(inspect(v, depth + 1, seen));
      return joinWithBreak(`Set(${value.size}) `, "{", "}", parts, depth);
    }

    if (Array.isArray(value)) {
      if (value.length === 0) return "[]";
      const parts = value.map((v) => inspect(v, depth + 1, seen));
      return joinWithBreak("", "[", "]", parts, depth);
    }

    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return value.toString();
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (value instanceof Promise) return "Promise { <pending> }";

    const ctor = (obj as { constructor?: { name?: string } }).constructor?.name;
    const prefix = ctor && ctor !== "Object" ? ctor + " " : "";

    const record = obj as Record<string, unknown>;
    const keys = Object.keys(record);
    const symKeys = Object.getOwnPropertySymbols(obj).filter(
      (s) => Object.getOwnPropertyDescriptor(obj, s)?.enumerable,
    );
    if (keys.length === 0 && symKeys.length === 0) {
      return prefix ? prefix + "{}" : "{}";
    }

    const parts: string[] = [];
    for (const k of keys) {
      const keyStr = isPlainKey(k) ? k : quoteString(k);
      parts.push(`${keyStr}: ${inspect(record[k], depth + 1, seen)}`);
    }
    for (const s of symKeys) {
      const symRecord = obj as unknown as Record<symbol, unknown>;
      parts.push(`[${s.toString()}]: ${inspect(symRecord[s], depth + 1, seen)}`);
    }
    return joinWithBreak(prefix, "{", "}", parts, depth);
  } finally {
    seen.delete(obj);
  }
}

export function __inspect(value: unknown): string {
  return inspect(value, 0, new Set());
}
