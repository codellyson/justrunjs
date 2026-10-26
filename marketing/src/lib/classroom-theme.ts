import { BUILT_IN_THEMES, type ThemePlugin } from "@codellyson/justui";
import { bootTheme } from "@codellyson/justui/boot";

/**
 * justrunjs's own look, the same as the lessons (src/learn/learn.css): a warm dark stage,
 * apricot for the teacher and actions, teal for values and the student's work. The default
 * for the landing page and the scratchpad; justui's themes stay in the picker.
 */
export const CLASSROOM: ThemePlugin = {
  id: "classroom",
  label: "Classroom",
  description: "Warm stage, apricot and teal: the lessons' look.",
  swatch: { light: "#faf5ee", dark: "#1a1512" },
  dark: {
    bg: "26 21 18",
    bgSecondary: "34 28 24",
    border: "58 49 42",
    textPrimary: "243 234 223",
    textSecondary: "214 203 189",
    textMuted: "179 165 150",
    accent: "240 163 94",
    accentHover: "244 180 122",
    accentText: "26 21 18",
    danger: "242 167 160",
    success: "127 203 181",
    warning: "240 194 122",
  },
  light: {
    bg: "250 245 238",
    bgSecondary: "243 236 226",
    border: "226 215 201",
    textPrimary: "38 29 23",
    textSecondary: "92 78 66",
    textMuted: "112 98 86",
    accent: "181 96 32",
    accentHover: "156 80 24",
    accentText: "255 255 255",
    danger: "190 60 50",
    success: "22 122 98",
    warning: "150 100 20",
  },
};

export const THEMES: readonly ThemePlugin[] = [CLASSROOM, ...BUILT_IN_THEMES];
export const DEFAULT_THEME = CLASSROOM.id;

/**
 * Apply the saved theme, or the Classroom theme on its dark stage: lessons are always dark, so
 * the rest of the site starts there too, whatever the system prefers. Light stays in the toggle.
 */
export function bootClassroom() {
  try {
    if (!localStorage.getItem("runjs.theme.mode")) localStorage.setItem("runjs.theme.mode", "dark");
  } catch {
    /* storage blocked: justui falls back to the system preference */
  }
  return bootTheme({ keyPrefix: "runjs", themes: THEMES, defaultThemeId: DEFAULT_THEME });
}
