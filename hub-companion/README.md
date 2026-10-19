# AKLA Hub companion

A small Chrome/Edge extension that shows the firm's Hub in a side panel next
to your claude.ai chat. When Claude answers with a line like
`Open in Hub: https://akla-interface.vercel.app/ai/d/<version>`, an
**Open beside** button appears after the link; click it and that document
(or project, or chat) opens in the panel on the right, with its formatting,
version compare, checks and the Changes list. You keep talking in the chat.

What it does, and all it does:

- On claude.ai, finds Hub links by their address (not by claude.ai's layout),
  puts an "Open beside" button after each, and remembers the newest one.
- The side panel shows the Hub inside a frame with `?embed=1` on the address,
  which the Hub uses to hide its sidebar.
- If the panel is open and **Follow new links** is on (the default), the
  panel follows the newest Hub link Claude mentions: straight away when the
  panel has only just opened or changed page, otherwise as a one-line
  "Claude mentioned a document. Show it." notice, so nothing you are doing
  in the panel (text in the composer, an accept/reject pass, a file still
  uploading) is lost under you.
- The toolbar button opens the panel on the last page shown.
- The panel's bar has Home, Back, a paste-a-link box, and Open in tab.

Privacy: the extension sends nothing anywhere. It reads links on claude.ai
pages, talks only to its own side panel, and loads the Hub in a frame exactly
as a tab would. Settings (Hub address, Follow new links) live in your Chrome
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
  permission `https://claude.ai/*` only.
- `links.js`: pure link finding and address tidying, shared by the content
  script and the panel, tested under node.
- `content.js` + `content.css`: runs on claude.ai; buttons, newest-link
  tracking. MutationObserver, one scan at most every 400 ms, no scan of the
  prompt box or other editable areas.
- `background.js`: service worker; opens the panel, passes addresses on.
  Only an address on the configured Hub origin is stored or passed (the
  panel checks again before it sets its frame).
- `panel.html/js/css`: the side panel.
- `options.html/js`: settings.
- `icons/`: navy square with an H, 16/32/48/128.
- `scripts/package.sh`: zip for the store.
- `tests/links.test.js`: `node --test hub-companion/tests/links.test.js`.
- `tests/load-check.mjs`: `node hub-companion/tests/load-check.mjs` loads the
  extension in Playwright's Chromium (Chrome for Testing; branded Google
  Chrome 137+ ignores `--load-extension`) with a visible window, checks the
  service worker starts under the expected id (`tests/expected-id.txt`),
  opens the panel and options pages, and runs the content script on a
  fixture page.

## Key

The manifest's `key` is the RSA-2048 public key (SPKI, DER, base64) made
with `openssl genrsa 2048` / `openssl rsa -pubout -outform DER`. The id is
the first 32 hex characters of the SHA-256 of that DER, with each hex digit
mapped to a letter a to p. The private half is not needed for anything (the
store signs its own packages; unpacked loads use only the public key) and is
not in this repository.
