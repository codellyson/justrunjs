// Learner accounts: email sign-in, experiments synced to the account, lesson progress.
// Guests keep everything on this device; signing in uploads their experiments once.
import type { EditorTab as LessonTab } from "./recorder.ts";
import { wirePopover } from "./popover.ts";

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
  const changed = () => {
    if (saveNote) saveNote.textContent = saveNoteText();
    listeners.forEach((f) => f());
  };

  // ---------- sync ----------

  // One request per experiment at a time; a failed save retries with back-off (2s, 4s … 60s)
  // instead of on every edit, and keeps the reason for the status line.
  const inFlight = new Set<string>();
  const failures = new Map<string, { reason: string; tries: number; timer: ReturnType<typeof setTimeout> }>();
  const unsent = (t: SyncedTab) => sent.get(t.id) !== JSON.stringify(payload(t));

  function reasonFor(code: number, error?: string) {
    if (code === 0) return navigator.onLine ? "Couldn't reach the server." : "You're offline.";
    if (code === 401) return "Your sign-in expired. Sign in again to save to your account.";
    if (code === 413) return "This experiment is too big to save to your account.";
    return error ?? `The server refused the save (${code}).`;
  }

  async function push(tab: SyncedTab) {
    if (inFlight.has(tab.id)) return; // the finished request re-checks for newer edits
    inFlight.add(tab.id);
    const body = payload(tab);
    status.set(tab.id, "syncing");
    changed();
    const res = await call<{ updatedAt?: number; conflict?: boolean; tab?: SyncedTab; error?: string }>(`/api/experiments/${tab.id}`, {
      method: "PUT",
      body: JSON.stringify({ tab: body, base: tab.syncedAt ?? null }),
    }).catch((e: Error) => ({ ok: false, status: 0, data: { error: e.message } as { error?: string; conflict?: boolean } }));
    inFlight.delete(tab.id);
    if (res.ok && "updatedAt" in res.data) {
      tab.syncedAt = res.data.updatedAt;
      sent.set(tab.id, JSON.stringify(body));
      status.set(tab.id, "saved");
      clearTimeout(failures.get(tab.id)?.timer);
      failures.delete(tab.id);
      if (unsent(tab)) void push(tab); // edited while this save was in flight
    } else if (res.status === 409 && res.data.conflict && "tab" in res.data && res.data.tab) {
      // Another device saved first. Keep both: their copy becomes a new tab, then ours saves over the original.
      const theirs: SyncedTab = { ...res.data.tab, id: `${tab.id}-${res.data.updatedAt}`, name: `${res.data.tab.name} (other device)` };
      ctx.addTabs([theirs]);
      tab.syncedAt = res.data.updatedAt;
      ctx.showToast("This experiment was also changed on another device. Both copies are kept.");
      void push(theirs);
      return push(tab);
    } else {
      const tries = (failures.get(tab.id)?.tries ?? 0) + 1;
      clearTimeout(failures.get(tab.id)?.timer);
      const timer = setTimeout(() => {
        if (ctx.tabs().includes(tab)) void push(tab);
      }, Math.min(60_000, 2000 * 2 ** (tries - 1)));
      failures.set(tab.id, { reason: reasonFor(res.status, res.data.error), tries, timer });
      status.set(tab.id, "error");
    }
    ctx.persist();
    changed();
  }

  function retry(tab: SyncedTab) {
    clearTimeout(failures.get(tab.id)?.timer);
    failures.delete(tab.id);
    void push(tab);
  }

  /** Called after every local save; uploads experiments whose content changed. */
  function onPersist() {
    if (!email) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      for (const t of ctx.tabs()) {
        // A failing experiment waits for its back-off timer instead of retrying on every edit.
        if (isExperiment(t) && !failures.has(t.id) && unsent(t)) void push(t);
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
  // Only claim "saved" when it's true.
  let saveNote: HTMLElement | null = null;
  const saveNoteText = () =>
    failures.size
      ? "Some experiment changes haven't reached your account yet. They're safe on this device."
      : "Your lesson experiments and progress save to your account.";
  const button = $("btn-account");
  let pendingEmail = "";

  function el<T extends HTMLElement = HTMLElement>(tag: string, props: object = {}, ...children: (Node | string)[]): T {
    const node = Object.assign(document.createElement(tag), props) as T;
    node.append(...children);
    return node;
  }

  function render() {
    button.classList.toggle("signed-in", !!email);
    const label = email ? `Signed in as ${email}` : "Sign in to save your work";
    button.setAttribute("aria-label", label);
    button.dataset.label = label;
    const section = el("div", { className: "settings-section account-section" });
    if (email) {
      section.append(
        el("div", { className: "settings-title" }, "Account"),
        el("p", { className: "account-text" }, "Signed in as ", el("strong", {}, email)),
        (saveNote = el("p", { className: "account-text account-muted" }, saveNoteText())),
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
    failures.forEach((f) => clearTimeout(f.timer));
    failures.clear();
    status.clear();
    sent.clear();
    progress.clear();
    render();
  }

  wirePopover(button, panel);

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
    /** Where this tab's work lives, for the status line in the tab bar. */
    /** `short` is the phone version, where the tab bar has little room. */
    statusFor(tab: LessonTab): { text: string; short: string; reason?: string; retry?: () => void } {
      const t = tab as SyncedTab;
      if (!isExperiment(t))
        return {
          text: "On this device",
          short: "On device",
          reason: email
            ? "Saved in this browser. Only experiments from lessons save to your account."
            : "Saved in this browser. Experiments from lessons also save to your account when you sign in.",
        };
      if (!email) return { text: "On this device · sign in to keep it everywhere", short: "On device" };
      const s = status.get(t.id);
      if (s === "error") return { text: "Couldn't save to your account", short: "Not saved", reason: `${failures.get(t.id)?.reason ?? ""} Your work is safe on this device.`.trim(), retry: () => retry(t) };
      return s === "saved" ? { text: "In your account", short: "Saved" } : { text: "Saving…", short: "Saving…" };
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
