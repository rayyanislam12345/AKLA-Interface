// The changes panel (ui://akla/changes, connector/apps.js): one
// self-contained page, every style and script inline, nothing loaded from
// anywhere (the host's default CSP, which blocks every outside origin,
// stands). It is kept as a JS module, not an .html file, because deploy.sh
// ships connector/*.js.
//
// The page talks to the host the way the MCP Apps SDK's App class does
// (@modelcontextprotocol/ext-apps 1.7.5 and 2.0.3, PostMessageTransport):
// JSON-RPC 2.0 over window.parent.postMessage(msg, "*"), listening only to
// messages whose source is window.parent. It sends ui/initialize
// ({ appInfo, appCapabilities, protocolVersion "2026-01-26" }), waits for the
// answer, applies the host's theme, style variables and fonts, then sends
// ui/notifications/initialized and starts reporting its size
// (ui/notifications/size-changed, the SDK's own measure). It draws from
// ui/notifications/tool-result's structuredContent (kind "akla.changes",
// connector/tools/changesPanel.js panelData), answers ping and
// ui/resource-teardown, and asks the host for tools/call (decide_changes,
// list_changes), ui/open-link, ui/request-display-mode and, when the host
// offers it, ui/update-model-context. Every text is set with textContent,
// never as markup. The SDK itself is not bundled: it is about 330 KB with
// its dependencies and the page needs a few dozen lines of it.
//
// No backticks and no dollar-brace in the page: it is a String.raw literal.

