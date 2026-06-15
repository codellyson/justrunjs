// Re-export the shared theme catalog from web/ so Astro and the static
// /web/ editor share one source of truth. Editing palettes? Do it in
// ../../../web/theme-plugins.js — both surfaces pick it up.
//
// Typed shapes are local to this shim so the marketing Astro frontmatter
// gets proper inference; the runtime data is imported.
export { BUILT_IN_THEMES, DEFAULT_THEME_ID, VAR_MAP } from '../web/theme-plugins.js';

export interface ThemeVariant {
  bg: string;
  bgSecondary: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentHover: string;
  accentText: string;
  danger: string;
  success: string;
  warning: string;
}

export interface ThemePlugin {
  id: string;
  label: string;
  description?: string;
  swatch: { light: string; dark: string };
  light: ThemeVariant;
  dark: ThemeVariant;
}
