// The AI workspace's colour themes. The tokens live in src/index.css under
// `.ai-app[data-ai-theme=...]`; this is the list the Appearance panel shows,
// plus reading and writing the choice. Night and Monokai are dark only: the
// picker switches the light/dark mode to dark when one is chosen.

export type AiThemeId = "warm" | "blue" | "pink" | "orange" | "green" | "night" | "monokai";

export interface AiThemeInfo {
  id: AiThemeId;
  name: string;
  // Three colours for the swatch: paper, sidebar and the accent (as CSS
  // colours, light then dark where the theme has both).
  swatch: { light?: [string, string, string]; dark: [string, string, string] };
  darkOnly?: boolean;
}

export const AI_THEME_KEY = "ai-theme";
export const DEFAULT_AI_THEME: AiThemeId = "warm";

export const AI_THEMES: AiThemeInfo[] = [
  { id: "warm", name: "Warm", swatch: { light: ["hsl(40 20% 98%)", "hsl(40 12% 95%)", "hsl(224 42% 30%)"], dark: ["hsl(30 8% 9%)", "hsl(30 8% 7%)", "hsl(224 45% 68%)"] } },
  { id: "blue", name: "Blue", swatch: { light: ["hsl(210 30% 98%)", "hsl(212 38% 94%)", "hsl(212 85% 36%)"], dark: ["hsl(212 20% 11%)", "hsl(212 22% 8%)", "hsl(206 85% 66%)"] } },
  { id: "pink", name: "Pink", swatch: { light: ["hsl(340 30% 98%)", "hsl(340 35% 95%)", "hsl(335 70% 36%)"], dark: ["hsl(335 15% 10%)", "hsl(335 16% 7%)", "hsl(338 75% 72%)"] } },
  { id: "orange", name: "Orange", swatch: { light: ["hsl(32 35% 98%)", "hsl(32 38% 94%)", "hsl(24 85% 32%)"], dark: ["hsl(28 12% 10%)", "hsl(28 13% 7%)", "hsl(28 85% 64%)"] } },
  { id: "green", name: "Green", swatch: { light: ["hsl(140 22% 98%)", "hsl(140 24% 94%)", "hsl(150 60% 26%)"], dark: ["hsl(150 12% 10%)", "hsl(150 13% 7%)", "hsl(145 55% 62%)"] } },
  { id: "night", name: "Night", darkOnly: true, swatch: { dark: ["hsl(0 0% 12%)", "hsl(0 0% 9%)", "hsl(206 92% 64%)"] } },
  { id: "monokai", name: "Monokai", darkOnly: true, swatch: { dark: ["hsl(70 8% 15%)", "hsl(70 8% 12%)", "hsl(80 76% 53%)"] } },
];

export function isAiThemeId(value: unknown): value is AiThemeId {
  return typeof value === "string" && AI_THEMES.some((t) => t.id === value);
}

export function isDarkOnlyAiTheme(id: AiThemeId): boolean {
  return !!AI_THEMES.find((t) => t.id === id)?.darkOnly;
}

/** The saved theme, read synchronously so the first paint already has it. */
export function readAiTheme(): AiThemeId {
  // The companion opens the page with ?aiTheme= so the document beside the
  // chat wears the chat's colours; that choice is saved like any other.
  try {
    const asked = new URLSearchParams(window.location.search).get("aiTheme");
    if (isAiThemeId(asked)) {
      saveAiTheme(asked);
      return asked;
    }
  } catch {
    /* no address to read */
  }
  try {
    const saved = localStorage.getItem(AI_THEME_KEY);
    return isAiThemeId(saved) ? saved : DEFAULT_AI_THEME;
  } catch {
    return DEFAULT_AI_THEME;
  }
}

export function saveAiTheme(id: AiThemeId): void {
  try {
    if (id === DEFAULT_AI_THEME) localStorage.removeItem(AI_THEME_KEY);
    else localStorage.setItem(AI_THEME_KEY, id);
  } catch {
    /* a private window: the choice lasts for the session */
  }
}

// Night and Monokai only exist in the dark, and the chat's other dark-mode
// styles (prose-invert, the amber notices) key off next-themes' .dark class,
// so Project Hub's mode is pinned to dark while one is chosen. The mode the
// lawyer had before is kept here and comes back when they pick another theme.
export type AiMode = "light" | "dark" | "system";
export const AI_MODE_BEFORE_DARK_ONLY_KEY = "ai-mode-before-dark-only";

function isAiMode(value: unknown): value is AiMode {
  return value === "light" || value === "dark" || value === "system";
}

function readModeBeforeDarkOnly(): AiMode | null {
  try {
    const saved = localStorage.getItem(AI_MODE_BEFORE_DARK_ONLY_KEY);
    return isAiMode(saved) ? saved : null;
  } catch {
    return null;
  }
}

/**
 * Switches the mode to dark for a dark-only theme, remembering the mode it
 * replaces (unless one is already remembered). Safe to call again: it does
 * nothing once the mode is dark.
 */
export function enterDarkOnlyMode(currentMode: string | undefined, setMode: (mode: AiMode) => void): void {
  if (currentMode === "dark") return;
  if (isAiMode(currentMode) && !readModeBeforeDarkOnly()) {
    try {
      localStorage.setItem(AI_MODE_BEFORE_DARK_ONLY_KEY, currentMode);
    } catch {
      /* a private window: the mode stays dark after leaving the theme */
    }
  }
  setMode("dark");
}

/** Leaving a dark-only theme: put back the mode the lawyer had before, if one was remembered. */
export function leaveDarkOnlyMode(setMode: (mode: AiMode) => void): void {
  const before = readModeBeforeDarkOnly();
  try {
    localStorage.removeItem(AI_MODE_BEFORE_DARK_ONLY_KEY);
  } catch {
    /* nothing to clear */
  }
  if (before) setMode(before);
}
