// Finding Hub links and tidying their addresses. Pure functions, no DOM, no
// chrome.* calls, so content.js and panel.js can share them and
// tests/links.test.js can run them under node.
//
// Loaded as a plain script before content.js (see manifest.json
// content_scripts.js) it defines a global `HubLinks`; under node it is
// importable (globalThis.HubLinks) or requirable.
(function (root) {
  "use strict";

  var DEFAULT_ORIGIN = "https://akla-interface.vercel.app";

  // Characters a sentence leaves after a bare address: "…/ai/d/abc." or
  // "(…/ai/p/xyz)". Hub addresses never end with these.
  var TRAILING = /[.,;:!?'"\)\]\}>*_]+$/;
  var FRAME_PARAMS = ["embed", "host", "aiTheme"];

  function isLocalHost(hostname) {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  }

  /**
   * Whether `input` names an origin the panel may show: https, or http only
   * on this machine (a development build of the Hub). Returns the origin
   * ("https://host", no path, no trailing slash) or null. A plain host gets
   * "https://" in front.
   */
  function parseOrigin(input) {
    var s = String(input == null ? "" : input).trim();
    if (!s) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = "https://" + s;
    try {
      var u = new URL(s);
      if (u.protocol === "https:") return u.origin;
      if (u.protocol === "http:" && isLocalHost(u.hostname)) return u.origin;
      return null;
    } catch (e) {
      return null;
    }
  }

  /**
   * The Hub's origin from whatever a person typed in the options page:
   * "akla-interface.vercel.app", "https://hub.example/", "" (the default).
   * Always "https://host" with no path and no trailing slash. Anything
   * unparseable, or not https (except http on localhost for development),
   * falls back to the default rather than breaking link finding: the Hub
   * sign-in must never go over plain http.
   */
  function normaliseOrigin(input) {
    return parseOrigin(input) || DEFAULT_ORIGIN;
  }

  function sameOrigin(u, origin) {
    return u.origin.toLowerCase() === origin.toLowerCase();
  }

  /**
   * One Hub address, cleaned: trailing punctuation dropped, the host lowered,
   * the `embed` flag removed, a trailing slash trimmed. Returns null when
   * `href` is not an address on the Hub origin.
   */
  function normaliseHubUrl(href, origin) {
    origin = normaliseOrigin(origin);
    var raw = String(href == null ? "" : href).trim().replace(TRAILING, "");
    if (!raw) return null;
    var u;
    try {
      u = new URL(raw);
    } catch (e) {
      return null;
    }
    if (!sameOrigin(u, origin)) return null;
    // The frame's own parameters are never part of a page's address.
    FRAME_PARAMS.forEach(function (k) { u.searchParams.delete(k); });
    var path = u.pathname.replace(/\/+$/, "") || "/";
    var search = u.searchParams.toString();
    return origin + path + (search ? "?" + search : "") + u.hash;
  }

  /** True when `href` is an address on the Hub origin. */
  function isHubUrl(href, origin) {
    return normaliseHubUrl(href, origin) !== null;
  }

  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Bare Hub addresses in a run of text, in order. Each entry is
   * { index, length, url }: where the address sits in `text` (after trailing
   * punctuation is dropped) and its cleaned form.
   */
  function findHubUrls(text, origin) {
    origin = normaliseOrigin(origin);
    var s = String(text == null ? "" : text);
    var out = [];
    if (!s) return out;
    // The origin must end there: "akla-interface.vercel.app.example.com" and
    // "akla-interface.vercel.app-old" are other hosts, not the Hub plus a
    // path. A full stop after it is fine when it ends the sentence.
    var re = new RegExp(escapeRegExp(origin) + "(?![A-Za-z0-9-]|\\.[A-Za-z0-9])" + "(?:[/?#][^\\s<>\"'`]*)?", "gi");
    var m;
    while ((m = re.exec(s)) !== null) {
      var raw = m[0];
      var clean = raw.replace(TRAILING, "");
      var url = normaliseHubUrl(clean, origin);
      // `terminated`: something follows the address in this text, so it is
      // not still being typed out (a streaming reply pauses mid-address).
      if (url) out.push({ index: m.index, length: clean.length, url: url, terminated: m.index + clean.length < s.length });
      if (!raw) re.lastIndex++;
    }
    return out;
  }

  /**
   * The address as the companion's frame opens it: `embed=1` (no sidebar),
   * `host=companion` (the companion draws the bar, so the Hub drops its own
   * header) and, when given, `aiTheme` (the Hub's colours to match the chat).
   */
  function embedUrl(url, aiTheme) {
    var u = new URL(url);
    u.searchParams.set("embed", "1");
    u.searchParams.set("host", "companion");
    if (aiTheme) u.searchParams.set("aiTheme", aiTheme);
    else u.searchParams.delete("aiTheme");
    return u.toString();
  }

  /** The address without the frame's parameters, for opening in a tab. */
  function plainUrl(url) {
    var u = new URL(url);
    FRAME_PARAMS.forEach(function (k) { u.searchParams.delete(k); });
    return u.toString();
  }

  /** What a Hub address points at: document, project, chat or page. */
  function linkKind(url) {
    var path;
    try {
      path = new URL(url).pathname;
    } catch (e) {
      return "page";
    }
    if (/^\/ai\/d\/[^/]+/.test(path)) return "document";
    if (/^\/ai\/p\/[^/]+/.test(path)) return "project";
    if (/^\/ai\/c\/[^/]+/.test(path)) return "chat";
    return "page";
  }

  /** The Hub's home page for the panel: the AI workspace. */
  function homeUrl(origin) {
    return normaliseOrigin(origin) + "/ai";
  }

  var api = {
    DEFAULT_ORIGIN: DEFAULT_ORIGIN,
    parseOrigin: parseOrigin,
    normaliseOrigin: normaliseOrigin,
    normaliseHubUrl: normaliseHubUrl,
    isHubUrl: isHubUrl,
    findHubUrls: findHubUrls,
    embedUrl: embedUrl,
    plainUrl: plainUrl,
    linkKind: linkKind,
    homeUrl: homeUrl,
  };

  if (typeof module === "object" && module && module.exports) module.exports = api;
  root.HubLinks = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
