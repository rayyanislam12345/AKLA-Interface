// Colour themes for the claude.ai chat. Pure data and pure functions, no DOM,
// no chrome.* calls, so theme.js (on claude.ai), options.js, panel.js and
// tests/themes.test.js all share one definition.
//
// How claude.ai colours itself (read off the live page, 19 Oct 2026,
// data-color-version v2). Everything hangs off one grey ramp,
// --cds-gray-0 (white) … --cds-gray-900 (near black), 36 steps. Light mode
// reads it as --cds-neutral-N = --cds-gray-N; dark mode flips it,
// --cds-neutral-N = --cds-gray-(900-N). Surfaces, text, borders, the older
// --bg-*/--text-*/--border-* tokens and the translucent alphas are all
// defined in terms of neutrals, and the accent comes from a second ramp,
// --cds-role-accent-50 … 850.
//
// So a theme is: a "paper" colour (the light end of the grey ramp), an
// "ink" colour (the dark end), an accent ramp, and a brand colour. The ramp
// is rebuilt between paper and ink and claude.ai's own rules derive the
// rest, in light and in dark, the way they already do for its grey. The
// older tokens are set as well, on the same steps claude.ai uses, so pages
// still on that family match. Anything not named keeps claude.ai's value:
// if claude.ai renames a token the page falls back to its own colours
// rather than breaking.
(function (root) {
  "use strict";

  var GRAY_STEPS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 150, 200, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 750, 800, 810, 820, 830, 840, 850, 860, 870, 880, 890, 900];
  var ACCENT_STEPS = ["50", "100", "250", "300", "400", "450", "600", "700", "800", "850"];

  // accent: per mode, {strong, main, soft}. ramp: ten accent steps from
  // palest to deepest (claude.ai picks different steps in dark, so one ramp
  // serves both unless a theme gives {light, dark}).
  var THEMES = [
    {
      id: "default",
      name: "Claude",
      description: "claude.ai's own colours. Nothing is changed.",
    },
    {
      id: "akla",
      name: "AKLA navy",
      description: "The firm's navy and gold on warm paper; deep navy at night.",
      paper: "#f9f7f1",
      ink: "#0a1120",
      brand: "#b8912a",
      accent: { light: { strong: "#0e1f3d", main: "#12264a", soft: "#e4e9f3" }, dark: { strong: "#c6d2e8", main: "#9fb0cf", soft: "#1c2a44" } },
      ramp: ["#e8ecf4", "#d3dbe9", "#9fb0cf", "#8296bb", "#4b6594", "#34507f", "#1f3763", "#172b4e", "#0f1d35", "#0b162a"],
    },
    {
      id: "sky",
      name: "Sky blue",
      description: "Pale blue paper and a clear azure accent; midnight blue at night.",
      paper: "#f1f6fd",
      ink: "#06142b",
      brand: "#1d6fd1",
      accent: { light: { strong: "#145bb0", main: "#1d6fd1", soft: "#dcebfb" }, dark: { strong: "#a9cdf5", main: "#7fb4ee", soft: "#12325c" } },
      ramp: ["#e8f1fc", "#d0e3f9", "#9ec5f2", "#7fb4ee", "#4a8fe0", "#1d6fd1", "#145bb0", "#0f468a", "#0a3062", "#07234a"],
    },
    {
      id: "rose",
      name: "Rose pink",
      description: "Blush paper and a rose accent; plum at night.",
      paper: "#fdf3f7",
      ink: "#2e0a1a",
      brand: "#d6336c",
      accent: { light: { strong: "#b02457", main: "#d6336c", soft: "#fbe0ea" }, dark: { strong: "#f7b3cb", main: "#f28bb0", soft: "#4a1a30" } },
      ramp: ["#fce8ef", "#f9d2df", "#f3a6c1", "#f28bb0", "#e45a8c", "#d6336c", "#b02457", "#8c1c45", "#631331", "#4a0e25"],
    },
    {
      id: "meadow",
      name: "Pastel pink & green",
      description: "Blush paper with mint accents and deep green text; pine and pink at night.",
      paper: "#fcf1f5",
      ink: "#0d2a1b",
      brand: "#d9729a",
      accent: { light: { strong: "#2a7a52", main: "#36926a", soft: "#dcf3e5" }, dark: { strong: "#bfe9cf", main: "#9fdcb4", soft: "#1c3f2d" } },
      ramp: ["#e6f6ec", "#cdeeda", "#9fdcb4", "#86d0a2", "#5bb384", "#36926a", "#2a7a52", "#215f41", "#17442f", "#113424"],
    },
    {
      id: "orchid",
      name: "Pink & purple",
      description: "Pale pink paper with a violet accent and plum text; aubergine and lilac at night.",
      paper: "#fdf1f7",
      ink: "#22103a",
      brand: "#d6479a",
      accent: { light: { strong: "#5e2a96", main: "#7a3fb8", soft: "#ecdcf7" }, dark: { strong: "#d8bcf5", main: "#c49cf0", soft: "#3c2160" } },
      ramp: ["#f3e8fb", "#e5d2f7", "#c9a6ee", "#b98ae8", "#9a63d4", "#7a3fb8", "#5e2a96", "#482074", "#331655", "#260f40"],
    },
    {
      id: "paper",
      name: "Warm paper",
      description: "Cream and sepia, like a printed page; a warm brown at night.",
      paper: "#fbf5e8",
      ink: "#241a10",
      brand: "#b5542d",
      accent: { light: { strong: "#8f3f1f", main: "#b5542d", soft: "#f6e4d8" }, dark: { strong: "#eaa987", main: "#d98b5f", soft: "#3f2a1d" } },
      ramp: ["#f6e4d8", "#f0d2bf", "#dfa283", "#d58c67", "#c56a3f", "#b5542d", "#8f3f1f", "#6f3119", "#4e2311", "#3d1b0d"],
    },
    {
      id: "slate",
      name: "Slate",
      description: "Cool greys and steel blue, easy on the eyes for long sessions.",
      paper: "#f4f6f9",
      ink: "#0e131a",
      brand: "#2f6f9f",
      accent: { light: { strong: "#225579", main: "#2f6f9f", soft: "#e1edf6" }, dark: { strong: "#9ac4e8", main: "#6ea8d8", soft: "#1d2f41" } },
      ramp: ["#e1edf6", "#c8dcec", "#8fb6d6", "#6fa2ca", "#4886b5", "#2f6f9f", "#225579", "#1a4360", "#123043", "#0d2433"],
    },
    {
      id: "forest",
      name: "Forest",
      description: "Soft greens on off-white; moss and pine at night.",
      paper: "#f3f7f2",
      ink: "#0b170f",
      brand: "#2e7d4f",
      accent: { light: { strong: "#1f5e3a", main: "#2e7d4f", soft: "#dff0e5" }, dark: { strong: "#9bd6b2", main: "#6cc08b", soft: "#1b3324" } },
      ramp: ["#dff0e5", "#c4e3cf", "#8ac6a2", "#6ab589", "#43996a", "#2e7d4f", "#1f5e3a", "#17482d", "#0f3420", "#0b2818"],
    },
    {
      id: "contrast",
      name: "High contrast",
      description: "Black on white, white on black, strong borders, one vivid accent.",
      paper: "#ffffff",
      ink: "#000000",
      brand: "#0000d6",
      strongBorders: true,
      accent: { light: { strong: "#0000a8", main: "#0000d6", soft: "#e0e0ff" }, dark: { strong: "#ffe766", main: "#ffd60a", soft: "#332b00" } },
      ramp: {
        light: ["#e0e0ff", "#c2c2ff", "#8585ff", "#6666ff", "#3333ff", "#0000d6", "#0000a8", "#000080", "#000059", "#000040"],
        dark: ["#332b00", "#4d4000", "#806b00", "#b39500", "#e6c000", "#ffd60a", "#ffe04d", "#ffe980", "#fff2b3", "#fff8d9"],
      },
    },
  ];

  var DEFAULT_THEME = "default";
  var ATTR = "data-hub-theme";
  var STYLE_ID = "hub-companion-theme";

  function byId(id) {
    for (var i = 0; i < THEMES.length; i++) if (THEMES[i].id === id) return THEMES[i];
    return null;
  }

  function isTheme(id) {
    return !!byId(id);
  }

  function hexToRgb(hex) {
    var s = String(hex || "").trim().replace(/^#/, "");
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-f]{6}$/i.test(s)) return null;
    var n = parseInt(s, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function rgbToHex(c) {
    var h = function (v) { v = Math.max(0, Math.min(255, Math.round(v))); return (v < 16 ? "0" : "") + v.toString(16); };
    return "#" + h(c.r) + h(c.g) + h(c.b);
  }

  // The older tokens are HSL triplets without the function: "48 33.3% 97.1%".
  function hexToHslTriplet(hex) {
    var c = hexToRgb(hex);
    if (!c) return null;
    var r = c.r / 255, g = c.g / 255, b = c.b / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var h = 0, s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    var round = function (x) { return Math.round(x * 10) / 10; };
    return Math.round(h) + " " + round(s * 100) + "% " + round(l * 100) + "%";
  }

  function withAlpha(hex, alpha) {
    var a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
    return hex + (a < 16 ? "0" : "") + a.toString(16);
  }

  // Straight-line mix in RGB. claude.ai's own ramp is close to linear from
  // white to near-black, so the same shape with tinted ends keeps every
  // derived shade (hover fills, muted text, borders) where it expects it.
  function mix(hexA, hexB, t) {
    var a = hexToRgb(hexA), b = hexToRgb(hexB);
    return rgbToHex({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });
  }

  // {0: paper, 10: …, 900: ink}
  function grayRamp(theme) {
    var out = {};
    for (var i = 0; i < GRAY_STEPS.length; i++) out[GRAY_STEPS[i]] = mix(theme.paper, theme.ink, GRAY_STEPS[i] / 900);
    return out;
  }

  function accentRamp(theme, mode) {
    return Array.isArray(theme.ramp) ? theme.ramp : theme.ramp[mode];
  }

  // WCAG relative luminance and contrast ratio, used by the tests to keep
  // every theme readable.
  function luminance(hex) {
    var c = hexToRgb(hex);
    if (!c) return 0;
    var f = function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }

  function contrast(hexA, hexB) {
    var a = luminance(hexA), b = luminance(hexB);
    var hi = Math.max(a, b), lo = Math.min(a, b);
    return (hi + 0.05) / (lo + 0.05);
  }

  // The colours a mode actually shows, on the steps claude.ai reads them
  // from (its v2 token block): page, card, text shades, border.
  function palette(theme, mode) {
    var g = grayRamp(theme);
    var dark = mode === "dark";
    return {
      gray: g,
      page: dark ? g[870] : g[20],
      card: dark ? g[800] : g[0],
      text: dark ? g[20] : g[860],
      textSecondary: dark ? g[200] : g[700],
      textMuted: dark ? g[350] : g[450],
      border: dark ? g[100] : g[810],
      accent: theme.accent[mode],
      ramp: accentRamp(theme, mode),
    };
  }

  // The declarations for one mode of one theme, as "--name: value;" lines.
  function declarations(theme, mode) {
    var p = palette(theme, mode);
    var g = p.gray, ramp = p.ramp, accent = p.accent;
    var dark = mode === "dark";
    var t = hexToHslTriplet;
    var lines = [];
    var put = function (name, value) { if (value) lines.push(name + ": " + value + ";"); };

    // The grey ramp: everything else in the design system follows from it.
    for (var i = 0; i < GRAY_STEPS.length; i++) put("--cds-gray-" + GRAY_STEPS[i], g[GRAY_STEPS[i]]);

    // The older family, on the same steps claude.ai's v2 block uses.
    var bg = dark ? [g[800], g[850], g[870], g[890], g[900]] : [g[0], g[20], g[40], g[50], g[80]];
    put("--bg-000", t(bg[0]));
    put("--bg-100", t(bg[1]));
    put("--bg-200", t(bg[2]));
    put("--bg-300", t(bg[3]));
    put("--bg-400", t(bg[4]));
    put("--bg-500", t(bg[4]));
    put("--text-000", t(p.text));
    put("--text-100", t(p.text));
    put("--text-200", t(p.textSecondary));
    put("--text-300", t(p.textSecondary));
    put("--text-400", t(p.textMuted));
    put("--text-500", t(p.textMuted));
    put("--border-100", t(p.border));
    put("--border-200", t(p.border));
    put("--border-300", t(p.border));
    put("--border-400", t(p.border));
    put("--accent-000", t(accent.strong));
    put("--accent-100", t(accent.main));
    put("--accent-200", t(accent.main));
    put("--accent-900", t(accent.soft));
    put("--accent-brand", t(theme.brand));
    put("--brand-100", t(theme.brand));
    put("--brand-200", t(theme.brand));

    // The accent ramp and the few accent roles claude.ai sets by hand.
    for (var j = 0; j < ACCENT_STEPS.length; j++) put("--cds-role-accent-" + ACCENT_STEPS[j], ramp[j]);
    put("--cds-role-accent-fill", accent.main);
    put("--cds-role-accent-fill-hover", accent.strong);
    put("--cds-role-accent-on", dark && luminance(accent.main) > 0.4 ? g[900] : "#ffffff");
    put("--cds-text-accent", dark ? ramp[3] : ramp[6]);
    put("--cds-bg-accent", dark ? ramp[8] : ramp[1]);

    if (theme.strongBorders) {
      put("--cds-border", withAlpha(p.text, 0.6));
      put("--cds-border-strong", withAlpha(p.text, 0.9));
    }
    return lines;
  }

  // Specificity has to beat claude.ai's own rules without !important: its
  // token blocks are selected by up to three attributes, and its dark
  // design-system block by three. Repeating [data-theme] counts each time.
  function rootSelector(id, extra) {
    return 'html[' + ATTR + '="' + id + '"]' + (extra || "") + "[data-theme][data-theme][data-theme][data-theme]";
  }

  // claude.ai re-declares the design-system tokens on every element that
  // carries .cds-root or .cds-dark-scope, not only on <html>; the grey ramp
  // itself lives on :root and is inherited, but the accent roles and the
  // older tokens are safest set on those scopes too.
  function selector(id, extra) {
    var r = rootSelector(id, extra);
    return r + ",\n" + r + " .cds-root,\n" + r + " .cds-dark-scope";
  }

  /**
   * The stylesheet for one theme id, or "" for the default (no overrides).
   * Light values apply unless claude.ai says dark; "system" follows the OS.
   */
  function cssFor(id) {
    var theme = byId(id);
    if (!theme || !theme.paper) return "";
    var light = declarations(theme, "light").join("\n  ");
    var dark = declarations(theme, "dark").join("\n  ");
    return [
      selector(id) + " {\n  " + light + "\n}",
      selector(id, '[data-mode="dark"]') + " {\n  " + dark + "\n}",
      "@media (prefers-color-scheme: dark) {\n" + selector(id, '[data-mode="system"]') + " {\n  " + dark + "\n}\n}",
    ].join("\n");
  }

  // Three swatch colours (page, text, accent) for a theme chip in the
  // options page and the panel, from the theme itself.
  function swatches(id, dark) {
    var theme = byId(id);
    if (!theme || !theme.paper) return null;
    var p = palette(theme, dark ? "dark" : "light");
    return { bg: p.page, text: p.text, accent: p.accent.main };
  }

  var api = {
    THEMES: THEMES,
    DEFAULT_THEME: DEFAULT_THEME,
    ATTR: ATTR,
    STYLE_ID: STYLE_ID,
    GRAY_STEPS: GRAY_STEPS,
    byId: byId,
    isTheme: isTheme,
    hexToRgb: hexToRgb,
    hexToHslTriplet: hexToHslTriplet,
    withAlpha: withAlpha,
    mix: mix,
    contrast: contrast,
    palette: palette,
    declarations: declarations,
    cssFor: cssFor,
    swatches: swatches,
  };

  root.HubThemes = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
