// inspector.js — runs as a classic script in the global scope before the user
// module is evaluated. It installs two globals:
//
//   globalThis.__capture(line, value)  -> records (line, inspect(value)) via an
//                                         op, then RETURNS value unchanged so it
//                                         is transparent to user semantics.
//   globalThis.__inspect(value)        -> a Node `util.inspect`-style formatter.
//
// The formatter is the whole point of the POC: it must render Maps, Sets, class
// instances, BigInt, symbols and circular references the way a developer expects
// — NOT the way JSON.stringify mangles them (Map -> "{}").

(function () {
  const MAX_DEPTH = 4;

  function quoteString(s) {
    // Single-quote like Node, escaping the quote and backslashes/newlines.
    return "'" + s.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\n/g, "\\n") + "'";
  }

  // A bare identifier key can be printed unquoted: `{ name: 1 }`.
  function isPlainKey(k) {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);
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
      const kind = /^class[\s{]/.test(Function.prototype.toString.call(value)) ? "class" : "Function";
      return name ? `[${kind}: ${name}]` : `[${kind} (anonymous)]`;
    }

    // From here on, value is an object.
    if (seen.has(value)) return "[Circular *1]";
    if (depth > MAX_DEPTH) return Array.isArray(value) ? "[Array]" : "[Object]";

    seen.add(value);
    try {
      // Map -> Map(2) { k => v, ... }
      if (value instanceof Map) {
        if (value.size === 0) return "Map(0) {}";
        const parts = [];
        for (const [k, v] of value) {
          parts.push(`${inspect(k, depth + 1, seen)} => ${inspect(v, depth + 1, seen)}`);
        }
        return `Map(${value.size}) { ${parts.join(", ")} }`;
      }

      // Set -> Set(2) { a, b }
      if (value instanceof Set) {
        if (value.size === 0) return "Set(0) {}";
        const parts = [];
        for (const v of value) parts.push(inspect(v, depth + 1, seen));
        return `Set(${value.size}) { ${parts.join(", ")} }`;
      }

      if (Array.isArray(value)) {
        if (value.length === 0) return "[]";
        const parts = value.map((v) => inspect(v, depth + 1, seen));
        return `[ ${parts.join(", ")} ]`;
      }

      if (value instanceof Date) return value.toISOString();
      if (value instanceof RegExp) return value.toString();
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      if (value instanceof Promise) return "Promise { <pending> }";

      // Plain object or class instance.
      const ctor = value.constructor && value.constructor.name;
      const prefix = ctor && ctor !== "Object" ? ctor + " " : "";

      const keys = Object.keys(value);
      // Include enumerable symbol keys too.
      const symKeys = Object.getOwnPropertySymbols(value).filter(
        (s) => Object.getOwnPropertyDescriptor(value, s).enumerable
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
      return `${prefix}{ ${parts.join(", ")} }`;
    } finally {
      seen.delete(value);
    }
  }

  globalThis.__inspect = function (value) {
    return inspect(value, 0, new Set());
  };

  globalThis.__capture = function (line, value) {
    try {
      Deno.core.ops.op_capture(line, globalThis.__inspect(value));
    } catch (e) {
      Deno.core.ops.op_capture(line, "[uninspectable: " + (e && e.message) + "]");
    }
    return value;
  };
})();
