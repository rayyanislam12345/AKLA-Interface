// Settings, kept in chrome.storage.sync so they follow the person's Chrome
// profile. content.js and panel.js read the same two keys.
(function () {
  "use strict";
  var origin = document.getElementById("origin");
  var follow = document.getElementById("follow");
  var status = document.getElementById("status");

  chrome.storage.sync.get({ hubOrigin: "", followNewLinks: true }, function (items) {
    origin.value = items.hubOrigin || "";
    follow.checked = items.followNewLinks !== false;
  });

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
