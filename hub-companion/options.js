// Settings, kept in chrome.storage.sync so they follow the person's Chrome
// profile. content.js, theme.js and panel.js read the same keys.
(function () {
  "use strict";
  var origin = document.getElementById("origin");
  var follow = document.getElementById("follow");
  var status = document.getElementById("status");
  var themes = document.getElementById("themes");
  var tokensNote = document.getElementById("tokens");

  // One radio per theme, with a three-colour swatch (page, text, accent)
  // drawn from the theme's own values so the chip is never out of step with
  // what the chat will get. The default has no swatch of its own.
  function renderThemes(selected) {
    themes.textContent = "";
    var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    HubThemes.THEMES.forEach(function (theme) {
      var label = document.createElement("label");
      label.className = "theme";
      var input = document.createElement("input");
      input.type = "radio";
      input.name = "theme";
      input.value = theme.id;
      input.checked = theme.id === selected;
      label.appendChild(input);
      var swatch = document.createElement("span");
      swatch.className = "swatch";
      var colours = HubThemes.swatches(theme.id, dark) || { bg: "#f9f9f7", text: "#141413", accent: "#2a78d6" };
      [colours.bg, colours.text, colours.accent].forEach(function (c) {
        var s = document.createElement("span");
        s.style.background = c;
        swatch.appendChild(s);
      });
      label.appendChild(swatch);
      var text = document.createElement("span");
      var b = document.createElement("b");
      b.textContent = theme.name;
      var small = document.createElement("small");
      small.textContent = theme.description;
      text.appendChild(b);
      text.appendChild(small);
      label.appendChild(text);
      // A theme change applies at once on every claude.ai tab; no Save needed.
      input.addEventListener("change", function () {
        if (input.checked) chrome.storage.sync.set({ theme: theme.id });
      });
      themes.appendChild(label);
    });
  }

  chrome.storage.sync.get({ hubOrigin: "", followNewLinks: true, theme: HubThemes.DEFAULT_THEME }, function (items) {
    origin.value = items.hubOrigin || "";
    follow.checked = items.followNewLinks !== false;
    renderThemes(HubThemes.isTheme(items.theme) ? items.theme : HubThemes.DEFAULT_THEME);
  });

  if (chrome.storage.session) {
    chrome.storage.session.get({ themeTokensMissing: [] }, function (items) {
      void chrome.runtime.lastError;
      var missing = items && items.themeTokensMissing;
      if (missing && missing.length) tokensNote.classList.add("show");
    });
  }

  document.getElementById("form").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var typed = origin.value.trim();
    var clean = "";
    if (typed) {
      // Only https (the Hub sign-in goes through this address). A mistyped
      // http:// is refused rather than silently saved.
      clean = HubLinks.parseOrigin(typed);
      if (!clean) {
        status.textContent = "The Hub address must start with https://";
        return;
      }
    }
    chrome.storage.sync.set({ hubOrigin: clean, followNewLinks: follow.checked }, function () {
      origin.value = clean;
      status.textContent = "Saved.";
      setTimeout(function () {
        status.textContent = "";
      }, 2000);
    });
  });
})();
