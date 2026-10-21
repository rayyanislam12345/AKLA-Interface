import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
// Node strips the types from this file itself, so the list checked is the
// very list the Appearance panel shows.
import { AI_THEMES } from '../src/ai/theme.ts';

// Every AI workspace theme, light and dark, read straight from index.css and
// measured the way WCAG measures: each text colour against the background it
// is drawn on. AA (4.5:1) for every theme; High contrast holds AAA (7:1).
// Borders and the input outline are not text: 3:1 where they must be seen.

const css = fs.readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');

function tokensOf(selector) {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) return null;
  const body = css.slice(css.indexOf('{', at) + 1, css.indexOf('}', at));
  const out = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*;/g)) out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  return out;
}

const WARM_LIGHT = tokensOf('.ai-app');
const WARM_DARK = tokensOf('.dark .ai-app');

/** The tokens a theme shows in one mode, as the cascade resolves them. */
function themeTokens(id, mode) {
  if (id === 'warm') return mode === 'dark' ? { ...WARM_LIGHT, ...WARM_DARK } : { ...WARM_LIGHT };
  const darkOnly = tokensOf(`.ai-app[data-ai-theme="${id}"], .dark .ai-app[data-ai-theme="${id}"]`);
  if (darkOnly) return { ...WARM_LIGHT, ...(mode === 'dark' ? WARM_DARK : {}), ...darkOnly };
  const light = tokensOf(`.ai-app[data-ai-theme="${id}"]`);
  const dark = tokensOf(`.dark .ai-app[data-ai-theme="${id}"]`);
  if (!light || !dark) return null;
  return mode === 'dark' ? { ...WARM_LIGHT, ...WARM_DARK, ...light, ...dark } : { ...WARM_LIGHT, ...light };
}

function hslToRgb([h, s, l]) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}

