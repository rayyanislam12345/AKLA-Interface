// Checks "Ask Claude about this" end to end, without a claude.ai sign-in:
// the extension is loaded in Playwright's Chromium (as load-check.mjs does),
// https://claude.ai/ is answered by a fixture page holding a real ProseMirror
// editor (from this repository's node_modules) set up like a chat composer
// (Enter sends, a Send button, a form), and the Hub's address by a fake Hub
// page. Then:
//   1. composer.js on its own (put in the page by hand, like load-check does
//      for content.js): the paste path, the line-by-line typing path (paste
//      blocked), a plain textarea, and a box that swallows pastes (clipboard
//      and a notice). Each keeps the draft and sends nothing.
//   2. The real thing in the extension's own content-script world: "Open
//      beside" opens the drawer, the fake Hub inside it posts hub:selection,
//      and the quoted passage lands in the ProseMirror box after the draft,
//      unsent, with "Added to your message" in the drawer's notice line.
//   3. The side panel's route: the service worker hands the text to the
//      tab's composer.js (chrome.tabs.sendMessage), which adds it.
//
//   node hub-companion/tests/composer-check.mjs
//
// Needs a display (headless false), like load-check.mjs.
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..");
const repo = path.resolve(ext, "..");
const nm = path.join(repo, "node_modules");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "hub-companion-composer-"));
const problems = [];
const note = (s) => console.log(s);
const check = (ok, what) => {
  if (ok) note(`  ok: ${what}`);
  else problems.push(what);
};

await import("../passage.js");
const message = globalThis.HubPassage.selectionMessage({
  text: "14.2 The Seller shall indemnify the Buyer\n\nagainst all Losses arising from a Breach.",
  title: "Share Purchase Agreement",
  versionId: "ver-123",
  versionNumber: 3,
  fileName: "SPA [AKLA].docx",
  projectName: "Karachi Port",
});
const HEAD = 'In "Share Purchase Agreement" v3 (SPA [AKLA].docx), project Karachi Port — versionId: ver-123';
const DRAFT = "Please look at this:";

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

// ---- fixture pages ----
const MODULES = {
  "prosemirror-model": "prosemirror-model/dist/index.js",
  "prosemirror-transform": "prosemirror-transform/dist/index.js",
  "prosemirror-state": "prosemirror-state/dist/index.js",
  "prosemirror-view": "prosemirror-view/dist/index.js",
  "prosemirror-keymap": "prosemirror-keymap/dist/index.js",
  "prosemirror-commands": "prosemirror-commands/dist/index.js",
  orderedmap: "orderedmap/dist/index.js",
  "w3c-keyname": "w3c-keyname/index.js",
};
const importMap = JSON.stringify({ imports: Object.fromEntries(Object.entries(MODULES).map(([k, v]) => [k, `/__nm/${v}`])) });

