// Session client for Pakistan Law Site (https://www.pakistanlawsite.com), the
// publisher's own service and the source of the official reported text.
//
// The firm works with the publisher directly and has its permission to read the
// site by program; the publisher offers no API, so this signs in the way a
// person does, with the firm's own account from PLS_USERNAME / PLS_PASSWORD.
//
// One account allows one session at a time. So: sign in only when needed, sign
// out when done, and never force another session off — if a colleague is using
// the account the caller is told (code IN_USE) and decides what to do.

import { parseCitation, parseCitationRows, pickRow, htmlToText, matchesCitation } from "./plsParse.js";

const BASE = process.env.PLS_BASE_URL ?? "https://www.pakistanlawsite.com";
const AGENT = "Mozilla/5.0 (AKLA caselaw-service)";

export class PlsError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PlsError";
    this.code = code; // NOT_CONFIGURED | BAD_CREDENTIALS | IN_USE | INACTIVE | UNEXPECTED
  }
}

export class PlsSession {
  constructor({ username = process.env.PLS_USERNAME, password = process.env.PLS_PASSWORD, fetcher = fetch, timeoutMs = 30_000 } = {}) {
    this.username = username;
    this.password = password;
    this.fetcher = fetcher;
    this.timeoutMs = timeoutMs;
    this.cookies = new Map();
    this.signedIn = false;
    this.landingUrl = null;
    this.signOutUrl = `${BASE}/Login/Logout`;
  }

  get configured() {
    return Boolean(this.username && this.password);
  }

  #absorb(response) {
    for (const line of response.headers.getSetCookie?.() ?? []) {
      const pair = line.split(";")[0];
      const eq = pair.indexOf("=");
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  // One request with the session's cookies. Redirects are followed by hand so
  // cookies set on an intermediate hop are kept.
  async request(pathOrUrl, { method = "GET", form = null, ajax = false } = {}) {
    let url = new URL(pathOrUrl, BASE);
    for (let hop = 0; hop < 6; hop++) {
      const headers = { "User-Agent": AGENT, Referer: `${BASE}/` };
      if (this.cookies.size) headers.Cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
      if (ajax) headers["X-Requested-With"] = "XMLHttpRequest";
      let body;
      if (form) {
        headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
        body = new URLSearchParams(form).toString();
      }
      const response = await this.fetcher(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
      this.#absorb(response);
      const next = response.headers.get("location");
      if (response.status >= 300 && response.status < 400 && next) {
        await response.body?.cancel();
        url = new URL(next, url);
        method = "GET";
        form = null;
        continue;
      }
      return { status: response.status, url: url.toString(), text: await response.text() };
    }
    throw new PlsError("Pakistan Law Site redirected too many times", "UNEXPECTED");
  }

  // Sign in. Resolves with the landing address on success; throws a PlsError
  // whose code says why not.
  async signIn() {
    if (!this.configured) throw new PlsError("PLS_USERNAME / PLS_PASSWORD are not set", "NOT_CONFIGURED");
    const home = await this.request("/");
    const formHtml = home.text.match(/<form action="\/Login\/Login"[\s\S]*?<\/form>/i)?.[0] ?? "";
    const token = formHtml.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/i)?.[1];
    if (!token) throw new PlsError("Could not find the sign-in form on Pakistan Law Site", "UNEXPECTED");

    const reply = await this.request("/Login/Login", {
      method: "POST",
      ajax: true,
      form: { __RequestVerificationToken: token, "Login.UserName": this.username, "Login.Password": this.password },
    });
    const text = reply.text.trim();

    if (text.includes("ErrorForMultiLoginAccess")) throw new PlsError("The account is signed in somewhere else", "IN_USE");
    if (text.includes("ErrorForInactiveUserAccount")) throw new PlsError("The account is inactive", "INACTIVE");
    if (text === "fails" || text === '"fails"') throw new PlsError("Wrong username or password", "BAD_CREDENTIALS");
    if (text.startsWith("{")) {
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* fall through */ }
      if (parsed && parsed.success === false) throw new PlsError(parsed.message || "Wrong username or password", "BAD_CREDENTIALS");
    }
    // Success is a bare address (sometimes JSON-quoted) to go to next.
    const landing = text.replace(/^"|"$/g, "");
    if (!landing || landing.length > 300 || /[<>\s]/.test(landing)) {
      throw new PlsError(`Unexpected sign-in reply (${reply.status}, ${text.length} chars)`, "UNEXPECTED");
    }
    this.signedIn = true;
    this.landingUrl = new URL(landing, BASE).toString();
    return this.landingUrl;
  }

  // Remember the sign-out link the first time a signed-in page shows one.
  noteSignOut(html) {
    const href = html.match(/href="([^"]*(?:log\s?-?out|sign\s?-?out|logoff)[^"]*)"/i)?.[1];
    if (href && !this.signOutUrl) this.signOutUrl = new URL(href, BASE).toString();
    return this.signOutUrl;
  }

