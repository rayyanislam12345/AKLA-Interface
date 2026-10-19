// node --test hub-companion/tests/links.test.js
import { test } from "node:test";
import assert from "node:assert/strict";

await import("../links.js");
const L = globalThis.HubLinks;
const HUB = "https://akla-interface.vercel.app";

test("normaliseOrigin: default, bare host, trailing slash, junk", () => {
  assert.equal(L.normaliseOrigin(""), HUB);
  assert.equal(L.normaliseOrigin(undefined), HUB);
  assert.equal(L.normaliseOrigin("akla-interface.vercel.app"), HUB);
  assert.equal(L.normaliseOrigin("https://hub.example/"), "https://hub.example");
  assert.equal(L.normaliseOrigin("https://hub.example/some/path?x=1"), "https://hub.example");
  assert.equal(L.normaliseOrigin("  HTTPS://Hub.Example  "), "https://hub.example");
  assert.equal(L.normaliseOrigin("not a url at all"), HUB);
  assert.equal(L.normaliseOrigin("ftp://hub.example"), HUB);
});

test("normaliseOrigin and parseOrigin: only https, except http on this machine", () => {
  assert.equal(L.normaliseOrigin("http://akla-interface.vercel.app"), HUB, "a plain-http Hub address is refused");
  assert.equal(L.normaliseOrigin("http://hub.example"), HUB);
  assert.equal(L.parseOrigin("http://hub.example"), null);
  assert.equal(L.parseOrigin("ftp://hub.example"), null);
  assert.equal(L.parseOrigin(""), null);
  assert.equal(L.parseOrigin("hub.example"), "https://hub.example");
  assert.equal(L.parseOrigin("http://localhost:5173/ai"), "http://localhost:5173");
  assert.equal(L.parseOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(L.normaliseOrigin("http://localhost:5173"), "http://localhost:5173");
});

test("normaliseHubUrl: accepts Hub addresses, rejects others", () => {
  assert.equal(L.normaliseHubUrl(`${HUB}/ai/d/v123`), `${HUB}/ai/d/v123`);
  assert.equal(L.normaliseHubUrl(`${HUB}/ai/d/v123.`), `${HUB}/ai/d/v123`);
  assert.equal(L.normaliseHubUrl(`${HUB}/ai/d/v123).`), `${HUB}/ai/d/v123`);
  assert.equal(L.normaliseHubUrl(`${HUB}/ai/p/m1/`), `${HUB}/ai/p/m1`);
  assert.equal(L.normaliseHubUrl(`${HUB}/`), `${HUB}/`);
  assert.equal(L.normaliseHubUrl(`${HUB}/ai/d/v1?embed=1&tab=changes`), `${HUB}/ai/d/v1?tab=changes`);
  assert.equal(L.normaliseHubUrl(`${HUB}/ai/d/v1#clause-14`), `${HUB}/ai/d/v1#clause-14`);
  assert.equal(L.normaliseHubUrl("HTTPS://AKLA-INTERFACE.VERCEL.APP/ai/c/t9"), `${HUB}/ai/c/t9`);
  assert.equal(L.normaliseHubUrl("https://claude.ai/chat/abc"), null);
  assert.equal(L.normaliseHubUrl("https://akla-interface.vercel.app.evil.com/ai/d/v1"), null);
  assert.equal(L.normaliseHubUrl("http://akla-interface.vercel.app/ai/d/v1"), null);
  assert.equal(L.normaliseHubUrl("/ai/d/v1"), null);
  assert.equal(L.normaliseHubUrl(""), null);
  assert.equal(L.normaliseHubUrl(null), null);
});

test("normaliseHubUrl honours a custom origin", () => {
  assert.equal(L.normaliseHubUrl("https://hub.example/ai/d/v1", "hub.example"), "https://hub.example/ai/d/v1");
  assert.equal(L.normaliseHubUrl(`${HUB}/ai/d/v1`, "https://hub.example"), null);
});

test("findHubUrls: bare addresses in text, in order, with positions", () => {
  const text = `Open in Hub: ${HUB}/ai/d/v1. See also ${HUB}/ai/p/m2, and (${HUB}/ai/c/t3).`;
  const found = L.findHubUrls(text);
  assert.deepEqual(
    found.map((f) => f.url),
    [`${HUB}/ai/d/v1`, `${HUB}/ai/p/m2`, `${HUB}/ai/c/t3`]
  );
  for (const f of found) {
    const slice = text.slice(f.index, f.index + f.length);
    assert.equal(slice, f.url, "the index/length covers exactly the cleaned address");
  }
});

test("findHubUrls: nothing on other sites or empty text", () => {
  assert.deepEqual(L.findHubUrls("https://claude.ai/chat/1 and https://example.com/ai/d/v1"), []);
  assert.deepEqual(L.findHubUrls(""), []);
  assert.deepEqual(L.findHubUrls(null), []);
});

test("findHubUrls: a host that merely starts with the Hub's is not the Hub", () => {
  assert.deepEqual(L.findHubUrls("https://akla-interface.vercel.app.example.com/ai/d/x"), []);
  assert.deepEqual(L.findHubUrls("https://akla-interface.vercel.app-old/ai/d/x"), []);
  assert.deepEqual(L.findHubUrls("https://akla-interface.vercel.appx/ai/d/x"), []);
  // A full stop that ends the sentence is still fine.
  assert.deepEqual(L.findHubUrls(`Home: ${HUB}. Then more.`).map((f) => f.url), [`${HUB}/`]);
  assert.deepEqual(L.findHubUrls(`Home: ${HUB}.`).map((f) => f.url), [`${HUB}/`]);
});

test("findHubUrls: whether text follows the address (a streaming reply may still be typing it)", () => {
  const [a] = L.findHubUrls(`Open in Hub: ${HUB}/ai/d/0c1f`);
  assert.equal(a.terminated, false, "nothing after it yet");
  const [b] = L.findHubUrls(`Open in Hub: ${HUB}/ai/d/0c1f.`);
  assert.equal(b.terminated, true, "a full stop follows");
  const [c] = L.findHubUrls(`Open in Hub: ${HUB}/ai/d/0c1f and then`);
  assert.equal(c.terminated, true);
  const two = L.findHubUrls(`${HUB}/ai/d/v1 and ${HUB}/ai/p/m2`);
  assert.deepEqual(two.map((f) => f.terminated), [true, false]);
});

test("findHubUrls: the origin alone and a markdown-ish tail", () => {
  assert.deepEqual(L.findHubUrls(`Home: ${HUB}`).map((f) => f.url), [`${HUB}/`]);
  assert.deepEqual(L.findHubUrls(`**${HUB}/ai/d/v1**`).map((f) => f.url), [`${HUB}/ai/d/v1`]);
});

test("findHubUrls: a custom origin", () => {
  const found = L.findHubUrls("see https://hub.example/ai/d/v1 now", "https://hub.example");
  assert.deepEqual(found.map((f) => f.url), ["https://hub.example/ai/d/v1"]);
});

test("embedUrl and plainUrl", () => {
  assert.equal(L.embedUrl(`${HUB}/ai/d/v1`), `${HUB}/ai/d/v1?embed=1`);
  assert.equal(L.embedUrl(`${HUB}/ai/d/v1?tab=changes#x`), `${HUB}/ai/d/v1?tab=changes&embed=1#x`);
  assert.equal(L.plainUrl(`${HUB}/ai/d/v1?embed=1`), `${HUB}/ai/d/v1`);
  assert.equal(L.plainUrl(`${HUB}/ai/d/v1?tab=changes&embed=1`), `${HUB}/ai/d/v1?tab=changes`);
});

test("linkKind and homeUrl", () => {
  assert.equal(L.linkKind(`${HUB}/ai/d/v1`), "document");
  assert.equal(L.linkKind(`${HUB}/ai/p/m1`), "project");
  assert.equal(L.linkKind(`${HUB}/ai/c/t1`), "chat");
  assert.equal(L.linkKind(`${HUB}/precedent-library`), "page");
  assert.equal(L.linkKind("nonsense"), "page");
  assert.equal(L.homeUrl(""), `${HUB}/ai`);
  assert.equal(L.homeUrl("hub.example"), "https://hub.example/ai");
});
