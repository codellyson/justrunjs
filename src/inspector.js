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

  // Override console.log/info/warn/error/debug so logged values flow into the
  // capture stream too. The original handlers (deno_core's stdout printers) are
  // still called, so logs continue to reach the host process — we just also
  // emit them to the inline results pane.
  if (typeof globalThis.console !== "object" || globalThis.console === null) {
    globalThis.console = {};
  }
  function wrapConsole(method) {
    const orig = globalThis.console[method];
    globalThis.console[method] = function (...args) {
      const formatted = args.map((a) => globalThis.__inspect(a)).join(" ");
      // Extract the caller's source line from the V8 stack — user code lives
      // in runjs_input.js, so we look for that frame.
      let line = 0;
      try {
        const stack = new Error().stack || "";
        const m = stack.match(/runjs_input\.js:(\d+)/);
        if (m) line = parseInt(m[1], 10);
      } catch (_) {}
      try {
        Deno.core.ops.op_capture(line, formatted);
      } catch (_) {}
      if (typeof orig === "function") {
        return orig.apply(globalThis.console, args);
      }
    };
  }
  ["log", "info", "warn", "error", "debug"].forEach(wrapConsole);

  // Minimal timer support. The desktop core is a bare V8 isolate with no Web
  // platform APIs, so setTimeout/clearTimeout are backed by an async Rust op
  // (op_sleep) that really waits, then fires the callback — the eval's event
  // loop drains once the timer resolves. setInterval is deliberately left out:
  // an endless interval would keep the event loop alive forever and hang the
  // scratchpad. (The browser playground has the real thing.)
  (function () {
    const pending = new Set();
    let nextId = 1;

    globalThis.setTimeout = function (cb, ms) {
      const id = nextId++;
      const args = Array.prototype.slice.call(arguments, 2);
      pending.add(id);
      let delay = Number(ms);
      if (!isFinite(delay) || delay < 0) delay = 0;
      Deno.core.ops.op_sleep(delay).then(function () {
        if (!pending.has(id)) return; // cleared before it fired
        pending.delete(id);
        if (typeof cb === "function") cb.apply(null, args);
      });
      return id;
    };

    globalThis.clearTimeout = function (id) {
      pending.delete(id);
    };

    globalThis.setInterval = function () {
      throw new Error(
        "setInterval isn't available in the desktop scratchpad (it would run " +
          "forever). Use setTimeout, or the browser playground.",
      );
    };
    globalThis.clearInterval = function () {};
  })();

  // Minimal fetch. The bare core has no deno_fetch, so this is backed by the
  // reqwest op op_fetch. It buffers the whole response body (no streaming) and
  // exposes just enough of the Response interface for a scratchpad: status,
  // ok, headers.get(), text(), json().
  globalThis.fetch = function (input, init) {
    init = init || {};
    const url =
      typeof input === "string" ? input : (input && input.url) || String(input);
    const method = init.method || "GET";
    const headers = [];
    if (init.headers) {
      if (Array.isArray(init.headers)) {
        for (let i = 0; i < init.headers.length; i++) headers.push(init.headers[i]);
      } else if (typeof init.headers.forEach === "function") {
        init.headers.forEach(function (v, k) {
          headers.push([k, String(v)]);
        });
      } else {
        for (const k in init.headers) headers.push([k, String(init.headers[k])]);
      }
    }
    const body = init.body != null ? String(init.body) : "";
    return Deno.core.ops
      .op_fetch(String(url), String(method), headers, body)
      .then(function (resp) {
        const hmap = {};
        resp.headers.forEach(function (pair) {
          hmap[String(pair[0]).toLowerCase()] = pair[1];
        });
        return {
          status: resp.status,
          statusText: resp.status_text,
          ok: resp.ok,
          url: String(url),
          headers: {
            get: function (name) {
              return hmap[String(name).toLowerCase()] || null;
            },
          },
          text: function () {
            return Promise.resolve(resp.body);
          },
          json: function () {
            return Promise.resolve(JSON.parse(resp.body));
          },
        };
      });
  };
})();
