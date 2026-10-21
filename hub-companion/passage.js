// The text a highlighted passage becomes in the claude.ai message box. Pure
// functions, no DOM, no chrome.* calls, so panel.js and tests/passage.test.js
// share them.
//
// The Hub posts { type: "hub:selection", text, title, versionId,
// versionNumber, fileName, projectName, truncated } when the lawyer picks
// "Add to message" on a passage; the message reads:
//
//   In "<title>" v<n> (<file name>), project <name> — versionId: <id>
//   > first line of the passage
//   > second line
//   <blank line, where the cursor waits for the lawyer's instruction>
//
// Loaded as a plain script by panel.html it defines a global `HubPassage`;
// under node it is importable (globalThis.HubPassage) or requirable.
(function (root) {
  "use strict";

  var LIMIT = 4000; // characters of passage, as the Hub caps it

  function str(v) {
    return typeof v === "string" ? v : v == null ? "" : String(v);
  }

  /**
   * The passage as shown: line endings made plain, spaces at line ends
   * dropped, runs of blank lines collapsed to one, trimmed, and cut at
   * 4,000 characters with "…". Returns { text, truncated }.
   */
  function tidyPassage(raw) {
    var s = str(raw)
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (s.length <= LIMIT) return { text: s, truncated: false };
    return { text: s.slice(0, LIMIT).replace(/\s+$/, "") + "…", truncated: true };
  }

  /**
   * The message for the chat's box, or null when there is no passage or no
   * version to name. `d` is the Hub's hub:selection message.
   */
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

  var api = { LIMIT: LIMIT, tidyPassage: tidyPassage, selectionMessage: selectionMessage };

  if (typeof module === "object" && module && module.exports) module.exports = api;
  root.HubPassage = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
