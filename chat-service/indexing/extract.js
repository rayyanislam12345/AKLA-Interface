// Reads a stored file into paragraphs ("blocks") for the chunker.
//
//   PDF   pdftotext -layout, page by page; any page with under 200 visible
//         characters is rendered (pdftoppm) and OCR'd (tesseract) on its own,
//         so a typed cover with a scanned body is read in full. Up to 400
//         pages; repeated running heads and page numbers are dropped.
//   DOCX  indexing/docx.js (clause numbers, accepted view of tracked
//         changes, headers/footers/comments/footnotes to side fields); mammoth
//         with pictures stripped if that reader finds nothing.
//   XLSX/XLS/PPTX  as the chat path reads them (extractText.js).
//   TXT/MD/CSV  as UTF-8 text; Markdown "#" lines are headings.
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import mammoth from "mammoth";
import { extractPdfPageTexts, extractTextFromFile, pdfInfo, PdfPasswordError } from "../extractText.js";
import { readDocx } from "./docx.js";
import { isCapsHeading, parseLabel } from "./chunk.js";

const execFileAsync = promisify(execFile);

export const SUPPORTED_EXTENSIONS = ["pdf", "docx", "xlsx", "xls", "pptx", "txt", "md", "csv"];
export const MAX_PDF_PAGES = Number(process.env.INDEX_MAX_PAGES ?? 400);
export const OCR_MIN_VISIBLE_CHARS = 200;
const OCR_DPI = Number(process.env.INDEX_OCR_DPI ?? 150);
const OCR_BATCH_PAGES = 8;

/** A failure the same file will hit again: no retry, the message goes to the lawyer. */
export class PermanentError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "PermanentError";
    this.permanent = true;
    if (cause) this.cause = cause;
  }
}

/** Raised between steps when the worker is asked to stop or loses its job. */
export class StopRequested extends Error {
  constructor(reason = "stop requested") {
    super(reason);
    this.name = "StopRequested";
  }
}

export const extensionOf = (name) => (/\.([A-Za-z0-9]+)$/.exec(String(name ?? ""))?.[1] ?? "").toLowerCase();

export const visibleChars = (text) => String(text ?? "").replace(/\s+/g, "").length;

/** Whether a PDF page's text layer is too thin to trust (a scan, or a scan with a stamp). */
export const pageNeedsOcr = (text) => visibleChars(text) < OCR_MIN_VISIBLE_CHARS;

// A picture written into text as a data URI is not words.
const stripDataUris = (text) => String(text ?? "").replace(/data:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=\s]{100,}/gi, "[image]");

/**
 * Plain text to paragraphs: a blank line ends one, and so does a line that
 * opens a new clause ("14.2 …", "(a) …", "ARTICLE 5") or a capitals heading.
 */
export function textToBlocks(text, { page = null, layoutText = false } = {}) {
  const lines = stripDataUris(text).replace(/\r\n?/g, "\n").split("\n").map((line) => {
    let l = line.replace(/\s+$/, "");
    if (layoutText) l = l.replace(/ {3,}/g, "  ");
    return l;
  });
  // pdftotext -layout indents everything by the page margin.
  const indents = lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)[0].length);
  const common = layoutText && indents.length ? Math.min(...indents) : 0;
  const blocks = [];
  let current = [];
  const flush = () => {
    const body = current.join("\n").trim();
    if (body) blocks.push(page === null ? { text: body } : { text: body, page });
    current = [];
  };
  for (const raw of lines) {
    const line = common ? raw.slice(common) : raw;
    const trimmed = line.trim();
    if (!trimmed) { flush(); continue; }
    const opens = parseLabel(trimmed) || isCapsHeading(trimmed);
    if (opens && current.length) flush();
    current.push(layoutText ? line.replace(/^\s+/, (s) => (s.length > 8 ? "  " : s)) : line);
    // A capitals heading stands on its own line.
    if (isCapsHeading(trimmed) && !parseLabel(trimmed)) flush();
  }
  flush();
  return blocks;
}

