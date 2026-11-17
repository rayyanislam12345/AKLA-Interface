import test from "node:test";
import assert from "node:assert/strict";
import { parseCitation, courtKey, parseCitationRows, pickRow, htmlToText, matchesCitation } from "./plsParse.js";
import { PlsClient, PlsError } from "./pls.js";

test("parseCitation reads the journals the site carries", () => {
  assert.deepEqual(parseCitation("2018 SCMR 365"), { year: 2018, book: "SCMR", page: 365, courtHint: null });
  assert.deepEqual(parseCitation("2014 PLD Supreme Court 47"), { year: 2014, book: "PLD", page: 47, courtHint: "Supreme Court" });
  assert.deepEqual(parseCitation("PLD 2016 Supreme Court 692"), { year: 2016, book: "PLD", page: 692, courtHint: "Supreme Court" });
  assert.deepEqual(parseCitation("2026 PLD 91"), { year: 2026, book: "PLD", page: 91, courtHint: null });
  assert.equal(parseCitation("2019 P Cr. L J 582").book, "PCRLJ");
  assert.equal(parseCitation("2026 PCrLJ 1068").book, "PCRLJ");
  assert.equal(parseCitation("2020 PCrLJN 30").book, "PCRLJN");
  assert.equal(parseCitation("2002 PLC (C.S.) 1019").book, "PLC(CS)");
  assert.equal(parseCitation("2026 PLC(CS) 386").book, "PLC(CS)");
  assert.equal(parseCitation("2020 CLC Note 12").book, "CLCN");
  assert.equal(parseCitation("2021 PLC N 4").book, "PLC N");
});

test("parseCitation returns null for journals the site does not carry", () => {
  for (const c of ["2018 P.S.C. 194", "2108 PLJ SC 208", "2024 SCP 108", "2026 SHC KHI 2105", "PLJ 2023 Cr.C. 543", "2023 PCTLR 56", "PTCL 2023 CL. 305", "2019 SC AJK 38", "", "nonsense"]) {
    assert.equal(parseCitation(c), null, c);
  }
});

test("courtKey treats the different spellings of a court as one", () => {
  assert.equal(courtKey("Supreme Court of Pakistan"), "sc");
  assert.equal(courtKey("SUPREME-COURT"), "sc");
  assert.equal(courtKey("KARACHI-HIGH-COURT-SINDH"), courtKey("Sindh High Court"));
  assert.equal(courtKey("Supreme Court (AJ&K)"), "ajk-sc");
  assert.equal(courtKey("FEDERAL-SHARIAT-COURT"), "fsc");
  assert.equal(courtKey(""), null);
});

const TABLE = (rows) => `<table><tbody>${rows.map(([cit, title, court, id], i) => `
<tr class="caseType" ><td>${i + 1}</td><td> ${cit} </td>
<td>${title} <br/><span style="color:darkred;">Honorable Justice X</span><br/><span>Lawyer Y</span></td>
<td>${court}</td><td><input type="button" casetypeid="${id}" class="btn" value="Read" /></td></tr>`).join("")}</tbody></table>`;

test("parseCitationRows reads the result table", () => {
  const rows = parseCitationRows(TABLE([["2026 SCMR 47", "IMRAN <font color:red>Versus</font> State", "SUPREME-COURT", "2026S706"]]));
  assert.deepEqual(rows, [{ citation: "2026 SCMR 47", title: "IMRAN Versus State", court: "SUPREME-COURT", caseName: "2026S706" }]);
  assert.deepEqual(parseCitationRows("<div>No record found</div>"), []);
});

test("pickRow uses the court, then the parties, and refuses to guess", () => {
  const rows = parseCitationRows(TABLE([
    ["2020 PLD 191", "MUHAMMAD SUBTAIN KHAN Versus NATIONAL ACCOUNTABILITY BUREAU", "LAHORE-HIGH-COURT", "2020L18"],
    ["2020 PLD 191", "ZAFAR IQBAL Versus KHALID MEHMOOD", "SUPREME-COURT", "2020S40"],
    ["2020 PLD 191", "ABDUL REHMAN Versus STATE", "KARACHI-HIGH-COURT-SINDH", "2020K9"],
  ]));
  assert.equal(pickRow(rows, { courtHint: "Lahore" }).caseName, "2020L18");
  assert.equal(pickRow(rows, { court: "Supreme Court of Pakistan" }).caseName, "2020S40");
  assert.equal(pickRow(rows, { title: "Muhammad Subtain Khan vs National Accountability Bureau" }).caseName, "2020L18");
  assert.equal(pickRow(rows, {}), null);
  assert.equal(pickRow(rows, { title: "Someone Else vs Nobody" }), null);
  assert.equal(pickRow([rows[0]], {}).caseName, "2020L18");
  assert.equal(pickRow([], {}), null);
});

