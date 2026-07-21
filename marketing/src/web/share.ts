// Share-by-URL: pack a single bin into the location hash so it can be pasted
// anywhere (a mentor, a chat, a bookmark) and reopened with no backend.
//
// Encoding is deliberately simple and dependency-free: JSON -> UTF-8 ->
// base64url. Snippets are small, so URL length isn't a concern at this stage;
// a compression pass (CompressionStream) can slot in later behind the same API.
//
// The payload is versioned and discriminated by kind so scratchpad and
// playground bins share one link format. Links minted before playground support
// had no `k`/`v` and are decoded as scratchpads.

export type ShareLanguage = "typescript" | "javascript";

export interface SharedScratchpad {
  kind: "scratchpad";
  name: string;
  language: ShareLanguage;
  code: string;
}

export interface SharedPlayground {
  kind: "playground";
  name: string;
  html: string;
  css: string;
  js: string;
  jsLanguage: ShareLanguage;
}

export type SharedBin = SharedScratchpad | SharedPlayground;

const HASH_KEY = "bin";
const VERSION = 1;

// --- base64url over UTF-8 (btoa only handles latin1, so round-trip bytes) ---

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function lang(v: unknown): ShareLanguage {
  return v === "javascript" ? "javascript" : "typescript";
}

/** Build a shareable absolute URL for the given bin. */
export function encodeShareUrl(bin: SharedBin): string {
  const payload =
    bin.kind === "playground"
      ? {
          v: VERSION,
          k: "playground",
          n: bin.name,
          h: bin.html,
          s: bin.css,
          j: bin.js,
          jl: bin.jsLanguage,
        }
      : { v: VERSION, k: "scratchpad", n: bin.name, l: bin.language, c: bin.code };
  const base = location.origin + location.pathname;
  return `${base}#${HASH_KEY}=${toBase64Url(JSON.stringify(payload))}`;
}

/**
 * Read a shared bin from the current location hash, if present.
 * Returns null when there's no share payload or it can't be decoded.
 */
export function decodeSharedBin(): SharedBin | null {
  const hash = location.hash.replace(/^#/, "");
  if (!hash) return null;
  const payload = new URLSearchParams(hash).get(HASH_KEY);
  if (!payload) return null;
  try {
    const raw = JSON.parse(fromBase64Url(payload)) as Record<string, unknown>;

    if (raw.k === "playground") {
      return {
        kind: "playground",
        name: typeof raw.n === "string" && raw.n ? raw.n : "playground.html",
        html: typeof raw.h === "string" ? raw.h : "",
        css: typeof raw.s === "string" ? raw.s : "",
        js: typeof raw.j === "string" ? raw.j : "",
        jsLanguage: lang(raw.jl),
      };
    }

    // Default / legacy: scratchpad (links shared before versioning had no k).
    if (typeof raw.c !== "string") return null;
    const language = lang(raw.l);
    return {
      kind: "scratchpad",
      name:
        typeof raw.n === "string" && raw.n
          ? raw.n
          : language === "typescript"
            ? "shared.ts"
            : "shared.js",
      language,
      code: raw.c,
    };
  } catch {
    return null;
  }
}

/** Remove the share payload from the URL without reloading (post-import tidy-up). */
export function clearShareHash(): void {
  if (location.hash.includes(`${HASH_KEY}=`)) {
    history.replaceState(null, "", location.origin + location.pathname);
  }
}
