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

const AI_MODEL = "claude-haiku-4-5-20251001";

// pakistancode.gov.pk's own search is the same fragile regex-scrapable
// endpoint scrape.py hits — it frequently can't surface an Act at all
// (wrong phrasing, an Act indexed under a different/shorter name, a
// provincial rather than federal Act, a site quirk), which is what was
// driving "Needs Upload" far more than it should. This is the fallback:
// a small Claude Haiku call with the hosted web_search tool, asked to find
// a direct PDF of the Act's actual text anywhere on the open web, not just
// on this one site. It only ever LOCATES a URL — the real text still comes
// from downloading and extracting that PDF ourselves via the same
// pipeline as the direct-search path, never from the model's own words,
// so a hallucinated paraphrase of statutory text can never reach the RAG
// store this way.
//
// Deliberately just this one call, nothing more — an earlier version also
// ran a post-hoc AI coherence check on web-search hits, and the combination
// (PDF extraction plus two sequential Claude round-trips) blew Supabase
// Edge Functions' CPU-time budget in production (confirmed via logs: "CPU
// Time exceeded", not a timeout). That coherence check, and a matching
// AI pick among ambiguous direct-search results, still exist — just
// server-side only in scripts/law_library/scrape.py, which runs locally
// with no such limit.
async function webSearchForStatute(actName: string, anthropicKey: string): Promise<StatuteSearchMatch | null> {
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: AI_MODEL,
        max_tokens: 1024,
        tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
        messages: [{
          role: "user",
          content: `Find a direct PDF URL for the full official text of the Pakistani statute "${actName}". Prefer pakistancode.gov.pk; if it isn't there, look for the National Assembly of Pakistan (na.gov.pk), a provincial assembly's website, or another official/government source. It must link directly to a PDF of the Act's actual text — not a summary, a news article, or a page that merely mentions the Act.\n\nRespond with ONLY a JSON object, no other text: {"found": true, "title": "<the Act's exact official title>", "pdfUrl": "<the direct .pdf URL>"} — or {"found": false} if you can't locate an actual PDF of this specific Act's text.`,
        }],
      }),
    });
    if (!resp.ok) {
      console.error("Web-search statute lookup failed:", resp.status, await resp.text());
      return null;
    }
    const data = await resp.json();
    // With a server-side tool in play, earlier text blocks can be the
    // model's own search narration — the final answer is the LAST text
    // block, not the first (unlike every other non-tool call in this app).
    const textBlocks = (data.content ?? []).filter((b: any) => b.type === "text");
    const rawText: string = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1].text : "";
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.found || !parsed.pdfUrl || !parsed.title) return null;
    return { title: parsed.title, pageUrl: parsed.pdfUrl, pdfUrl: parsed.pdfUrl };
  } catch (err) {
    console.error("Web-search statute lookup error:", err);
    return null;
  }
}

export type ResolveStatuteResult =
  | { found: true; title: string; pageUrl: string; pdfUrl: string; text: string; viaWebSearch: boolean }
  | { found: false };

// Searches pakistancode.gov.pk for actName and, if found, downloads and
// extracts its PDF text; falls back to webSearchForStatute when the direct
// site search comes up empty and an Anthropic key is available. Does NOT
// chunk/embed/insert — callers invoke the existing ingest-documents
// function for that (same pattern process-document already uses), so this
// stays a pure "find + extract" step reusable by both the manual-add and
// auto-detection paths.
export async function resolveStatute(actName: string, anthropicKey?: string): Promise<ResolveStatuteResult> {
  let match = await searchAct(actName);
  let viaWebSearch = false;

  if (!match && anthropicKey) {
    match = await webSearchForStatute(actName, anthropicKey);
    viaWebSearch = true;
  }
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

  return { found: true, title: match.title, pageUrl: match.pageUrl, pdfUrl: match.pdfUrl, text, viaWebSearch };
}
