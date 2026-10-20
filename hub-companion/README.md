# AKLA Hub companion

A small Chrome/Edge extension that shows the firm's Hub beside your
claude.ai chat. When Claude answers with a line like
`Open in Hub: https://akla-interface.vercel.app/ai/d/<version>`, an
**Open beside** button appears after the link; click it and that document
(or project, or chat) opens on the right, with its formatting, version
compare, checks and the Changes list. You keep talking in the chat.

What it does, and all it does:

- On claude.ai, finds Hub links by their address (not by claude.ai's layout),
  puts an "Open beside" button after each, and remembers the newest one.
- **Where the Hub shows** (Settings, or the panel's menu):
  - **Inside the chat page** (the default): a drawer on the right of the
    claude.ai tab (`pane.js`). Drag its left edge to resize; the width is
    remembered. **Push** narrows the chat so nothing is covered; **Slide
    over** lays the drawer on top (always so on a window under 1,000 px).
    Each conversation remembers the last Hub page shown for it, so switching
    chats switches the document. The toolbar button shows or hides it. The
    drawer is one fixed element of the extension's own, never something
    added into claude.ai's components, so a redesign of the chat cannot
    break it; at worst Push looks wrong and Slide over still works.
  - **In Chrome's side panel**: the same panel, outside the page. Kept as
    the fallback.
- Either way the Hub opens with `?embed=1&host=companion`: no sidebar and no
  header of its own. The Hub tells the panel the page's name, and the
  panel's one bar shows it, with Back, Home, Open in the Hub, a menu (paste
  a link, colours, push or slide over, where the Hub shows, all settings)
  and, in the drawer, Close. The chat's colour theme is passed to the Hub
  (`aiTheme`), so the chat and the document wear the same colours.
- If **Follow new links** is on (the default), an open panel follows the
  newest Hub link Claude mentions: straight away when the panel has only
  just opened or changed page, otherwise as a one-line "Claude mentioned a
  document. Show it." notice, so nothing you are doing in the panel is lost
  under you.
- **Ask Claude about a passage.** Highlight words in a Word document in the
  drawer and a small **Ask Claude about this** button appears by them (Tab
  reaches it too). Click it and the chat's message box gets the passage,
  quoted, under a line naming the document, version, file, project and
  version id:

  ```
  In "Share Purchase Agreement" v3 (SPA [AKLA].docx), project Karachi Port — versionId: 0c1f…
  > 14.2 The Seller shall indemnify the Buyer
  > against all Losses arising from a Breach.
  ```

  with the cursor on a fresh line below it, after anything you had already
  typed, so you only add what you want ("tighten this", "make it mutual")
  and send. Nothing is ever sent for you. Passages over 4,000 characters are
  cut, and the message says so. The drawer's notice line says "Added to your
  message"; if the chat's box would not take it, the text is copied instead
  and a note by the box says "Copied: paste it into the chat". Works in
  Chrome's side panel too (it goes to the active claude.ai tab in that
  window). The button never shows in the ordinary Hub, only in the
  companion.
- **Chat colours.** Looks for the claude.ai chat itself: Claude (no change),
  AKLA navy, Sky blue, Rose pink, Warm paper, Slate, Forest and High
  contrast, each in light and dark. Pick one in the panel bar or the settings page; it
  applies at once on every claude.ai tab and the panel bar matches.

How the themes work: claude.ai paints everything from CSS variables on its
root element. One grey ramp (`--cds-gray-0` white to `--cds-gray-900` near
black) drives surfaces, text, borders and the older `--bg-*`/`--text-*`
tokens, read forwards in light mode and flipped in dark; an accent ramp
drives links and buttons. A theme in `themes.js` is a paper colour, an ink
colour, an accent ramp and a brand colour; the grey ramp is rebuilt between
paper and ink and claude.ai's own rules derive the rest in both modes; `theme.js` adds them as one
`<style>` on claude.ai and a `data-hub-theme` attribute on `<html>`, and
removes both for the default. Nothing in claude.ai's layout or class names
is touched, no `!important` is used, and a token the themes do not name
keeps claude.ai's own value. If claude.ai renames its tokens a theme falls
back to claude.ai's colours for whatever changed; the settings page shows a
note when that has happened (`theme.js` checks a few tokens after load).

Privacy: the extension sends nothing anywhere. It reads links on claude.ai
pages, talks only to its own side panel, and loads the Hub in a frame exactly
as a tab would. The only thing it writes on claude.ai is a passage you asked
for, into your own message box, unsent. Settings (Hub address, Follow new links) live in your Chrome
profile's extension storage. No analytics, no servers of its own.

