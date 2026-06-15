// Applies the user's chosen theme + mode to <html> BEFORE the editor styles
// resolve. Same localStorage keys as the marketing picker (runjs.theme.id
// and runjs.theme.mode), so picking Gruvbox on the landing page carries
// over into /web/ on the same origin.
//
// Loaded as a classic script (not module) from index.html so it runs
// synchronously before <link rel="stylesheet"> is parsed.

import { BUILT_IN_THEMES, DEFAULT_THEME_ID, VAR_MAP } from "./theme-plugins.js";

const themes = Object.fromEntries(BUILT_IN_THEMES.map((t) => [t.id, t]));

function pickMode() {
  const stored = localStorage.getItem("runjs.theme.mode");
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function pickThemeId() {
  return localStorage.getItem("runjs.theme.id") || DEFAULT_THEME_ID;
}

function applyVariant(variant, mode) {
  const root = document.documentElement;
  for (const key of Object.keys(VAR_MAP)) {
    if (variant[key]) root.style.setProperty(VAR_MAP[key], variant[key]);
  }
  if (mode === "dark") root.classList.add("dark");
  else root.classList.remove("dark");
}

try {
  const themeId = pickThemeId();
  const mode = pickMode();
  const theme = themes[themeId] || themes[DEFAULT_THEME_ID];
  applyVariant(mode === "dark" ? theme.dark : theme.light, mode);
  document.documentElement.dataset.themeId = themeId;
  document.documentElement.dataset.themeMode = mode;
} catch (_) {
  // Anything wrong → leave the :root fallback in style.css in place.
}

// Cross-tab sync: if the user changes the theme on the marketing site in
// another tab, the editor here picks it up live.
window.addEventListener("storage", (e) => {
  if (e.key !== "runjs.theme.id" && e.key !== "runjs.theme.mode") return;
  const themeId = pickThemeId();
  const mode = pickMode();
  const theme = themes[themeId] || themes[DEFAULT_THEME_ID];
  applyVariant(mode === "dark" ? theme.dark : theme.light, mode);
  document.documentElement.dataset.themeId = themeId;
  document.documentElement.dataset.themeMode = mode;
});