  // Free the account's single session. Returns false when no sign-out link was
  // seen, so the caller can say the session was left to time out.
  async signOut() {
    if (!this.signedIn) return true;
    if (!this.signOutUrl) return false;
    await this.request(this.signOutUrl);
    this.signedIn = false;
    this.cookies.clear();
    return true;
  }
}

// The service's one shared door to the site. It signs in when first needed,
// keeps the session while questions are using it, and signs out after a short
// idle spell so the account is free for the firm's lawyers again. Requests go
// one at a time, spaced, so the service reads no faster than a person clicks.
export class PlsClient {
  constructor({ session = new PlsSession(), idleMs = Number(process.env.PLS_IDLE_MS ?? 15_000), spacingMs = 400, busyRetryMs = 60_000 } = {}) {
    this.session = session;
    this.idleMs = idleMs;
    this.spacingMs = spacingMs;
    this.busyRetryMs = busyRetryMs;
    this.users = 0;
    this.idleTimer = null;
    this.signingIn = null;
    this.blocked = null; // { code, until } after a failed sign-in, so a burst of questions does not hammer it
    this.gate = Promise.resolve();
  }

  get configured() {
    return this.session.configured;
  }

  async #signIn() {
    if (this.session.signedIn) return;
    if (this.blocked && Date.now() < this.blocked.until) throw new PlsError("Pakistan Law Site sign-in is paused after a failed attempt", this.blocked.code);
    this.signingIn ??= this.session.signIn()
      .then(() => { this.blocked = null; })
      .catch((err) => {
        // A busy account may free up in a minute; wrong details will not fix themselves.
        const wait = err.code === "IN_USE" ? this.busyRetryMs : 15 * 60_000;
        this.blocked = { code: err.code ?? "UNEXPECTED", until: Date.now() + wait };
        throw err;
      })
      .finally(() => { this.signingIn = null; });
    await this.signingIn;
  }

  // Run `work` with a signed-in session held open.
  async use(work) {
    clearTimeout(this.idleTimer);
    this.users++;
    try {
      await this.#signIn();
      return await work();
    } finally {
      this.users--;
      if (this.users === 0 && this.session.signedIn) {
        this.idleTimer = setTimeout(() => { this.close().catch(() => {}); }, this.idleMs);
        this.idleTimer.unref?.();
      }
    }
  }

  async close() {
    clearTimeout(this.idleTimer);
    if (this.session.signedIn) await this.session.signOut();
  }

  // One spaced request. If the site answers with its sign-in page the session
  // has lapsed (or was taken over): sign in again once and repeat.
  #request(path, options) {
    const run = this.gate.then(async () => {
      let reply = await this.session.request(path, options);
      if (reply.text.includes("mainLoginForm")) {
        this.session.signedIn = false;
        this.session.cookies.clear();
        await this.#signIn();
        reply = await this.session.request(path, options);
      }
      await new Promise((r) => setTimeout(r, this.spacingMs));
      return reply;
    });
    this.gate = run.then(() => {}, () => {});
    return run;
  }

  // Rows the site's citation search returns for a year, journal and page.
  async findByCitation({ year, book, page }) {
    const reply = await this.#request("/Login/CitationSearch", {
      method: "POST", ajax: true,
      form: { year: String(year), book, code: String(page), court: "", judge: "", lawyer: "", party: "" },
    });
    if (reply.status !== 200) throw new PlsError(`Citation search failed (${reply.status})`, "UNEXPECTED");
    return parseCitationRows(reply.text);
  }

  // The full reported text of one judgment, by the site's id for it.
  async judgmentText(caseName) {
    const reply = await this.#request("/Login/GetCaseFile", { method: "POST", ajax: true, form: { caseName, headNotes: "0" } });
    if (reply.status !== 200) throw new PlsError(`Judgment fetch failed (${reply.status})`, "UNEXPECTED");
    let html = reply.text;
    try { const parsed = JSON.parse(html); if (typeof parsed === "string") html = parsed; } catch { /* already HTML */ }
    return htmlToText(html);
  }

  // The official text for a judgment known by its citations, or the reason
  // there is none: "not_carried" (no citation is from a journal the site
  // publishes), "not_found", "ambiguous" (several rows, none clearly it) or
  // "mismatch" (the text fetched is not this case, so it is not used).
  async officialText({ citations = [], court = null, title = null }) {
    const parsed = citations.map((c) => ({ raw: c, ...(parseCitation(c) ?? {}) })).filter((c) => c.book);
    if (parsed.length === 0) return { status: "not_carried" };
    let status = "not_found";
    for (const c of parsed) {
      const rows = await this.findByCitation(c);
      if (rows.length === 0) continue;
      const row = pickRow(rows, { courtHint: c.courtHint, court, title });
      if (!row) { status = "ambiguous"; continue; }
      const text = await this.judgmentText(row.caseName);
      if (!matchesCitation(text, c, title)) { status = "mismatch"; continue; }
      return { status: "found", text, citation: row.citation || c.raw, caseName: row.caseName, court: row.court };
    }
    return { status };
  }
}