// A chat-like page: a decoy editable and an "edit message" textarea earlier
// in the page, then the composer (ProseMirror, labelled, Enter sends), a
// Send button and a form whose submit is counted. ?block=paste stops pastes
// from reaching the editor (so the typing path runs); ?mode=textarea and
// ?mode=swallow swap the composer for a textarea, or for a box that eats
// pastes.
const CHAT_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture chat</title>
<script type="importmap">${importMap}</script>
<style>body{font:14px system-ui;margin:0;padding:20px}.ProseMirror{border:1px solid #888;min-height:60px;padding:8px;white-space:pre-wrap}#decoy{border:1px dashed #ccc;padding:6px;margin-bottom:12px}</style></head>
<body>
<main>
  <p>Claude said: Open in Hub: https://akla-interface.vercel.app/ai/d/ver-123</p>
  <div id="decoy" contenteditable="true">notes, not the composer</div>
  <textarea id="edit-old" rows="2">an earlier message being edited</textarea>
</main>
<form id="composer-form">
  <div id="composer"></div>
  <button id="send" type="submit">Send</button>
</form>
<script>
  window.__submits = 0; window.__enter = 0; window.__sendClicks = 0;
  document.getElementById("composer-form").addEventListener("submit", (e) => { e.preventDefault(); window.__submits++; });
  document.getElementById("send").addEventListener("click", () => { window.__sendClicks++; });
  const q = new URLSearchParams(location.search);
  if (q.get("block") === "paste") {
    window.addEventListener("paste", (e) => { if (!e.isTrusted) e.stopImmediatePropagation(); }, true);
  }
</script>
<script type="module">
  import { Schema } from "prosemirror-model";
  import { EditorState, TextSelection } from "prosemirror-state";
  import { EditorView } from "prosemirror-view";
  import { keymap } from "prosemirror-keymap";
  import { baseKeymap, splitBlock } from "prosemirror-commands";
  const q = new URLSearchParams(location.search);
  const mount = document.getElementById("composer");
  if (q.get("mode") === "textarea") {
    const t = document.createElement("textarea");
    t.id = "box"; t.setAttribute("aria-label", "Write your prompt to Claude"); t.value = ${JSON.stringify(DRAFT)};
    t.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); window.__enter++; } });
    mount.appendChild(t);
  } else if (q.get("mode") === "swallow") {
    const d = document.createElement("div");
    d.id = "box"; d.contentEditable = "true"; d.setAttribute("role", "textbox"); d.textContent = ${JSON.stringify(DRAFT)};
    d.addEventListener("paste", (e) => e.preventDefault()); // takes the paste, puts it nowhere
    mount.appendChild(d);
  } else {
    const schema = new Schema({ nodes: { doc: { content: "block+" }, paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0], parseDOM: [{ tag: "p" }] }, text: { group: "inline" } } });
    const doc = schema.node("doc", null, [schema.node("paragraph", null, [schema.text(${JSON.stringify(DRAFT)})])]);
    const send = () => { window.__enter++; return true; }; // claude.ai: Enter sends
    window.view = new EditorView(mount, {
      state: EditorState.create({ doc, plugins: [keymap({ Enter: send, "Shift-Enter": splitBlock }), keymap(baseKeymap)] }),
      attributes: { "aria-label": "Write your prompt to Claude", role: "textbox", id: "box" },
    });
    window.pmText = () => { const out = []; window.view.state.doc.forEach((n) => out.push(n.textContent)); return out; };
    window.pmCaretAtEnd = () => window.view.state.selection.empty && window.view.state.selection.head === window.view.state.doc.content.size - 1;
  }
  window.__ready = true;
</script>
</body></html>`;

// The Hub in the drawer: says its name, and posts a selection when asked.
const FAKE_HUB = `<!doctype html><html><head><meta charset="utf-8"><title>Fake Hub</title></head><body><p>Fake Hub document</p>
<script>
  window.ask = (ext, msg) => parent.postMessage(msg, ext);
  parent.postMessage({ type: "hub:location", href: location.href, title: "Share Purchase Agreement" }, "*");
</script></body></html>`;

const executablePath = findBrowser();
if (!executablePath) {
  console.error("No Chromium that loads unpacked extensions was found. Run `npx playwright install chromium` or set HUB_COMPANION_BROWSER.");
  process.exit(2);
}
note(`browser: ${executablePath}`);

const context = await chromium.launchPersistentContext(profile, {
  executablePath,
  headless: false,
  viewport: { width: 1400, height: 900 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "https://claude.ai" });
await context.route("https://claude.ai/**", (route) => {
  const u = new URL(route.request().url());
  if (u.pathname.startsWith("/__nm/")) {
    const file = path.join(nm, u.pathname.slice("/__nm/".length));
    if (!file.startsWith(nm) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({ status: 200, contentType: "text/javascript", body: fs.readFileSync(file, "utf8") });
  }
  if (u.pathname === "/favicon.ico") return route.fulfill({ status: 404, body: "" });
  return route.fulfill({ status: 200, contentType: "text/html", body: CHAT_PAGE });
});
await context.route("https://akla-interface.vercel.app/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: FAKE_HUB }));

async function chatPage(query = "", { inject = true } = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`https://claude.ai/chat/fixture${query}`);
  await page.waitForFunction(() => window.__ready === true);
  if (inject) await page.addScriptTag({ path: path.join(ext, "composer.js") });
  return { page, errors };
}
const counters = (page) => page.evaluate(() => ({ submits: window.__submits, enter: window.__enter, sendClicks: window.__sendClicks }));
const nothingSent = (c) => c.submits === 0 && c.enter === 0 && c.sendClicks === 0;
const quotedLines = message.trimEnd().split("\n").slice(1);

