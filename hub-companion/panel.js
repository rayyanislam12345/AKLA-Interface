// The side panel: a slim bar and a frame that shows the Hub. It shows the
// last address it was given (chrome.storage.session), the Hub home otherwise,
// and follows the newest link from the chat when that setting is on.
(function () {
  "use strict";

  var frame = document.getElementById("frame");
  var notice = document.getElementById("notice");
  var idle = document.getElementById("idle");
  var address = document.getElementById("address");

  var LOAD_WAIT = 12000; // ms before "did not load" is shown
  var FRESH = 4000; // ms after a page is shown during which a new link may replace it outright
  var settings = { hubOrigin: HubLinks.DEFAULT_ORIGIN, followNewLinks: true };
  var settingsReady = false;
  var queued = []; // "show" messages that arrived before the settings were read
  var currentUrl = null; // the address we showed, without embed=1
  var shownAt = 0; // when the frame was last sent to a page
  var pendingUrl = null; // a link Claude mentioned that is waiting for a click
  var busy = false; // the Hub said the person is mid-task (text typed, a save in flight)
  var windowId = null; // the Chrome window this panel belongs to
  var loadTimer = null;

  function clearNotice() {
    notice.textContent = "";
    notice.hidden = true;
  }

  function say(text, url) {
    notice.textContent = "";
    if (!text) {
      notice.hidden = true;
      return;
    }
    notice.appendChild(document.createTextNode(text + " "));
    if (url) {
      var a = document.createElement("a");
      a.href = url;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Open it in a tab.";
      notice.appendChild(a);
    }
    notice.hidden = false;
  }

  function show(url) {
    var clean = HubLinks.normaliseHubUrl(url, settings.hubOrigin);
    if (!clean) {
      say("That is not a Hub link.");
      return;
    }
    clearNotice();
    idle.hidden = true;
    pendingUrl = null;
    busy = false;
    currentUrl = clean;
    shownAt = Date.now();
    frame.src = HubLinks.embedUrl(clean);
    address.value = "";
    chrome.storage.session.set({ panelUrl: clean });
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = setTimeout(function () {
      say("The Hub did not load.", currentUrl);
    }, LOAD_WAIT);
  }

  // A link from the chat while the person may be working in the frame: never
  // navigate under them. Offer it in one line and move only when clicked.
  function offer(url) {
    pendingUrl = url;
    notice.textContent = "";
    notice.appendChild(document.createTextNode("Claude mentioned a " + HubLinks.linkKind(url) + ". "));
    var go = document.createElement("button");
    go.type = "button";
    go.textContent = "Show it";
    go.addEventListener("click", function () {
      if (pendingUrl) show(pendingUrl);
    });
    notice.appendChild(go);
    var skip = document.createElement("button");
    skip.type = "button";
    skip.className = "quiet";
    skip.textContent = "Not now";
    skip.addEventListener("click", function () {
      pendingUrl = null;
      clearNotice();
    });
    notice.appendChild(skip);
    notice.hidden = false;
  }

  function onShow(message) {
    if (windowId !== null && typeof message.windowId === "number" && message.windowId !== windowId) return; // another Chrome window's chat
    if (message.url === currentUrl) {
      if (message.auto) return;
      clearNotice();
      pendingUrl = null;
      return;
    }
    if (!message.auto) {
      show(message.url);
      return;
    }
    if (settings.followNewLinks === false) return;
    var clean = HubLinks.normaliseHubUrl(message.url, settings.hubOrigin);
    if (!clean) return;
    // A page that has just come up (or no page yet) can be replaced; one the
    // person has had time to start working in is not.
    if (!busy && (currentUrl === null || Date.now() - shownAt < FRESH)) show(clean);
    else offer(clean);
  }

  frame.addEventListener("load", function () {
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = null;
  });

  // The Hub may post messages while embedded. Both are optional: without
  // "hub:location" the last address the panel set is used for "Open in
  // tab"; without "hub:busy" a mentioned link is offered, never forced, once
  // the page has been up for a few seconds.
  window.addEventListener("message", function (ev) {
    if (ev.origin.toLowerCase() !== settings.hubOrigin.toLowerCase()) return;
    var d = ev.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "hub:location" && typeof d.href === "string") {
      var clean = HubLinks.normaliseHubUrl(d.href, settings.hubOrigin);
      if (clean) {
        currentUrl = clean;
        chrome.storage.session.set({ panelUrl: clean });
      }
    }
    if (d.type === "hub:busy") busy = d.busy === true;
  });

  document.getElementById("home").addEventListener("click", function () {
    show(HubLinks.homeUrl(settings.hubOrigin));
  });
  document.getElementById("back").addEventListener("click", function () {
    history.back(); // the frame's navigations are in this window's history
  });
  document.getElementById("tab").addEventListener("click", function () {
    chrome.tabs.create({ url: currentUrl || HubLinks.homeUrl(settings.hubOrigin) });
  });
  document.getElementById("go").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var typed = address.value.trim();
    if (!typed) return;
    // A pasted address without a scheme ("akla-interface.vercel.app/ai/d/…")
    // is tried as https, the same way the options page treats a bare host.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(typed)) typed = "https://" + typed;
    show(typed);
  });

  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== "show" || typeof message.url !== "string") return;
    if (!settingsReady) {
      queued.push(message); // replayed once the settings are read, so a custom Hub address is honoured
      return;
    }
    onShow(message);
  });

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "sync") return;
    if (changes.hubOrigin) settings.hubOrigin = HubLinks.normaliseOrigin(changes.hubOrigin.newValue);
    if (changes.followNewLinks) settings.followNewLinks = changes.followNewLinks.newValue !== false;
  });

  if (chrome.windows && chrome.windows.getCurrent) {
    chrome.windows.getCurrent(function (w) {
      void chrome.runtime.lastError;
      if (w && typeof w.id === "number") windowId = w.id;
    });
  }

  chrome.storage.sync.get({ hubOrigin: "", followNewLinks: true }, function (items) {
    settings.hubOrigin = HubLinks.normaliseOrigin(items.hubOrigin);
    settings.followNewLinks = items.followNewLinks !== false;
    chrome.storage.session.get({ panelUrl: "" }, function (s) {
      settingsReady = true;
      var replay = queued;
      queued = [];
      for (var i = 0; i < replay.length; i++) onShow(replay[i]);
      // A "show" that arrived while we were starting has already set the
      // frame; loading the remembered page as well would load it twice.
      if (currentUrl) return;
      // Nothing chosen yet: say so rather than load the whole workspace.
      var last = HubLinks.normaliseHubUrl(s.panelUrl, settings.hubOrigin);
      if (last) show(last);
      else idle.hidden = false;
    });
  });
})();
