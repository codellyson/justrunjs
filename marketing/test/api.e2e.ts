// End-to-end API test against a real local Worker (wrangler dev, local D1, simulated email).
// Needs dist/ from `astro build`. Run with `pnpm test:api`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const state = mkdtempSync(join(tmpdir(), "justrunjs-api-"));
let worker: ChildProcess;
let log = "";

before(async () => {
  const wrangler = (...args: string[]) => ["wrangler", ...args, "--persist-to", state];
  execFileSync("npx", wrangler("d1", "migrations", "apply", "justrunjs", "--local"), { stdio: "ignore" });
  worker = spawn("npx", [...wrangler("dev", "--port", String(PORT), "--inspector-port", "9399")], { stdio: ["ignore", "pipe", "pipe"] });
  worker.stdout!.on("data", (d) => (log += d));
  worker.stderr!.on("data", (d) => (log += d));
  for (let i = 0; !log.includes("Ready on"); i++) {
    if (i > 120) throw new Error(`wrangler dev didn't start:\n${log}`);
    await new Promise((r) => setTimeout(r, 500));
  }
});
after(() => worker?.kill());

// A browser-like client: keeps its session cookie and sends this site's Origin on writes.
function client() {
  let sid = "";
  return async (path: string, init: { method?: string; body?: unknown; origin?: string } = {}) => {
    const res = await fetch(BASE + path, {
      method: init.method ?? "GET",
      headers: { "content-type": "application/json", origin: init.origin ?? BASE, ...(sid && { cookie: `sid=${sid}` }) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      redirect: "manual",
    });
    sid = res.headers.get("set-cookie")?.match(/sid=([^;]*)/)?.[1] ?? sid;
    return { status: res.status, data: (await res.json().catch(() => null)) as any };
  };
}

async function signedIn(email: string) {
  const api = client();
  const codes = () => [...log.matchAll(/To: (\S+)\s+Subject: [^\n]*sign-in code: (\d{6})/g)].filter((m) => m[1] === email);
  const seen = codes().length; // wait for this request's email, not an earlier one to the same address
  assert.equal((await api("/api/auth/request", { method: "POST", body: { email } })).status, 200);
  let code = "";
  for (let i = 0; i < 40 && !code; i++) {
    code = codes()[seen]?.[2] ?? "";
    if (!code) await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(code, "sign-in email was not sent");
  assert.equal((await api("/api/auth/code", { method: "POST", body: { email, code: "000000" === code ? "111111" : "000000" } })).status, 400);
  assert.equal((await api("/api/auth/code", { method: "POST", body: { email, code } })).status, 200);
  return api;
}

const tab = (id: string, html: string) => ({ id, name: "Card @ 0:12.html", kind: "playground", content: "", language: "javascript", html, lesson: { slug: "greeting-card", originMs: 12000 } });

test("signed-out requests are refused", async () => {
  const api = client();
  assert.equal((await api("/api/me")).status, 401);
  assert.equal((await api("/api/experiments")).status, 401);
});

test("experiments save, list, and refuse stale overwrites", async () => {
  const api = await signedIn("ada@example.com");
  assert.equal((await api("/api/me")).data.email, "ada@example.com");

  const first = await api("/api/experiments/t-1", { method: "PUT", body: { tab: tab("t-1", "<p>one</p>"), base: null } });
  assert.equal(first.status, 200);
  // Retrying the same create (base null) after it landed is a conflict, not a duplicate.
  assert.equal((await api("/api/experiments/t-1", { method: "PUT", body: { tab: tab("t-1", "<p>one</p>"), base: null } })).status, 409);

  const second = await api("/api/experiments/t-1", { method: "PUT", body: { tab: tab("t-1", "<p>two</p>"), base: first.data.updatedAt } });
  assert.equal(second.status, 200);
  // A device still holding the first version gets the newer copy back instead of overwriting it.
  const stale = await api("/api/experiments/t-1", { method: "PUT", body: { tab: tab("t-1", "<p>stale</p>"), base: first.data.updatedAt } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.tab.html, "<p>two</p>");

  const list = await api("/api/experiments");
  assert.deepEqual(list.data.map((e: any) => [e.id, e.tab.html]), [["t-1", "<p>two</p>"]]);
  assert.equal((await api("/api/experiments/t-2", { method: "PUT", body: { tab: { id: "t-2", name: 1 }, base: null } })).status, 400);
});

test("one learner never sees or changes another's work", async () => {
  const ada = await signedIn("ada@example.com");
  const bo = await signedIn("bo@example.com");
  assert.equal((await bo("/api/experiments")).data.length, 0);
  // Same client-made id under a different user is a separate row, and Ada's copy is untouched.
  assert.equal((await bo("/api/experiments/t-1", { method: "PUT", body: { tab: tab("t-1", "<p>bo</p>"), base: null } })).status, 200);
  assert.equal((await bo("/api/experiments/t-1", { method: "DELETE" })).status, 200);
  assert.equal((await ada("/api/experiments")).data[0].tab.html, "<p>two</p>");
});

test("progress keeps position and sticky completion", async () => {
  const api = await signedIn("cy@example.com");
  await api("/api/progress/greeting-card", { method: "PUT", body: { positionMs: 25000, completed: true } });
  await api("/api/progress/greeting-card", { method: "PUT", body: { positionMs: 4000, completed: false } });
  assert.deepEqual((await api("/api/progress")).data, [{ slug: "greeting-card", positionMs: 4000, completed: true }]);
});

test("writes from another site are refused", async () => {
  const api = await signedIn("dee@example.com");
  assert.equal((await api("/api/experiments/t-9", { method: "PUT", body: { tab: tab("t-9", "x"), base: null }, origin: "https://evil.example" })).status, 403);
  assert.equal((await api("/api/auth/logout", { method: "POST" })).status, 200);
  assert.equal((await api("/api/me")).status, 401);
});

const copyOf = (html: string, slug = "greeting-card", originMs = 12000) => ({ slug, originMs, files: { html, css: "", js: "" }, active: "html", edits: {}, updatedAt: 1 });

test("lesson copies save, list, refuse stale overwrites, and stay private", async () => {
  const api = await signedIn("eve@example.com");
  const first = await api("/api/copies/greeting-card/12000", { method: "PUT", body: { copy: copyOf("<h1>one</h1>"), base: null } });
  assert.equal(first.status, 200);
  // Another device that never saw this copy gets it back instead of overwriting it.
  const stale = await api("/api/copies/greeting-card/12000", { method: "PUT", body: { copy: copyOf("<h1>other</h1>"), base: null } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.copy.files.html, "<h1>one</h1>");
  assert.equal(stale.data.updatedAt, first.data.updatedAt);
  const second = await api("/api/copies/greeting-card/12000", { method: "PUT", body: { copy: copyOf("<h1>two</h1>"), base: first.data.updatedAt } });
  assert.equal(second.status, 200);
  assert.deepEqual((await api("/api/copies")).data.map((r: any) => [r.copy.slug, r.copy.originMs, r.copy.files.html]), [["greeting-card", 12000, "<h1>two</h1>"]]);
  // The address and the copy must agree, and it must look like a copy.
  assert.equal((await api("/api/copies/greeting-card/9000", { method: "PUT", body: { copy: copyOf("x"), base: null } })).status, 400);
  assert.equal((await api("/api/copies/greeting-card/12000", { method: "PUT", body: { copy: { slug: "greeting-card", originMs: 12000 }, base: null } })).status, 400);

  const other = await signedIn("fin@example.com");
  assert.equal((await other("/api/copies")).data.length, 0);
});

test("a sign-in asked for from the course page links back to it", async () => {
  const api = client();
  assert.equal((await api("/api/auth/request", { method: "POST", body: { email: "gus@example.com", from: "learn" } })).status, 200);
  // The simulated email's text lands in a file; the log names it.
  let text = "";
  for (let i = 0; i < 40 && !text; i++) {
    const file = log.match(/To: gus@example\.com[\s\S]*?Text: (\S+\.txt)/)?.[1];
    if (file) text = readFileSync(file, "utf8");
    else await new Promise((r) => setTimeout(r, 250));
  }
  const link = text.match(/\/auth\/verify\?token=[\w-]{43}&to=learn/)?.[0] ?? "";
  assert.ok(link, `the emailed link should return to /learn/:\n${text}`);
  const page = await (await fetch(BASE + link)).text();
  assert.match(page, /name="to" value="learn"/);
});
