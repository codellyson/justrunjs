// justrunjs API: email sign-in (link or typed code), and per-learner storage for lesson
// copies, scratchpad experiments and lesson progress. Everything else is the static Astro build.
// Sign-in follows Fillie's worker (personal-projects/fillie/app/worker/index.js).

const DAY = 86400_000;
const MAX_TAB = 300_000;

type User = { userId: string; email: string; tokenHash: string };

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
const fail = (status: number, error: string) => json({ error }, status);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
const randomCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000).padStart(6, "0");
async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const cookie = (req: Request, name: string) => req.headers.get("cookie")?.match(new RegExp(`(?:^|; )${name}=([^;]+)`))?.[1];
const sessionCookie = (token: string, url: URL, maxAge: number) =>
  `sid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${url.protocol === "https:" ? "; Secure" : ""}`;

async function authenticate(req: Request, env: Env): Promise<User | null> {
  const token = cookie(req, "sid");
  if (!token) return null;
  const row = await env.DB.prepare(
    "SELECT s.user_id, s.token_hash, u.email FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?",
  ).bind(await sha256(token), Date.now()).first<{ user_id: string; token_hash: string; email: string }>();
  return row && { userId: row.user_id, email: row.email, tokenHash: row.token_hash };
}

async function signIn(env: Env, email: string) {
  await env.DB.prepare("INSERT OR IGNORE INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(crypto.randomUUID(), email, Date.now()).run();
  const { id } = (await env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>())!;
  const token = randomToken();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), id, Date.now() + 30 * DAY).run();
  return { token, maxAge: (30 * DAY) / 1000 };
}

function page(title: string, body: string) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:15px system-ui,sans-serif;background:#161412;color:#e8ded2;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;box-sizing:border-box}
main{max-width:360px;width:100%;border:1px solid #3a332d;border-radius:10px;padding:24px}button{width:100%;padding:10px;border:0;border-radius:6px;background:#e8a25c;color:#161412;font:inherit;font-weight:600;cursor:pointer}a{color:#e8a25c}</style>
</head><body><main>${body}</main></body></html>`,
    { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'" } },
  );
}

async function requestSignIn(req: Request, env: Env, url: URL) {
  const { email: raw, from } = (await req.json().catch(() => ({}))) as { email?: unknown; from?: unknown };
  const email = String(raw ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return fail(400, "Enter a valid email address.");
  // shortcut: this edge limit is per Cloudflare location; use a global limiter if cross-region abuse appears.
  if (!(await env.SIGNIN_RATE_LIMIT.limit({ key: req.headers.get("cf-connecting-ip") || "local" })).success)
    return fail(429, "Too many sign-in requests. Try again shortly.");
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_tokens WHERE email = ? AND created_at > ?").bind(email, Date.now() - 3600_000).first<{ n: number }>();
  if (recent!.n >= 5) return fail(429, "Too many sign-in emails. Try again in an hour.");
  const token = randomToken();
  const code = randomCode();
  await env.DB.prepare("INSERT INTO login_tokens (token_hash, code_hash, email, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256(token), await sha256(code), email, Date.now() + 15 * 60_000, Date.now()).run();
  // The link brings the student back to where they asked from: the course or the scratchpad.
  const link = `${url.origin}/auth/verify?token=${token}${from === "learn" ? "&to=learn" : ""}`;
  try {
    await env.EMAIL.send({
      to: email,
      from: { email: env.MAIL_FROM, name: "justrunjs" },
      subject: `Your justrunjs sign-in code: ${code}`,
      text: `Sign in to justrunjs: ${link}\n\nOr type this code: ${code}\n\nThe link and code work for 15 minutes. If you didn't ask for this, ignore this email.`,
      html: `<p>Sign in to justrunjs:</p><p><a href="${esc(link)}">Sign in</a></p><p>Or type this code: <strong style="font-size:20px;letter-spacing:2px">${code}</strong></p><p>The link and code work for 15 minutes. If you didn't ask for this, ignore this email.</p>`,
    });
  } catch (e) {
    console.error("send_email failed", (e as Error).message);
    return fail(502, "Couldn't send the sign-in email. Try again shortly.");
  }
  return json({ ok: true });
}

type TokenRow = { token_hash: string; code_hash: string; email: string };

async function consumeToken(env: Env, row: TokenRow) {
  const claimed = await env.DB.prepare("UPDATE login_tokens SET used = 1 WHERE token_hash = ? AND used = 0 AND expires_at > ?").bind(row.token_hash, Date.now()).run();
  return claimed.meta.changes ? signIn(env, row.email) : null;
}