test("htmlToText strips Word markup and keeps paragraphs", () => {
  const html = `<html><head><style>p{}</style></head><body><!-- c --><p class=MsoNormal><b>2012 S C M R 773</b></p><p>A&nbsp;&amp; B&#39;s <i>case</i></p><script>x()</script></body></html>`;
  assert.equal(htmlToText(html), "2012 S C M R 773\nA & B's case");
});

test("matchesCitation accepts the right judgment and rejects another", () => {
  const text = "P L D 2026 Supreme Court 91\nPresent: A and B, JJ\nDr. SEEMA HANIF KHAN---Petitioner\nVersus\nWAQAS KHAN and others---Respondents";
  assert.equal(matchesCitation(text, { year: 2026, page: 91 }, "Dr. Seema Hanif Khan vs Waqas Khan"), true);
  assert.equal(matchesCitation(text, { year: 2026, page: 9 }, "Dr. Seema Hanif Khan vs Waqas Khan"), false);
  assert.equal(matchesCitation(text, { year: 2025, page: 91 }, null), false);
  assert.equal(matchesCitation(text, { year: 2026, page: 91 }, "Habibullah Energy vs WAPDA"), false);
  assert.equal(matchesCitation(text, { year: 2026, page: 91 }, null), true);
});

// A stand-in session: no network, records what the client asks of it.
function fakeSession({ failSignIn = null, replies = {} } = {}) {
  return {
    configured: true, signedIn: false, cookies: new Map(), calls: [], signIns: 0, signOuts: 0,
    async signIn() { this.signIns++; if (failSignIn) throw new PlsError("no", failSignIn); this.signedIn = true; },
    async signOut() { this.signOuts++; this.signedIn = false; return true; },
    async request(path, options) { this.calls.push([path, options?.form ?? null]); const r = replies[path]; return { status: 200, url: path, text: typeof r === "function" ? r(options, this) : r }; },
  };
}

test("PlsClient finds the official text and signs out once idle", async () => {
  const judgment = JSON.stringify("<html><body><p>2026 S C M R 47</p><p>IMRAN---Petitioner Versus The STATE</p><p>Held, bail granted.</p></body></html>");
  const session = fakeSession({ replies: {
    "/Login/CitationSearch": TABLE([["2026 SCMR 47", "IMRAN Versus State", "SUPREME-COURT", "2026S706"]]),
    "/Login/GetCaseFile": judgment,
  } });
  const client = new PlsClient({ session, idleMs: 20, spacingMs: 0 });
  const found = await client.use(() => client.officialText({ citations: ["2026 SCP 12", "2026 SCMR 47"], title: "Imran vs State", court: "Supreme Court of Pakistan" }));
  assert.equal(found.status, "found");
  assert.equal(found.caseName, "2026S706");
  assert.match(found.text, /Held, bail granted/);
  assert.deepEqual(session.calls[0], ["/Login/CitationSearch", { year: "2026", book: "SCMR", code: "47", court: "", judge: "", lawyer: "", party: "" }]);
  assert.equal(session.signIns, 1);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(session.signOuts, 1);
});

test("PlsClient reports why there is no official text", async () => {
  const session = fakeSession({ replies: {
    "/Login/CitationSearch": (o) => o.form.code === "1" ? "<div></div>" : TABLE([["2020 SCMR 5", "A Versus B", "SUPREME-COURT", "X1"]]),
    "/Login/GetCaseFile": JSON.stringify("<p>2019 S C M R 999</p><p>SOMEONE ELSE</p>"),
  } });
  const client = new PlsClient({ session, idleMs: 5, spacingMs: 0 });
  assert.equal((await client.use(() => client.officialText({ citations: ["2024 SCP 108"] }))).status, "not_carried");
  assert.equal((await client.use(() => client.officialText({ citations: ["2020 SCMR 1"] }))).status, "not_found");
  assert.equal((await client.use(() => client.officialText({ citations: ["2020 SCMR 5"] }))).status, "mismatch");
  await client.close();
});

test("PlsClient pauses after a busy account instead of retrying every question", async () => {
  const session = fakeSession({ failSignIn: "IN_USE" });
  const client = new PlsClient({ session, spacingMs: 0 });
  await assert.rejects(client.use(async () => 1), (e) => e.code === "IN_USE");
  await assert.rejects(client.use(async () => 1), (e) => e.code === "IN_USE");
  assert.equal(session.signIns, 1);
});

test("PlsClient signs in again when the site shows its sign-in page", async () => {
  let first = true;
  const session = fakeSession({ replies: {
    "/Login/CitationSearch": () => { if (first) { first = false; return '<form id="mainLoginForm"></form>'; } return TABLE([["2020 SCMR 5", "A Versus B", "SUPREME-COURT", "X1"]]); },
  } });
  const client = new PlsClient({ session, idleMs: 5, spacingMs: 0 });
  const rows = await client.use(() => client.findByCitation({ year: 2020, book: "SCMR", page: 5 }));
  assert.equal(rows.length, 1);
  assert.equal(session.signIns, 2);
  await client.close();
});
