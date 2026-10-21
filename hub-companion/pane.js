// The in-page drawer: the companion's panel inside the claude.ai tab, on the
// right, resizable, beside the chat. It is one fixed element of our own (a
// closed shadow root holding a frame of panel.html), never something grafted
// into claude.ai's components, so a redesign of the chat cannot break it.
// In "push" mode the chat is narrowed by the drawer's width; in "slide over"
// mode (and on a narrow window) the drawer sits on top of the chat.
// Each conversation remembers the last Hub page shown for it, in the tab's
// own sessionStorage, so switching chats switches the document.
// content.js drives it through the HubPane global (same content-script world).
// A passage the panel asks to quote in the chat ("insert") goes to
// composer.js (HubComposer, same world), and the outcome back to the panel.
(function () {
  "use strict";
  if (typeof HubLinks === "undefined") return;
  var api = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id ? chrome : null;
  if (!api) return;

  var MARK = "data-hub-companion"; // content.js never scans inside an element carrying it
  var HOST_ID = "hub-companion-pane";
  var STYLE_ID = "hub-companion-pane-page";
  var ATTR = "data-hub-pane"; // on <html>: "push" or "over" while the drawer is open
  var MIN_W = 340;
  var DEFAULT_W = 460;
  var MAX_SHARE = 0.7; // the chat keeps at least 30% of the window
  var NARROW = 1000; // below this window width the drawer always slides over
  var OPEN_KEY = "hub-companion:pane-open";
  var CONV_KEY = "hub-companion:conversations";
  // The extension's own origin as this browser spells it (Chrome:
  // chrome-extension://<id>; Edge may use extension://<id>).
  var EXT_ORIGIN = new URL(api.runtime.getURL("")).origin;
  var PAGE_ORIGIN = location.origin;
  var MAX_INSERT = 8000; // characters: a quoted passage (4,000) with its heading and "> " marks

  var settings = { hubOrigin: HubLinks.DEFAULT_ORIGIN, width: DEFAULT_W, mode: "push" };
  var host = null;
  var frame = null;
  var ready = false; // the panel inside has said hello
  var outbox = []; // messages for the panel, sent once it is ready
  var openNow = false;

  // ---- per-tab memory (the page's own sessionStorage, keys prefixed) ----
  function readJSON(key, fallback) {
    try {
      var v = sessionStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function writeJSON(key, value) {
    try {
      if (value == null) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* storage blocked: the drawer simply forgets */
    }
  }
  function conversationKey() {
    return location.pathname; // /chat/<id>, /project/<id>, /new …
  }
  function rememberFor(url) {
    var map = readJSON(CONV_KEY, {});
    map[conversationKey()] = url;
    var keys = Object.keys(map);
    if (keys.length > 200) delete map[keys[0]]; // a long day of chats stays small
    writeJSON(CONV_KEY, map);
  }
  function rememberedUrl() {
    var url = readJSON(CONV_KEY, {})[conversationKey()];
    return url ? HubLinks.normaliseHubUrl(url, settings.hubOrigin) : null;
  }

  // ---- layout ----
  function clampWidth(w) {
    var max = Math.max(MIN_W, Math.floor(window.innerWidth * MAX_SHARE));
    return Math.max(MIN_W, Math.min(max, Math.round(w) || DEFAULT_W));
  }
  function effectiveMode() {
    return settings.mode === "push" && window.innerWidth >= NARROW ? "push" : "over";
  }
  // The page-side rule for push mode. <body> becomes a fixed box ending where
  // the drawer starts; translateZ makes it the containing block for the
  // chat's own fixed elements (composer, menus), so they shrink with it.
  var PAGE_CSS =
    "html[" + ATTR + '="push"] > body {' +
    "position: fixed !important; top: 0 !important; left: 0 !important; bottom: 0 !important;" +
    "right: var(--hub-pane-w, " + DEFAULT_W + "px) !important; width: auto !important; height: auto !important;" +
    "margin: 0 !important; overflow: auto !important; overflow-x: hidden !important; transform: translateZ(0); }";
  function pageStyle() {
    var el = document.getElementById(STYLE_ID);
    if (el) return;
    el = document.createElement("style");
    el.id = STYLE_ID;
    el.setAttribute(MARK, "style");
    el.textContent = PAGE_CSS;
    (document.head || document.documentElement).appendChild(el);
  }
  function layout() {
    if (!host) return;
    var w = clampWidth(settings.width);
    host.style.width = w + "px";
    var html = document.documentElement;
    if (openNow) {
      html.style.setProperty("--hub-pane-w", w + "px");
      html.setAttribute(ATTR, effectiveMode());
      host.dataset.mode = effectiveMode();
    } else {
      html.removeAttribute(ATTR);
      html.style.removeProperty("--hub-pane-w");
    }
  }

  // ---- the drawer element ----
  var SHADOW_CSS =
    ":host { all: initial; position: fixed; top: 0; right: 0; bottom: 0; z-index: 2147483000; display: flex; }" +
    ":host([hidden]) { display: none; }" +
    ".edge { width: 6px; margin-right: -3px; cursor: col-resize; position: relative; z-index: 1; touch-action: none; }" +
    ".edge::after { content: ''; position: absolute; top: 0; bottom: 0; left: 2px; width: 1px; background: rgba(127,127,127,.35); }" +
    ".edge:hover::after, .edge.drag::after { width: 3px; left: 1px; background: rgba(127,127,127,.7); }" +
    "iframe { flex: 1 1 auto; border: 0; width: 100%; height: 100%; background: transparent; color-scheme: normal; }" +
    ":host([data-mode='over']) { box-shadow: -12px 0 32px rgba(0,0,0,.18); }" +
    ".drag-cover { position: fixed; inset: 0; cursor: col-resize; }";

  function build(firstUrl) {
    host = document.createElement("div");
    host.id = HOST_ID;
    host.setAttribute(MARK, "pane");
    var shadow = host.attachShadow({ mode: "closed" });
    var style = document.createElement("style");
    style.textContent = SHADOW_CSS;
    var edge = document.createElement("div");
    edge.className = "edge";
    edge.title = "Drag to resize";
    frame = document.createElement("iframe");
    frame.title = "AKLA Hub";
    frame.setAttribute("allow", "clipboard-read; clipboard-write");
    frame.src = api.runtime.getURL("panel.html") + "?mode=pane" + (firstUrl ? "#u=" + encodeURIComponent(firstUrl) : "");
    shadow.appendChild(style);
    shadow.appendChild(edge);
    shadow.appendChild(frame);
    dragOn(edge, shadow);
    document.documentElement.appendChild(host);
    ready = false;
  }

  function dragOn(edge, shadow) {
    edge.addEventListener("pointerdown", function (ev) {
      ev.preventDefault();
      var cover = document.createElement("div");
      cover.className = "drag-cover"; // keeps the pointer from falling into the frame mid-drag
      shadow.appendChild(cover);
      edge.classList.add("drag");
      edge.setPointerCapture(ev.pointerId);
      function move(e) {
        settings.width = clampWidth(window.innerWidth - e.clientX);
        layout();
      }
      function up() {
        edge.removeEventListener("pointermove", move);
        edge.removeEventListener("pointerup", up);
        edge.removeEventListener("pointercancel", up);
        edge.classList.remove("drag");
        cover.remove();
        api.storage.sync.set({ paneWidth: settings.width });
      }
      edge.addEventListener("pointermove", move);
      edge.addEventListener("pointerup", up);
      edge.addEventListener("pointercancel", up);
    });
  }

  function post(message) {
    message.source = "hub-companion";
    if (!frame || !ready) {
      outbox.push(message);
      return;
    }
    frame.contentWindow.postMessage(message, EXT_ORIGIN);
  }

  // Messages from the panel inside: only from our own frame and origin.
  window.addEventListener("message", function (ev) {
    if (!frame || ev.source !== frame.contentWindow || ev.origin !== EXT_ORIGIN) return;
    var d = ev.data;
    if (!d || d.source !== "hub-companion-pane") return;
    if (d.type === "ready") {
      ready = true;
      var queued = outbox;
      outbox = [];
      queued.forEach(function (m) { frame.contentWindow.postMessage(m, EXT_ORIGIN); });
    } else if (d.type === "close") {
      close();
    } else if (d.type === "location" && typeof d.url === "string") {
      var url = HubLinks.normaliseHubUrl(d.url, settings.hubOrigin);
      if (url) rememberFor(url);
    } else if (d.type === "insert" && typeof d.text === "string" && d.text.length <= MAX_INSERT) {
      if (typeof window.HubComposer === "undefined") return post({ type: "inserted", ok: false, how: "none" });
      window.HubComposer.insert(d.text).then(function (result) {
        post({ type: "inserted", ok: !!(result && result.ok), how: result && result.how });
      });
    }
  });

  // ---- public ----
  function open(url) {
    pageStyle();
    var first = url || rememberedUrl();
    if (!host) build(first);
    else {
      host.hidden = false;
      if (first) post({ type: "show", url: first, auto: false });
    }
    openNow = true;
    writeJSON(OPEN_KEY, true);
    layout();
  }
  function close() {
    openNow = false;
    writeJSON(OPEN_KEY, null);
    if (host) host.hidden = true;
    layout();
  }
  // "Open beside" was clicked, or a link came from the chat (auto).
  function show(url, auto) {
    var clean = HubLinks.normaliseHubUrl(url, settings.hubOrigin);
    if (!clean) return;
    if (auto && !openNow) {
      rememberFor(clean); // ready for when the drawer next opens in this chat
      return;
    }
    rememberFor(clean);
    if (!openNow) return open(clean);
    post({ type: "show", url: clean, auto: !!auto });
  }
  // claude.ai moved to another conversation (a pushState, not a load).
  function conversationChanged() {
    if (!openNow) return;
    var url = rememberedUrl();
    post(url ? { type: "show", url: url, auto: false } : { type: "idle" });
  }

  window.HubPane = {
    open: function (url) { open(url); },
    close: close,
    toggle: function () { if (openNow) close(); else open(); },
    isOpen: function () { return openNow; },
    show: show,
    conversationChanged: conversationChanged,
  };

  // The toolbar button (in-page view) toggles the drawer in this tab.
  api.runtime.onMessage.addListener(function (message, sender, reply) {
    if (!message || message.type !== "pane:toggle") return;
    window.HubPane.toggle();
    reply({ open: openNow });
  });

  window.addEventListener("resize", function () {
    if (openNow) layout();
  });

  api.storage.sync.get({ hubOrigin: "", paneWidth: DEFAULT_W, paneMode: "push", view: "page" }, function (items) {
    void api.runtime.lastError;
    settings.hubOrigin = HubLinks.normaliseOrigin(items.hubOrigin);
    settings.width = clampWidth(items.paneWidth);
    settings.mode = items.paneMode === "over" ? "over" : "push";
    // Open again after a reload if it was open in this tab, in the in-page view.
    if (items.view !== "side" && readJSON(OPEN_KEY, false)) open();
  });
  api.storage.onChanged.addListener(function (changes, area) {
    if (area !== "sync") return;
    if (changes.hubOrigin) settings.hubOrigin = HubLinks.normaliseOrigin(changes.hubOrigin.newValue);
    if (changes.paneWidth) settings.width = clampWidth(changes.paneWidth.newValue);
    if (changes.paneMode) settings.mode = changes.paneMode.newValue === "over" ? "over" : "push";
    if (changes.view && changes.view.newValue === "side" && openNow) close();
    if (openNow) layout();
  });
})();