export const changesPanelHtml = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>AKLA changes</title>
<style>
:root {
  color-scheme: light dark;
  --akla-navy: #1F3864;
  --akla-gold: #B8902C;
  --fg: var(--color-text-primary, #141413);
  --fg2: var(--color-text-secondary, #3D3D3A);
  --fg3: var(--color-text-tertiary, #73726C);
  --surface: var(--color-background-secondary, #F7F6F1);
  --line: var(--color-border-tertiary, rgba(31, 30, 29, 0.15));
  --line2: var(--color-border-secondary, rgba(31, 30, 29, 0.3));
  --brand: #1F3864;
  --accent: #1F3864;
  --on-accent: #FFFFFF;
  --ins-fg: #17602E;
  --ins-bg: #E3F1E6;
  --del-fg: #8E2420;
  --del-bg: #F7E4E2;
  --ok-fg: var(--color-text-success, #265B19);
  --ok-bg: var(--color-background-success, #E9F1DC);
  --bad-fg: var(--color-text-danger, #7F2C28);
  --bad-bg: var(--color-background-danger, #F7ECEC);
  --wait-fg: #6B4E0E;
  --wait-bg: #F6EEDF;
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
    --line: var(--color-border-tertiary, rgba(222, 220, 209, 0.15));
    --line2: var(--color-border-secondary, rgba(222, 220, 209, 0.3));
    --brand: #A9BCE6;
    --accent: #D9B65A;
    --on-accent: #141413;
    --ins-fg: #8FD19E;
    --ins-bg: rgba(46, 125, 50, 0.25);
    --del-fg: #F2A3A3;
    --del-bg: rgba(198, 40, 40, 0.22);
    --ok-fg: var(--color-text-success, #7AB948);
    --ok-bg: var(--color-background-success, #1B4614);
    --bad-fg: var(--color-text-danger, #EE8884);
    --bad-bg: var(--color-background-danger, #602A28);
    --wait-fg: #D1A041;
    --wait-bg: #483A0F;
  }
}
:root[data-theme="dark"] {
  --fg: var(--color-text-primary, #FAF9F5);
  --fg2: var(--color-text-secondary, #C2C0B6);
  --fg3: var(--color-text-tertiary, #9C9A92);
  --surface: var(--color-background-secondary, #262624);
  --line: var(--color-border-tertiary, rgba(222, 220, 209, 0.15));
  --line2: var(--color-border-secondary, rgba(222, 220, 209, 0.3));
  --brand: #A9BCE6;
  --accent: #D9B65A;
  --on-accent: #141413;
  --ins-fg: #8FD19E;
  --ins-bg: rgba(46, 125, 50, 0.25);
  --del-fg: #F2A3A3;
  --del-bg: rgba(198, 40, 40, 0.22);
  --ok-fg: var(--color-text-success, #7AB948);
  --ok-bg: var(--color-background-success, #1B4614);
  --bad-fg: var(--color-text-danger, #EE8884);
  --bad-bg: var(--color-background-danger, #602A28);
  --wait-fg: #D1A041;
  --wait-bg: #483A0F;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
body { font-family: var(--font); font-size: 14px; line-height: 1.45; color: var(--fg); -webkit-text-size-adjust: 100%; }
#app { padding: calc(12px + var(--pad-top)) calc(12px + var(--pad-right)) calc(12px + var(--pad-bottom)) calc(12px + var(--pad-left)); }
.hd { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding-bottom: 8px; border-bottom: 2px solid var(--akla-gold); margin-bottom: 10px; }
.mark { font-weight: 700; letter-spacing: 0.08em; color: var(--brand); }
.ttl { font-weight: 600; color: var(--fg); }
.sub { flex-basis: 100%; color: var(--fg3); font-size: 12px; overflow-wrap: anywhere; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
.chip { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--surface); color: var(--fg2); border: 1px solid var(--line); }
.chip.waiting { background: var(--wait-bg); color: var(--wait-fg); border-color: transparent; }
.chip.accepted { background: var(--ok-bg); color: var(--ok-fg); border-color: transparent; }
.chip.rejected { background: var(--bad-bg); color: var(--bad-fg); border-color: transparent; }
.banner { margin: 0 0 10px; padding: 8px 10px; border-radius: var(--radius); font-size: 13px; background: var(--surface); color: var(--fg2); border: 1px solid var(--line); }
.banner.ok { background: var(--ok-bg); color: var(--ok-fg); border-color: transparent; }
.banner.error { background: var(--bad-bg); color: var(--bad-fg); border-color: transparent; }
.banner .act { margin-left: 6px; }
.note { margin: 0 0 10px; font-size: 12px; color: var(--fg3); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 10px; }
.card.done { opacity: 0.8; }
.meta { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 12px; color: var(--fg3); }
.num { font-weight: 700; color: var(--brand); min-width: 1.4em; }
.where { flex: 1; overflow-wrap: anywhere; }
.pill { font-size: 11px; padding: 1px 7px; border-radius: 999px; white-space: nowrap; background: var(--wait-bg); color: var(--wait-fg); }
.pill.accepted { background: var(--ok-bg); color: var(--ok-fg); }
.pill.rejected { background: var(--bad-bg); color: var(--bad-fg); }
.pill.other { background: transparent; color: var(--fg3); border: 1px solid var(--line2); }
.diff { color: var(--fg); overflow-wrap: anywhere; white-space: pre-wrap; }
.diff.clamped { max-height: 9.6em; overflow: hidden; -webkit-mask-image: linear-gradient(to bottom, #000 70%, transparent); mask-image: linear-gradient(to bottom, #000 70%, transparent); }
.ins { color: var(--ins-fg); background: var(--ins-bg); text-decoration: underline; text-decoration-thickness: 1px; border-radius: 2px; }
.del { color: var(--del-fg); background: var(--del-bg); text-decoration: line-through; border-radius: 2px; }
.lbl { display: block; font-size: 11px; color: var(--fg3); margin-top: 4px; }
.why { margin-top: 6px; font-size: 12px; color: var(--fg2); font-style: italic; overflow-wrap: anywhere; }
.state-note { margin-top: 6px; font-size: 12px; color: var(--fg3); }
.acts { display: flex; gap: 8px; margin-top: 8px; }
.acts button { flex: 1; }
button { font: inherit; font-size: 14px; min-height: 44px; padding: 0 14px; border-radius: var(--radius); cursor: pointer; border: 1px solid var(--line2); background: transparent; color: var(--fg); }
button:disabled { opacity: 0.5; cursor: default; }
button:focus-visible { outline: 2px solid var(--akla-gold); outline-offset: 2px; }
button.primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); font-weight: 600; }
button.danger { color: var(--bad-fg); }
button.link { border: none; min-height: 32px; padding: 0 4px; color: var(--brand); text-decoration: underline; font-size: 13px; }
button.small { min-height: 32px; font-size: 13px; padding: 0 10px; }
.more { width: 100%; margin-top: 8px; }
.ft { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--line); }
.ft .grow { flex: 1 1 140px; }
.ft .links { display: flex; gap: 10px; flex-basis: 100%; justify-content: flex-end; }
.skeleton { height: 14px; border-radius: 4px; background: var(--surface); margin: 8px 0; }
.skeleton.short { width: 60%; }
.empty { color: var(--fg3); }
.url { font-size: 12px; color: var(--fg3); overflow-wrap: anywhere; user-select: all; }
</style>
</head>
<body>
<div id="app" aria-live="polite">
  <div class="hd"><span class="mark">AKLA</span><span class="ttl">Changes</span><span class="sub">Loading the changes…</span></div>
  <div class="skeleton"></div><div class="skeleton short"></div><div class="skeleton"></div>
</div>
<script>
(function () {
  "use strict";
  var PROTOCOL_VERSION = "2026-01-26";
  var KIND = "akla.changes";
  var DECIDE_TOOL = "decide_changes";
  var LIST_TOOL = "list_changes";
  var SHOWN_AT_FIRST = 6;
  var MAX_DECISIONS = 200;
  var LONG_TEXT = 600;
  var parentWin = window.parent;
  var app = document.getElementById("app");

  var state = {
    data: null, fallbackText: null, busy: false, banner: null, showAll: false, open: {},
    confirmAll: null, confirmTimer: null, hostCaps: {}, hostContext: {}, initialized: false, linkShown: false
  };

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
  function onRequest(m) {
    if (m.method === "ping") return post({ jsonrpc: "2.0", id: m.id, result: {} });
    if (m.method === "ui/resource-teardown") return post({ jsonrpc: "2.0", id: m.id, result: {} });
    post({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "Method not found: " + m.method } });
  }
  function onNotification(m) {
    var p = m.params || {};
    if (m.method === "ui/notifications/tool-result") return showResult(p);
    if (m.method === "ui/notifications/tool-cancelled") { state.banner = { kind: "error", text: "The tool call was cancelled." }; return render(); }
    if (m.method === "ui/notifications/host-context-changed") { applyHostContext(p); return render(); }
    // tool-input and tool-input-partial carry the arguments; the result carries all the panel needs.
  }
  window.addEventListener("message", function (ev) {
    if (ev.source !== parentWin) return;
    var m = ev.data;
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") return;
    if (typeof m.method === "string") {
      if (m.id !== undefined && m.id !== null) return onRequest(m);
      return onNotification(m);
    }
    if (m.id !== undefined && pending[m.id]) {
      var p = pending[m.id];
      delete pending[m.id];
      if (m.error) p.reject(new Error(m.error.message || "refused")); else p.resolve(m.result);
    }
  });

  // ------------------------------------------------------------ the host's look
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

  // ------------------------------------------------------------ size
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
  function watchSize() {
    measure();
    if (typeof ResizeObserver === "function") {
      var ro = new ResizeObserver(measure);
      ro.observe(document.documentElement);
      ro.observe(document.body);
    }
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
      state.data = sc;
      state.fallbackText = null;
      if (result.isError) state.banner = { kind: "error", text: textOf(result) };
    } else {
      state.fallbackText = textOf(result) || "Nothing to show.";
      if (result && result.isError) state.banner = { kind: "error", text: state.fallbackText };
    }
    render();
  }
  function waitingIds() {
    var d = state.data;
    if (!d || !d.changes) return [];
    return d.changes.filter(function (c) { return c.canDecide; }).map(function (c) { return c.id; });
  }

  // ------------------------------------------------------------ word diff
  function tokens(s) { return String(s || "").match(/\S+\s*/g) || []; }
  function wordDiff(before, after) {
    var a = tokens(before), b = tokens(after);
    var n = a.length, m = b.length;
    if (!n) return m ? [["ins", after]] : [];
    if (!m) return [["del", before]];
    if (n * m > 160000) return null;
    var key = function (t) { return t.replace(/\s+$/, ""); };
    var w = m + 1;
    var dp = new Uint32Array((n + 1) * w);
    for (var i = n - 1; i >= 0; i--) {
      for (var j = m - 1; j >= 0; j--) {
        dp[i * w + j] = key(a[i]) === key(b[j]) ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    var out = [];
    var push = function (kind, t) { var last = out[out.length - 1]; if (last && last[0] === kind) last[1] += t; else out.push([kind, t]); };
    i = 0; j = 0;
    while (i < n && j < m) {
      if (key(a[i]) === key(b[j])) { push("same", b[j]); i++; j++; }
      else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { push("del", a[i]); i++; }
      else { push("ins", b[j]); j++; }
    }
    while (i < n) push("del", a[i++]);
    while (j < m) push("ins", b[j++]);
    return out;
  }

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
  function plural(k, one, many) { return k === 1 ? one : (many || one + "s"); }
  function whereOf(c) {
    var parts = [];
    if (c.clause) parts.push("Clause " + c.clause);
    if (c.paragraph !== null && c.paragraph !== undefined) parts.push("¶" + c.paragraph);
    if (c.part && c.part !== "body") parts.push(c.part);
    parts.push(c.kind === "addition" ? "addition" : c.kind === "deletion" ? "deletion" : "change");
    return parts.join(" · ");
  }
  function pillClass(s) { return s === "accepted" ? "pill accepted" : s === "rejected" ? "pill rejected" : s === "waiting" ? "pill" : "pill other"; }

  function drawDiff(c) {
    var box = el("div", "diff");
    var long = (c.before || "").length + (c.after || "").length > LONG_TEXT;
    if (long && !state.open[c.id]) box.className = "diff clamped";
    var parts = wordDiff(c.before, c.after);
    if (parts) {
      parts.forEach(function (p) { box.appendChild(p[0] === "same" ? document.createTextNode(p[1]) : el("span", p[0], p[1])); });
    } else {
      box.appendChild(el("span", "lbl", "Before"));
      box.appendChild(el("span", "del", c.before));
      box.appendChild(el("span", "lbl", "After"));
      box.appendChild(el("span", "ins", c.after));
    }
    var wrap = el("div");
    wrap.appendChild(box);
    if (long) {
      wrap.appendChild(button(state.open[c.id] ? "Show less" : "Show the whole text", "link", function () { state.open[c.id] = !state.open[c.id]; render(); }));
    }
    return wrap;
  }

  function drawCard(c, canDecide) {
    var li = el("li", c.state === "waiting" ? "card" : "card done");
    var meta = el("div", "meta");
    meta.appendChild(el("span", "num", c.number));
    meta.appendChild(el("span", "where", whereOf(c)));
    meta.appendChild(el("span", pillClass(c.state), c.stateLabel || c.state));
    li.appendChild(meta);
    li.appendChild(drawDiff(c));
    if (c.why) li.appendChild(el("div", "why", "Why: " + c.why));
    if (c.note) li.appendChild(el("div", "state-note", c.note));
    if (c.decidedBy && (c.state === "accepted" || c.state === "rejected")) li.appendChild(el("div", "state-note", (c.state === "accepted" ? "Accepted" : "Rejected") + " by " + c.decidedBy));
    if (canDecide && c.canDecide) {
      var acts = el("div", "acts");
      acts.appendChild(button("Accept", "primary", function () { decide([{ id: c.id, decision: "accept" }]); }, "Accept change " + c.number));
      acts.appendChild(button("Reject", "danger", function () { decide([{ id: c.id, decision: "reject" }]); }, "Reject change " + c.number));
      li.appendChild(acts);
    }
    return li;
  }

  function render() {
    app.textContent = "";
    var d = state.data;
    var hd = el("div", "hd");
    hd.appendChild(el("span", "mark", "AKLA"));
    hd.appendChild(el("span", "ttl", "Changes"));
    var sub = d ? [d.title || "Document", d.versionNumber ? "v" + d.versionNumber : null, d.projectName].filter(Boolean).join(" · ") : (state.fallbackText ? "" : "Loading the changes…");
    if (sub) hd.appendChild(el("span", "sub", sub));
    app.appendChild(hd);

    if (state.banner) {
      var bn = el("div", "banner" + (state.banner.kind === "ok" ? " ok" : state.banner.kind === "error" ? " error" : ""), state.banner.text);
      bn.setAttribute("role", state.banner.kind === "error" ? "alert" : "status");
      if (state.banner.kind === "error" && d) bn.appendChild(button("Refresh the list", "link act", refresh));
      app.appendChild(bn);
    }

    if (!d) {
      if (state.fallbackText) app.appendChild(el("div", "empty", state.fallbackText.split("\n")[0]));
      else { app.appendChild(el("div", "skeleton")); app.appendChild(el("div", "skeleton short")); }
      measure();
      return;
    }

    var k = d.counts || {};
    var chips = el("div", "chips");
    chips.appendChild(el("span", "chip waiting", (k.waiting || 0) + " waiting"));
    chips.appendChild(el("span", "chip accepted", (k.accepted || 0) + " accepted"));
    chips.appendChild(el("span", "chip rejected", (k.rejected || 0) + " rejected"));
    var rest = (k.couldNotPlace || 0) + (k.needsWord || 0) + (k.replaced || 0);
    if (rest) chips.appendChild(el("span", "chip", rest + " other"));
    app.appendChild(chips);

    if (d.newer) app.appendChild(el("div", "note", "A newer version (v" + d.newer.versionNumber + ") exists; changes still waiting here were carried forward to it, so decide them there."));
    if (!d.canDecide) app.appendChild(el("div", "note", "This sign-in is read-only: decide in the Hub, or remove and re-add the AKLA Hub connector to turn saving on."));
    if (d.notDone && d.notDone.length) {
      var byId = {};
      (d.changes || []).forEach(function (c) { byId[c.id] = c; });
      d.notDone.forEach(function (n) { app.appendChild(el("div", "note", "Change " + (byId[n.id] ? byId[n.id].number : "?") + " was not decided: " + (n.note || "it cannot be decided here."))); });
    }

    var changes = d.changes || [];
    if (!changes.length) app.appendChild(el("div", "empty", "No AKLA AI changes are recorded on this version."));
    var shown = state.showAll || state.hostContext.displayMode === "fullscreen" ? changes : changes.slice(0, SHOWN_AT_FIRST);
    var list = el("ol", "list");
    shown.forEach(function (c) { list.appendChild(drawCard(c, d.canDecide)); });
    app.appendChild(list);
    if (shown.length < changes.length) app.appendChild(button("Show " + (changes.length - shown.length) + " more", "more", function () { state.showAll = true; render(); }));
    if (d.more) app.appendChild(el("div", "note", d.more + " more " + plural(d.more, "change") + " in the Hub's Changes list."));

    var ft = el("div", "ft");
    var ids = waitingIds();
    if (d.canDecide && ids.length > 1) {
      var n = Math.min(ids.length, MAX_DECISIONS);
      ft.appendChild(button(state.confirmAll === "accept" ? "Confirm: accept all " + n : "Accept all " + n, "primary grow", function () { all("accept"); }));
      ft.appendChild(button(state.confirmAll === "reject" ? "Confirm: reject all " + n : "Reject all " + n, "danger grow", function () { all("reject"); }));
    }
    var links = el("div", "links");
    var modes = state.hostContext.availableDisplayModes || [];
    if (modes.indexOf && modes.indexOf("fullscreen") >= 0) {
      var full = state.hostContext.displayMode === "fullscreen";
      links.appendChild(button(full ? "Back to the chat" : "Full screen", "link", function () { setMode(full ? "inline" : "fullscreen"); }));
    }
    if (d.hubUrl) links.appendChild(button("Open in Hub ↗", "link", function () { openLink(d.hubUrl); }));
    ft.appendChild(links);
    if (state.linkShown && d.hubUrl) ft.appendChild(el("div", "url", d.hubUrl));
    app.appendChild(ft);
    measure();
  }

  // ------------------------------------------------------------ actions
  function all(decision) {
    if (state.busy) return;
    if (state.confirmAll !== decision) {
      state.confirmAll = decision;
      clearTimeout(state.confirmTimer);
      state.confirmTimer = setTimeout(function () { state.confirmAll = null; render(); }, 5000);
      return render();
    }
    state.confirmAll = null;
    clearTimeout(state.confirmTimer);
    decide(waitingIds().slice(0, MAX_DECISIONS).map(function (id) { return { id: id, decision: decision }; }));
  }

  function callTool(name, args) {
    return request("tools/call", { name: name, arguments: args }, 180000);
  }

  function afterCall(promise, okText) {
    state.busy = true;
    render();
    return promise.then(function (res) {
      state.busy = false;
      var sc = res && res.structuredContent;
      if (res && res.isError) state.banner = { kind: "error", text: textOf(res) || "The Hub refused." };
      else if (sc && sc.kind === KIND) { state.data = sc; state.banner = sc.message ? { kind: "ok", text: sc.message } : okText ? { kind: "ok", text: okText } : null; }
      else state.banner = { kind: "ok", text: textOf(res).split("\n")[0] || okText || "Done." };
      render();
      return res;
    }, function (err) {
      state.busy = false;
      state.banner = { kind: "error", text: "Claude did not pass this on to the Hub (" + (err && err.message ? err.message : "refused") + "). You can say it in the chat instead, for example “accept change 2”." };
      render();
      return null;
    });
  }

  function decide(decisions) {
    if (state.busy || !state.data || !decisions.length) return;
    state.banner = { kind: "info", text: "Saving " + decisions.length + " " + plural(decisions.length, "decision") + " in the Hub…" };
    afterCall(callTool(DECIDE_TOOL, { versionId: state.data.versionId, decisions: decisions })).then(function (res) {
      if (res && !res.isError) tellModel();
    });
  }

  function refresh() {
    if (state.busy || !state.data) return;
    state.banner = { kind: "info", text: "Reading the list again…" };
    afterCall(callTool(LIST_TOOL, { versionId: state.data.versionId }), "The list is up to date.");
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

  // What Claude should know before its next reply, where the host takes it.
  function tellModel() {
    var d = state.data;
    if (!d || !state.hostCaps || !state.hostCaps.updateModelContext) return;
    var k = d.counts || {};
    var text = "In the AKLA changes panel the lawyer decided changes on \"" + (d.title || "the document") + "\" v" + d.versionNumber + " (versionId " + d.versionId + "): " + (d.message || "") + " Now " + (k.waiting || 0) + " waiting, " + (k.accepted || 0) + " accepted, " + (k.rejected || 0) + " rejected.";
    request("ui/update-model-context", { content: [{ type: "text", text: text }] }, 15000).then(null, function () {});
  }

  // ------------------------------------------------------------ start
  request("ui/initialize", {
    appInfo: { name: "AKLA changes panel", version: "0.1.0" },
    appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
    protocolVersion: PROTOCOL_VERSION
  }, 30000).then(function (result) {
    result = result || {};
    state.hostCaps = result.hostCapabilities || {};
    applyHostContext(result.hostContext || {});
    state.initialized = true;
    notify("ui/notifications/initialized", {});
    render();
    watchSize();
  }, function (err) {
    state.fallbackText = "This panel could not reach Claude (" + (err && err.message ? err.message : "no answer") + "). The reply above has every change in text.";
    render();
  });
})();
</script>
</body>
</html>
`;
