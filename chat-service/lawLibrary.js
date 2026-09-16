// Adding a law to the firm's law library by name.
//
// Until now the library was filled by a scraper run from a developer's
// machine, or by an associate uploading a file against one project's
// Relevant Laws. This is the same job done from the app, on this server:
// find the Act on pakistancode.gov.pk (its search page, read through the
// download relay because the site does not answer this server directly),
// or failing that let a model with web search locate an official PDF; then
// download the PDF, confirm its text really is that Act, and index it. The
// model only ever names a URL — the text that reaches the library is always
// the downloaded document's own.
import { createHash } from 'node:crypto';
import { sourceIdentityMatches } from './sourcePolicy.js';
import { extractTextFromFile } from './extractText.js';
import { findInLibrary, downloadOfficial } from './research.js';

const SEARCH_URL = 'https://pakistancode.gov.pk/english/sHyuRsF';
const MAX_RESULT_PAGES = 5;

/** The Act pages a pakistancode search results page links to. */
export function parseSearchResults(html) {
  const links = new Set();
  const re = /href="(https?:\/\/pakistancode\.gov\.pk\/english\/[^"]*-con-\d+-sg-[^"]*)"/g;
  let m;
  while ((m = re.exec(String(html ?? ''))) !== null) links.add(m[1]);
  return [...links].sort().slice(0, MAX_RESULT_PAGES);
}

/** An Act page's title and the PDF of its text, if the page has one. */
export function parseActPage(html) {
  const text = String(html ?? '');
  const title = /<h2>([^<]+)/.exec(text)?.[1]?.trim() ?? null;
  const pdfUrl = /href="(https:\/\/pakistancode\.gov\.pk\/pdffiles\/[^"]+\.pdf)"/.exec(text)?.[1] ?? null;
  return { title, pdfUrl };
}

// Every significant word of the name the associate typed, and every year in
// it, must appear in the page's title — enough to reject an unrelated Act
// without demanding the site's exact spacing and punctuation.
export function titleMatches(name, title) {
  if (!title) return false;
  const lower = title.toLowerCase();
  const words = (String(name).match(/[A-Za-z]+/g) ?? []).filter((w) => w.length > 2).map((w) => w.toLowerCase());
  const years = String(name).match(/\b(?:18|19|20)\d{2}\b/g) ?? [];
  return words.length > 0 && words.every((w) => lower.includes(w)) && years.every((y) => title.includes(y));
}

