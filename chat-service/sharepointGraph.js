// The firm's SharePoint, for the Hub's "Search SharePoint" tab: one search of
// the Data Room by word (SharePoint's own index, which reads inside Word and
// PDF files) and one download of a file found that way. Nothing here writes,
// moves or deletes.
//
// The app is the one the WhatsApp Filer and the intake service already use
// (Entra app "AKLA WhatsApp Filer", app-only). Reading a file works under its
// Sites.Selected grant on akla-internal; SEARCHING does not: Microsoft's
// search needs the application permission Sites.Read.All, granted once by a
// Microsoft administrator. Until then search() fails with code "not_approved".
import { readFileSync } from "node:fs";

const GRAPH = "https://graph.microsoft.com/v1.0";
const DEFAULT_SITE = "aklacopk.sharepoint.com:/sites/akla-internal";
const DEFAULT_ROOM = "AKLA - Data Room";
const TIMEOUT_MS = 30_000;
// A search with app permissions must name the tenant's region, and a tenant
// in one region does not say which. SHAREPOINT_REGION pins it; otherwise the
// site's own data location is tried, then whatever region the refusal names,
// then these in turn. The one that works is remembered for the process.
// The firm's tenant answers in EUR (first live run, 23 Nov 2026), so it leads.
export const REGION_GUESSES = ["EUR", "APC", "NAM", "ARE", "IND", "GBR", "AUS", "JPN", "CAN", "ZAF"];
export const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;

const ENV_KEYS = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "SHAREPOINT_SITE", "DATA_ROOM_PATH", "SHAREPOINT_REGION"];

/** A failure the lawyer can be told about in the message's own words. */
export class SharePointError extends Error {
  constructor(message, { status = 502, code = "sharepoint" } = {}) {
    super(message);
    this.name = "SharePointError";
    this.status = status;
    this.code = code;
  }
}

/**
 * The SharePoint app's settings, or null when they are not on this machine.
 * They live with the WhatsApp Filer (/opt/whatsapp-filer/.env) rather than in
 * this service's own file, so they are read from there when the environment
 * does not carry them; only the keys named above are taken from that file.
 */