## Install

Two sign-ins, once each: claude.ai in the tab, and the Hub inside the panel
(the panel keeps its own Hub sign-in, so sign in there once and it stays).

### Load unpacked (any machine, no store)

1. Copy this `hub-companion` folder somewhere it can stay (the extension runs
   from the folder; do not delete it afterwards).
2. Open `chrome://extensions` (Edge: `edge://extensions`).
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the folder.
5. Pin the "AKLA Hub companion" button from the puzzle-piece menu.

Thanks to the fixed `key` in `manifest.json`, every unpacked install has the
same extension id: `djjhabnppnfpboomokbikdjdoimgogdp`. That matters because
the Hub only lets itself and this id embed it (`vercel.json` sends
`Content-Security-Policy: frame-ancestors 'self'
chrome-extension://djjhabnppnfpboomokbikdjdoimgogdp`). An install with any
other id gets Chrome's grey "refused to connect" page in the panel.

### Unlisted Chrome Web Store listing (updates itself)

1. `scripts/package.sh` writes `dist/akla-hub-companion-<version>.zip`
   (README, tests and scripts left out).
2. In the Chrome Web Store developer dashboard, create a new item, upload the
   zip, set visibility to **Unlisted**, and publish. Only people with the
   link can install it, and Chrome updates it on its own.
3. Check the item id in the dashboard matches the id above. If the dashboard
   refuses a manifest with a `key` field, package with
   `scripts/package.sh --no-key`, upload that, and then paste the public key
   the dashboard shows (Package > View public key) into `manifest.json` as
   `key`, so unpacked installs keep the store's id. The store's id must then
   also go into the Hub's `frame-ancestors` header in `vercel.json` (see
   above), or the panel shows the grey "refused to connect" page.
4. Bump `version` in `manifest.json` for every later upload.

Edge installs Chrome Web Store items directly (Edge asks once to allow
extensions from other stores).

## Settings

Right-click the toolbar button > Options (or the Details page):

- **Hub address**: the site the links point at. Default
  `https://akla-interface.vercel.app`. Change it only if the Hub moves. It
  must start with `https://`; a plain `http://` address is refused (except
  `localhost`, for a development build of the Hub).
- **Follow new links**: on by default. Off means the panel changes page only
  when you click Open beside, paste a link, or press Home.

## Limits

- Chrome and Edge on a computer only. Nothing on mobile or Safari.
- Link detection depends on claude.ai showing the connector's "Open in Hub"
  addresses as text or links. If claude.ai stops showing them, the buttons
  stop appearing; the panel still works from the toolbar button and the
  paste-a-link box.
- It is a viewer beside the chat, not part of Claude's messages. Claude does
  not know what you accepted or rejected in the panel unless you tell it, or
  ask it to check the Changes list through the connector.
- "Open in tab" opens the last page the panel was sent to. If you navigate
  inside the panel, the Hub tells the panel its new address only if the Hub
  posts `{ type: "hub:location", href }` to its parent window in embed mode;
  until it does, Open in tab may be one step behind. Likewise the Hub may
  post `{ type: "hub:busy", busy }` to hold "Follow new links" while you
  type or a save is in flight; until it does, the panel holds back on its
  own once a page has been up for a few seconds and offers the link instead.
- The paste box takes an address with or without `https://` in front.
- "The Hub did not load" appears when the frame makes no progress for 12
  seconds. Chrome's own grey "refused to connect" page inside the frame
  means the Hub's `frame-ancestors` header does not name this extension's
  id (see Install); use Open in tab until it does.
- Each Chrome window's panel follows only the claude.ai tab in that window.
- "Ask Claude about this" works on Word files drawn in the page. A PDF is
  shown by the browser's own viewer in a frame the Hub cannot read, so
  there it does not appear; copy from the PDF instead.
- The passage goes in as a paste, the way claude.ai expects text to arrive.
  If claude.ai turns a long paste into an attachment, the extension does
  not type it a second time; it copies it and says so, and you may find it
  already attached.

## How the message box is found and filled (composer.js)

Without any claude.ai class names. The box is, first that fits: the
editable element with focus; the one that last had focus; the last visible
contenteditable (or, failing that, textarea) on the page that says what it
is for (`role="textbox"`, or an `aria-label`, placeholder or
`data-placeholder` naming a prompt, message, reply, chat or Claude); else
the last visible contenteditable or textarea. The extension's own elements
are never chosen.

