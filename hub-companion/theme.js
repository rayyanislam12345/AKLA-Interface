// Runs on claude.ai at document_start. Applies the chosen colour theme by
// adding one <style> of CSS-variable overrides and a data-hub-theme
// attribute on <html>; removes both when the choice goes back to the
// default. Nothing leaves the page: the only read is this extension's own
// storage, and the only write is to the page's own root element.
(function () {
  "use strict";
  if (typeof HubThemes === "undefined") return;
  var api = typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id ? chrome : null;
  if (!api || !api.storage) return;

  var html = document.documentElement;

  function styleElement() {
    var el = document.getElementById(HubThemes.STYLE_ID);
    if (!el) {
      el = document.createElement("style");
      el.id = HubThemes.STYLE_ID;
      // <head> may not exist yet at document_start; the root always does.
      (document.head || html).appendChild(el);
    }
    return el;
  }

  function apply(id) {
    var theme = HubThemes.isTheme(id) ? id : HubThemes.DEFAULT_THEME;
    var css = HubThemes.cssFor(theme);
    if (!css) {
      html.removeAttribute(HubThemes.ATTR);
      var old = document.getElementById(HubThemes.STYLE_ID);
      if (old) old.remove();
      return;
    }
    var el = styleElement();
    if (el.textContent !== css) el.textContent = css;
    html.setAttribute(HubThemes.ATTR, theme);
  }

  // claude.ai re-renders <head> during hydration; if our <style> is swept
  // away, put it back. Attributes on <html> survive hydration.
  var watcher = new MutationObserver(function () {
    if (!html.hasAttribute(HubThemes.ATTR)) return;
    if (!document.getElementById(HubThemes.STYLE_ID)) apply(html.getAttribute(HubThemes.ATTR));
  });
  watcher.observe(html, { childList: true, subtree: false });
  if (document.head) watcher.observe(document.head, { childList: true });
  else document.addEventListener("DOMContentLoaded", function () {
    if (document.head) watcher.observe(document.head, { childList: true });
  });

  api.storage.sync.get({ theme: HubThemes.DEFAULT_THEME }, function (items) {
    void api.runtime.lastError;
    apply(items && items.theme);
  });
  api.storage.onChanged.addListener(function (changes, area) {
    if (area === "sync" && changes.theme) apply(changes.theme.newValue);
  });

  // A quiet check that claude.ai still uses the tokens the themes set.
  // Read once the page has rendered; the options page shows a note when
  // the tokens have gone, so a theme that silently stopped working is not
  // mistaken for a broken extension.
  function checkTokens() {
    try {
      var cs = getComputedStyle(html);
      var probes = ["--danger-100", "--cds-gray-850", "--cds-surface-0", "--bg-100"];
      var missing = probes.filter(function (p) { return !cs.getPropertyValue(p).trim(); });
      api.storage.session.set({ themeTokensMissing: missing });
    } catch (e) {
      /* the page is still ours to leave alone */
    }
  }
  if (document.readyState === "complete") setTimeout(checkTokens, 1500);
  else window.addEventListener("load", function () { setTimeout(checkTokens, 1500); });
})();
