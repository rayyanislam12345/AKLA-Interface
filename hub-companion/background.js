// Service worker. Four jobs: the toolbar button (the drawer or the side
// panel, by the "view" setting); in the side view, open the side panel when
// an "Open beside" button is clicked on claude.ai; pass the newest Hub link
// on to the side panel so it can follow the conversation; and hand a passage
// the side panel wants quoted to the claude.ai tab in its window, whose
// composer.js puts it in the message box. Nothing is sent outside the
// browser.
//
// chrome.sidePanel.open() may only run in response to a user action. Chrome's
// documentation counts "a user interaction on an extension page or content
// script, such as clicking a button", and the click's gesture carries through
// runtime.sendMessage to this listener as long as open() is called before
// anything is awaited. So open() is the first call below. If it still fails
// (Chrome before 116, or the gesture did not carry), the content script shows
// a hint to use the toolbar button, which opens the panel on the remembered
// address (openPanelOnActionClick below).
importScripts("links.js");

// theme.js (a content script) records in session storage whether claude.ai
// still has the colour tokens the themes set; content scripts may only use
// session storage once the worker opens it to them.
chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" }).catch(() => {});

// Where the Hub shows: "page" (the drawer inside the claude.ai tab, pane.js;
// the default) or "side" (Chrome's side panel). In the side view the toolbar
// button opens the side panel itself; in the page view it toggles the drawer
// in the current claude.ai tab, and on any other tab opens the side panel.
let view = "page";
function applyView() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: view === "side" }).catch(() => {});
}
chrome.storage.sync.get({ view: "page" }, (items) => {
  void chrome.runtime.lastError;
  view = items && items.view === "side" ? "side" : "page";
  applyView();
});
chrome.runtime.onInstalled.addListener(applyView);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.view) {
    view = changes.view.newValue === "side" ? "side" : "page";
    applyView();
  }
});

// Only fires while openPanelOnActionClick is off, i.e. in the page view.
chrome.action.onClicked.addListener((tab) => {
  if (tab && tab.id != null && tab.url && tab.url.startsWith("https://claude.ai/")) {
    chrome.tabs.sendMessage(tab.id, { type: "pane:toggle" }).catch(() => {
      // The page loaded before the extension did: no drawer script there yet.
      chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
    });
    return;
  }
  if (tab && tab.id != null) chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

// The Hub origin, kept in memory so the address check below stays
// synchronous (sidePanel.open must be the first call while the gesture
// lasts). Read at worker start and again whenever the setting changes.
let hubOrigin = HubLinks.DEFAULT_ORIGIN;
chrome.storage.sync.get({ hubOrigin: "" }, (items) => {
  void chrome.runtime.lastError;
  hubOrigin = HubLinks.normaliseOrigin(items && items.hubOrigin);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.hubOrigin) hubOrigin = HubLinks.normaliseOrigin(changes.hubOrigin.newValue);
});

function tellPanel(url, auto, windowId) {
  // Delivered only when a panel is open; otherwise there is no receiver,
  // which is fine: the stored address is picked up when it next opens.
  // Every open panel receives this, so the window id lets a panel in
  // another Chrome window ignore it.
  chrome.runtime.sendMessage({ type: "show", url, auto, windowId }).catch(() => {});
}

// The side panel asks for a passage to be put in the chat's message box
// (never sent). Only our own panel page may ask, and only the active
// claude.ai tab of that panel's window receives it.
const MAX_INSERT = 8000;
function insertIntoChat(message, sender, sendResponse) {
  if (sender.id !== chrome.runtime.id || sender.tab || !sender.url || !sender.url.startsWith(chrome.runtime.getURL("panel.html"))) return false;
  if (typeof message.text !== "string" || !message.text || message.text.length > MAX_INSERT) return false;
  const query = typeof message.windowId === "number" ? { active: true, windowId: message.windowId } : { active: true, lastFocusedWindow: true };
  chrome.tabs.query(query, (tabs) => {
    void chrome.runtime.lastError;
    const tab = (tabs || []).find((t) => t.id != null && t.url && t.url.startsWith("https://claude.ai/"));
    if (!tab) return sendResponse({ ok: false, how: "none" });
    chrome.tabs
      .sendMessage(tab.id, { type: "composer:insert", text: message.text })
      .then((reply) => sendResponse(reply && typeof reply === "object" ? { ok: !!reply.ok, how: reply.how } : { ok: false, how: "none" }))
      .catch(() => sendResponse({ ok: false, how: "none" })); // the tab loaded before the extension: no composer.js there
  });
  return true; // the reply is sent later
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "composer:request") return insertIntoChat(message, sender, sendResponse);
  if (!message || typeof message.url !== "string") return;
  if (!sender.tab || !sender.tab.url || !sender.tab.url.startsWith("https://claude.ai/")) return;
  // Only a Hub address is stored or shown; the panel checks again before
  // setting its frame, but the worker never passes anything else on.
  const url = HubLinks.normaliseHubUrl(message.url, hubOrigin);
  if (!url) return;
  const windowId = sender.tab.windowId;

  if (message.type === "open") {
    const opening = chrome.sidePanel.open({ tabId: sender.tab.id }); // first, synchronously: the gesture is short-lived
    chrome.storage.session.set({ panelUrl: url, latestUrl: url });
    opening
      .then(() => {
        tellPanel(url, false, windowId);
        sendResponse({ ok: true });
      })
      .catch((err) => {
        sendResponse({ ok: false, error: String(err && err.message ? err.message : err) });
      });
    return true; // the reply is sent later
  }

  if (message.type === "seen") {
    chrome.storage.session.set({ latestUrl: url });
    if (sender.tab.active === false) return; // a chat in a background tab does not steer the panel
    chrome.storage.sync.get({ followNewLinks: true }, (items) => {
      if (items.followNewLinks !== false) tellPanel(url, true, windowId);
    });
    return;
  }
});
