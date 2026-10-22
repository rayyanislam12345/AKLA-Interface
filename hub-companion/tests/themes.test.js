// node --test hub-companion/tests/themes.test.js
import { test } from "node:test";
import assert from "node:assert/strict";

await import("../themes.js");
const T = globalThis.HubThemes;

const coloured = T.THEMES.filter((t) => t.paper);
const HEX = /^#[0-9a-f]{6}$/;

test("themes: the default exists, a blue and a pink are offered, and every coloured theme is complete", () => {
  assert.equal(T.THEMES[0].id, "default");
  assert.ok(coloured.length >= 6, "at least six coloured themes");
  assert.ok(T.isTheme("sky") && T.isTheme("rose"), "a blue and a pink theme");
  for (const t of coloured) {
    assert.match(t.paper, HEX, `${t.id} paper`);
    assert.match(t.ink, HEX, `${t.id} ink`);
    assert.match(t.brand, HEX, `${t.id} brand`);
    for (const mode of ["light", "dark"]) {
      const a = t.accent[mode];
      for (const hex of [a.strong, a.main, a.soft]) assert.match(hex, HEX, `${t.id} ${mode} accent`);
      const ramp = Array.isArray(t.ramp) ? t.ramp : t.ramp[mode];
      assert.equal(ramp.length, 10, `${t.id} ${mode} ramp`);
      for (const hex of ramp) assert.match(hex, HEX, `${t.id} ${mode} ramp ${hex}`);
    }
  }
});

test("hexToHslTriplet matches claude.ai's own notation; mix and alpha behave", () => {
  assert.equal(T.hexToHslTriplet("#ffffff"), "0 0% 100%");
  assert.equal(T.hexToHslTriplet("#000000"), "0 0% 0%");
  assert.equal(T.hexToHslTriplet("#f9f8f4"), "48 29.4% 96.7%");
  assert.equal(T.hexToHslTriplet("nope"), null);
  assert.equal(T.withAlpha("#123456", 0.5), "#12345680");
  assert.equal(T.mix("#000000", "#ffffff", 0.5), "#808080");
  assert.equal(T.mix("#ffffff", "#000000", 0), "#ffffff");
});

test("the grey ramp runs from paper to ink through all of claude.ai's steps", () => {
  const p = T.palette(T.byId("akla"), "light");
  assert.equal(Object.keys(p.gray).length, T.GRAY_STEPS.length);
  assert.equal(p.gray[0], "#f9f7f1");
  assert.equal(p.gray[900], "#0a1120");
  // Monotonic: each step is no lighter than the one before.
  let last = Infinity;
  for (const step of T.GRAY_STEPS) {
    const l = T.contrast(p.gray[step], "#000000");
    assert.ok(l <= last + 1e-9, `step ${step} lighter than the step before`);
    last = l;
  }
});

test("every theme keeps text readable in both modes: 7:1 body text, 4.5:1 secondary, 3:1 accent", () => {
  for (const t of coloured) {
    for (const mode of ["light", "dark"]) {
      const p = T.palette(t, mode);
      const tag = `${t.id} ${mode}`;
      assert.ok(T.contrast(p.text, p.page) >= 7, `${tag} body text ${T.contrast(p.text, p.page).toFixed(1)}`);
      assert.ok(T.contrast(p.text, p.card) >= 7, `${tag} body text on cards ${T.contrast(p.text, p.card).toFixed(1)}`);
      assert.ok(T.contrast(p.textSecondary, p.page) >= 4.5, `${tag} secondary text ${T.contrast(p.textSecondary, p.page).toFixed(1)}`);
      assert.ok(T.contrast(p.accent.main, p.page) >= 3, `${tag} accent on page ${T.contrast(p.accent.main, p.page).toFixed(1)}`);
    }
    assert.ok(T.contrast("#000000", T.palette(t, "light").page) > T.contrast("#ffffff", T.palette(t, "light").page), `${t.id} light mode is light`);
    assert.ok(T.contrast("#ffffff", T.palette(t, "dark").page) > T.contrast("#000000", T.palette(t, "dark").page), `${t.id} dark mode is dark`);
  }
});

test("cssFor: the default produces nothing; a theme produces light, dark and system blocks on the root and its nested scopes", () => {
  assert.equal(T.cssFor("default"), "");
  assert.equal(T.cssFor("no-such-theme"), "");
  const css = T.cssFor("akla");
  assert.ok(!css.includes("undefined") && !css.includes("null") && !css.includes("NaN"), "no missing values");
  assert.ok(!css.includes("!important"), "never !important");
  assert.ok(css.includes('html[data-hub-theme="akla"][data-theme][data-theme][data-theme][data-theme],'));
  assert.ok(css.includes('html[data-hub-theme="akla"][data-theme][data-theme][data-theme][data-theme] .cds-root'));
  assert.ok(css.includes(" .cds-dark-scope {"));
  assert.ok(css.includes('html[data-hub-theme="akla"][data-mode="dark"][data-theme]'));
  assert.ok(css.includes("@media (prefers-color-scheme: dark)"));
  assert.ok(css.includes('[data-mode="system"]'));
  for (const token of ["--cds-gray-0", "--cds-gray-20", "--cds-gray-870", "--cds-gray-900", "--bg-100", "--text-100", "--border-200", "--accent-100", "--accent-brand", "--cds-role-accent-450", "--cds-role-accent-fill", "--cds-text-accent", "--cds-bg-accent"]) {
    assert.ok(css.includes(token + ":"), `sets ${token}`);
  }
  // Derived by claude.ai from the grey ramp, or deliberately left to it.
  for (const token of ["--cds-surface-0", "--cds-neutral-30", "--cds-text-primary", "--danger-100", "--success-100", "--warning-100"]) {
    assert.ok(!css.includes(token + ":"), `leaves ${token} to claude.ai`);
  }
  assert.match(css, /--bg-100: \d+ [\d.]+% [\d.]+%;/, "older family is HSL triplets");
  assert.match(css, /--cds-gray-20: #[0-9a-f]{6};/, "design-system family is plain colours");
  // High contrast is the only theme that forces the translucent borders.
  assert.ok(T.cssFor("contrast").includes("--cds-border:"));
  assert.ok(!css.includes("--cds-border:"));
});

test("swatches come from the theme itself", () => {
  const s = T.swatches("rose", false);
  assert.equal(s.accent, "#d6336c");
  assert.match(s.bg, HEX);
  assert.ok(T.contrast(s.text, s.bg) >= 7);
  assert.equal(T.swatches("default", false), null);
  assert.equal(T.isTheme("slate"), true);
  assert.equal(T.isTheme(""), false);
});

test("every chat theme tells the Hub which of its own themes to wear (HUB_THEME in panel.js)", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../panel.js", import.meta.url), "utf8");
  const m = src.match(/var HUB_THEME = (\{[^}]+\})/);
  assert.ok(m, "HUB_THEME is declared in panel.js");
  const map = Function("return (" + m[1] + ")")();
  const hubIds = ["warm", "blue", "pink", "orange", "green", "slate", "contrast", "night", "monokai"]; // src/ai/theme.ts
  for (const t of T.THEMES) {
    assert.ok(t.id in map, `${t.id} has a Hub theme`);
    assert.ok(hubIds.includes(map[t.id]), `${t.id} maps to a Hub theme the Hub knows (${map[t.id]})`);
  }
});
