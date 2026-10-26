// Sidebar popovers (examples, settings, account): toggle from their button, close on an
// outside click or Esc, move keyboard focus in on open and back to the button on Esc.
export function wirePopover(button: HTMLElement, panel: HTMLElement) {
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", panel.id);
  const isOpen = () => !panel.classList.contains("hidden");

  function close(returnFocus = true) {
    if (!isOpen()) return;
    panel.classList.add("hidden");
    button.setAttribute("aria-expanded", "false");
    if (returnFocus) button.focus();
  }

  function open() {
    panel.classList.remove("hidden");
    button.setAttribute("aria-expanded", "true");
    panel.querySelector<HTMLElement>("input, select, button:not(:disabled), [href]")?.focus();
  }

  button.addEventListener("click", (e) => {
    e.stopPropagation();
    if (isOpen()) close();
    else open();
  });
  document.addEventListener("click", (e) => {
    const target = e.target as Node;
    // Focus stays where the person clicked.
    if (isOpen() && !panel.contains(target) && !button.contains(target)) close(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !isOpen()) return;
    const inside = panel.contains(document.activeElement) || document.activeElement === button;
    e.preventDefault();
    close(inside);
  });

  return { open, close, isOpen };
}
