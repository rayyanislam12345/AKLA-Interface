// Loads the unpacked extension into a real Chrome and checks that the
// manifest is accepted, the service worker starts, the panel and options
// pages open without errors, and the content script on a fixture page (the
// script is run there by hand, since it only auto-runs on claude.ai) puts
// its small "Open beside the chat" button after a bare Hub address and none
// after a Hub link, takes a plain click on a Hub link for itself (the link
// opens beside the chat) and leaves a Cmd/Ctrl click to the browser.
//
//   node hub-companion/tests/load-check.mjs
//
// Needs a display: extensions do not load in old headless mode. Branded
// Google Chrome 137 and later ignores --load-extension, so this uses
// Playwright's own Chromium (Chrome for Testing): the one the installed
// playwright expects, else any in ~/Library/Caches/ms-playwright, else the
// path in HUB_COMPANION_BROWSER.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const ext = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hub-companion-profile-"));
const manifest = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
const problems = [];
const note = (s) => console.log(s);

function findBrowser() {
  if (process.env.HUB_COMPANION_BROWSER) return process.env.HUB_COMPANION_BROWSER;
  const own = chromium.executablePath();
  if (fs.existsSync(own)) return own;
  const cache = path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  if (fs.existsSync(cache)) {
    const dirs = fs.readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      const p = path.join(cache, d, "chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing");
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
const executablePath = findBrowser();
if (!executablePath) {
  console.error("No Chromium that loads unpacked extensions was found. Run `npx playwright install chromium` or set HUB_COMPANION_BROWSER.");
  process.exit(2);
}
note(`browser: ${executablePath}`);

const context = await chromium.launchPersistentContext(profile, {
  executablePath,
  headless: false,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

try {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(worker.url()).host;
  note(`service worker: ${worker.url()}`);
  const expected = fs.existsSync(path.join(ext, "tests", "expected-id.txt"))
    ? fs.readFileSync(path.join(ext, "tests", "expected-id.txt"), "utf8").trim()
    : null;
  if (expected && expected !== id) problems.push(`extension id ${id} differs from expected ${expected}`);

  const name = await worker.evaluate(() => chrome.runtime.getManifest().name);
  if (name !== manifest.name) problems.push(`manifest name mismatch: ${name}`);
  const behaviour = await worker.evaluate(() => chrome.sidePanel.getPanelBehavior());
  // The default view is the in-page drawer: the toolbar button toggles it, so
  // Chrome's own open-on-click must be off (it is on only in the side view).
  if (!behaviour || behaviour.openPanelOnActionClick !== false) problems.push("openPanelOnActionClick should be off in the default (in-page) view");
  note(`panel behaviour: ${JSON.stringify(behaviour)}`);

  for (const file of ["panel.html", "options.html"]) {
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
    page.on("console", (m) => {
      if (m.type() === "error") errors.push(`console: ${m.text()}`);
    });
    await page.goto(`chrome-extension://${id}/${file}`);
    await page.waitForTimeout(800);
    if (file === "panel.html") {
      // A fresh profile has no remembered page, so the panel shows its
      // "No document yet" state and leaves the frame empty; a remembered
      // page shows in the frame with embed=1.
      const src = await page.getAttribute("#frame", "src");
      const idleShown = await page.$eval("#idle", (el) => !el.hidden);
      note(`panel frame src: ${src}; idle shown: ${idleShown}`);
      if (!idleShown && (!src || !src.includes("embed=1"))) problems.push("panel showed neither its idle state nor an embed URL");
      const themes = await page.$$eval("#theme option", (o) => o.map((x) => x.value));
      note(`panel theme options: ${themes.join(",")}`);
      if (!themes.includes("default") || !themes.includes("akla")) problems.push("panel theme picker is missing themes");
    }
    if (errors.length) problems.push(`${file}: ${errors.join(" | ")}`);
    else note(`${file}: loaded, no errors`);
    await page.close();
  }

  // Content script on a fixture: not claude.ai, so inject the same two files.
  const fixture = await context.newPage();
  const errors = [];
  fixture.on("pageerror", (e) => errors.push(e.message));
  await fixture.setContent(`<!doctype html><main>
    <p>Open in Hub: https://akla-interface.vercel.app/ai/d/v-first.</p>
    <p>Project: <a href="https://akla-interface.vercel.app/ai/p/m-two">the project</a> and https://example.com/ai/d/nope</p>
    <div contenteditable="true">draft https://akla-interface.vercel.app/ai/c/t-ignored</div>
  </main>`);
  await fixture.addScriptTag({ path: path.join(ext, "links.js") });
  await fixture.addScriptTag({ path: path.join(ext, "content.js") });
  await fixture.waitForTimeout(900);
  const buttons = await fixture.$$eval("button.hub-companion-open", (b) => b.map((x) => ({ url: x.dataset.url, title: x.title, text: x.textContent, icon: !!x.querySelector("svg") })));
  note(`fixture buttons: ${JSON.stringify(buttons)}`);
  // Only the bare address gets a button; the link opens beside the chat itself.
  const want = ["https://akla-interface.vercel.app/ai/d/v-first"];
  if (JSON.stringify(buttons.map((b) => b.url)) !== JSON.stringify(want)) problems.push(`fixture buttons were ${JSON.stringify(buttons)}`);
  if (buttons[0] && (buttons[0].title !== "Open beside the chat" || buttons[0].text !== "" || !buttons[0].icon)) problems.push(`the button should be an icon titled "Open beside the chat": ${JSON.stringify(buttons[0])}`);
  // A second scan must not add duplicates.
  await fixture.evaluate(() => document.querySelector("main").appendChild(document.createElement("p")));
  await fixture.waitForTimeout(900);
  const again = await fixture.$$eval("button.hub-companion-open", (b) => b.length);
  if (again !== 1) problems.push(`buttons after a rescan: ${again}`);
  // A click on the Hub link: a plain one is the content script's (default
  // prevented), a Cmd/Ctrl one the browser's. Recorded by a capture listener
  // added after content.js's, which then stops the navigation either way.
  // (With no extension runtime on a fixture page, a plain click falls back
  // to a new tab, as when Chrome's side panel will not open; that window is
  // closed again.)
  await fixture.evaluate(() => {
    window.__clicks = [];
    window.addEventListener("click", (e) => {
      if (!e.target.closest || !e.target.closest("a")) return;
      window.__clicks.push(e.defaultPrevented);
      e.preventDefault();
    }, true);
  });
  const popups = [];
  context.on("page", (p) => popups.push(p));
  await fixture.click("a[href*='/ai/p/m-two']");
  await fixture.click("a[href*='/ai/p/m-two']", { modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
  await fixture.waitForTimeout(300);
  const clicks = await fixture.evaluate(() => window.__clicks);
  note(`fixture link clicks (default prevented): ${JSON.stringify(clicks)}`);
  if (JSON.stringify(clicks) !== JSON.stringify([true, false])) problems.push(`a plain click should be taken and a Cmd/Ctrl click left alone: ${JSON.stringify(clicks)}`);
  for (const p of popups) await p.close().catch(() => {});
  if (errors.length) problems.push(`fixture: ${errors.join(" | ")}`);
  await fixture.close();
} catch (e) {
  problems.push(`failed: ${e.message}`);
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

if (problems.length) {
  console.error("PROBLEMS:\n- " + problems.join("\n- "));
  process.exit(1);
}
console.log("OK: extension loads, service worker runs, pages open, content script places buttons.");
