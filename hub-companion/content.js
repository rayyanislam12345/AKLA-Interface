// Runs on claude.ai. Finds Hub links in the conversation by their address
// (never by claude.ai's class names), puts a small "Open beside" button after
// each, and tells the service worker about the newest link so an open panel
// can follow it. Nothing leaves the page: the only messages go to this
// extension's own service worker.
(function () {
  "use strict";
  if (typeof HubLinks === "undefined") return;

  var api = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id ? chrome : null;

  var BUTTON_CLASS = "hub-companion-open";
  var MARK = "data-hub-companion";
  var SCAN_DELAY = 400; // ms after the last DOM change before a scan
  var CONFIRM_DELAY = 1200; // ms an address at the very end of its text must stay unchanged before it counts as complete
  var SWITCH_QUIET = 3000; // ms after claude.ai changes conversation during which links are the old chat loading, not a new reply

  var origin = HubLinks.DEFAULT_ORIGIN;
  var hostNeedle = originHost(origin);
  var newestUrl = null;
  var unconfirmed = null; // an address with nothing after it yet: maybe still streaming
  var scanTimer = null;
  var confirmTimer = null;
  var pageHref = location.href;
  var quietUntil = 0;

  function originHost(o) {
    try {
      return new URL(o).host.toLowerCase();
    } catch (e) {
      return o.toLowerCase();
    }
  }

  function send(message) {
    return new Promise(function (resolve) {
      if (!api) return resolve(null);
      try {
        api.runtime.sendMessage(message, function (reply) {
          void api.runtime.lastError; // the worker may be asleep; not an error for us
          resolve(reply || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  // Places we never touch: the prompt box and anything editable, code the
  // page runs, and our own buttons.
  function insideSkipped(node) {
    var el = node.nodeType === 1 ? node : node.parentElement;
    while (el) {
      if (el.hasAttribute(MARK)) return true;
      if (el.isContentEditable) return true;
      var tag = el.tagName;
      if (tag === "TEXTAREA" || tag === "INPUT" || tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return true;
      el = el.parentElement;
    }
    return false;
  }

  function isButton(n) {
    return n && n.nodeType === 1 && n.hasAttribute(MARK);
  }

  function makeButton(url) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = BUTTON_CLASS;
    b.setAttribute(MARK, "1");
    b.dataset.url = url;
    b.textContent = "Open beside";
    b.title = "Show this " + HubLinks.linkKind(url) + " in the Hub panel";
    b.addEventListener("click", function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      delete b.dataset.hint;
      send({ type: "open", url: url }).then(function (reply) {
        if (reply && reply.ok) return;
        // The panel could not be opened from here (older Chrome, or the
        // gesture did not carry). The address is remembered, so the toolbar
        // button shows it.
        b.dataset.hint = "Click the Hub button in the toolbar";
        setTimeout(function () {
          delete b.dataset.hint;
        }, 6000);
      });
    });
    return b;
  }

  // One button per link in a given parent. A button whose address is a strict
  // prefix of the new one is a leftover from text that was still streaming
  // in; it goes.
  function placeButton(parent, before, url) {
    var existing = parent.querySelectorAll("button." + BUTTON_CLASS);
    for (var i = 0; i < existing.length; i++) {
      var u = existing[i].dataset.url;
      if (u === url) return;
      if (u && url.indexOf(u) === 0) existing[i].remove();
    }
    parent.insertBefore(makeButton(url), before);
  }

  // The node a button was placed after: the nearest earlier sibling that is
  // not one of our buttons (several buttons can follow one text node).
  function sourceOf(button) {
    var n = button.previousSibling;
    while (isButton(n)) n = n.previousSibling;
    return n;
  }

  // Whether `node` (an anchor or a text node) still carries `url`.
  function stillHas(node, url) {
    if (!node) return false;
    if (node.nodeType === 3) {
      var matches = HubLinks.findHubUrls(node.nodeValue, origin);
      for (var i = 0; i < matches.length; i++) if (matches[i].url === url) return true;
      return false;
    }
    if (node.nodeType === 1 && node.tagName === "A") return HubLinks.normaliseHubUrl(node.getAttribute("href"), origin) === url;
    return false;
  }

  // claude.ai re-renders a message when it streams, is edited or regenerated.
  // The text we matched is then rewritten in place and may no longer hold the
  // address a button points at, so stale buttons are dropped on every scan.
  function dropStale() {
    var buttons = document.body.querySelectorAll("button." + BUTTON_CLASS);
    for (var i = 0; i < buttons.length; i++) {
      var b = buttons[i];
      if (!stillHas(sourceOf(b), b.dataset.url)) b.remove();
    }
  }

  function handleAnchor(a, found) {
    var url = HubLinks.normaliseHubUrl(a.getAttribute("href"), origin);
    if (!url) return;
    found.push({ url: url, terminated: true }); // an href is never half-typed
    if (!a.parentNode) return;
    placeButton(a.parentNode, a.nextSibling, url);
  }

  function handleText(node, found) {
    var matches = HubLinks.findHubUrls(node.nodeValue, origin);
    if (!matches.length) return;
    for (var i = 0; i < matches.length; i++) found.push(matches[i]);
    if (!node.parentNode) return;
    // The button goes after the whole text node, never inside it: React owns
    // the node and rewrites its text on a re-render, so a split-off tail
    // would be shown twice. Several addresses in one node get their buttons
    // in order, all after the node.
    var before = node.nextSibling;
    while (isButton(before)) before = before.nextSibling;
    for (var j = 0; j < matches.length; j++) placeButton(node.parentNode, before, matches[j].url);
  }

  function report(url) {
    newestUrl = url;
    unconfirmed = null;
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = null;
    // Just after a change of conversation, the links on screen are the chat
    // that is loading, not something Claude has just said.
    if (Date.now() < quietUntil) return;
    send({ type: "seen", url: url });
  }

  function scan() {
    scanTimer = null;
    if (!document.body) return;
    if (location.href !== pageHref) {
      pageHref = location.href;
      quietUntil = Date.now() + SWITCH_QUIET;
    }
    dropStale();
    var found = []; // Hub addresses in document order; the last is the newest
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        if (n.nodeType === 3) {
          if (n.nodeValue.toLowerCase().indexOf(hostNeedle) === -1) return NodeFilter.FILTER_SKIP;
          if (n.parentElement && n.parentElement.closest("a[href]")) return NodeFilter.FILTER_SKIP; // the anchor handles it
          return insideSkipped(n) ? NodeFilter.FILTER_SKIP : NodeFilter.FILTER_ACCEPT;
        }
        if (n.hasAttribute(MARK) || n.isContentEditable) return NodeFilter.FILTER_REJECT;
        var tag = n.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEXTAREA") return NodeFilter.FILTER_REJECT;
        return tag === "A" && n.hasAttribute("href") ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    // Collect first, then change the DOM, so insertions are not revisited.
    var nodes = [];
    for (var n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n);
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].nodeType === 1) handleAnchor(nodes[i], found);
      else handleText(nodes[i], found);
    }
    var newest = found.length ? found[found.length - 1] : null;
    if (!newest || newest.url === newestUrl) return;
    if (newest.terminated) {
      report(newest.url);
      return;
    }
    // Nothing follows the address in its text: a reply may still be
    // streaming it. Count it once it has stayed the same for a moment; a
    // later scan with more of the address replaces it.
    if (unconfirmed === newest.url) return;
    unconfirmed = newest.url;
    if (confirmTimer) clearTimeout(confirmTimer);
    confirmTimer = setTimeout(function () {
      confirmTimer = null;
      if (unconfirmed) report(unconfirmed);
    }, CONFIRM_DELAY);
  }

  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, SCAN_DELAY);
  }

  function applySettings(items) {
    origin = HubLinks.normaliseOrigin(items && items.hubOrigin);
    hostNeedle = originHost(origin);
  }

  function start() {
    var observer = new MutationObserver(function (records) {
      // Our own insertions also fire; ignore mutations that are only ours.
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        if (r.type === "characterData") return scheduleScan();
        for (var j = 0; j < r.addedNodes.length; j++) {
          var a = r.addedNodes[j];
          if (!(a.nodeType === 1 && a.hasAttribute(MARK))) return scheduleScan();
        }
        for (var k = 0; k < r.removedNodes.length; k++) {
          var d = r.removedNodes[k];
          if (!(d.nodeType === 1 && d.hasAttribute(MARK))) return scheduleScan();
        }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    // claude.ai is a single-page app: a change of conversation is a pushState,
    // not a page load, and popstate covers the back button.
    window.addEventListener("popstate", scheduleScan);
    scheduleScan();
  }

  if (api && api.storage && api.storage.sync) {
    api.storage.sync.get({ hubOrigin: "" }, function (items) {
      void api.runtime.lastError;
      applySettings(items);
      start();
    });
    api.storage.onChanged.addListener(function (changes, area) {
      if (area === "sync" && changes.hubOrigin) {
        applySettings({ hubOrigin: changes.hubOrigin.newValue });
        scheduleScan();
      }
    });
  } else {
    // No extension runtime (a test page): default origin, no messages.
    start();
  }
})();
