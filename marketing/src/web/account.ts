// Learner accounts: email sign-in, experiments synced to the account, lesson progress.
// Guests keep everything on this device; signing in uploads their experiments once.
import type { LessonTab } from "./lesson-mode.ts";

type SyncedTab = LessonTab & { syncedAt?: number };
type Status = "local" | "syncing" | "saved" | "error";

export interface AccountContext {
  tabs(): SyncedTab[];
  /** Add tabs that exist only on the server, then redraw and persist. */
  addTabs(tabs: SyncedTab[]): void;
  persist(): void;
  showToast(message: string): void;
}

const $ = (id: string) => document.getElementById(id)!;
const isExperiment = (t: SyncedTab) => !!t.lesson;
// What gets compared and uploaded: the tab minus local-only bookkeeping.
const payload = ({ syncedAt: _s, ...tab }: SyncedTab) => tab;

async function call<T>(path: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; data: T }> {
  const res = await fetch(path, { ...init, headers: { "content-type": "application/json", ...init.headers }, credentials: "same-origin" });
  const data = (await res.json().catch(() => ({}))) as T;
  return { ok: res.ok, status: res.status, data };
}

export function initAccount(ctx: AccountContext) {
  let email: string | null = null;
  const status = new Map<string, Status>();
  const sent = new Map<string, string>(); // tab id -> JSON last acknowledged by the server
  const progress = new Map<string, { positionMs: number; completed: boolean }>();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach((f) => f());

  // ---------- sync ----------

  async function push(tab: SyncedTab) {
    const body = payload(tab);
    status.set(tab.id, "syncing");
    changed();
    const res = await call<{ updatedAt?: number; conflict?: boolean; tab?: SyncedTab; error?: string }>(`/api/experiments/${tab.id}`, {
      method: "PUT",
      body: JSON.stringify({ tab: body, base: tab.syncedAt ?? null }),
    }).catch((e: Error) => ({ ok: false, status: 0, data: { error: e.message } as { error?: string; conflict?: boolean } }));
    if (res.ok && "updatedAt" in res.data) {
      tab.syncedAt = res.data.updatedAt;
      sent.set(tab.id, JSON.stringify(body));
      status.set(tab.id, "saved");
    } else if (res.status === 409 && res.data.conflict && "tab" in res.data && res.data.tab) {
      // Another device saved first. Keep both: their copy becomes a new tab, then ours saves over the original.
      const theirs: SyncedTab = { ...res.data.tab, id: `${tab.id}-${res.data.updatedAt}`, name: `${res.data.tab.name} (other device)` };
      ctx.addTabs([theirs]);
      tab.syncedAt = res.data.updatedAt;
      ctx.showToast("This experiment was also changed on another device. Both copies are kept.");
      void push(theirs);
      return push(tab);
    } else {
      status.set(tab.id, "error");
    }
    ctx.persist();
    changed();
  }

  /** Called after every local save; uploads experiments whose content changed. */
  function onPersist() {
    if (!email) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      for (const t of ctx.tabs()) {
        if (isExperiment(t) && sent.get(t.id) !== JSON.stringify(payload(t))) void push(t);
      }
    }, 1000);
  }

  async function pull() {
    const res = await call<{ id: string; tab: SyncedTab; updatedAt: number }[]>("/api/experiments");
    if (!res.ok) return;
    const local = new Map(ctx.tabs().map((t) => [t.id, t]));
    const fresh: SyncedTab[] = [];
    for (const row of res.data) {
      const mine = local.get(row.id);
      if (!mine) fresh.push({ ...row.tab, syncedAt: row.updatedAt });
      else if (JSON.stringify(payload(mine)) === JSON.stringify(row.tab)) mine.syncedAt = row.updatedAt;
      // Differs and we never saw this server version: push() will hit the conflict path and keep both.
      if (!mine || mine.syncedAt === row.updatedAt) sent.set(row.id, JSON.stringify(row.tab));
      status.set(row.id, "saved");
    }
    if (fresh.length) ctx.addTabs(fresh);
    // Experiments made before signing in (or on this device only) upload now; ids make retries idempotent.
    for (const t of ctx.tabs()) if (isExperiment(t) && sent.get(t.id) !== JSON.stringify(payload(t))) void push(t);
    const prog = await call<{ slug: string; positionMs: number; completed: boolean }[]>("/api/progress");
    if (prog.ok) for (const p of prog.data) progress.set(p.slug, p);
    changed();
  }

  // ---------- sign-in panel ----------

  const panel = $("account-popover");
  const button = $("btn-account");
  let pendingEmail = "";

  function el<T extends HTMLElement = HTMLElement>(tag: string, props: object = {}, ...children: (Node | string)[]): T {
    const node = Object.assign(document.createElement(tag), props) as T;
    node.append(...children);
    return node;
  }

  function render() {
    button.classList.toggle("signed-in", !!email);
    button.title = email ? `Signed in as ${email}` : "Sign in to save your work";
    const section = el("div", { className: "settings-section account-section" });
    if (email) {
      section.append(
        el("div", { className: "settings-title" }, "Account"),
        el("p", { className: "account-text" }, "Signed in as ", el("strong", {}, email)),
        el("p", { className: "account-text account-muted" }, "Your lesson experiments and progress are saved to your account."),
        el("button", { className: "settings-mode-btn", type: "button", onclick: signOut }, "Sign out"),
      );
    } else if (!pendingEmail) {
      const input = el<HTMLInputElement>("input", { type: "email", required: true, placeholder: "you@example.com", className: "account-input", autocomplete: "email" });
      input.setAttribute("aria-label", "Email address");
      const error = el("p", { className: "account-text account-error", role: "alert" });
      section.append(
        el("div", { className: "settings-title" }, "Sign in"),
        el("p", { className: "account-text account-muted" }, "Save your lesson experiments and progress across devices. No password: we email you a code."),
        el("form", {
          className: "account-form",
          onsubmit: async (e: Event) => {
            e.preventDefault();
            error.textContent = "";
            const res = await call<{ error?: string }>("/api/auth/request", { method: "POST", body: JSON.stringify({ email: input.value }) });
            if (!res.ok) return void (error.textContent = res.data.error ?? "Couldn't send the email.");
            pendingEmail = input.value.trim().toLowerCase();
            render();
          },
        }, input, el("button", { className: "account-submit", type: "submit" }, "Email me a code")),
        error,
      );
    } else {
      const input = el<HTMLInputElement>("input", { inputMode: "numeric", autocomplete: "one-time-code", maxLength: 6, placeholder: "123456", className: "account-input" });
      input.setAttribute("aria-label", "Sign-in code");
      const error = el("p", { className: "account-text account-error", role: "alert" });
      section.append(
        el("div", { className: "settings-title" }, "Check your email"),
        el("p", { className: "account-text account-muted" }, `We sent a code to ${pendingEmail}. Type it here, or click the link in the email.`),
        el("form", {
          className: "account-form",
          onsubmit: async (e: Event) => {
            e.preventDefault();
            error.textContent = "";
            const res = await call<{ error?: string; email?: string }>("/api/auth/code", { method: "POST", body: JSON.stringify({ email: pendingEmail, code: input.value }) });
            if (!res.ok) return void (error.textContent = res.data.error ?? "That code didn't work.");
            email = res.data.email ?? pendingEmail;
            pendingEmail = "";
            render();
            ctx.showToast("Signed in. Your experiments are syncing.");
            await pull();
          },
        }, input, el("button", { className: "account-submit", type: "submit" }, "Sign in")),
        error,
        el("button", { className: "settings-mode-btn", type: "button", onclick: () => { pendingEmail = ""; render(); } }, "Use a different email"),
      );
    }
    panel.replaceChildren(section);
    if (!panel.classList.contains("hidden")) panel.querySelector("input")?.focus();
    changed();
  }

  async function signOut() {
    await call("/api/auth/logout", { method: "POST" }).catch(() => {});
    email = null;
    status.clear();
    sent.clear();
    progress.clear();
    render();
  }

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.classList.toggle("hidden");
    panel.querySelector("input")?.focus();
  });
  document.addEventListener("click", (e) => {
    const target = e.target as Node;
    if (!panel.classList.contains("hidden") && !panel.contains(target) && !button.contains(target)) panel.classList.add("hidden");
  });

  void call<{ email?: string }>("/api/me")
    .then(async (res) => {
      if (res.ok && res.data.email) {
        email = res.data.email;
        render();
        await pull();
      } else render();
    })
    .catch(render);

  return {
    onPersist,
    /** For the lesson bar: where this tab's work is saved. */
    statusText(tab: LessonTab) {
      if (!email) return "Saved on this device · sign in to keep it everywhere";
      const s = status.get(tab.id);
      return s === "saved" ? "Saved to your account" : s === "error" ? "Not saved to your account yet" : "Syncing…";
    },
    /** Ask before a closed experiment is removed from the account too. */
    async onClose(tab: LessonTab) {
      if (!email || !isExperiment(tab as SyncedTab) || !(tab as SyncedTab).syncedAt) return;
      if (!confirm(`Also delete "${tab.name}" from your account? Choose Cancel to keep it there.`)) return;
      sent.delete(tab.id);
      await call(`/api/experiments/${tab.id}`, { method: "DELETE" });
    },
    progressFor: (slug: string) => progress.get(slug),
    saveProgress(slug: string, positionMs: number, completed: boolean) {
      if (!email) return;
      const prev = progress.get(slug);
      const next = { positionMs: Math.round(positionMs), completed: completed || !!prev?.completed };
      progress.set(slug, next);
      void call(`/api/progress/${slug}`, { method: "PUT", body: JSON.stringify(next) }).catch(() => {});
    },
    onChange(f: () => void) {
      listeners.add(f);
    },
  };
}