export function sharePointEnv(env = process.env, readFile = readFileSync) {
  const out = {};
  for (const key of ENV_KEYS) if (env[key]) out[key] = env[key];
  const complete = () => !!(out.AZURE_TENANT_ID && out.AZURE_CLIENT_ID && out.AZURE_CLIENT_SECRET);
  if (!complete()) {
    try {
      const text = readFile(env.SHAREPOINT_ENV_FILE || "/opt/whatsapp-filer/.env", "utf8");
      for (const line of String(text).split(/\r?\n/)) {
        const m = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (!m || !ENV_KEYS.includes(m[1]) || out[m[1]]) continue;
        const value = m[2].replace(/^(['"])(.*)\1$/, "$2");
        if (value) out[m[1]] = value;
      }
    } catch { /* no such file here: not configured */ }
  }
  return complete() ? out : null;
}

/**
 * A SharePoint address as people read it: each part of the path decoded, no
 * trailing slash. Search results give addresses plain and file lookups give
 * them encoded; this is the one form the two are compared in.
 */
export function plainUrl(url) {
  const text = String(url ?? "").replace(/\/+$/, "");
  const m = /^(https?:\/\/[^/]+)(.*)$/i.exec(text);
  if (!m) return text;
  const part = (segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment; // a name with a bare % in it
    }
  };
  return m[1] + m[2].split("/").map(part).join("/");
}

const encodePlain = (plain) => encodeURI(plain).replace(/#/g, "%23").replace(/\?/g, "%3F");

/** An address as a link a browser opens: left alone when already encoded, encoded when plain. */
export function linkUrl(url) {
  const text = String(url ?? "");
  return /%[0-9a-f]{2}/i.test(text) ? text.replace(/ /g, "%20") : encodePlain(text);
}

/**
 * The link a lawyer clicks. A Word, Excel or PowerPoint file's plain address
 * downloads it; "?web=1" opens it in the browser instead. A PDF's plain
 * address already opens in the browser.
 */
export function openUrl(url) {
  const link = linkUrl(url);
  return /\.(docx?|xlsx?|pptx?)$/i.test(link) ? `${link}?web=1` : link;
}

/** SharePoint marks the matched words and the gaps in a snippet; this is the snippet as plain text. */
export function cleanSummary(summary) {
  return String(summary ?? "")
    .replace(/<ddd\s*\/>/gi, " … ")
    .replace(/<\/?c\d+>/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

const FILE_TYPES = {
  word: "(filetype:docx OR filetype:doc)",
  pdf: "filetype:pdf",
  excel: "(filetype:xlsx OR filetype:xls)",
  powerpoint: "(filetype:pptx OR filetype:ppt)",
};

/**
 * The search as SharePoint takes it: the words (quoted phrases, OR and
 * filename: kept as written), held to files inside the Data Room, or one
 * folder of it. Returns null when there is nothing to search for.
 */
export function buildQuery({ words, fileType = null, folder = null, roomUrl }) {
  let q = String(words ?? "")
    .replace(/[()]/g, " ")
    // Where to look is decided here, never by the words.
    .replace(/\b(?:path|site|siteid|webid|contentclass|isdocument)\s*:/gi, " ")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
  // An unclosed quote is a syntax error to SharePoint: drop the last one.
  if ((q.match(/"/g) ?? []).length % 2) q = q.replace(/"([^"]*)$/, "$1").trim();
  if (!q.replace(/["\s]/g, "")) return null;
  const sub = String(folder ?? "").replace(/["\\]/g, "").split("/").map((s) => s.trim()).filter((s) => s && s !== "." && s !== "..").join("/");
  const parts = [`(${q})`, `path:"${roomUrl}${sub ? `/${sub}` : ""}"`, "IsDocument:true"];
  if (fileType && FILE_TYPES[fileType]) parts.push(FILE_TYPES[fileType]);
  return parts.join(" ");
}

/**
 * One search hit as a file of the Data Room, or null when the hit is a
 * folder or sits outside the Data Room (the query already holds the search
 * there; this is the check that does not depend on the query).
 */
export function hitToFile(hit, room) {
  const r = hit?.resource ?? {};
  const url = plainUrl(r.webUrl);
  if (!url || r.folder) return null;
  if (!url.toLowerCase().startsWith(`${room.url.toLowerCase()}/`)) return null;
  const rel = url.slice(room.url.length + 1);
  const slash = rel.lastIndexOf("/");
  const id = r.id ?? hit.hitId ?? null;
  if (!id) return null;
  return {
    id,
    driveId: r.parentReference?.driveId ?? room.driveId,
    name: r.name || rel.slice(slash + 1),
    webUrl: openUrl(r.webUrl),
    folder: slash < 0 ? "" : rel.slice(0, slash),
    folderUrl: encodePlain(slash < 0 ? room.url : `${room.url}/${rel.slice(0, slash)}`),
    modified: r.lastModifiedDateTime ?? r.fileSystemInfo?.lastModifiedDateTime ?? null,
    size: typeof r.size === "number" ? r.size : null,
    snippet: cleanSummary(hit.summary),
  };
}

/** The region a refused search says is the valid one, if it names one. */
export function regionFromError(message) {
  const text = String(message ?? "");
  const at = text.search(/valid regions?/i);
  if (at < 0) return null;
  return /\b[A-Z]{3}\b/.exec(text.slice(at))?.[0] ?? null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The connection. `env` is sharePointEnv()'s answer; `fetchImpl` is replaced
 * in tests.
 */
export function createSharePoint({ env, fetchImpl = fetch, log = () => {}, wait = sleep }) {
  let token = null;
  let tokenExpires = 0;
  let room = null;
  let region = env.SHAREPOINT_REGION || null;

  const withTimeout = (signal) => (signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS));

  async function accessToken(signal) {
    if (token && Date.now() < tokenExpires - 300_000) return token;
    const resp = await fetchImpl(`https://login.microsoftonline.com/${env.AZURE_TENANT_ID}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: env.AZURE_CLIENT_ID, client_secret: env.AZURE_CLIENT_SECRET, scope: "https://graph.microsoft.com/.default", grant_type: "client_credentials" }).toString(),
      signal: withTimeout(signal),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok || !body.access_token) {
      log(`sharepoint: sign-in refused (${resp.status}): ${String(body.error_description ?? body.error ?? "").slice(0, 200)}`);
      throw new SharePointError("The Hub could not sign in to SharePoint. Ask an administrator to check the SharePoint app's key.", { status: 502, code: "sign_in" });
    }
    token = body.access_token;
    tokenExpires = Date.now() + Number(body.expires_in ?? 3600) * 1000;
    return token;
  }

  /** One Graph call. Throws SharePointError carrying Graph's status and message. */
  async function call(method, path, { body, signal, raw = false } = {}) {
    const url = path.startsWith("http") ? path : GRAPH + path;
    for (let attempt = 0; ; attempt++) {
      const resp = await fetchImpl(url, {
        method,
        headers: { Authorization: `Bearer ${await accessToken(signal)}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: withTimeout(signal),
      });
      if (resp.ok) return raw ? new Uint8Array(await resp.arrayBuffer()) : resp.json().catch(() => ({}));
      if ([429, 503, 504].includes(resp.status) && attempt < 3) {
        await wait(Math.min(Number(resp.headers.get("Retry-After")) || 2 ** attempt, 8) * 1000);
        continue;
      }
      const detail = await resp.json().catch(() => ({}));
      throw new SharePointError(String(detail?.error?.message ?? `SharePoint answered ${resp.status}`), { status: resp.status, code: "graph" });
    }
  }

  /** The Data Room: its drive, its address, and the region the site reports (if any). */
  async function dataRoom(signal) {
    if (room) return room;
    const site = await call("GET", `/sites/${env.SHAREPOINT_SITE || DEFAULT_SITE}`, { signal });
    const folder = (env.DATA_ROOM_PATH || DEFAULT_ROOM).split("/").map(encodeURIComponent).join("/");
    const drives = await call("GET", `/sites/${site.id}/drives`, { signal });
    for (const drive of drives.value ?? []) {
      try {
        const item = await call("GET", `/drives/${drive.id}/root:/${folder}`, { signal });
        room = { driveId: drive.id, url: plainUrl(item.webUrl), regionHint: site.siteCollection?.dataLocationCode || null };
        return room;
      } catch (err) {
        if (err?.status !== 404) throw err;
      }
    }
    throw new SharePointError("The Data Room folder was not found on SharePoint.", { status: 502, code: "no_room" });
  }

  async function searchRequest(request, signal) {
    const { regionHint } = await dataRoom(signal);
    const queue = region ? [region] : [...new Set([regionHint, ...REGION_GUESSES].filter(Boolean))];
    const tried = new Set();
    let last = null;
    while (queue.length) {
      const candidate = queue.shift();
      if (tried.has(candidate)) continue;
      tried.add(candidate);
      try {
        const answer = await call("POST", "/search/query", { body: { requests: [{ ...request, region: candidate }] }, signal });
        if (region !== candidate) {
          region = candidate;
          log(`sharepoint: search region is ${candidate} (set SHAREPOINT_REGION=${candidate} to skip the lookup)`);
        }
        return answer;
      } catch (err) {
        if (err?.status === 401 || err?.status === 403) {
          throw new SharePointError("SharePoint search is not switched on yet: the firm's Microsoft administrator has to approve it once (the Sites.Read.All permission for the Hub's SharePoint app).", { status: 503, code: "not_approved" });
        }
        if (!(err?.status === 400 && /region/i.test(err.message))) throw err;
        last = err;
        const named = regionFromError(err.message);
        if (named && !tried.has(named)) queue.unshift(named);
      }
    }
    log(`sharepoint: no region was accepted: ${last?.message ?? ""}`);
    throw new SharePointError("SharePoint search could not find the firm's region. Ask an administrator to set SHAREPOINT_REGION for the chat service.", { status: 502, code: "region" });
  }

  /**
   * Files in the Data Room matching the words.
   * @returns {Promise<{ total: number, files: object[], query: string }>}
   */
  async function search({ words, fileType = null, folder = null, size = 12, signal }) {
    const theRoom = await dataRoom(signal);
    const queryString = buildQuery({ words, fileType, folder, roomUrl: theRoom.url });
    if (!queryString) return { total: 0, files: [], query: "" };
    const answer = await searchRequest({ entityTypes: ["driveItem"], query: { queryString }, from: 0, size: Math.max(1, Math.min(size, 25)) }, signal);
    const container = (answer.value?.[0] ?? answer).hitsContainers?.[0] ?? {};
    const files = [];
    const seen = new Set();
    for (const hit of container.hits ?? []) {
      const file = hitToFile(hit, theRoom);
      if (!file || seen.has(`${file.driveId}:${file.id}`)) continue;
      seen.add(`${file.driveId}:${file.id}`);
      files.push(file);
    }
    return { total: Number(container.total ?? files.length), files, query: queryString };
  }

  /** A file's bytes. Files over MAX_DOWNLOAD_BYTES are refused rather than pulled into memory. */
  async function download(file, signal) {
    if (file.size && file.size > MAX_DOWNLOAD_BYTES) throw new SharePointError("The file is too large to open here.", { status: 413, code: "too_large" });
    return call("GET", `/drives/${file.driveId}/items/${file.id}/content`, { signal, raw: true });
  }

  return { search, download, dataRoom };
}
