// Share-by-URL: pack a single bin into the location hash so it can be pasted
// anywhere (a mentor, a chat, a bookmark) and reopened with no backend.
//
// Encoding is deliberately simple and dependency-free: JSON -> UTF-8 ->
// base64url. Snippets are small, so URL length isn't a concern at this stage;
// a compression pass (CompressionStream) can slot in later behind the same API.

export type ShareLanguage = "typescript" | "javascript";

export interface SharedBin {
  /** Tab name, e.g. "fibonacci.ts". */
  name: string;
  language: ShareLanguage;
  code: string;
}

const HASH_KEY = "bin";

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

/** Build a shareable absolute URL for the given bin. */
export function encodeShareUrl(bin: SharedBin): string {
  const payload = toBase64Url(
    JSON.stringify({ n: bin.name, l: bin.language, c: bin.code }),
  );
  const base = location.origin + location.pathname;
  return `${base}#${HASH_KEY}=${payload}`;
}

/**
 * Read a shared bin from the current location hash, if present.
 * Returns null when there's no share payload or it can't be decoded.
 */
export function decodeSharedBin(): SharedBin | null {
  const hash = location.hash.replace(/^#/, "");
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const payload = params.get(HASH_KEY);
  if (!payload) return null;
  try {
    const raw = JSON.parse(fromBase64Url(payload)) as {
      n?: unknown;
      l?: unknown;
      c?: unknown;
    };
    if (typeof raw.c !== "string") return null;
    const language: ShareLanguage =
      raw.l === "javascript" ? "javascript" : "typescript";
    const name =
      typeof raw.n === "string" && raw.n
        ? raw.n
        : language === "typescript"
          ? "shared.ts"
          : "shared.js";
    return { name, language, code: raw.c };
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