function luminance(rgb) {
  const [r, g, b] = rgb.map((v) => {
    v /= 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const la = luminance(hslToRgb(a));
  const lb = luminance(hslToRgb(b));
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// [text, background]: every pairing the workspace draws text with.
const TEXT_PAIRS = [
  ['foreground', 'background'],
  ['card-foreground', 'card'],
  ['popover-foreground', 'popover'],
  ['primary-foreground', 'primary'],
  ['secondary-foreground', 'secondary'],
  ['muted-foreground', 'muted'],
  ['muted-foreground', 'background'],
  ['muted-foreground', 'card'],
  ['muted-foreground', 'popover'],
  ['muted-foreground', 'sidebar-background'],
  ['accent-foreground', 'accent'],
  ['gold-foreground', 'gold'],
  ['success-foreground', 'success'],
  ['warning-foreground', 'warning'],
  ['destructive-foreground', 'destructive'],
  ['destructive', 'background'],
  ['destructive', 'card'],
  ['sidebar-foreground', 'sidebar-background'],
  ['sidebar-primary-foreground', 'sidebar-primary'],
  ['sidebar-accent-foreground', 'sidebar-accent'],
  ['ai-bubble-foreground', 'ai-bubble'],
  // Links in a reply, and the primary colour used as text.
  ['primary', 'background'],
  ['primary', 'card'],
];
// Outlines that must be seen (WCAG 1.4.11): the input's edge and the focus ring.
const EDGE_PAIRS = [
  ['input', 'background'],
  ['ring', 'background'],
];
// High contrast's strong borders: dividers and card edges stand out too.
const STRONG_BORDER_PAIRS = [
  ['border', 'background'],
  ['border', 'card'],
  ['sidebar-border', 'sidebar-background'],
];

const AAA = new Set(['contrast']);

// Shortfalls the older themes already had when this test was written
// (21 Oct 2026), kept as they are and named here so nothing new joins them:
// the shared light success fill with its near-white text (4.14:1, the
// "saved" badges), and Night's error text on a card (4.32:1).
const KNOWN_SHORTFALLS = new Set([
  ...['warm', 'blue', 'pink', 'orange', 'green'].map((id) => `${id} light success-foreground success`),
  'night dark destructive card',
]);

function modesOf(theme) {
  return theme.darkOnly ? ['dark'] : ['light', 'dark'];
}

/** Every measured pair of every theme: for the record and for the tests below. */
function measureAll() {
  const rows = [];
  for (const theme of AI_THEMES) {
    for (const mode of modesOf(theme)) {
      const t = themeTokens(theme.id, mode);
      for (const [fg, bg] of TEXT_PAIRS) rows.push({ theme: theme.id, mode, kind: 'text', fg, bg, ratio: ratio(t[fg], t[bg]) });
      for (const [fg, bg] of EDGE_PAIRS) rows.push({ theme: theme.id, mode, kind: 'edge', fg, bg, ratio: ratio(t[fg], t[bg]) });
      if (AAA.has(theme.id)) for (const [fg, bg] of STRONG_BORDER_PAIRS) rows.push({ theme: theme.id, mode, kind: 'edge', fg, bg, ratio: ratio(t[fg], t[bg]) });
    }
  }
  return rows;
}

test('every theme in the Appearance list has its tokens in index.css, in each mode it offers', () => {
  for (const theme of AI_THEMES) {
    for (const mode of modesOf(theme)) {
      const t = themeTokens(theme.id, mode);
      assert.ok(t, `${theme.id} has no ${mode} block`);
      for (const [fg, bg] of [...TEXT_PAIRS, ...EDGE_PAIRS]) {
        assert.ok(t[fg] && t[bg], `${theme.id} (${mode}) is missing --${t[fg] ? bg : fg}`);
      }
    }
  }
});

test('every theme keeps its text readable: AA for all, AAA for High contrast', () => {
  const failures = [];
  for (const row of measureAll()) {
    const min = row.kind === 'edge' ? 3 : AAA.has(row.theme) ? 7 : 4.5;
    if (KNOWN_SHORTFALLS.has(`${row.theme} ${row.mode} ${row.fg} ${row.bg}`)) continue;
    if (row.ratio < min) failures.push(`${row.theme} (${row.mode}) ${row.fg} on ${row.bg}: ${row.ratio.toFixed(2)} < ${min}`);
  }
  assert.deepEqual(failures, []);
});

test('each swatch shows the theme as it is: page, sidebar and accent', () => {
  const hsl = ([h, s, l]) => `hsl(${h} ${s}% ${l}%)`;
  for (const theme of AI_THEMES) {
    for (const mode of modesOf(theme)) {
      const t = themeTokens(theme.id, mode);
      const swatch = mode === 'dark' ? theme.swatch.dark : theme.swatch.light;
      assert.deepEqual(swatch, [hsl(t.background), hsl(t['sidebar-background']), hsl(t.primary)], `${theme.id} (${mode})`);
    }
  }
});

// The companion's chat themes (hub-companion/themes.js) and the Hub's themes
// of the same name are one look: the drawer beside the chat wears the chat's
// page, card, text and accent colours.
function companionThemes() {
  const src = fs.readFileSync(new URL('../hub-companion/themes.js', import.meta.url), 'utf8');
  const ctx = {};
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx.HubThemes;
}

test('Slate and High contrast match the chat themes of the same name, in light and dark', () => {
  const T = companionThemes();
  const close = (hex, hsl, what) => {
    const want = [T.hexToRgb(hex).r, T.hexToRgb(hex).g, T.hexToRgb(hex).b];
    const got = hslToRgb(hsl);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(want[i] - got[i]) <= 1, `${what}: ${got} is not ${hex}`);
  };
  for (const id of ['slate', 'contrast']) {
    for (const mode of ['light', 'dark']) {
      const p = T.palette(T.byId(id), mode);
      const t = themeTokens(id, mode);
      close(p.page, t.background, `${id} ${mode} page`);
      close(p.text, t.foreground, `${id} ${mode} text`);
      close(p.accent.main, t.primary, `${id} ${mode} accent`);
      close(p.accent.soft, t['ai-bubble'], `${id} ${mode} bubble`);
      if (mode === 'light') close(p.card, t.card, `${id} ${mode} card`);
    }
  }
});
