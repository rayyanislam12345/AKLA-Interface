// Service worker. Two jobs: open the side panel when an "Open beside" button
// is clicked on claude.ai, and pass the newest Hub link on to the panel so it
// can follow the conversation. Nothing is sent outside the browser.
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

function enableActionClick() {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
}
enableActionClick();
chrome.runtime.onInstalled.addListener(enableActionClick);

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
