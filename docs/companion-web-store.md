# Publishing the Hub companion on the Chrome Web Store

The companion (`hub-companion/`) is published **unlisted** on the Chrome Web
Store: only people with the link can find it, and Chrome updates every
installed copy on its own within a few hours of a new version going live.
The claude.ai connector needs none of this: it runs on the firm's server
and every update reaches everyone at once.

Everything for the first upload is in `~/Desktop/AKLA Companion for the Web Store/`
(the zip, the icon, three 1280×800 screenshots).

## 1. One-time: the developer account (Rayyan)

1. Go to https://chrome.google.com/webstore/devconsole with the Google account
   the firm should own the listing under, accept the developer agreement and
   pay the one-off US$5 registration fee.
2. Verify the account's contact email when asked.

## 2. First upload (Rayyan, about 20 minutes)

1. In the developer console: **New item** → upload
   `FOR THE WEB STORE ONLY - do not send to staff - 0.6.0.zip`.
2. **Store listing** tab:
   - Description: paste the text in section 5 below.
   - Category: *Productivity* (Workflow & Planning). Language: English.
   - Icon: `store-icon-128.png`. Screenshots: the three PNGs.
3. **Privacy** tab (answers in section 5):
   - Single purpose, the three permission justifications, and "does not
     collect or use user data" (tick none of the data types; tick the three
     certifications).
   - Privacy policy URL: `https://akla-interface.vercel.app/companion-privacy.html`.
4. **Distribution** tab: Visibility **Unlisted**; regions: all.
5. **Submit for review.** The first review usually takes a few working days.
6. When it is published, copy the item's **ID** (32 letters, shown in the
   console and in the listing's address) and the listing link, and send both
   to Claude.

## 3. After the first publish (Claude)

The store gives the extension its own id, different from the unpacked
install's. The Hub must know it, or the drawer cannot frame the Hub and the
Hub's page names, theme and highlighted passages do not reach it:

- add `chrome-extension://<store id>` to `COMPANION_ORIGINS` in
  `src/lib/embedMode.ts`, and to `frame-ancestors` in `vercel.json`;
- deploy the Hub (`vercel --prod`), check with
  `curl -I https://akla-interface.vercel.app/ai` that the header names both ids;
- put the listing link in the employee guide.

## 4. One-command releases (optional, recommended)

Without this, a new version is uploaded by hand in the console (Package →
Upload new package → Submit). With it, `hub-companion/scripts/release.sh`
bumps the version, packages and publishes in one go.

One-time (Rayyan, about 15 minutes):

1. https://console.cloud.google.com → create a project ("AKLA companion
   releases") → **APIs & Services → Library** → enable **Chrome Web Store API**.
2. **OAuth consent screen**: External, app name "AKLA companion releases",
   add your own Google account as a test user.
3. **Credentials → Create credentials → OAuth client ID** → type
   *Desktop app*. Note the client ID and client secret.
4. Get a refresh token with the OAuth Playground (Google retired the old
   copy-the-code flow): make the client a *Web application* instead, add
   `https://developers.google.com/oauthplayground` as an authorised redirect
   URI, open https://developers.google.com/oauthplayground, click the gear →
   *Use your own OAuth credentials* (paste the client ID and secret), enter
   the scope `https://www.googleapis.com/auth/chromewebstore`, *Authorize
   APIs* with the account that owns the listing, then *Exchange authorization
   code for tokens*. Keep the `refresh_token`.
   (Google is moving the Web Store API to a v2 that also takes service
   accounts; if release.sh's v1.1 calls are ever refused, it switches to v2.)
5. Create `~/.akla/cws.env` (never in the repository):
   ```
   CWS_CLIENT_ID=…
   CWS_CLIENT_SECRET=…
   CWS_REFRESH_TOKEN=…
   CWS_EXTENSION_ID=<the store id>
   ```

Then a release is:

```
hub-companion/scripts/release.sh            # 0.4.0 → 0.4.1, upload, publish
hub-companion/scripts/release.sh --dry-run  # package only, version unchanged
```

and commit `hub-companion/manifest.json`. Installed copies update within a
few hours (a release that adds a permission may wait for a short review, and
Chrome asks each user to accept a new permission once).

## 5. Listing text

**Name:** AKLA Hub companion

**Summary (manifest description, ≤132 characters):** Shows the firm's Hub
beside your claude.ai chat. Reads only Hub links on claude.ai and sends
nothing anywhere.

**Description:**

For lawyers at Ali Khan Law Associates who use Claude with the firm's AKLA
Hub connector.

When Claude names a Hub document or project, click the link and the
document opens in a drawer on the right of the chat (or in Chrome's side panel): the firm's own Word document with its
formatting, versions, checks and the Changes list, where tracked changes are
accepted or rejected. Highlight a passage in the drawer and "Add to message"
puts it in your message box, quoted with its version, ready for your
instruction. It never sends anything for you.

You can also recolour the chat with the firm's themes.

The extension reads only links to the firm's Hub on claude.ai. It has no
server of its own, no analytics and no tracking, and sends nothing to anyone.
Each lawyer signs in to the Hub with their own Hub account.

**Single purpose:** Show the firm's Project Hub (documents, projects and
their tracked changes) beside a claude.ai conversation, opened from the Hub
links that conversation contains.

**Permission justifications:**

- *Host permission claude.ai:* to find links to the firm's Hub in a
  claude.ai conversation, open the one the lawyer clicks in a drawer beside
  the chat, and, when the lawyer asks, place a
  highlighted passage in their own message box (never sending it).
- *sidePanel:* to offer the Hub in Chrome's side panel as an alternative to
  the drawer.
- *storage:* to keep the lawyer's settings (Hub address, theme, where the
  Hub shows, drawer width, the last Hub page per conversation) in their own
  browser.

**Remote code:** No, the extension uses no remote code. (The Hub page it
shows is a normal website loaded in a frame, not code run by the extension.)

**Data usage:** collects none of the listed data types; does not sell or
transfer data; does not use data for unrelated purposes or for credit.

## 6. Force-install on firm machines (optional)

If the laptops are managed, the extension can be installed for everyone
without a click, still updating from the store:

- **Microsoft Intune** (Microsoft 365): a Chrome policy
  `ExtensionInstallForcelist` = `<store id>;https://clients2.google.com/service/update2/crx`
  (and the same id for Edge, whose Chrome-extension support takes the same
  policy under `Microsoft Edge`).
- **Chrome Enterprise Core** (free, Google Admin console): Apps & extensions →
  Users & browsers → add the item by id → Force install.
