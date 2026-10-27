// Fills in the playlist page from what this browser remembers: finished lessons, where the
// student stopped, and their copies. Also the sign-in every learn page shares.
import { formatTime } from "../web/lesson.ts";
import { copiesOf } from "./copies.ts";
import { listState, savedPosition } from "./progress.ts";
import { requestCode, signOut, signedInEmail, syncAll, verifyCode } from "./sync.ts";

export function paintCourse() {
  const rows = [...document.querySelectorAll<HTMLElement>(".cp-row")];
  const { done, doneCount, next: nextSlug } = listState(rows.map((r) => r.dataset.slug!));
  const next = rows.find((r) => r.dataset.slug === nextSlug);

  rows.forEach((row, i) => {
    const slug = row.dataset.slug!;
    const isDone = done.includes(slug);
    const isNext = row === next;
    const at = savedPosition(slug);
    row.classList.toggle("done", isDone);
    row.classList.toggle("next", isNext);
    row.querySelector(".cp-state")!.textContent = isNext ? (at ? "In progress" : "Up next") : "";
    row.querySelector(".cp-row-where")!.textContent = isNext && at ? ` · stopped at ${formatTime(at)}` : "";
    row.querySelector(".cp-mark")!.setAttribute("aria-label", isDone ? "Done" : isNext ? "Up next" : `Lesson ${i + 1}`);

    const start = row.querySelector<HTMLAnchorElement>(".cp-start")!;
    start.hidden = !isNext;
    start.querySelector(".cp-start-label")!.textContent = at ? "Continue" : "Start";
    start.setAttribute("aria-label", `${at ? "Continue" : "Start"} ${row.dataset.title}`);

    // The copy the student worked on last; the lesson page opens it from ?copy=<moment>.
    const copies = copiesOf(slug).sort((a, b) => b.updatedAt - a.updatedAt);
    const link = row.querySelector<HTMLAnchorElement>(".cp-copy")!;
    link.hidden = !copies.length;
    if (copies.length) {
      link.href = `/learn/${slug}?copy=${copies[0].originMs}`;
      link.querySelector(".cp-copy-label")!.textContent = copies.length > 1 ? `Your copies · ${copies.length}` : "Your copy";
      link.setAttribute("aria-label", `Your copy of ${row.dataset.title}${copies.length > 1 ? ` (latest of ${copies.length})` : ""}`);
    }
  });

  const cta = document.getElementById("cp-cta") as HTMLAnchorElement;
  const label = document.getElementById("cp-cta-label")!;
  if (next) {
    const n = rows.indexOf(next) + 1;
    cta.href = `/learn/${next.dataset.slug}`;
    label.textContent = savedPosition(next.dataset.slug!) ? `Continue lesson ${n}` : doneCount ? `Continue with lesson ${n}` : "Start the playlist";
  } else {
    label.textContent = "Watch lesson 1 again";
  }
  document.getElementById("cp-done-count")!.textContent = !doneCount
    ? ""
    : doneCount === rows.length
      ? "You've finished every lesson"
      : `${doneCount} of ${rows.length} done`;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Sign in (email, then a code) so progress and copies follow the student; sync, then repaint. */
export function initAccount(repaint: () => void) {
  const saved = $("cp-saved");
  const openBtn = $<HTMLButtonElement>("cp-signin-open");
  const outBtn = $<HTMLButtonElement>("cp-signout");
  const emailForm = $<HTMLFormElement>("cp-signin");
  const codeForm = $<HTMLFormElement>("cp-code");
  const emailInput = $<HTMLInputElement>("cp-email");
  const codeInput = $<HTMLInputElement>("cp-code-input");
  const error = $("cp-error");

  function show(email: string | null) {
    saved.textContent = email
      ? `Your progress and your copies are saved to your account (${email}), and in this browser.`
      : "Your progress and your copies are saved in this browser, on this device.";
    openBtn.hidden = !!email;
    outBtn.hidden = !email;
    emailForm.hidden = codeForm.hidden = true;
    error.textContent = "";
  }

  async function refresh() {
    show(await signedInEmail());
    if (await syncAll()) repaint();
  }

  openBtn.addEventListener("click", () => {
    openBtn.hidden = true;
    emailForm.hidden = false;
    emailInput.focus();
  });
  emailForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    const problem = await requestCode(emailInput.value.trim());
    if (problem) return void (error.textContent = problem);
    $("cp-code-email").textContent = emailInput.value.trim();
    emailForm.hidden = true;
    codeForm.hidden = false;
    codeInput.focus();
  });
  codeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.textContent = "";
    const problem = await verifyCode(emailInput.value.trim(), codeInput.value.trim());
    if (problem) return void (error.textContent = problem);
    codeInput.value = "";
    await refresh();
  });
  $("cp-code-back").addEventListener("click", () => {
    codeForm.hidden = true;
    emailForm.hidden = false;
    emailInput.focus();
  });
  outBtn.addEventListener("click", async () => {
    await signOut();
    show(null);
  });

  void refresh();
}