/** pakistancode.gov.pk's own search, read page by page through `fetchText(url)`. */
export async function searchPakistanCode(name, { fetchText, signal }) {
  // A comma in the query ("Contract Act, 1872") makes the site return nothing.
  const query = String(name).replace(/[^\w\s]/g, ' ');
  let html;
  try {
    html = await fetchText(`${SEARCH_URL}?${new URLSearchParams({ query, search: '1' })}`);
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
  for (const link of parseSearchResults(html)) {
    if (signal?.aborted) throw new Error('Stopped');
    let page;
    try {
      page = await fetchText(link);
    } catch {
      continue;
    }
    const { title, pdfUrl } = parseActPage(page);
    if (pdfUrl && titleMatches(name, title)) return { title, pageUrl: link, pdfUrl, via: 'pakistancode.gov.pk' };
  }
  return null;
}

// A model with a search tool narrates before it answers; the answer is the
// last text block, and the JSON in it.
function lastJson(content) {
  const blocks = (content ?? []).filter((b) => b.type === 'text');
  const raw = blocks.length ? blocks[blocks.length - 1].text : '';
  const m = /\{[\s\S]*\}/.exec(raw);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

/** A model with web search, asked only to locate an official PDF of the Act. */
export async function locateWithWebSearch(name, anthropicJson, signal) {
  const result = await anthropicJson({
    model: process.env.RESEARCH_MODEL ?? 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
    messages: [{
      role: 'user',
      content: `Find a direct PDF URL for the full official text of the Pakistani statute "${name}". Prefer pakistancode.gov.pk; if it is not there, look for the National Assembly of Pakistan (na.gov.pk), the Senate, a provincial assembly or government website, or a regulator's own site (sbp.org.pk, nepra.org.pk, ogra.org.pk, ppra.org.pk). It must link directly to a PDF of the Act's actual text — not a summary, a news article, a bill, or a page that merely mentions the Act.\n\nRespond with ONLY a JSON object, no other text: {"found": true, "title": "<the Act's exact official title>", "pdfUrl": "<the direct .pdf URL>"} — or {"found": false} if you cannot locate an actual PDF of this specific Act's text.`,
    }],
  }, signal);
  const parsed = lastJson(result.content);
  if (!parsed?.found || typeof parsed.pdfUrl !== 'string' || typeof parsed.title !== 'string') return null;
  return { title: parsed.title, pageUrl: parsed.pdfUrl, pdfUrl: parsed.pdfUrl, via: 'ai-web-search' };
}

/**
 * Finds an Act by name and adds it to the law library. Returns
 * { status: "available", actName, alreadyInLibrary?, sourceUrl?, via? } or
 * { status: "not_found", reason }.
 */
export async function addLawToLibrary({ supabase, authHeader, anthropicJson, actName, signal, notice = () => {} }) {
  const name = String(actName ?? '').trim();
  if (name.length < 4 || name.length > 300) throw new Error('Give the Act its name, e.g. "Public Procurement Regulatory Authority Ordinance, 2002".');

  const { data: library, error: libraryError } = await supabase.rpc('statute_sources');
  if (libraryError) throw new Error(`Could not read the law library: ${libraryError.message}`);
  const held = findInLibrary(name, library ?? []) ?? (library ?? []).find((entry) => entry.act_name.toLowerCase() === name.toLowerCase());
  if (held) return { status: 'available', actName: held.act_name, alreadyInLibrary: true };

  const fetchText = async (url) => (await downloadOfficial(url, { signal })).blob.text();
  notice('Searching pakistancode.gov.pk…');
  let match = await searchPakistanCode(name, { fetchText, signal });
  if (!match) {
    notice('Not found there; searching official sources on the web…');
    match = await locateWithWebSearch(name, anthropicJson, signal);
  }
  if (!match) return { status: 'not_found', reason: 'No official copy of this Act could be found on pakistancode.gov.pk or elsewhere on official websites. Check the name and year, or upload the Act as a PDF.' };

  notice(`Downloading ${match.title}…`);
  let downloaded;
  try {
    downloaded = await downloadOfficial(match.pdfUrl, { signal });
  } catch (err) {
    if (signal?.aborted) throw err;
    return { status: 'not_found', reason: `An official copy was located (${match.pdfUrl}) but could not be downloaded: ${err.message}. Upload the Act as a PDF instead.` };
  }
  const bytes = new Uint8Array(await downloaded.blob.arrayBuffer());
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') return { status: 'not_found', reason: `The file at ${downloaded.url} is not a PDF. Upload the Act as a PDF instead.` };
  const { text } = await extractTextFromFile(downloaded.blob, 'statute.pdf');
  if (!sourceIdentityMatches(match.title, text)) return { status: 'not_found', reason: `A document was downloaded from ${downloaded.url}, but its text does not read as "${match.title}", so it was not added. Upload the Act as a PDF if you have it.` };

  const hash = createHash('sha256').update(bytes).digest('hex');
  const { data: existing, error: lookupError } = await supabase.from('documents').select('metadata').eq('is_statute', true).eq('metadata->>source_hash', hash).limit(1);
  if (lookupError) throw lookupError;
  if (existing?.length) return { status: 'available', actName: existing[0].metadata?.act_name ?? match.title, alreadyInLibrary: true };

  const metadata = {
    act_name: match.title,
    source: match.via,
    source_url: match.pageUrl,
    pdf_url: downloaded.url,
    source_hash: hash,
    scraped_at: new Date().toISOString(),
    fetched_at: new Date().toISOString(),
    applicability: 'candidate',
    identity_checked: true,
    requested_as: name,
  };
  notice('Indexing…');
  const { error: ingestError } = await supabase.functions.invoke('ingest-documents', {
    body: { content: text, metadata, isStatute: true },
    headers: authHeader ? { Authorization: authHeader } : undefined,
  });
  if (ingestError) throw new Error(`${match.title} was found but indexing it failed: ${ingestError.message}`);
  return { status: 'available', actName: match.title, sourceUrl: downloaded.url, via: match.via };
}
