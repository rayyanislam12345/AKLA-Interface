// Text extraction for attachments — a port of
// supabase/functions/_shared/extractText.ts to Node. Same formats, same
// output shapes, same fallbacks; the only difference is that the "offload to
// ocr-service" paths now talk to a process on the same machine.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import mammoth from "mammoth";
import * as XLSX from "xlsx";
import { extractText as unpdfExtractText, getDocumentProxy } from "unpdf";

// ocr-service runs on this box (127.0.0.1:8090); the secret is the same
// OCR_SHARED_SECRET it checks.
const OCR_URL = (process.env.OCR_SERVICE_URL ?? "http://127.0.0.1:8090").replace(/\/$/, "");
const OCR_SECRET = process.env.OCR_SERVICE_SECRET ?? "";

async function ocrService(path, contentType, bytes) {
  if (!OCR_SECRET) {
    console.warn(`ocr-service fallback not configured (OCR_SERVICE_SECRET unset) — skipping ${path}.`);
    return null;
  }
  try {
    const resp = await fetch(`${OCR_URL}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${OCR_SECRET}`, "Content-Type": contentType },
      body: bytes,
      signal: AbortSignal.timeout(150_000),
    });
    if (!resp.ok) {
      console.error(`ocr-service ${path} error: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
      return null;
    }
    return await resp.json();
  } catch (err) {
    console.error(`ocr-service ${path} request failed:`, err);
    return null;
  }
}

// A scanned PDF has no real text layer; a real OCR pass is a call away.
async function ocrPdfFallback(pdfBytes) {
  const data = await ocrService("/ocr/pdf", "application/pdf", pdfBytes);
  return data?.text ?? null;
}

// unpdf is pdf.js in a worker, and it gives up on some perfectly ordinary
// PDFs — a 186-page ADB transaction report failed on it with "Unable to
// deserialize cloned data" in 174ms, though the file has a clean text layer
// and poppler reads it in under a second. poppler's pdftotext is installed
// on this box, so a PDF unpdf cannot read is not a PDF this cannot read.
const execFileAsync = promisify(execFile);
const PDFTOTEXT_TIMEOUT_MS = 120_000;

async function pdftotext(pdfBytes) {
  let dir;
  try {
    dir = await mkdtemp(join(tmpdir(), "pdf-"));
    const input = join(dir, "in.pdf");
    const output = join(dir, "out.txt");
    await writeFile(input, pdfBytes);
    // -layout keeps columns and tables readable rather than interleaving them.
    await execFileAsync("pdftotext", ["-layout", "-enc", "UTF-8", input, output], {
      timeout: PDFTOTEXT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    return await readFile(output, "utf8");
  } catch (err) {
    console.error("pdftotext failed:", err?.message ?? err);
    return null;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// mammoth holds the whole unzipped document.xml in memory. Not the hard
// isolate kill it was on Supabase, but a tracked-changes-heavy 5MB file
// still expanded to 14MB of HTML there; the Python service handles those.
const LARGE_DOCX_BYTES = 2 * 1024 * 1024;
async function docxHtmlFallback(docxBytes) {
  const data = await ocrService("/extract/docx", "application/octet-stream", docxBytes);
  return data?.html ?? null;
}

const LARGE_PPTX_BYTES = 20 * 1024 * 1024;
async function pptxTextFallback(pptxBytes) {
  const data = await ocrService("/extract/pptx", "application/octet-stream", pptxBytes);
  return data ? { text: data.text, slides: data.slides } : null;
}

function decodeXmlEntities(value) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, "&");
}

// DrawingML → lines: one line per <a:p>, runs joined with nothing (a run
// boundary is a formatting change, not a word boundary), <a:br/> a newline.
function drawingMlToLines(xml) {
  const lines = [];
  for (const paragraph of xml.split("</a:p>")) {
    const runs = [];
    const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\s*\/>/g;
    let match;
    while ((match = re.exec(paragraph)) !== null) {
      runs.push(match[0].startsWith("<a:br") ? "\n" : decodeXmlEntities(match[1]));
    }
    const line = runs.join("").trim();
    if (line) lines.push(line);
  }
  return lines;
}

// Output must match the Python path byte for byte in shape — "[Slide N]"
// blocks, one line per paragraph, "Notes: …" appended — because
// suggest-redline re-extracts the same file and needs verbatim substrings.
function extractPptxInProcess(bytes) {
  const wanted =
    /^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/slide\d+\.xml|slides\/_rels\/slide\d+\.xml\.rels|notesSlides\/notesSlide\d+\.xml)$/;
  const entries = unzipSync(bytes, { filter: (file) => wanted.test(file.name) });
  const decoder = new TextDecoder();
  const part = (name) => (entries[name] ? decoder.decode(entries[name]) : "");

  const rels = new Map();
  for (const m of part("ppt/_rels/presentation.xml.rels").matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[1])?.[1];
    if (id && target) rels.set(id, target.replace(/^\/?ppt\//, "").replace(/^\//, ""));
  }
  const ordered = [];
  for (const m of part("ppt/presentation.xml").matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)) {
    const target = rels.get(m[1]);
    if (target) ordered.push(`ppt/${target}`);
  }
  const slidePaths =
    ordered.length > 0
      ? ordered
      : Object.keys(entries)
          .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
          .sort((a, b) => Number(/slide(\d+)/.exec(a)[1]) - Number(/slide(\d+)/.exec(b)[1]));

  const blocks = [];
  slidePaths.forEach((slidePath, index) => {
    const lines = drawingMlToLines(part(slidePath));
    const slideFile = slidePath.split("/").pop();
    const notesTarget = /<Relationship\b[^>]*Type="[^"]*\/notesSlide"[^>]*Target="([^"]+)"/.exec(
      part(`ppt/slides/_rels/${slideFile}.rels`),
    )?.[1];
    if (notesTarget) {
      const notesXml = part(`ppt/notesSlides/${notesTarget.split("/").pop()}`);
      const noteLines = notesXml
        .split("<p:sp>")
        .filter((shape) => /<p:ph\b[^>]*type="body"/.test(shape))
        .flatMap(drawingMlToLines);
      if (noteLines.length > 0) lines.push(`Notes: ${noteLines.join("\n")}`);
    }
    blocks.push(`[Slide ${index + 1}]\n${lines.join("\n")}`);
  });

  return { text: blocks.join("\n\n"), slides: slidePaths.length };
}

/**
 * @param {Blob} fileData
 * @param {string} fileName
 * @returns {Promise<{ text: string; metadata: Record<string, unknown> }>}
 */
export async function extractTextFromFile(fileData, fileName) {
  const fileExtension = fileName.toLowerCase().split(".").pop();

  if (fileExtension === "pdf") {
    const bytes = new Uint8Array(await fileData.arrayBuffer());
    let numPages = null;
    let text = "";
    // pdf.js transfers the array it is handed to its worker, which detaches
    // it — anything that reads the file afterwards gets an empty buffer. Each
    // call gets its own copy so the original survives for the fallbacks.
    try {
      numPages = (await getDocumentProxy(bytes.slice())).numPages;
    } catch { /* the page count is not worth failing over */ }
    try {
      text = (await unpdfExtractText(bytes.slice(), { mergePages: true })).text ?? "";
    } catch (err) {
      console.error("unpdf could not read this PDF:", err?.message ?? err);
    }
    if (text.trim().length < 20) {
      const popplerText = await pdftotext(bytes);
      if (popplerText && popplerText.trim().length >= 20) {
        return { text: popplerText, metadata: { page_count: numPages, original_format: "pdf", extractor: "pdftotext" } };
      }
      // Neither could find text: it is a scan, and OCR is the last resort.
      const ocrText = await ocrPdfFallback(bytes);
      if (ocrText && ocrText.trim().length >= 20) {
        return { text: ocrText, metadata: { page_count: numPages, original_format: "pdf", ocr: true } };
      }
      if (!text.trim()) throw new Error("No text could be read from this PDF");
    }
    return { text, metadata: { page_count: numPages, original_format: "pdf" } };
  }

  if (fileExtension === "docx") {
    const arrayBuffer = await fileData.arrayBuffer();
    if (arrayBuffer.byteLength > LARGE_DOCX_BYTES) {
      const html = await docxHtmlFallback(new Uint8Array(arrayBuffer));
      if (html) return { text: html, metadata: { original_format: "docx", large_docx_offloaded: true } };
      // ocr-service unreachable — a shot in-process beats no text at all.
    }
    // convertToHtml, not extractRawText: headings/bold/lists survive as
    // semantic HTML, which is real formatting signal for the model.
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(arrayBuffer) });
    return { text: result.value, metadata: { original_format: "docx" } };
  }

  if (fileExtension === "pptx") {
    const bytes = new Uint8Array(await fileData.arrayBuffer());
    if (bytes.byteLength > LARGE_PPTX_BYTES) {
      const offloaded = await pptxTextFallback(bytes);
      if (offloaded) {
        return { text: offloaded.text, metadata: { original_format: "pptx", slide_count: offloaded.slides, large_pptx_offloaded: true } };
      }
    }
    const { text, slides } = extractPptxInProcess(bytes);
    return { text, metadata: { original_format: "pptx", slide_count: slides } };
  }

  if (fileExtension === "xlsx" || fileExtension === "xls") {
    const workbook = XLSX.read(new Uint8Array(await fileData.arrayBuffer()), { type: "array" });
    const sheets = [];
    for (const sheetName of workbook.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
      let sheetText = `[Sheet: ${sheetName}]\n`;
      rows.forEach((row, index) => {
        if (row && row.length > 0) sheetText += `Row ${index + 1}: ${row.join(", ")}\n`;
      });
      sheets.push(sheetText);
    }
    return { text: sheets.join("\n\n"), metadata: { sheet_count: workbook.SheetNames.length, original_format: "excel" } };
  }

  throw new Error(`Unsupported file type: ${fileExtension}`);
}
