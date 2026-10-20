// Runs on claude.ai. Puts text into the chat's message box WITHOUT sending
// it: the passage the lawyer highlighted in the Hub ("Ask Claude about
// this"), quoted, with the cursor after it, ready for their instruction.
// pane.js calls HubComposer.insert() for the drawer; the service worker sends
// { type: "composer:insert", text } for Chrome's side panel.
//
// Finding the box, without claude.ai's class names (first that fits):
//   1. the editable element that has focus now (its outermost contenteditable,
//      or a textarea);
//   2. the one that had focus last (tracked with focusin);
//   3. among the visible, enabled contenteditables and textareas, the last in
//      the page that says what it is for: role="textbox", or an aria-label,
//      placeholder or data-placeholder naming a prompt, message, reply, chat
//      or Claude; contenteditables before textareas;
//   4. else the last visible contenteditable, else the last textarea.
// Our own elements (data-hub-companion) are never chosen.
//
// Putting the text in, at the end of whatever is already typed, which is kept:
//   1. a synthetic paste (a "paste" ClipboardEvent carrying text/plain), which
//      ProseMirror and most editors handle as a paste; then check the text
//      is in the box;
//   2. if nothing handled the paste: document.execCommand("insertText") line
//      by line with "insertParagraph" between lines, all in one go (so
//      ProseMirror sees one change with text in it, never a lone new line it
//      could take for the Enter key); then check again;
//   3. otherwise (or if the page took the paste but the text is not in the
//      box, e.g. turned into an attachment) the text is copied to the
//      clipboard and a small notice by the box says "Copied: paste it into
//      the chat". Nothing is typed a second time.
// The box is focused and the caret put at the end. No key is pressed, no
// button clicked: nothing is ever sent.
(function () {
  "use strict";

  var MARK = "data-hub-companion"; // content.js skips anything carrying it
  var NOTICE_ID = "hub-companion-composer-notice";
  var PURPOSE = /prompt|message|reply|chat|claude|ask/i;
  var SETTLE = 50; // ms for the editor to read a new caret position
  var CHECK = 700; // ms to wait for the text to show in the box

  var lastFocused = null;

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function ours(el) {
    return !!(el && el.closest && el.closest("[" + MARK + "]"));
  }

  /** The editable box an element belongs to: a textarea, or the outermost contenteditable. */
  function boxOf(el) {
    if (!el || el.nodeType !== 1) return null;
    if (el.tagName === "TEXTAREA") return el;
    if (!el.isContentEditable) return null;
    while (el.parentElement && el.parentElement.isContentEditable) el = el.parentElement;
    return el;
  }

  function visible(el) {
    if (!el.isConnected) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none") return false;
    return !el.closest("[aria-hidden='true'], [inert]");
  }

  function usable(el) {
    if (!el || ours(el) || !visible(el)) return false;
    if (el.tagName === "TEXTAREA") return !el.disabled && !el.readOnly;
    return el.isContentEditable;
  }

  function saysPurpose(el) {
    if (el.getAttribute("role") === "textbox") return true;
    var words = [el.getAttribute("aria-label"), el.getAttribute("aria-placeholder"), el.getAttribute("placeholder"), el.getAttribute("data-placeholder")];
    // ProseMirror's placeholder sits on the empty first paragraph.
    var p = el.querySelector("[data-placeholder]");
    if (p) words.push(p.getAttribute("data-placeholder"));
    return PURPOSE.test(words.filter(Boolean).join(" "));
  }

  function findBox() {
    var focused = boxOf(document.activeElement);
    if (usable(focused)) return focused;
    if (usable(lastFocused)) return lastFocused;
    var found = document.querySelectorAll('[contenteditable]:not([contenteditable="false"]), textarea');
    var boxes = [];
    for (var i = 0; i < found.length; i++) {
      var b = boxOf(found[i]);
      if (b && boxes.indexOf(b) === -1 && usable(b)) boxes.push(b);
    }
    var groups = [
      boxes.filter(function (b) { return b.tagName !== "TEXTAREA" && saysPurpose(b); }),
      boxes.filter(function (b) { return b.tagName === "TEXTAREA" && saysPurpose(b); }),
      boxes.filter(function (b) { return b.tagName !== "TEXTAREA"; }),
      boxes,
    ];
    for (var g = 0; g < groups.length; g++) if (groups[g].length) return groups[g][groups[g].length - 1];
    return null;
  }

  document.addEventListener(
    "focusin",
    function (ev) {
      var b = boxOf(ev.target);
      if (b && !ours(b)) lastFocused = b;
    },
    true
  );

  // ---- reading the box ----
  function contentOf(box) {
    return box.tagName === "TEXTAREA" ? box.value : box.innerText || box.textContent || "";
  }
  function flat(s) {
    return String(s).replace(/\s+/g, " ").trim();
  }
  function count(hay, needle) {
    if (!needle) return 0;
    var n = 0;
    for (var i = hay.indexOf(needle); i !== -1; i = hay.indexOf(needle, i + needle.length)) n++;
    return n;
  }
  // The text is in: its first line shows once more than before, and what was
  // typed before is still there.
  function landed(box, before, text) {
    var now = flat(contentOf(box));
    var head = flat(text.split("\n")[0]);
    return count(now, head) > count(flat(before), head) && now.indexOf(flat(before)) !== -1;
  }
  async function settle(box, before, text) {
    for (var t = 0; t < CHECK; t += SETTLE) {
      if (landed(box, before, text)) return true;
      await wait(SETTLE);
    }
    return landed(box, before, text);
  }

  // ---- the caret ----
  // The end of the last thing typed: the deepest last text, skipping the
  // editor's trailing <br> and anything not editable.
  function endPoint(box) {
    var node = box;
    for (;;) {
      var child = node.lastChild;
      while (child && ((child.nodeType === 3 && !child.nodeValue.length) || (child.nodeType === 1 && (child.tagName === "BR" || !child.isContentEditable)) || (child.nodeType !== 1 && child.nodeType !== 3))) {
        child = child.previousSibling;
      }
      if (!child) return { node: node, offset: 0 };
      if (child.nodeType === 3) return { node: child, offset: child.nodeValue.length };
      node = child;
    }
  }
  function caretAtEnd(box) {
    if (box.tagName === "TEXTAREA") {
      var n = box.value.length;
      box.setSelectionRange(n, n);
      return;
    }
    var end = endPoint(box);
    var range = document.createRange();
    range.setStart(end.node, end.offset);
    range.collapse(true);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  // ---- the ways in ----
  function paste(box, text) {
    var data = new DataTransfer();
    data.setData("text/plain", text);
    var ev = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true });
    var sel = window.getSelection();
    var at = sel && sel.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement) : null;
    (at && box.contains(at) ? at : box).dispatchEvent(ev);
    return ev.defaultPrevented;
  }

  // Line by line, in one synchronous run: the editor reads all of it as one
  // change that carries text, never a bare new paragraph (which ProseMirror
  // can mistake for Enter, and Enter sends).
  function typeLines(text) {
    var lines = text.split("\n");
    var ok = true;
    for (var i = 0; i < lines.length; i++) {
      if (i > 0) ok = document.execCommand("insertParagraph") && ok;
      if (lines[i]) ok = document.execCommand("insertText", false, lines[i]) && ok;
    }
    return ok;
  }

  function setTextareaValue(box, value) {
    var setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
    setter.call(box, value);
    box.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function copy(text, box) {
    var ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      var area = document.createElement("textarea");
      area.setAttribute(MARK, "copy");
      area.value = text;
      area.style.cssText = "position:fixed;top:0;left:0;opacity:0;pointer-events:none;";
      document.documentElement.appendChild(area);
      area.select();
      try {
        ok = document.execCommand("copy");
      } catch (e2) {
        ok = false;
      }
      area.remove();
      if (box) {
        box.focus();
        caretAtEnd(box);
      }
    }
    return ok;
  }

  // A small line just above the box (or at the foot of the window), gone by
  // itself after a few seconds.
  function noticeBy(box, text) {
    var old = document.getElementById(NOTICE_ID);
    if (old) old.remove();
    var el = document.createElement("div");
    el.id = NOTICE_ID;
    el.setAttribute(MARK, "notice");
    el.setAttribute("role", "status");
    el.textContent = text;
    var r = box ? box.getBoundingClientRect() : null;
    var top = r ? Math.max(8, r.top - 40) : window.innerHeight - 60;
    var left = r ? Math.max(8, r.left) : 16;
    el.style.cssText =
      "all: initial; position: fixed; z-index: 2147483001; top: " + top + "px; left: " + left + "px;" +
      "padding: 6px 10px; border-radius: 6px; background: #1f2430; color: #fff;" +
      "font: 500 12px/1.4 system-ui, -apple-system, 'Segoe UI', sans-serif; box-shadow: 0 4px 14px rgba(0,0,0,.25); pointer-events: none;";
    document.documentElement.appendChild(el);
    setTimeout(function () { el.remove(); }, 6000);
  }

  async function fallBackToClipboard(box, text) {
    var copied = await copy(text, box);
    noticeBy(box, copied ? "Copied: paste it into the chat" : "Could not add the passage. Copy it from the Hub instead.");
    return { ok: false, how: copied ? "clipboard" : "none" };
  }

  /**
   * Puts `text` at the end of the chat's message box, keeping what is
   * typed there, and never sends. Resolves to { ok, how }: how is "paste" or
   * "typed" when the text is in the box, "clipboard" when it was copied
   * instead, "none" when neither worked.
   */
  async function insert(text) {
    text = String(text == null ? "" : text);
    if (!text) return { ok: false, how: "none" };
    var box = findBox();
    if (!box) return fallBackToClipboard(null, text);
    box.focus({ preventScroll: false });
    await wait(SETTLE);
    var before = contentOf(box);
    var typed = flat(before) !== "";

    if (box.tagName === "TEXTAREA") {
      var sep = !typed ? "" : /\n$/.test(before) ? "\n" : "\n\n";
      caretAtEnd(box);
      document.execCommand("insertText", false, sep + text);
      if (await settle(box, before, text)) return done(box, "typed");
      setTextareaValue(box, before + sep + text);
      if (await settle(box, before, text)) return done(box, "typed");
      return fallBackToClipboard(box, text);
    }

    // A leading line break starts the passage on a line of its own after
    // what is already typed.
    var payload = (typed ? "\n" : "") + text;
    caretAtEnd(box);
    await wait(SETTLE);
    var taken = paste(box, payload);
    if (await settle(box, before, text)) return done(box, "paste");
    // The page took the paste somewhere else: typing it as well could put
    // the passage in twice.
    if (taken) return fallBackToClipboard(box, text);
    caretAtEnd(box);
    typeLines(payload);
    if (await settle(box, before, text)) return done(box, "typed");
    return fallBackToClipboard(box, text);
  }

  async function done(box, how) {
    box.focus({ preventScroll: true });
    await wait(SETTLE);
    caretAtEnd(box);
    return { ok: true, how: how };
  }

  window.HubComposer = { insert: insert, findBox: findBox };

  // Chrome's side panel asks through the service worker.
  var api = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id ? chrome : null;
  if (api) {
    api.runtime.onMessage.addListener(function (message, sender, reply) {
      if (!message || message.type !== "composer:insert" || sender.id !== api.runtime.id) return;
      if (typeof message.text !== "string") return;
      insert(message.text).then(reply, function () { reply({ ok: false, how: "none" }); });
      return true; // the reply is sent later
    });
  }
})();