async function verifyCode(req: Request, env: Env, url: URL) {
  const { email: raw, code } = (await req.json().catch(() => ({}))) as { email?: unknown; code?: unknown };
  const email = String(raw ?? "").trim().toLowerCase();
  const expired = fail(400, "That code has expired. Ask for a new one.");
  const row = await env.DB.prepare("SELECT * FROM login_tokens WHERE email = ? AND used = 0 AND expires_at > ? ORDER BY created_at DESC LIMIT 1")
    .bind(email, Date.now()).first<TokenRow>();
  if (!row) return expired;
  const attempt = await env.DB.prepare("UPDATE login_tokens SET attempts = attempts + 1 WHERE token_hash = ? AND used = 0 AND expires_at > ? AND attempts < 5")
    .bind(row.token_hash, Date.now()).run();
  if (!attempt.meta.changes) return expired;
  if (row.code_hash !== (await sha256(String(code ?? "").trim()))) return fail(400, "That code doesn't match. Check the email and try again.");
  const session = await consumeToken(env, row);
  if (!session) return expired;
  return json({ ok: true, email }, 200, { "set-cookie": sessionCookie(session.token, url, session.maxAge) });
}

// The link lands on a page with a button, so mail scanners that prefetch links can't use it up.
async function verifyLink(req: Request, env: Env, url: URL) {
  if (req.method === "GET") {
    const token = url.searchParams.get("token") ?? "";
    if (!/^[\w-]{43}$/.test(token)) return page("Sign in", "<p>This sign-in link is broken. Ask for a new one.</p>");
    const to = url.searchParams.get("to") === "learn" ? "learn" : "web";
    return page("Sign in", `<h1>Sign in to justrunjs</h1><form method="post" action="/auth/verify"><input type="hidden" name="token" value="${esc(token)}"><input type="hidden" name="to" value="${to}"><button>Sign in</button></form>`);
  }
  const form = await req.formData();
  const token = String(form.get("token") ?? "");
  const home = form.get("to") === "learn" ? "/learn/" : "/web/";
  const used = page("Sign in", `<p>This link has expired or was already used. <a href="${home}">Ask for a new one</a>.</p>`);
  const row = await env.DB.prepare("SELECT * FROM login_tokens WHERE token_hash = ? AND used = 0 AND expires_at > ?").bind(await sha256(token), Date.now()).first<TokenRow>();
  if (!row) return used;
  const session = await consumeToken(env, row);
  if (!session) return used;
  return new Response(null, { status: 303, headers: { location: home, "set-cookie": sessionCookie(session.token, url, session.maxAge) } });
}

const body = async <T>(req: Request, max: number): Promise<T> => {
  const text = await req.text();
  if (text.length > max) throw Object.assign(new Error("Request too large."), { status: 413 });
  try {
    return JSON.parse(text || "{}") as T;
  } catch {
    throw Object.assign(new Error("Send JSON."), { status: 400 });
  }
};
const ID = /^[\w-]{1,80}$/;

