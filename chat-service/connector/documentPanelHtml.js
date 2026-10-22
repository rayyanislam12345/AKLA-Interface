// The document panel (ui://akla/document, connector/apps.js and
// connector/tools/documentPanel.js): one self-contained page, every style
// and script inline, nothing loaded from anywhere. A JS module because
// deploy.sh ships connector/*.js.
//
// The same host bridge as the changes panel (changesPanelHtml.js says how
// it matches the MCP Apps SDK on the wire): ui/initialize, then
// ui/notifications/initialized, size reports, ping and teardown answered.
// It draws structuredContent of kind "akla.document" (the version's text in
// numbered paragraphs), asks the host for the next page with tools/call
// (open_document_panel { versionId, from }), offers full screen with
// ui/request-display-mode when the host lists it, and sends the selected
// passage to the chat with ui/message as the Chrome companion's own quoted
// message (hub-companion/passage.js selectionMessage, ported below line for
// line; tests/connector-apps.test.js checks the two agree). When the host
// will not take the message, the text is shown selectable to copy instead.
// Every text is set with textContent, never as markup.
//
// No backticks and no dollar-brace in the page: it is a String.raw literal.

export const documentPanelHtml = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>AKLA document</title>
<style>
:root {
  color-scheme: light dark;
  --akla-gold: #B8902C;
  --fg: var(--color-text-primary, #141413);
  --fg2: var(--color-text-secondary, #3D3D3A);
  --fg3: var(--color-text-tertiary, #73726C);
  --surface: var(--color-background-secondary, #F7F6F1);
  --page: var(--color-background-primary, #FFFFFF);
  --line: var(--color-border-tertiary, rgba(31, 30, 29, 0.15));
  --line2: var(--color-border-secondary, rgba(31, 30, 29, 0.3));
  --brand: #1F3864;
  --accent: #1F3864;
  --on-accent: #FFFFFF;
  --ok-fg: var(--color-text-success, #265B19);
  --ok-bg: var(--color-background-success, #E9F1DC);
  --bad-fg: var(--color-text-danger, #7F2C28);
  --bad-bg: var(--color-background-danger, #F7ECEC);
  --radius: var(--border-radius-md, 8px);
  --font: var(--font-sans, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif);
  --pad-top: 0px; --pad-right: 0px; --pad-bottom: 0px; --pad-left: 0px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --fg: var(--color-text-primary, #FAF9F5);
    --fg2: var(--color-text-secondary, #C2C0B6);
    --fg3: var(--color-text-tertiary, #9C9A92);
    --surface: var(--color-background-secondary, #262624);
    --page: var(--color-background-primary, #30302E);
    --line: var(--color-border-tertiary, rgba(222, 220, 209, 0.15));
    --line2: var(--color-border-secondary, rgba(222, 220, 209, 0.3));
    --brand: #A9BCE6;
    --accent: #D9B65A;
    --on-accent: #141413;
    --ok-fg: var(--color-text-success, #7AB948);
    --ok-bg: var(--color-background-success, #1B4614);
    --bad-fg: var(--color-text-danger, #EE8884);
    --bad-bg: var(--color-background-danger, #602A28);
  }
}
:root[data-theme="dark"] {
  --fg: var(--color-text-primary, #FAF9F5);
  --fg2: var(--color-text-secondary, #C2C0B6);
  --fg3: var(--color-text-tertiary, #9C9A92);
  --surface: var(--color-background-secondary, #262624);
  --page: var(--color-background-primary, #30302E);
  --line: var(--color-border-tertiary, rgba(222, 220, 209, 0.15));
  --line2: var(--color-border-secondary, rgba(222, 220, 209, 0.3));
  --brand: #A9BCE6;
  --accent: #D9B65A;
  --on-accent: #141413;
  --ok-fg: var(--color-text-success, #7AB948);
  --ok-bg: var(--color-background-success, #1B4614);
  --bad-fg: var(--color-text-danger, #EE8884);
  --bad-bg: var(--color-background-danger, #602A28);
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
body { font-family: var(--font); font-size: 14px; line-height: 1.5; color: var(--fg); -webkit-text-size-adjust: 100%; }
#app { padding: calc(12px + var(--pad-top)) calc(12px + var(--pad-right)) calc(12px + var(--pad-bottom)) calc(12px + var(--pad-left)); }
.hd { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding-bottom: 8px; border-bottom: 2px solid var(--akla-gold); margin-bottom: 8px; }
.mark { font-weight: 700; letter-spacing: 0.08em; color: var(--brand); }
.ttl { font-weight: 600; }
.sub { flex-basis: 100%; color: var(--fg3); font-size: 12px; overflow-wrap: anywhere; }
.tools { display: flex; flex-wrap: wrap; gap: 10px; justify-content: flex-end; margin-bottom: 8px; }
.hint { font-size: 12px; color: var(--fg3); margin: 0 0 8px; }
.doc { background: var(--page); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; }
.doc.inline { max-height: 420px; overflow: auto; }
.para { display: flex; gap: 8px; margin: 0 0 8px; }
.para .n { flex: none; min-width: 2.2em; min-height: 24px; padding: 0 4px; font-size: 11px; color: var(--fg3); border: none; background: transparent; text-align: right; cursor: pointer; border-radius: 4px; }
.para .n:hover { color: var(--brand); text-decoration: underline; }
.para .t { flex: 1; overflow-wrap: anywhere; user-select: text; -webkit-user-select: text; }
.bar { position: sticky; bottom: 0; margin-top: 10px; padding: 8px 0 calc(4px + var(--pad-bottom)); background: transparent; display: flex; flex-direction: column; gap: 6px; }
.pick { font-size: 12px; color: var(--fg2); background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 6px 8px; overflow-wrap: anywhere; }
.banner { margin: 0 0 8px; padding: 8px 10px; border-radius: var(--radius); font-size: 13px; background: var(--surface); color: var(--fg2); border: 1px solid var(--line); }
.banner.ok { background: var(--ok-bg); color: var(--ok-fg); border-color: transparent; }
.banner.error { background: var(--bad-bg); color: var(--bad-fg); border-color: transparent; }
.copy { white-space: pre-wrap; font-size: 12px; user-select: all; -webkit-user-select: all; background: var(--surface); border: 1px dashed var(--line2); border-radius: var(--radius); padding: 8px; margin: 0 0 8px; }
button { font: inherit; font-size: 14px; min-height: 44px; padding: 0 14px; border-radius: var(--radius); cursor: pointer; border: 1px solid var(--line2); background: transparent; color: var(--fg); }
button:disabled { opacity: 0.5; cursor: default; }
button:focus-visible { outline: 2px solid var(--akla-gold); outline-offset: 2px; }
button.primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); font-weight: 600; }
button.link { border: none; min-height: 32px; padding: 0 4px; color: var(--brand); text-decoration: underline; font-size: 13px; }
.more { width: 100%; margin-top: 4px; }
.skeleton { height: 14px; border-radius: 4px; background: var(--surface); margin: 8px 0; }
.skeleton.short { width: 60%; }
.empty { color: var(--fg3); }
.url { font-size: 12px; color: var(--fg3); overflow-wrap: anywhere; user-select: all; }
</style>
</head>
<body>
<div id="app" aria-live="polite">
  <div class="hd"><span class="mark">AKLA</span><span class="ttl">Document</span><span class="sub">Opening the document…</span></div>
  <div class="skeleton"></div><div class="skeleton short"></div><div class="skeleton"></div>
</div>
<script>
(function () {
  "use strict";
  var PROTOCOL_VERSION = "2026-01-26";
  var KIND = "akla.document";
  var OPEN_TOOL = "open_document_panel";
  var parentWin = window.parent;
  var app = document.getElementById("app");
  var state = {
    doc: null, paragraphs: [], next: null, selection: "", busy: false, banner: null, copyText: null,
    fallbackText: null, hostCaps: {}, hostContext: {}, initialized: false, linkShown: false
  };

  // ------------------------------------------------------------ the passage message (hub-companion/passage.js)
  var LIMIT = 4000;
  function str(v) { return typeof v === "string" ? v : v == null ? "" : String(v); }
  function tidyPassage(raw) {
    var s = str(raw)
      .replace(/\r\n?/g, "\n")
      .replace(/ /g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (s.length <= LIMIT) return { text: s, truncated: false };
    return { text: s.slice(0, LIMIT).replace(/\s+$/, "") + "…", truncated: true };
  }
  function selectionMessage(d) {
    if (!d || typeof d !== "object") return null;
    var versionId = str(d.versionId).trim();
    var passage = tidyPassage(d.text);
    if (!versionId || !passage.text) return null;
    var title = str(d.title).trim() || "Untitled document";
    var n = Number(d.versionNumber);
    var head = 'In "' + title + '"' + (isFinite(n) && n > 0 ? " v" + n : "");
    var fileName = str(d.fileName).trim();
    if (fileName) head += " (" + fileName + ")";
    var projectName = str(d.projectName).trim();
    if (projectName) head += ", project " + projectName;
    head += " — versionId: " + versionId;
    var quoted = passage.text.split("\n").map(function (line) { return line ? "> " + line : ">"; });
    var lines = [head].concat(quoted);
    if (passage.truncated || d.truncated === true) lines.push("(Only the first " + LIMIT.toLocaleString("en-US") + " characters of the passage are quoted.)");
    return lines.join("\n") + "\n\n";
  }

  // ------------------------------------------------------------ JSON-RPC over postMessage
  var nextId = 1;
  var pending = {};
  function post(msg) { try { parentWin.postMessage(msg, "*"); } catch (e) { /* no host */ } }
  function notify(method, params) { post({ jsonrpc: "2.0", method: method, params: params || {} }); }
  function request(method, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      var timer = setTimeout(function () { delete pending[id]; reject(new Error("no answer from Claude")); }, timeoutMs || 60000);
      pending[id] = {
        resolve: function (r) { clearTimeout(timer); resolve(r); },
        reject: function (e) { clearTimeout(timer); reject(e); }
      };
      post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
    });
  }
  window.addEventListener("message", function (ev) {
    if (ev.source !== parentWin) return;
    var m = ev.data;
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return;
    if (typeof m.method === "string") {
      if (m.id !== undefined && m.id !== null) {
        if (m.method === "ping" || m.method === "ui/resource-teardown") return post({ jsonrpc: "2.0", id: m.id, result: {} });
        return post({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found: " + m.method } });
      }
      if (m.method === "ui/notifications/tool-result") return showResult(m.params || {});
      if (m.method === "ui/notifications/tool-cancelled") { state.banner = { kind: "error", text: "The tool call was cancelled." }; return render(); }
      if (m.method === "ui/notifications/host-context-changed") { applyHostContext(m.params || {}); return render(); }
      return;
    }
    if (m.id !== undefined && pending[m.id]) {
      var p = pending[m.id];
      delete pending[m.id];
      if (m.error) p.reject(new Error(m.error.message || "refused")); else p.resolve(m.result);
    }
  });

  function applyHostContext(ctx) {
    if (!ctx || typeof ctx !== "object") return;
    for (var k in ctx) if (Object.prototype.hasOwnProperty.call(ctx, k)) state.hostContext[k] = ctx[k];
    var root = document.documentElement;
    if (ctx.theme === "light" || ctx.theme === "dark") { root.setAttribute("data-theme", ctx.theme); root.style.colorScheme = ctx.theme; }
    var vars = ctx.styles && ctx.styles.variables;
    if (vars && typeof vars === "object") {
      for (var name in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, name) && typeof vars[name] === "string" && name.indexOf("--") === 0) root.style.setProperty(name, vars[name]);
      }
    }
    var fonts = ctx.styles && ctx.styles.css && ctx.styles.css.fonts;
    if (typeof fonts === "string" && fonts && !document.getElementById("host-fonts")) {
      var st = document.createElement("style");
      st.setAttribute("id", "host-fonts");
      st.textContent = fonts;
      document.head.appendChild(st);
    }
    var ins = ctx.safeAreaInsets;
    if (ins && typeof ins === "object") {
      ["top", "right", "bottom", "left"].forEach(function (side) {
        if (typeof ins[side] === "number") root.style.setProperty("--pad-" + side, Math.max(0, ins[side]) + "px");
      });
    }
  }

  var lastW = 0, lastH = 0, measuring = false;
  function measure() {
    if (!state.initialized || measuring) return;
    measuring = true;
    var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 16); };
    raf(function () {
      measuring = false;
      var el = document.documentElement;
      var was = el.style.height;
      el.style.height = "max-content";
      var h = Math.ceil(el.getBoundingClientRect().height);
      el.style.height = was;
      var w = Math.ceil(window.innerWidth || 0);
      if (w !== lastW || h !== lastH) { lastW = w; lastH = h; notify("ui/notifications/size-changed", { width: w, height: h }); }
    });
  }

  // ------------------------------------------------------------ data
  function textOf(result) {
    var c = result && result.content;
    if (!c || !c.length) return "";
    for (var i = 0; i < c.length; i++) if (c[i] && c[i].type === "text" && typeof c[i].text === "string") return c[i].text;
    return "";
  }
  function showResult(result) {
    var sc = result && result.structuredContent;
    if (sc && sc.kind === KIND) {
      state.doc = sc;
      state.paragraphs = (sc.paragraphs || []).slice();
      state.next = sc.next || null;
      state.fallbackText = null;
    } else {
      state.fallbackText = textOf(result) || "Nothing to show.";
      if (result && result.isError) state.banner = { kind: "error", text: state.fallbackText };
    }
    render();
  }
  function isFullscreen() { return state.hostContext.displayMode === "fullscreen"; }

  // ------------------------------------------------------------ drawing
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function button(label, cls, onClick, aria) {
    var b = el("button", cls, label);
    b.setAttribute("type", "button");
    if (aria) b.setAttribute("aria-label", aria);
    b.disabled = state.busy;
    b.addEventListener("click", onClick);
    return b;
  }
  function render() {
    app.textContent = "";
    var d = state.doc;
    var hd = el("div", "hd");
    hd.appendChild(el("span", "mark", "AKLA"));
    hd.appendChild(el("span", "ttl", "Document"));
    var sub = d ? [d.title || "Document", d.versionNumber ? "v" + d.versionNumber : null, d.fileName, d.projectName].filter(Boolean).join(" · ") : (state.fallbackText ? "" : "Opening the document…");
    if (sub) hd.appendChild(el("span", "sub", sub));
    app.appendChild(hd);

    if (state.banner) {
      var bn = el("div", "banner" + (state.banner.kind === "ok" ? " ok" : state.banner.kind === "error" ? " error" : ""), state.banner.text);
      bn.setAttribute("role", state.banner.kind === "error" ? "alert" : "status");
      app.appendChild(bn);
    }
    if (state.copyText) app.appendChild(el("div", "copy", state.copyText));

    if (!d) {
      if (state.fallbackText) app.appendChild(el("div", "empty", state.fallbackText.split("\n")[0]));
      else { app.appendChild(el("div", "skeleton")); app.appendChild(el("div", "skeleton short")); }
      measure();
      return;
    }

    var tools = el("div", "tools");
    var modes = state.hostContext.availableDisplayModes || [];
    if (modes.indexOf && modes.indexOf("fullscreen") >= 0) tools.appendChild(button(isFullscreen() ? "Back to the chat" : "Full screen", "link", function () { setMode(isFullscreen() ? "inline" : "fullscreen"); }));
    // Picture in picture, where the host offers it: the document floats and
    // stays in view while the chat goes on (the nearest a panel comes to
    // sitting beside the chat).
    var floating = state.hostContext.displayMode === "pip";
    if (modes.indexOf && modes.indexOf("pip") >= 0) tools.appendChild(button(floating ? "Back into the reply" : "Keep in view", "link", function () { setMode(floating ? "inline" : "pip"); }));
    if (d.hubUrl) tools.appendChild(button("Open in Hub ↗", "link", function () { openLink(d.hubUrl); }));
    app.appendChild(tools);
    if (state.linkShown && d.hubUrl) app.appendChild(el("div", "url", d.hubUrl));
    app.appendChild(el("div", "hint", "Select a passage, then send it to the chat; or tap a paragraph's number to quote the whole paragraph."));

    var box = el("div", isFullscreen() ? "doc" : "doc inline");
    box.setAttribute("id", "doc");
    state.paragraphs.forEach(function (p) {
      var row = el("div", "para");
      row.appendChild(button(String(p.n), "n", function () { state.selection = p.text; send(); }, "Quote paragraph " + p.n));
      row.appendChild(el("div", "t", p.text));
      box.appendChild(row);
    });
    if (!state.paragraphs.length) box.appendChild(el("div", "empty", "No text could be shown for this version."));
    if (state.next) box.appendChild(button("Show more of the document", "more", loadMore));
    app.appendChild(box);

    var bar = el("div", "bar");
    if (state.selection) bar.appendChild(el("div", "pick", "“" + (state.selection.length > 140 ? state.selection.slice(0, 139) + "…" : state.selection) + "”"));
    var go = button("Ask Claude about the selected text", "primary", send);
    go.disabled = state.busy || !state.selection;
    bar.appendChild(go);
    app.appendChild(bar);
    measure();
  }

  // ------------------------------------------------------------ actions
  function currentSelection() {
    try {
      var sel = window.getSelection ? window.getSelection() : null;
      return sel ? String(sel.toString() || "").trim() : "";
    } catch (e) { return ""; }
  }
  document.addEventListener("selectionchange", function () {
    var s = currentSelection();
    if (s && s !== state.selection) { state.selection = s; updateBar(); }
  });
  // Only the bar changes while the lawyer selects: a full redraw would drop the selection.
  function updateBar() {
    var bars = app.getElementsByClassName ? app.getElementsByClassName("bar") : [];
    if (!bars.length) return;
    var bar = bars[0];
    bar.textContent = "";
    bar.appendChild(el("div", "pick", "“" + (state.selection.length > 140 ? state.selection.slice(0, 139) + "…" : state.selection) + "”"));
    var go = button("Ask Claude about the selected text", "primary", send);
    go.disabled = state.busy || !state.selection;
    bar.appendChild(go);
    measure();
  }

  function send() {
    var d = state.doc;
    var text = currentSelection() || state.selection;
    if (!d || !text || state.busy) return;
    var message = selectionMessage({ text: text, title: d.title, versionId: d.versionId, versionNumber: d.versionNumber, fileName: d.fileName, projectName: d.projectName });
    if (!message) return;
    state.busy = true;
    render();
    request("ui/message", { role: "user", content: [{ type: "text", text: message }] }, 30000).then(function (r) {
      state.busy = false;
      if (r && r.isError) { state.banner = { kind: "error", text: "Claude did not take the passage. Copy it from the box below into the chat." }; state.copyText = message; }
      else { state.banner = { kind: "ok", text: "The passage is in the chat. Say what you want done with it." }; state.copyText = null; state.selection = ""; }
      render();
    }, function (err) {
      state.busy = false;
      state.banner = { kind: "error", text: "Claude did not take the passage (" + (err && err.message ? err.message : "refused") + "). Copy it from the box below into the chat." };
      state.copyText = message;
      render();
    });
  }

  function loadMore() {
    var d = state.doc;
    if (!d || !state.next || state.busy) return;
    state.busy = true;
    render();
    request("tools/call", { name: OPEN_TOOL, arguments: { versionId: d.versionId, from: state.next } }, 120000).then(function (res) {
      state.busy = false;
      var sc = res && res.structuredContent;
      if (sc && sc.kind === KIND && sc.versionId === d.versionId) {
        state.paragraphs = state.paragraphs.concat(sc.paragraphs || []);
        state.next = sc.next || null;
      } else state.banner = { kind: "error", text: textOf(res) || "The next page could not be read." };
      render();
    }, function (err) {
      state.busy = false;
      state.banner = { kind: "error", text: "The next page could not be read (" + (err && err.message ? err.message : "refused") + ")." };
      render();
    });
  }

  function openLink(url) {
    request("ui/open-link", { url: url }, 15000).then(null, function () { state.linkShown = true; render(); });
  }
  function setMode(mode) {
    request("ui/request-display-mode", { mode: mode }, 15000).then(function (r) {
      if (r && r.mode) state.hostContext.displayMode = r.mode;
      render();
    }, function () { /* the host keeps its mode */ });
  }

  // ------------------------------------------------------------ start
  request("ui/initialize", {
    appInfo: { name: "AKLA document panel", version: "0.1.0" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen", "pip"] },
    protocolVersion: PROTOCOL_VERSION
  }, 30000).then(function (result) {
    result = result || {};
    state.hostCaps = result.hostCapabilities || {};
    applyHostContext(result.hostContext || {});
    state.initialized = true;
    notify("ui/notifications/initialized", {});
    render();
    measure();
    if (typeof ResizeObserver === "function") {
      var ro = new ResizeObserver(measure);
      ro.observe(document.documentElement);
      ro.observe(document.body);
    }
  }, function (err) {
    state.fallbackText = "This panel could not reach Claude (" + (err && err.message ? err.message : "no answer") + "). The reply above says how to read the document.";
    render();
  });
})();
</script>
</body>
</html>
`;