function markdownToBlocks(text) {
  const blocks = [];
  let body = [];
  const flush = () => {
    for (const b of textToBlocks(body.join("\n"))) blocks.push(b);
    body = [];
  };
  for (const line of String(text ?? "").replace(/\r\n?/g, "\n").split("\n")) {
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      blocks.push({ text: line.trim(), heading: { depth: h[1].length, entry: h[2] } });
    } else body.push(line);
  }
  flush();
  return blocks;
}

// "[Sheet: Rent roll]" / "[Slide 3]" open a section; every other line is a paragraph.
function markedTextToBlocks(text) {
  const blocks = [];
  for (const line of String(text ?? "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const sheet = /^\[Sheet: (.+)\]$/.exec(t);
    const slide = /^\[Slide (\d+)\]$/.exec(t);
    if (sheet) blocks.push({ text: t, heading: { depth: 1, entry: `Sheet ${sheet[1]}` } });
    else if (slide) blocks.push({ text: t, heading: { depth: 1, entry: `Slide ${slide[1]}` } });
    else blocks.push({ text: t });
  }
  return blocks;
}

const normaliseRunningHead = (line) => line.trim().toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ");

/**
 * Drops lines that repeat at the top or bottom of most pages (running heads,
 * "Page 3 of 40", the Act's short title on every page): left in, they become
 * a heading on every page and noise in every passage.
 */
export function stripRunningHeads(pages) {
  if (pages.length < 3) return pages;
  const counts = new Map();
  // The top and bottom two lines (one on a short page, so the body is never a candidate).
  const reach = (n) => (n >= 6 ? 2 : 1);
  const edges = (text) => {
    const lines = text.split("\n").filter((l) => l.trim());
    const k = reach(lines.length);
    return [...new Set([...lines.slice(0, k), ...lines.slice(-k)].map(normaliseRunningHead))];
  };
  for (const p of pages) for (const key of edges(p)) counts.set(key, (counts.get(key) ?? 0) + 1);
  const threshold = Math.max(3, Math.ceil(pages.length * 0.5));
  const repeated = new Set([...counts].filter(([key, n]) => n >= threshold && key.length <= 120).map(([key]) => key));
  // A bare page number differs on every page but normalises to "#".
  repeated.add("#");
  repeated.add("- # -");
  repeated.add("page #");
  repeated.add("page # of #");
  if (!repeated.size) return pages;
  return pages.map((text) => {
    const lines = text.split("\n");
    const nonEmpty = lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
    const k = reach(nonEmpty.length);
    const edgeIdx = new Set([...nonEmpty.slice(0, k), ...nonEmpty.slice(-k)]);
    return lines.filter((l, i) => !(edgeIdx.has(i) && repeated.has(normaliseRunningHead(l)))).join("\n");
  });
}

async function run(cmd, args, options = {}) {
  try {
    return await execFileAsync(cmd, args, { maxBuffer: 32 * 1024 * 1024, ...options });
  } catch (err) {
    if (err?.code === "ENOENT") {
      const e = new Error(`${cmd} is not installed on this server`);
      e.missingTool = cmd;
      throw e;
    }
    throw err;
  }
}

/**
 * OCRs the given 1-based pages, a few at a time: pdftoppm renders a short
 * range to images on disk, tesseract reads each and the image is deleted, so
 * memory and disk stay flat however long the document.
 */
export async function ocrPages(pdfPath, pageNumbers, { onPage, checkStop } = {}) {
  const results = new Map();
  const dir = await mkdtemp(join(tmpdir(), "ocr-"));
  const env = { ...process.env, OMP_THREAD_LIMIT: "1" }; // one vCPU: threads only add overhead
  try {
    const sorted = [...pageNumbers].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length;) {
      // A contiguous run of up to OCR_BATCH_PAGES pages.
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1 && j + 1 - i < OCR_BATCH_PAGES) j++;
      const first = sorted[i];
      const last = sorted[j];
      checkStop?.();
      await run("pdftoppm", ["-f", String(first), "-l", String(last), "-r", String(OCR_DPI), "-gray", "-png", pdfPath, join(dir, "p")], { timeout: 10 * 60_000 });
      const files = (await readdir(dir)).filter((f) => /^p-\d+\.png$/.test(f)).sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]));
      for (const file of files) {
        const page = Number(/(\d+)/.exec(file)[1]);
        const image = join(dir, file);
        try {
          checkStop?.();
          const { stdout } = await run("tesseract", [image, "stdout", "-l", process.env.INDEX_OCR_LANG ?? "eng"], { timeout: 5 * 60_000, env });
          results.set(page, stdout);
        } finally {
          await rm(image, { force: true });
        }
        await onPage?.(page);
      }
      i = j + 1;
    }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return results;
}