async function api(req: Request, env: Env, url: URL, user: User) {
  const path = url.pathname;
  const m = req.method;
  const [, , resource, id, sub] = path.split("/");

  if (path === "/api/me" && m === "GET") return json({ email: user.email });
  if (path === "/api/auth/logout" && m === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(user.tokenHash).run();
    return json({ ok: true }, 200, { "set-cookie": sessionCookie("", url, 0) });
  }

  if (resource === "experiments" && !id && m === "GET") {
    const { results } = await env.DB.prepare("SELECT id, tab, updated_at FROM experiments WHERE user_id = ? ORDER BY updated_at DESC")
      .bind(user.userId).all<{ id: string; tab: string; updated_at: number }>();
    return json(results.map((r) => ({ id: r.id, tab: JSON.parse(r.tab), updatedAt: r.updated_at })));
  }
  if (resource === "experiments" && id && ID.test(id)) {
    const existing = await env.DB.prepare("SELECT tab, updated_at FROM experiments WHERE user_id = ? AND id = ?")
      .bind(user.userId, id).first<{ tab: string; updated_at: number }>();
    if (m === "DELETE") {
      await env.DB.prepare("DELETE FROM experiments WHERE user_id = ? AND id = ?").bind(user.userId, id).run();
      return json({ ok: true });
    }
    if (m === "PUT") {
      // `base` is the updatedAt this client last saw; null for a brand-new experiment.
      const { tab, base } = await body<{ tab?: Record<string, unknown>; base?: number | null }>(req, MAX_TAB);
      if (!tab || typeof tab !== "object" || tab.id !== id || typeof tab.name !== "string" || !["scratchpad", "playground"].includes(tab.kind as string))
        return fail(400, "That isn't an editor tab.");
      // Someone else (another device) saved since this client last looked: hand back their copy, change nothing.
      if (existing && existing.updated_at !== base) return json({ conflict: true, tab: JSON.parse(existing.tab), updatedAt: existing.updated_at }, 409);
      const updatedAt = Math.max(Date.now(), (existing?.updated_at ?? 0) + 1);
      const write = existing
        ? env.DB.prepare("UPDATE experiments SET tab = ?, updated_at = ? WHERE user_id = ? AND id = ? AND updated_at = ?").bind(JSON.stringify(tab), updatedAt, user.userId, id, existing.updated_at)
        : env.DB.prepare("INSERT OR IGNORE INTO experiments (user_id, id, tab, updated_at) VALUES (?, ?, ?, ?)").bind(user.userId, id, JSON.stringify(tab), updatedAt);
      const res = await write.run();
      if (!res.meta.changes) return fail(409, "This experiment changed while saving. Try again.");
      return json({ updatedAt });
    }
  }

  if (resource === "copies" && !id && m === "GET") {
    const { results } = await env.DB.prepare("SELECT copy, updated_at FROM lesson_copies WHERE user_id = ? ORDER BY updated_at DESC")
      .bind(user.userId).all<{ copy: string; updated_at: number }>();
    return json(results.map((r) => ({ copy: JSON.parse(r.copy), updatedAt: r.updated_at })));
  }
  // /api/copies/<slug>/<origin ms>
  if (resource === "copies" && id && ID.test(id) && /^\d{1,9}$/.test(sub ?? "") && m === "PUT") {
    const origin = Number(sub);
    const existing = await env.DB.prepare("SELECT copy, updated_at FROM lesson_copies WHERE user_id = ? AND slug = ? AND origin_ms = ?")
      .bind(user.userId, id, origin).first<{ copy: string; updated_at: number }>();
    // `base` is the updatedAt this client last saw; null for a copy it never synced.
    const { copy, base } = await body<{ copy?: Record<string, unknown>; base?: number | null }>(req, MAX_TAB);
    if (!copy || typeof copy !== "object" || copy.slug !== id || copy.originMs !== origin || !copy.files || typeof copy.files !== "object")
      return fail(400, "That isn't a lesson copy.");
    // Another device saved since this client last looked: hand back their copy, change nothing.
    if (existing && existing.updated_at !== base) return json({ conflict: true, copy: JSON.parse(existing.copy), updatedAt: existing.updated_at }, 409);
    const updatedAt = Math.max(Date.now(), (existing?.updated_at ?? 0) + 1);
    const write = existing
      ? env.DB.prepare("UPDATE lesson_copies SET copy = ?, updated_at = ? WHERE user_id = ? AND slug = ? AND origin_ms = ? AND updated_at = ?")
          .bind(JSON.stringify(copy), updatedAt, user.userId, id, origin, existing.updated_at)
      : env.DB.prepare("INSERT OR IGNORE INTO lesson_copies (user_id, slug, origin_ms, copy, updated_at) VALUES (?, ?, ?, ?, ?)")
          .bind(user.userId, id, origin, JSON.stringify(copy), updatedAt);
    if (!(await write.run()).meta.changes) return fail(409, "This copy changed while saving. Try again.");
    return json({ updatedAt });
  }

  if (resource === "progress" && !id && m === "GET") {
    const { results } = await env.DB.prepare("SELECT slug, position_ms, completed FROM progress WHERE user_id = ?").bind(user.userId)
      .all<{ slug: string; position_ms: number; completed: number }>();
    return json(results.map((r) => ({ slug: r.slug, positionMs: r.position_ms, completed: !!r.completed })));
  }
  if (resource === "progress" && id && ID.test(id) && m === "PUT") {
    const { positionMs, completed } = await body<{ positionMs?: unknown; completed?: unknown }>(req, 1000);
    const pos = Number(positionMs);
    if (!Number.isFinite(pos) || pos < 0) return fail(400, "Send positionMs.");
    // Completion sticks once reached; replaying from the start doesn't undo it.
    await env.DB.prepare(
      `INSERT INTO progress (user_id, slug, position_ms, completed, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, slug) DO UPDATE SET position_ms = excluded.position_ms, completed = MAX(completed, excluded.completed), updated_at = excluded.updated_at`,
    ).bind(user.userId, id, Math.round(pos), completed ? 1 : 0, Date.now()).run();
    return json({ ok: true });
  }
  return fail(404, "Not found.");
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      // Cookie-authenticated writes must come from this site's own pages.
      if (req.method !== "GET" && req.headers.get("origin") !== url.origin) return fail(403, "Cross-site request refused.");
      if (url.pathname === "/api/auth/request" && req.method === "POST") return await requestSignIn(req, env, url);
      if (url.pathname === "/api/auth/code" && req.method === "POST") return await verifyCode(req, env, url);
      if (url.pathname === "/auth/verify") return await verifyLink(req, env, url);
      const user = await authenticate(req, env);
      if (!user) return fail(401, "Sign in first.");
      return await api(req, env, url, user);
    } catch (e) {
      const err = e as Error & { status?: number };
      if (err.status) return fail(err.status, err.message);
      console.error(e);
      return fail(500, "Something went wrong.");
    }
  },
} satisfies ExportedHandler<Env>;