try {
  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 15000 });
  const id = new URL(worker.url()).host;
  note(`extension: ${id}`);

  // ---- 1. composer.js by hand ----
  note("ProseMirror, paste:");
  {
    const { page, errors } = await chatPage();
    // The lawyer last clicked in the decoy; the box with focus wins only if
    // it is an editable box, so focus the composer the way a person would.
    await page.click("#box");
    const r = await page.evaluate((t) => window.HubComposer.insert(t), message);
    const text = await page.evaluate(() => window.pmText());
    note(`  result: ${JSON.stringify(r)}; paragraphs: ${JSON.stringify(text)}`);
    check(r.ok && r.how === "paste", "the synthetic paste was taken by ProseMirror");
    check(text[0] === DRAFT, "the draft is kept, first");
    check(text[1] === HEAD && JSON.stringify(text.slice(2, 2 + quotedLines.length)) === JSON.stringify(quotedLines.filter((l) => l !== "")), "the heading and quoted lines follow, one per paragraph");
    check(text[text.length - 1] === "", "it ends on an empty line");
    check(await page.evaluate(() => window.pmCaretAtEnd()), "the caret is at the end");
    check(await page.evaluate(() => document.activeElement && document.activeElement.id === "box"), "the box has focus");
    check(nothingSent(await counters(page)), "nothing was sent (no Enter, no submit, no Send click)");
    check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
    await page.close();
  }

  note("ProseMirror, paste blocked (typing line by line):");
  {
    const { page, errors } = await chatPage("?block=paste");
    // No focus this time: the box is found by its label.
    const chosen = await page.evaluate(() => window.HubComposer.findBox() && window.HubComposer.findBox().id);
    check(chosen === "box", `the labelled composer is found without focus (got ${chosen})`);
    const r = await page.evaluate((t) => window.HubComposer.insert(t), message);
    const text = await page.evaluate(() => window.pmText());
    note(`  result: ${JSON.stringify(r)}; paragraphs: ${JSON.stringify(text)}`);
    check(r.ok && r.how === "typed", "execCommand typed it in");
    check(text[0] === DRAFT && text[1] === HEAD, "the draft is kept and the heading follows");
    check(text.join("\n").includes(quotedLines[0]), "the quoted passage is there");
    check(await page.evaluate(() => window.pmCaretAtEnd()), "the caret is at the end");
    check(nothingSent(await counters(page)), "nothing was sent (the new paragraphs were not taken for Enter)");
    check(errors.length === 0, `no page errors (${errors.join(" | ")})`);
    await page.close();
  }

  note("Textarea:");
  {
    const { page } = await chatPage("?mode=textarea");
    await page.click("#box");
    const r = await page.evaluate((t) => window.HubComposer.insert(t), message);
    const value = await page.$eval("#box", (t) => t.value);
    check(r.ok && r.how === "typed", `typed into the textarea (${JSON.stringify(r)})`);
    check(value === `${DRAFT}\n\n${message}`, "the draft, a blank line, then the message");
    check(await page.$eval("#box", (t) => t.selectionStart === t.value.length && t.selectionEnd === t.value.length), "the caret is at the end");
    check(await page.$eval("#edit-old", (t) => t.value === "an earlier message being edited"), "the other textarea is untouched");
    check(nothingSent(await counters(page)), "nothing was sent");
    await page.close();
  }

  note("A box that eats pastes (clipboard fallback):");
  {
    const { page } = await chatPage("?mode=swallow");
    await page.click("#box");
    const r = await page.evaluate((t) => window.HubComposer.insert(t), message);
    const content = await page.$eval("#box", (b) => b.textContent);
    const shown = await page.$eval("#hub-companion-composer-notice", (n) => n.textContent).catch(() => null);
    const clip = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null);
    note(`  result: ${JSON.stringify(r)}; notice: ${shown}`);
    check(r.ok === false && r.how === "clipboard", "fell back to the clipboard");
    check(content === DRAFT, "nothing typed twice, the draft untouched");
    check(shown === "Copied: paste it into the chat", "the notice by the box says so");
    check(clip === message, "the clipboard holds the message");
    check(nothingSent(await counters(page)), "nothing was sent");
    await page.close();
  }

  // ---- 2. the drawer, end to end, in the extension's own world ----
  note("Drawer, end to end:");
  {
    const { page, errors } = await chatPage("", { inject: false });
    await page.waitForSelector("button.hub-companion-open", { timeout: 5000 });
    await page.click("#box"); // the lawyer was typing in the chat
    await page.click("button.hub-companion-open");
    const panel = await (async () => {
      for (let i = 0; i < 50; i++) {
        const f = page.frames().find((fr) => fr.url().startsWith(`chrome-extension://${id}/panel.html`));
        if (f) return f;
        await page.waitForTimeout(100);
      }
      return null;
    })();
    check(!!panel, "the drawer opened with the panel inside");
    const hub = await (async () => {
      for (let i = 0; i < 80; i++) {
        const f = page.frames().find((fr) => fr.url().startsWith("https://akla-interface.vercel.app/ai/d/ver-123"));
        if (f) return f;
        await page.waitForTimeout(100);
      }
      return null;
    })();
    check(!!hub, "the fake Hub loaded in the drawer");
    if (panel && hub) {
      await hub.waitForFunction(() => typeof window.ask === "function");
      await hub.evaluate(
        ([extOrigin]) =>
          window.ask(extOrigin, {
            type: "hub:selection",
            text: "14.2 The Seller shall indemnify the Buyer\n\nagainst all Losses arising from a Breach.",
            truncated: false,
            title: "Share Purchase Agreement",
            versionId: "ver-123",
            versionNumber: 3,
            fileName: "SPA [AKLA].docx",
            projectName: "Karachi Port",
          }),
        [`chrome-extension://${id}`]
      );
      await page.waitForFunction((head) => window.pmText().includes(head), HEAD, { timeout: 5000 }).catch(() => {});
      const text = await page.evaluate(() => window.pmText());
      note(`  paragraphs: ${JSON.stringify(text)}`);
      check(text[0] === DRAFT && text[1] === HEAD && text.includes(quotedLines[0]), "the passage landed in the composer after the draft");
      check(await page.evaluate(() => window.pmCaretAtEnd()), "the caret is at the end");
      await panel.waitForFunction(() => !document.getElementById("notice").hidden, null, { timeout: 3000 }).catch(() => {});
      const said = await panel.$eval("#notice", (n) => (n.hidden ? "" : n.textContent));
      check(/^Added to your message/.test(said), `the drawer says so ("${said}")`);
      // A message from anywhere but the Hub frame is ignored.
      await page.evaluate(() => window.postMessage({ type: "hub:selection", text: "spoof", versionId: "x" }, "*"));
      await page.waitForTimeout(400);
      check(!(await page.evaluate(() => window.pmText().join("\n").includes("spoof"))), "a selection message from the page itself is ignored");
    }
    check(nothingSent(await counters(page)), "nothing was sent");
    // Known, and not this feature's: theme.js writes chrome.storage.session
    // from the content script, which Chrome refuses by default (its token
    // check, 1.5 s after load). Reported, not hidden: it is printed here.
    const known = /Access to storage is not allowed from this context/;
    errors.filter((e) => known.test(e)).forEach((e) => note(`  known (theme.js token check): ${e}`));
    const others = errors.filter((e) => !known.test(e));
    check(others.length === 0, `no page errors (${others.join(" | ")})`);
    await page.close();
  }

  // ---- 3. the side panel's route: worker to the tab's composer.js ----
  note("Side panel route (service worker to the tab):");
  {
    const { page } = await chatPage("", { inject: false });
    await page.click("#box");
    await page.bringToFront();
    const reply = await worker.evaluate(async (text) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: "https://claude.ai/*" });
      if (!tab) return { error: "no claude.ai tab" };
      return chrome.tabs.sendMessage(tab.id, { type: "composer:insert", text });
    }, message);
    const text = await page.evaluate(() => window.pmText());
    note(`  reply: ${JSON.stringify(reply)}`);
    check(reply && reply.ok && reply.how === "paste", "the content script added it (paste, from the isolated world)");
    check(text[0] === DRAFT && text[1] === HEAD, "after the draft");
    check(nothingSent(await counters(page)), "nothing was sent");
    await page.close();
  }
} catch (e) {
  problems.push(`failed: ${e.stack || e.message}`);
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

if (problems.length) {
  console.error("PROBLEMS:\n- " + problems.join("\n- "));
  process.exit(1);
}
console.log("OK: the passage goes into the composer after the draft, by paste, by typing or via the clipboard, and nothing is sent.");
