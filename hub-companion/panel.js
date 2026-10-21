// The companion's panel: one bar (Back, the page's name, Home, Open in the
// Hub, a menu) over a frame that shows the Hub. The same page runs in two
// places:
//   - the drawer inside the claude.ai tab (pane.js frames it with ?mode=pane;
//     links arrive from the chat by postMessage, and Close hands back);
//   - Chrome's side panel (links arrive from the service worker).
// The Hub is opened with embed=1&host=companion, so it shows no sidebar and
// no header of its own: it posts its address and name here instead, and the
// bar shows them. The chat's colour theme tints the bar and is passed to the
// Hub, so the chat and the document wear the same colours.
// A passage highlighted in a Hub document ("Ask Claude about this", posted as
// hub:selection) is quoted into the chat's message box, unsent: in the drawer
// through pane.js, in the side panel through the service worker; composer.js
// on claude.ai does the typing.
(function () {
  "use strict";

  var PANE = new URLSearchParams(location.search).get("mode") === "pane";
  var PAGE_ORIGIN = "https://claude.ai"; // the drawer's only parent

  var frame = document.getElementById("frame");
  var notice = document.getElementById("notice");
  var idleBox = document.getElementById("idle");
  var titleEl = document.getElementById("title");
  var kindEl = document.getElementById("kind");
  var backBtn = document.getElementById("back");
  var moreBtn = document.getElementById("more");
  var menu = document.getElementById("menu");
  var address = document.getElementById("address");
  var themeSelect = document.getElementById("theme");
  var viewSwitch = document.getElementById("viewSwitch");

  document.body.classList.toggle("pane", PANE);
  document.getElementById("close").hidden = !PANE;
  viewSwitch.textContent = PANE ? "Use Chrome's side panel instead" : "Show inside the chat page instead";

  // The chat's themes (themes.js) and the Hub's own (src/ai/theme.ts) are two
  // lists; each chat theme is given the Hub theme closest to it.
  var HUB_THEME = { default: "warm", akla: "warm", sky: "blue", rose: "pink", paper: "orange", slate: "slate", forest: "green", contrast: "contrast" };

  var LOAD_WAIT = 12000; // ms before "did not load" is shown
  var FRESH = 4000; // ms after a page is shown during which a new link may replace it outright
  var settings = { hubOrigin: HubLinks.DEFAULT_ORIGIN, followNewLinks: true, theme: "default", paneMode: "push" };
  var settingsReady = false;
  var queued = []; // links that arrived before the settings were read
  var currentUrl = null; // the page on screen, without the frame's parameters
  var trail = []; // pages shown before it, for Back (never the tab's own history)
  var shownAt = 0;
  var pendingUrl = null; // a link Claude mentioned, waiting for "Show it"
  var busy = false; // the Hub said the person is mid-task
  var windowId = null; // side panel: the Chrome window this panel belongs to
  var loadTimer = null;
  var frameStarted = false;

  // ---- the bar ----
  function capital(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function setPlace(url, title) {
    if (!url) {
      kindEl.textContent = "AKLA Hub";
      titleEl.textContent = "No document open";
      titleEl.title = "";
      return;
    }
    var kind = HubLinks.linkKind(url);
    kindEl.textContent = kind === "page" ? "AKLA Hub" : capital(kind);
    titleEl.textContent = title || "Opening…";
    titleEl.title = title || "";
  }
  function updateBack() { backBtn.disabled = trail.length === 0; }

  // ---- notices ----
  var flashTimer = null;
  function clearNotice() {
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = null;
    notice.textContent = "";
    notice.hidden = true;
  }
  function say(text, url) {
    notice.textContent = "";
    if (!text) return clearNotice();
    notice.appendChild(document.createTextNode(text));
    if (url) {
      var a = document.createElement("a");
      a.href = HubLinks.plainUrl(url);
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Open it in a tab";
      notice.appendChild(a);
    }
    notice.hidden = false;
  }
  // A line that goes by itself after a few seconds, unless something else
  // has taken its place.
  function flash(text) {
    say(text);
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      flashTimer = null;
      if (notice.textContent === text) clearNotice();
    }, 5000);
  }

  // ---- a passage for the chat's message box ----
  // composer.js answers { ok, how }: ok when the text is in the box (how is
  // "paste" or "typed"); otherwise how is "clipboard" (copied for the lawyer
  // to paste) or "none".
  function inserted(result) {
    if (result && result.ok) return flash("Added to your message. Say what you want changed, then send.");
    if (result && result.how === "clipboard") return flash("Copied: paste it into the chat.");
    flash("Could not reach the chat's message box. Open the chat and try again.");
  }
  function askAbout(d) {
    var text = HubPassage.selectionMessage(d);
    if (!text) return;
    if (PANE) {
      window.parent.postMessage({ source: "hub-companion-pane", type: "insert", text: text }, PAGE_ORIGIN);
      return;
    }
    // The side panel: the service worker finds this window's claude.ai tab.
    try {
      chrome.runtime.sendMessage({ type: "composer:request", text: text, windowId: windowId }, function (reply) {
        void chrome.runtime.lastError;
        inserted(reply || { ok: false, how: "none" });
      });
    } catch (e) {
      inserted({ ok: false, how: "none" });
    }
  }

  // ---- showing a page ----
  function remember(url) {
    if (PANE) window.parent.postMessage({ source: "hub-companion-pane", type: "location", url: url }, PAGE_ORIGIN);
    else chrome.storage.session.set({ panelUrl: url });
  }

  // The Hub lets only this extension's own id frame it (vercel.json). A copy
  // installed from another file gets another id, and the browser would only
  // show a grey "refused to connect"; say what to do instead.
  var KNOWN_IDS = ["djjhabnppnfpboomokbikdjdoimgogdp"];
  var wrongCopy = KNOWN_IDS.indexOf(chrome.runtime.id) === -1;

  function navigateFrame(url) {
    if (wrongCopy) {
      say("This copy of the companion was installed from the wrong file, so the Hub will not open inside it. Remove it in chrome://extensions (edge://extensions in Edge) and load the folder from the \"sideload\" zip instead.", url);
      return;
    }
    var target = HubLinks.embedUrl(url, HUB_THEME[settings.theme] || null);
    frame.hidden = false;
    if (!frameStarted) {
      frameStarted = true;
      frame.src = target;
    } else {
      // replace(), not a new entry: the Hub's pages must not pile up in the
      // claude.ai tab's own Back history.
      try {
        frame.contentWindow.location.replace(target);
      } catch (e) {
        frame.src = target;
      }
    }
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = setTimeout(function () { say("The Hub did not load. ", url); }, LOAD_WAIT);
  }

  function show(url, keepTrail) {
    var clean = HubLinks.normaliseHubUrl(url, settings.hubOrigin);
    if (!clean) {
      say("That is not a Hub link.");
      return false;
    }
    clearNotice();
    idleBox.hidden = true;
    pendingUrl = null;
    busy = false;
    if (!keepTrail && currentUrl && currentUrl !== clean) {
      trail.push(currentUrl);
      if (trail.length > 30) trail.shift();
    }
    updateBack();
    currentUrl = clean;
    shownAt = Date.now();
    setPlace(clean, null);
    navigateFrame(clean);
    remember(clean);
    return true;
  }

  function idle() {
    clearNotice();
    currentUrl = null;
    pendingUrl = null;
    trail = [];
    updateBack();
    setPlace(null);
    frame.hidden = true;
    idleBox.hidden = false;
  }

  // A link from the chat while the person may be working in the frame: never
  // move under them. Offer it in one line and move only when asked.
  function offer(url) {
    pendingUrl = url;
    notice.textContent = "";
    notice.appendChild(document.createTextNode("Claude mentioned a " + HubLinks.linkKind(url) + "."));
    var go = document.createElement("button");
    go.type = "button";
    go.className = "primary";
    go.textContent = "Show it";
    go.addEventListener("click", function () { if (pendingUrl) show(pendingUrl); });
    var skip = document.createElement("button");
    skip.type = "button";
    skip.className = "quiet";
    skip.textContent = "Not now";
    skip.addEventListener("click", function () { pendingUrl = null; clearNotice(); });
    notice.appendChild(go);
    notice.appendChild(skip);
    notice.hidden = false;
  }

  function onShow(message) {
    if (!PANE && windowId !== null && typeof message.windowId === "number" && message.windowId !== windowId) return;
    var clean = HubLinks.normaliseHubUrl(message.url, settings.hubOrigin);
    if (!clean) return;
    if (clean === currentUrl) {
      if (!message.auto) { clearNotice(); pendingUrl = null; }
      return;
    }
    if (!message.auto) return void show(clean);
    if (settings.followNewLinks === false) return;
    // A page that has only just come up (or none) can be replaced; one the
    // person has had time to start working in is not.
    if (!busy && (currentUrl === null || Date.now() - shownAt < FRESH)) show(clean);
    else offer(clean);
  }

  frame.addEventListener("load", function () {
    if (loadTimer) clearTimeout(loadTimer);
    loadTimer = null;
    // A page that never says its name still gets a plain one.
    setTimeout(function () {
      if (titleEl.textContent === "Opening…" && currentUrl) setPlace(currentUrl, "AKLA Hub");
    }, 3000);
  });

  // ---- theme ----
  function tint(id) {
    var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    var sw = typeof HubThemes !== "undefined" ? HubThemes.swatches(id, dark) : null;
    var st = document.documentElement.style;
    if (!sw) {
      ["--bar", "--text", "--accent"].forEach(function (k) { st.removeProperty(k); });
      return;
    }
    st.setProperty("--bar", sw.bg);
    st.setProperty("--text", sw.text);
    st.setProperty("--accent", sw.accent);
  }
  function applyTheme(id) {
    settings.theme = HubThemes.isTheme(id) ? id : HubThemes.DEFAULT_THEME;
    themeSelect.value = settings.theme;
    tint(settings.theme);
    if (frameStarted && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: "companion:theme", aiTheme: HUB_THEME[settings.theme] || "warm" }, settings.hubOrigin);
    }
  }
  if (typeof HubThemes !== "undefined") {
    HubThemes.THEMES.forEach(function (theme) {
      var option = document.createElement("option");
      option.value = theme.id;
      option.textContent = theme.name;
      themeSelect.appendChild(option);
    });
    themeSelect.addEventListener("change", function () { chrome.storage.sync.set({ theme: themeSelect.value }); });
    if (window.matchMedia) window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function () { tint(settings.theme); });
  }

  // ---- menu ----
  function setMenu(open) {
    menu.hidden = !open;
    moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) address.focus();
  }
  moreBtn.addEventListener("click", function () { setMenu(menu.hidden); });
  document.addEventListener("click", function (ev) {
    if (!menu.hidden && !menu.contains(ev.target) && !moreBtn.contains(ev.target)) setMenu(false);
  });
  document.addEventListener("keydown", function (ev) {
    if (ev.key === "Escape" && !menu.hidden) { setMenu(false); moreBtn.focus(); }
  });
  document.getElementById("go").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var typed = address.value.trim();
    if (!typed) return;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(typed)) typed = "https://" + typed; // a pasted bare host
    if (show(typed)) { address.value = ""; setMenu(false); }
  });
  function paintMode() {
    var buttons = document.querySelectorAll(".seg button");
    for (var i = 0; i < buttons.length; i++) buttons[i].setAttribute("aria-pressed", buttons[i].dataset.mode === settings.paneMode ? "true" : "false");
  }
  document.querySelectorAll(".seg button").forEach(function (b) {
    b.addEventListener("click", function () { chrome.storage.sync.set({ paneMode: b.dataset.mode }); });
  });
  viewSwitch.addEventListener("click", function () {
    if (PANE) {
      // The drawer closes itself when the setting changes; the toolbar
      // button and "Open beside" then open Chrome's side panel.
      chrome.storage.sync.set({ view: "side" });
      return;
    }
    chrome.storage.sync.set({ view: "page" }, function () {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        var tab = tabs && tabs[0];
        if (tab && tab.id != null) chrome.tabs.sendMessage(tab.id, { type: "pane:toggle" }).catch(function () {});
        window.close();
      });
    });
  });
  document.getElementById("settings").addEventListener("click", function () { chrome.runtime.openOptionsPage(); });

  // ---- bar buttons ----
  backBtn.addEventListener("click", function () {
    var prev = trail.pop();
    updateBack();
    if (prev) show(prev, true);
  });
  document.getElementById("home").addEventListener("click", function () { show(HubLinks.homeUrl(settings.hubOrigin)); });
  document.getElementById("tab").addEventListener("click", function () {
    chrome.tabs.create({ url: HubLinks.plainUrl(currentUrl || HubLinks.homeUrl(settings.hubOrigin)) });
  });
  document.getElementById("close").addEventListener("click", function () {
    window.parent.postMessage({ source: "hub-companion-pane", type: "close" }, PAGE_ORIGIN);
  });

  // ---- messages ----
  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || typeof d !== "object") return;
    // From the Hub inside our frame: where it is, and what it is called.
    if (ev.source === frame.contentWindow && ev.origin.toLowerCase() === settings.hubOrigin.toLowerCase()) {
      if (d.type === "hub:location" && typeof d.href === "string") {
        var clean = HubLinks.normaliseHubUrl(d.href, settings.hubOrigin);
        if (!clean) return;
        if (clean !== currentUrl) {
          // A move inside the Hub (a link clicked there): Back returns to the
          // page before. A change in the first moments is the Hub settling
          // the address it was given (a redirect), not a move.
          if (currentUrl && Date.now() - shownAt > 3000) trail.push(currentUrl);
          updateBack();
          currentUrl = clean;
          remember(clean);
        }
        setPlace(clean, typeof d.title === "string" && d.title ? d.title : null);
      }
      // A page outside the workspace (the sign-in page) names itself only.
      if (d.type === "hub:title" && typeof d.title === "string" && d.title) setPlace(currentUrl || HubLinks.homeUrl(settings.hubOrigin), d.title);
      if (d.type === "hub:busy") busy = d.busy === true;
      if (d.type === "hub:selection") askAbout(d);
      return;
    }
    // From the claude.ai page around the drawer.
    if (PANE && ev.source === window.parent && ev.origin === PAGE_ORIGIN && d.source === "hub-companion") {
      if (d.type === "show" && typeof d.url === "string") {
        if (!settingsReady) queued.push(d);
        else onShow(d);
      } else if (d.type === "idle") {
        idle();
      } else if (d.type === "inserted") {
        inserted(d);
      }
    }
  });

  if (!PANE) {
    chrome.runtime.onMessage.addListener(function (message) {
      if (!message || message.type !== "show" || typeof message.url !== "string") return;
      if (!settingsReady) queued.push(message);
      else onShow(message);
    });
    if (chrome.windows && chrome.windows.getCurrent) {
      chrome.windows.getCurrent(function (w) {
        void chrome.runtime.lastError;
        if (w && typeof w.id === "number") windowId = w.id;
      });
    }
  }

  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "sync") return;
    if (changes.hubOrigin) settings.hubOrigin = HubLinks.normaliseOrigin(changes.hubOrigin.newValue);
    if (changes.followNewLinks) settings.followNewLinks = changes.followNewLinks.newValue !== false;
    if (changes.theme) applyTheme(changes.theme.newValue);
    if (changes.paneMode) { settings.paneMode = changes.paneMode.newValue === "over" ? "over" : "push"; paintMode(); }
  });

  // ---- start ----
  chrome.storage.sync.get({ hubOrigin: "", followNewLinks: true, theme: "default", paneMode: "push" }, function (items) {
    settings.hubOrigin = HubLinks.normaliseOrigin(items.hubOrigin);
    settings.followNewLinks = items.followNewLinks !== false;
    settings.paneMode = items.paneMode === "over" ? "over" : "push";
    paintMode();
    if (typeof HubThemes !== "undefined") applyTheme(items.theme);
    function begin(first) {
      settingsReady = true;
      var replay = queued;
      queued = [];
      for (var i = 0; i < replay.length; i++) onShow(replay[i]);
      if (currentUrl) return; // a link that arrived while starting has already been shown
      var start = first && HubLinks.normaliseHubUrl(first, settings.hubOrigin);
      if (start) show(start);
      else idle();
    }
    if (PANE) {
      var m = /^#u=(.+)$/.exec(location.hash);
      begin(m ? decodeURIComponent(m[1]) : null);
      window.parent.postMessage({ source: "hub-companion-pane", type: "ready" }, PAGE_ORIGIN);
    } else {
      chrome.storage.session.get({ panelUrl: "" }, function (s) { begin(s.panelUrl); });
    }
  });
})();
