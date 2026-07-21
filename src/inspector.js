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

    // setInterval reschedules over op_sleep. Safe now: the host caps every eval
    // at a fixed budget and terminates the isolate, so an uncleared interval
    // can't run forever (the ticks that fired before the cutoff still show).
    globalThis.setInterval = function (cb, ms) {
      const id = nextId++;
      const args = Array.prototype.slice.call(arguments, 2);
      pending.add(id);
      let delay = Number(ms);
      if (!isFinite(delay) || delay < 0) delay = 0;
      function tick() {
        if (!pending.has(id)) return;
        Deno.core.ops.op_sleep(delay).then(function () {
          if (!pending.has(id)) return; // cleared
          if (typeof cb === "function") cb.apply(null, args);
          tick();
        });
      }
      tick();
      return id;
    };
    globalThis.clearInterval = function (id) {
      pending.delete(id);
    };
  })();

  // Web platform shims the bare core lacks (no deno_web): TextEncoder/Decoder,
  // structuredClone, Blob. Pure JS over ECMAScript built-ins.
  (function () {
    function utf8Encode(str) {
      const bytes = [];
      for (let i = 0; i < str.length; i++) {
        let code = str.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
          const next = str.charCodeAt(i + 1);
          if (next >= 0xdc00 && next <= 0xdfff) {
            code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
            i++;
          }
        }
        if (code < 0x80) {
          bytes.push(code);
        } else if (code < 0x800) {
          bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
        } else if (code < 0x10000) {
          bytes.push(
            0xe0 | (code >> 12),
            0x80 | ((code >> 6) & 0x3f),
            0x80 | (code & 0x3f),
          );
        } else {
          bytes.push(
            0xf0 | (code >> 18),
            0x80 | ((code >> 12) & 0x3f),
            0x80 | ((code >> 6) & 0x3f),
            0x80 | (code & 0x3f),
          );
        }
      }
      return new Uint8Array(bytes);
    }

    function toU8(input) {
      if (input instanceof Uint8Array) return input;
      if (input instanceof ArrayBuffer) return new Uint8Array(input);
      if (ArrayBuffer.isView(input)) {
        return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      }
      return new Uint8Array(0);
    }

    function utf8Decode(input) {
      const arr = toU8(input);
      let out = "";
      let i = 0;
      while (i < arr.length) {
        const c = arr[i++];
        if (c < 0x80) {
          out += String.fromCharCode(c);
        } else if (c < 0xe0) {
          out += String.fromCharCode(((c & 0x1f) << 6) | (arr[i++] & 0x3f));
        } else if (c < 0xf0) {
          out += String.fromCharCode(
            ((c & 0x0f) << 12) | ((arr[i++] & 0x3f) << 6) | (arr[i++] & 0x3f),
          );
        } else {
          let cp =
            ((c & 0x07) << 18) |
            ((arr[i++] & 0x3f) << 12) |
            ((arr[i++] & 0x3f) << 6) |
            (arr[i++] & 0x3f);
          cp -= 0x10000;
          out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        }
      }
      return out;
    }

    class TextEncoder {
      get encoding() {
        return "utf-8";
      }
      encode(input) {
        return utf8Encode(input === undefined ? "" : String(input));
      }
      encodeInto(source, dest) {
        const encoded = utf8Encode(String(source));
        const written = Math.min(encoded.length, dest.length);
        dest.set(encoded.subarray(0, written));
        return { read: source.length, written: written };
      }
    }

    // utf-8 only (the common case); label is accepted but ignored.
    class TextDecoder {
      constructor(label) {
        this._label = (label || "utf-8").toLowerCase();
      }
      get encoding() {
        return "utf-8";
      }
      decode(input) {
        return input === undefined ? "" : utf8Decode(input);
      }
    }

    function structuredClone(value) {
      const seen = new Map();
      function clone(val) {
        if (val === null || typeof val !== "object") {
          if (typeof val === "function" || typeof val === "symbol") {
            throw new Error(
              "Failed to execute 'structuredClone': value could not be cloned.",
            );
          }
          return val;
        }
        if (seen.has(val)) return seen.get(val);
        if (val instanceof Date) return new Date(val.getTime());
        if (val instanceof RegExp) return new RegExp(val.source, val.flags);
        if (val instanceof ArrayBuffer) return val.slice(0);
        if (ArrayBuffer.isView(val)) {
          const buf = val.buffer.slice(0);
          if (val instanceof DataView) {
            return new DataView(buf, val.byteOffset, val.byteLength);
          }
          return new val.constructor(buf, val.byteOffset, val.length);
        }
        let out;
        if (val instanceof Map) {
          out = new Map();
          seen.set(val, out);
          val.forEach(function (v, k) {
            out.set(clone(k), clone(v));
          });
          return out;
        }
        if (val instanceof Set) {
          out = new Set();
          seen.set(val, out);
          val.forEach(function (v) {
            out.add(clone(v));
          });
          return out;
        }
        if (Array.isArray(val)) {
          out = new Array(val.length);
          seen.set(val, out);
          for (let i = 0; i < val.length; i++) out[i] = clone(val[i]);
          return out;
        }
        out = {};
        seen.set(val, out);
        for (const k of Object.keys(val)) out[k] = clone(val[k]);
        return out;
      }
      return clone(value);
    }

    class Blob {
      constructor(parts, options) {
        parts = parts || [];
        options = options || {};
        const chunks = [];
        let size = 0;
        for (const part of parts) {
          let bytes;
          if (typeof part === "string") bytes = utf8Encode(part);
          else if (part instanceof Blob) bytes = part._bytes;
          else if (part instanceof ArrayBuffer || ArrayBuffer.isView(part)) {
            bytes = toU8(part);
          } else bytes = utf8Encode(String(part));
          chunks.push(bytes);
          size += bytes.length;
        }
        const all = new Uint8Array(size);
        let off = 0;
        for (const c of chunks) {
          all.set(c, off);
          off += c.length;
        }
        this._bytes = all;
        this.size = size;
        this.type = String(options.type || "").toLowerCase();
      }
      text() {
        return Promise.resolve(utf8Decode(this._bytes));
      }
      arrayBuffer() {
        return Promise.resolve(this._bytes.slice().buffer);
      }
      slice(start, end, contentType) {
        const sub = this._bytes.slice(
          start || 0,
          end === undefined ? this._bytes.length : end,
        );
        const out = new Blob([], { type: contentType || this.type });
        out._bytes = sub;
        out.size = sub.length;
        return out;
      }
    }

    globalThis.TextEncoder = TextEncoder;
    globalThis.TextDecoder = TextDecoder;
    globalThis.structuredClone = structuredClone;
    globalThis.Blob = Blob;
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