The text goes after what is already typed, which is kept: first as a
synthetic paste (a `paste` event carrying `text/plain`, which ProseMirror,
claude.ai's editor, handles as a paste), checked by reading the box back;
if nothing handled the paste, by `execCommand("insertText")` line by line
with `insertParagraph` between lines, all in one go (ProseMirror reads a
lone new paragraph as the Enter key, and Enter sends, so a new line is
never inserted on its own); failing both, the clipboard and a note by the
box. A textarea is typed into directly. The caret ends after the text and
the box keeps focus. No key is pressed and no button clicked.

## How the panel opens

`chrome.sidePanel.open()` may only run in response to a user action. Chrome's
documentation counts a click in a content script, and the click's user
gesture carries through `runtime.sendMessage` to the service worker as long
as `open()` is the first call in the listener (nothing awaited before it).
That is what `background.js` does. If `open()` still fails (Chrome before
116, or a gesture that did not carry), the button shows "Click the Hub button
in the toolbar"; the address is already stored, so the toolbar button
(`openPanelOnActionClick`) opens the panel on it. Needs Chrome 116 or later
(`minimum_chrome_version`).

## Files

- `manifest.json`: Manifest V3; permissions `sidePanel`, `storage`; host
  permission `https://claude.ai/*` only; `panel.html` is web-accessible on
  claude.ai only, so the drawer can frame it.
- `links.js`: pure link finding and address tidying, shared by the content
  script and the panel, tested under node.
- `passage.js`: pure; turns the Hub's `hub:selection` message into the
  quoted text for the chat (shared by the panel and the tests).
- `composer.js`: runs on claude.ai before the drawer and link scripts;
  finds the chat's message box and puts text at its end without sending
  (`HubComposer.insert`, and `composer:insert` from the service worker).
- `content.js` + `content.css`: runs on claude.ai; buttons, newest-link
  tracking. MutationObserver, one scan at most every 400 ms, no scan of the
  prompt box or other editable areas.
- `pane.js`: runs on claude.ai; the in-page drawer (a closed shadow root
  holding a frame of `panel.html?mode=pane`), its resize edge, push or
  slide-over layout, and the per-conversation memory.
- `background.js`: service worker; the toolbar button (toggles the drawer,
  or opens the side panel in the side view); opens the side panel, passes
  addresses on; hands a passage from the side panel to the active claude.ai
  tab in its window (only from the extension's own panel page).
  Only an address on the configured Hub origin is stored or passed (the
  panel checks again before it sets its frame).
- `panel.html/js/css`: the panel, in the drawer (`?mode=pane`) and in
  Chrome's side panel: one bar, a menu, the Hub's frame. Takes
  `hub:selection` only from the Hub's frame on the Hub's origin, builds the
  text with `passage.js`, and sends it to `pane.js` (drawer) or the service
  worker (side panel); shows the outcome in its notice line.
- `options.html/js`: settings.
- `icons/`: navy square with an H, 16/32/48/128.
- `scripts/package.sh`: zip for the store.
- `tests/links.test.js`: `node --test hub-companion/tests/links.test.js`.
- `tests/passage.test.js`: `node --test hub-companion/tests/passage.test.js`
  checks the quoted message: its heading, the `> ` lines, tidying, the
  4,000-character cut.
- `tests/themes.test.js`: `node --test hub-companion/tests/themes.test.js`
  checks every theme has both modes, reads at 7:1 or better, and that the
  generated CSS sets the tokens claude.ai uses and leaves the rest alone.
- `tests/load-check.mjs`: `node hub-companion/tests/load-check.mjs` loads the
  extension in Playwright's Chromium (Chrome for Testing; branded Google
  Chrome 137+ ignores `--load-extension`) with a visible window, checks the
  service worker starts under the expected id (`tests/expected-id.txt`),
  opens the panel and options pages, and runs the content script on a
  fixture page.
- `tests/composer-check.mjs`: `node hub-companion/tests/composer-check.mjs`
  loads the extension the same way and answers `https://claude.ai/` with a
  fixture holding a real ProseMirror editor (from the repository's
  `node_modules`) where Enter sends. It checks the paste path, the
  line-by-line path, a textarea and the clipboard fallback (each keeps the
  draft and sends nothing), then the whole drawer route (a fake Hub in the
  drawer posts `hub:selection`; the passage lands in the box with "Added to
  your message" in the drawer) and the side panel's route through the
  service worker.

## Key

The manifest's `key` is the RSA-2048 public key (SPKI, DER, base64) made
with `openssl genrsa 2048` / `openssl rsa -pubout -outform DER`. The id is
the first 32 hex characters of the SHA-256 of that DER, with each hex digit
mapped to a letter a to p. The private half is not needed for anything (the
store signs its own packages; unpacked loads use only the public key) and is
not in this repository.
