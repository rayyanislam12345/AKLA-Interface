// node --test hub-companion/tests/passage.test.js
import { test } from "node:test";
import assert from "node:assert/strict";

await import("../passage.js");
const P = globalThis.HubPassage;

const base = {
  type: "hub:selection",
  title: "Share Purchase Agreement",
  versionId: "0c1f-77aa",
  versionNumber: 3,
  fileName: "KPT5.7 - SPA [AKLA].docx",
  projectName: "Karachi Port",
};

test("the heading names the document, version, file, project and id; every line is quoted; a blank line ends it", () => {
  const text = P.selectionMessage({ ...base, text: "14.2 The Seller shall indemnify\nthe Buyer against all Losses." });
  assert.equal(
    text,
    'In "Share Purchase Agreement" v3 (KPT5.7 - SPA [AKLA].docx), project Karachi Port — versionId: 0c1f-77aa\n' +
      "> 14.2 The Seller shall indemnify\n" +
      "> the Buyer against all Losses.\n" +
      "\n"
  );
  assert.ok(text.endsWith("\n\n"), "the cursor waits on a line of its own");
});

test("missing file name or project leaves them out", () => {
  const text = P.selectionMessage({ ...base, fileName: null, projectName: "", text: "Clause 1" });
  assert.equal(text, 'In "Share Purchase Agreement" v3 — versionId: 0c1f-77aa\n> Clause 1\n\n');
});

test("the passage is tidied: line ends, trailing spaces, runs of blank lines, outer space", () => {
  const text = P.selectionMessage({ ...base, text: "  \r\nFirst  \r\n\r\n\r\n\r\nSecond\u00a0line \n\n" });
  assert.equal(text.split("\n").slice(1).join("\n"), "> First\n>\n> Second line\n\n");
});

test("a long passage is cut at 4,000 characters with … and says so", () => {
  const long = "word ".repeat(1200); // 6,000 characters
  const tidy = P.tidyPassage(long);
  assert.equal(tidy.truncated, true);
  assert.ok(tidy.text.endsWith("…"));
  assert.ok(tidy.text.length <= P.LIMIT + 1);
  const text = P.selectionMessage({ ...base, text: long });
  assert.match(text, /\(Only the first 4,000 characters of the passage are quoted\.\)\n\n$/);
  // The Hub caps it first; cutting again changes nothing.
  assert.deepEqual(P.tidyPassage(tidy.text), { text: tidy.text, truncated: false });
  const again = P.selectionMessage({ ...base, text: tidy.text, truncated: true });
  assert.equal(again, text, "the Hub's own flag gives the same note");
});

test("nothing to say: no passage, no version, not a message", () => {
  assert.equal(P.selectionMessage({ ...base, text: "   \n\n " }), null);
  assert.equal(P.selectionMessage({ ...base, text: "x", versionId: "" }), null);
  assert.equal(P.selectionMessage(null), null);
  assert.equal(P.selectionMessage("hub:selection"), null);
});

test("an untitled document and an odd version number still read sensibly", () => {
  assert.equal(P.selectionMessage({ versionId: "v1", text: "x", title: "", versionNumber: "n/a" }), 'In "Untitled document" — versionId: v1\n> x\n\n');
});