async function extractPdf(bytes, { checkStop, onProgress } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "index-pdf-"));
  try {
    const pdfPath = join(dir, "in.pdf");
    await writeFile(pdfPath, bytes);
    let info;
    try {
      info = await pdfInfo(pdfPath);
    } catch (err) {
      if (err instanceof PdfPasswordError) throw new PermanentError("The PDF is password-protected. Save a copy without the password and upload that.");
      if (err?.code === "ENOENT") throw err;
      throw new PermanentError("The PDF is damaged and could not be opened. Try saving or printing it to a new PDF.", err);
    }
    if (info.encrypted) {
      // Encrypted with an empty user password still opens; a real password does not.
    }
    let texts;
    let extractor;
    try {
      ({ pages: texts, extractor } = await extractPdfPageTexts(pdfPath, { maxPages: MAX_PDF_PAGES }));
    } catch (err) {
      if (err instanceof PdfPasswordError) throw new PermanentError("The PDF is password-protected. Save a copy without the password and upload that.");
      throw new PermanentError("The PDF is damaged and its text could not be read. Try saving or printing it to a new PDF.", err);
    }
    const pageCount = info.pages ?? texts.length;
    const pagesRead = Math.min(pageCount, MAX_PDF_PAGES);
    while (texts.length < pagesRead) texts.push("");
    texts = texts.slice(0, pagesRead);

    const needOcr = [];
    texts.forEach((t, i) => { if (pageNeedsOcr(t)) needOcr.push(i + 1); });
    const ocrUsed = [];
    if (needOcr.length) {
      checkStop?.();
      const ocr = await ocrPages(pdfPath, needOcr, { checkStop, onPage: (page) => onProgress?.({ step: "ocr", page, of: needOcr.length }) });
      for (const [page, text] of ocr) {
        if (visibleChars(text) > visibleChars(texts[page - 1])) {
          texts[page - 1] = text;
          ocrUsed.push(page);
        }
      }
    }
    const cleaned = stripRunningHeads(texts);
    const blocks = [];
    cleaned.forEach((t, i) => {
      for (const b of textToBlocks(t, { page: i + 1, layoutText: extractor === "pdftotext" && !ocrUsed.includes(i + 1) })) blocks.push(b);
    });
    const totalVisible = cleaned.reduce((n, t) => n + visibleChars(t), 0);
    if (totalVisible < 100) {
      throw new PermanentError(needOcr.length
        ? "No readable text, even after OCR. The scan may be blank, handwritten or too faint; try a clearer scan."
        : "No readable text was found in this PDF.");
    }
    return {
      format: "pdf",
      mode: "page",
      blocks,
      pageCount,
      pagesRead,
      truncatedPages: Math.max(0, pageCount - pagesRead),
      ocrPages: ocrUsed.sort((a, b) => a - b),
      extractor,
      side: null,
      hasTrackedChanges: false,
    };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const htmlToBlocks = (html) =>
  String(html ?? "")
    .replace(/<img\b[^>]*>/gi, "")
    .split(/<\/(?:p|li|h[1-6]|tr|td|div)>|<br\s*\/?>/i)
    .map((part) => part.replace(/<[^>]*>/g, " ")
      .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
      .replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .map((text) => ({ text }));

async function extractDocx(bytes) {
  let read = null;
  try {
    read = readDocx(bytes);
  } catch (err) {
    if (err?.permanent) throw new PermanentError(err.message, err);
    console.error("docx reader failed, trying mammoth:", err?.message ?? err);
  }
  if (read && read.blocks.length) {
    return {
      format: "docx",
      mode: "structure",
      blocks: read.blocks,
      pageCount: null,
      side: read.side,
      hasTrackedChanges: read.hasTrackedChanges,
      revisionCount: read.revisionCount,
      extractor: "ooxml",
    };
  }
  // Pictures are dropped before they are ever base64-encoded.
  const result = await mammoth.convertToHtml(
    { buffer: Buffer.from(bytes) },
    { convertImage: mammoth.images.imgElement(async () => ({ src: "" })) },
  );
  const blocks = htmlToBlocks(result.value);
  if (!blocks.length) throw new PermanentError("This Word file has no readable text.");
  return { format: "docx", mode: "structure", blocks, pageCount: null, side: read?.side ?? null, hasTrackedChanges: read?.hasTrackedChanges ?? false, extractor: "mammoth" };
}

function decodeText(bytes) {
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // Mostly replacement characters: it was not UTF-8; Windows-1252 is the usual other.
  if ((text.match(/�/g)?.length ?? 0) > text.length / 50) text = new TextDecoder("windows-1252").decode(bytes);
  return text;
}

/**
 * @param {Uint8Array} bytes
 * @param {string} fileName
 * @param {{ checkStop?: () => void, onProgress?: (p: object) => void }} [options]
 */
export async function extractForIndex(bytes, fileName, options = {}) {
  const ext = extensionOf(fileName);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new PermanentError(`Files of type .${ext || "unknown"} cannot be read for search. Save it as a PDF or Word file.`);
  }
  if (ext === "pdf") return extractPdf(bytes, options);
  if (ext === "docx") return extractDocx(bytes);
  if (ext === "txt" || ext === "csv") {
    const text = decodeText(bytes);
    const blocks = ext === "csv" ? text.split(/\r?\n/).filter((l) => l.trim()).map((l) => ({ text: l })) : textToBlocks(text);
    if (!blocks.length) throw new PermanentError("The file is empty.");
    return { format: ext, mode: "structure", blocks, pageCount: null, side: null, hasTrackedChanges: false, extractor: "text" };
  }
  if (ext === "md") {
    const blocks = markdownToBlocks(decodeText(bytes));
    if (!blocks.length) throw new PermanentError("The file is empty.");
    return { format: "md", mode: "structure", blocks, pageCount: null, side: null, hasTrackedChanges: false, extractor: "text" };
  }
  // xlsx / xls / pptx: the chat path's reader, unchanged.
  let result;
  try {
    result = await extractTextFromFile(new Blob([bytes]), fileName);
  } catch (err) {
    throw new PermanentError(ext === "pptx" ? "This PowerPoint file is damaged and could not be opened." : "This spreadsheet is damaged and could not be opened.", err);
  }
  const blocks = markedTextToBlocks(result.text);
  if (!blocks.some((b) => !b.heading)) throw new PermanentError(ext === "pptx" ? "This presentation has no readable text." : "This spreadsheet has no readable cells.");
  return {
    format: ext,
    mode: "structure",
    blocks,
    pageCount: result.metadata?.slide_count ?? null,
    side: null,
    hasTrackedChanges: false,
    extractor: "chat-extractor",
  };
}
