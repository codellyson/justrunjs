// inspector.js — port of src/inspector.js for the browser, with Node-style
// multi-line pretty-printing for wide objects/arrays so the results pane
// looks like RunJS instead of one extremely-long horizontal line.
//
// Heuristic: render inline (`{ a: 1, b: 2 }`) when the single-line form fits
// within BREAK_LENGTH. Otherwise break across lines, indented two spaces,
// trailing comma on each entry. Matches what `util.inspect` does in Node.

const MAX_DEPTH = 4;
const BREAK_LENGTH = 72;
const INDENT = "  ";

function quoteString(s) {
  return (
    "'" +
    s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n") +
    "'"
  );
}

function isPlainKey(k) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);
}

/** Build an inline string for an object/array; if it's too wide for the
 * current depth's budget, switch to a multi-line form. */
function joinWithBreak(prefix, open, close, parts, depth) {
  if (parts.length === 0) return `${prefix}${open}${close}`;

  const inlineSpacer = open === "[" ? " " : " ";
  const inline = `${prefix}${open}${inlineSpacer}${parts.join(", ")}${inlineSpacer}${close}`;
  // No newlines allowed in the inline form — a nested object that's already
  // multi-line forces the parent to multi-line too.
  if (inline.length <= BREAK_LENGTH && !parts.some((p) => p.includes("\n"))) {
    return inline;
  }

  const inner = INDENT.repeat(depth + 1);
  const outer = INDENT.repeat(depth);
  // indent nested newlines so a multi-line child inside a parent reads right
  const indented = parts.map((p) => p.replace(/\n/g, "\n" + inner));
  return `${prefix}${open}\n${inner}${indented.join(",\n" + inner)},\n${outer}${close}`;
}

function inspect(value, depth, seen) {
  const t = typeof value;

  if (value === null) return "null";
  if (t === "undefined") return "undefined";
  if (t === "string") return quoteString(value);
  if (t === "number") return Object.is(value, -0) ? "-0" : String(value);
  if (t === "boolean") return String(value);
  if (t === "bigint") return String(value) + "n";
  if (t === "symbol") return value.toString();
  if (t === "function") {
    const name = value.name;
    const kind = /^class[\s{]/.test(Function.prototype.toString.call(value))
      ? "class"
      : "Function";
    return name ? `[${kind}: ${name}]` : `[${kind} (anonymous)]`;
  }

  if (seen.has(value)) return "[Circular *1]";
  if (depth > MAX_DEPTH) return Array.isArray(value) ? "[Array]" : "[Object]";

  seen.add(value);
  try {
    if (value instanceof Map) {
      if (value.size === 0) return `Map(0) {}`;
      const parts = [];
      for (const [k, v] of value) {
        parts.push(
          `${inspect(k, depth + 1, seen)} => ${inspect(v, depth + 1, seen)}`,
        );
      }
      return joinWithBreak(`Map(${value.size}) `, "{", "}", parts, depth);
    }

    if (value instanceof Set) {
      if (value.size === 0) return `Set(0) {}`;
      const parts = [];
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

    const ctor = value.constructor && value.constructor.name;
    const prefix = ctor && ctor !== "Object" ? ctor + " " : "";

    const keys = Object.keys(value);
    const symKeys = Object.getOwnPropertySymbols(value).filter(
      (s) => Object.getOwnPropertyDescriptor(value, s).enumerable,
    );
    if (keys.length === 0 && symKeys.length === 0) {
      return prefix ? prefix + "{}" : "{}";
    }

    const parts = [];
    for (const k of keys) {
      const keyStr = isPlainKey(k) ? k : quoteString(k);
      parts.push(`${keyStr}: ${inspect(value[k], depth + 1, seen)}`);
    }
    for (const s of symKeys) {
      parts.push(`[${s.toString()}]: ${inspect(value[s], depth + 1, seen)}`);
    }
    return joinWithBreak(prefix, "{", "}", parts, depth);
  } finally {
    seen.delete(value);
  }
}

export function __inspect(value) {
  return inspect(value, 0, new Set());
}
