import { extractTextFromFile } from "./extractText.ts";

// Ported from scripts/law_library/scrape.py's search_act() — same site,
// same regex-based scraping technique (the site has no real API), just in
// Deno instead of a local Python CLI so it can run from the app itself.
const BASE_URL = "https://pakistancode.gov.pk/english";
const SEARCH_URL = `${BASE_URL}/sHyuRsF`;
const HEADERS = { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AKLA-law-library-bot" };

// Matches extractText.ts's own OCR-fallback threshold — below this, treat
// the PDF as having no usable text layer.
const MIN_TEXT_LENGTH = 20;

interface StatuteSearchMatch {
  title: string;
  pageUrl: string;
  pdfUrl: string;
}

async function searchAct(name: string): Promise<StatuteSearchMatch | null> {
  // A comma in the query (as in a formal cite like "Contract Act, 1872")
  // makes the site's search return zero results — it wants bare words only.
  const query = name.replace(/[^\w\s]/g, " ");
  const searchUrl = `${SEARCH_URL}?${new URLSearchParams({ query, search: "1" })}`;

  let html: string;
  try {
    const resp = await fetch(searchUrl, { headers: HEADERS });
    if (!resp.ok) return null;
    html = await resp.text();
  } catch {
    return null;
  }

  const linkRegex = /href="(https?:\/\/pakistancode\.gov\.pk\/english\/[^"]*-con-\d+-sg-[^"]*)"/g;
  const links = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = linkRegex.exec(html)) !== null) links.add(m[1]);
  const resultLinks = Array.from(links).sort().slice(0, 10);

  // Loose match: the searched name's significant words should all appear in
  // the result title — good enough to reject an obviously unrelated Act
  // without needing exact-string equality (titles carry inconsistent
  // spacing/punctuation across the site).
  const nameWords = (name.match(/[A-Za-z]+/g) ?? []).filter((w) => w.length > 2).map((w) => w.toLowerCase());

  for (const link of resultLinks) {
    let pageHtml: string;
    try {
      const pageResp = await fetch(link, { headers: HEADERS });
      if (!pageResp.ok) continue;
      pageHtml = await pageResp.text();
    } catch {
      continue;
    }

    const titleMatch = pageHtml.match(/<h2>([^<]+)/);
    const title = titleMatch ? titleMatch[1].trim() : null;
    const pdfMatch = pageHtml.match(/href="(https:\/\/pakistancode\.gov\.pk\/pdffiles\/[^"]+\.pdf)"/);
    if (!pdfMatch) continue;

    const titleLower = (title ?? "").toLowerCase();
    if (title && nameWords.every((w) => titleLower.includes(w))) {
      return { title, pageUrl: link, pdfUrl: pdfMatch[1] };
    }
  }

  return null;
}

export type ResolveStatuteResult =
  | { found: true; title: string; pageUrl: string; pdfUrl: string; text: string }
  | { found: false };

// Searches pakistancode.gov.pk for actName and, if found, downloads and
// extracts its PDF text. Does NOT chunk/embed/insert — callers invoke the
// existing ingest-documents function for that (same pattern
// process-document already uses), so this stays a pure "find + extract"
// step reusable by both the manual-add and auto-detection paths.
export async function resolveStatute(actName: string): Promise<ResolveStatuteResult> {
  const match = await searchAct(actName);
  if (!match) return { found: false };

  let text: string;
  try {
    const pdfResp = await fetch(match.pdfUrl, { headers: HEADERS });
    if (!pdfResp.ok) return { found: false };
    const blob = await pdfResp.blob();
    const extracted = await extractTextFromFile(blob, "statute.pdf");
    text = extracted.text;
  } catch (err) {
    console.error(`Failed to download/extract statute PDF for "${actName}":`, err);
    return { found: false };
  }

  if (!text || text.trim().length < MIN_TEXT_LENGTH) return { found: false };

  return { found: true, title: match.title, pageUrl: match.pageUrl, pdfUrl: match.pdfUrl, text };
}
