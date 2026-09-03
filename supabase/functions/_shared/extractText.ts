import { Buffer } from "node:buffer";

export interface ExtractResult {
  text: string;
  metadata: Record<string, unknown>;
}

// A scanned/photographed PDF has no real text layer — unpdf pulls whatever
// is embedded, which for these is next to nothing (a handful of stray
// characters, not real content). Real OCR isn't viable inside this function
// (150-256MB memory, 2s CPU time per request — OCR blows through both), so
// this calls out to a small dedicated OCR service on its own VM instead
// (see ocr-service/app.py) rather than failing the whole ingestion. That's
// an outbound fetch (async I/O), not CPU-bound work, so it doesn't count
// against this function's own CPU-time budget even though it's slow.
async function ocrPdfFallback(pdfBytes: Uint8Array): Promise<string | null> {
  const ocrUrl = Deno.env.get("OCR_SERVICE_URL");
  const ocrSecret = Deno.env.get("OCR_SERVICE_SECRET");
  if (!ocrUrl || !ocrSecret) {
    console.warn("OCR fallback not configured (OCR_SERVICE_URL/OCR_SERVICE_SECRET unset) — skipping.");
    return null;
  }
  try {
    const resp = await fetch(`${ocrUrl}/ocr/pdf`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ocrSecret}`,
        "Content-Type": "application/pdf",
      },
      body: pdfBytes,
      signal: AbortSignal.timeout(150_000),
    });
    if (!resp.ok) {
      console.error(`OCR service error: ${resp.status} ${await resp.text()}`);
      return null;
    }
    const data = await resp.json();
    return data.text as string;
  } catch (err) {
    console.error("OCR fallback request failed:", err);
    return null;
  }
}

// mammoth's in-process docx-to-HTML conversion has to hold the whole
// unzipped document.xml (plus its own intermediate structures) in memory
// at once. A large Word file with heavy tracked-changes history (every
// insertion/deletion is its own XML run) can expand many times over its
// zipped size — confirmed directly against a real 5.5MB precedent file: it
// produced 14MB of HTML, and killed this function with Supabase's
// WORKER_RESOURCE_LIMIT in under 7 seconds. That's a hard platform-level
// memory kill of the whole isolate, not a normal JS exception — nothing in
// this function's own code gets a chance to catch it or fall back
// afterwards, so the only real fix is deciding before ever calling mammoth
// in-process. Anything over this threshold routes to ocr-service's
// /extract/docx instead (same VM as the PDF OCR fallback below, just no
// per-request memory ceiling there).
const LARGE_DOCX_BYTES = 2 * 1024 * 1024;

async function docxHtmlFallback(docxBytes: Uint8Array): Promise<string | null> {
  const ocrUrl = Deno.env.get("OCR_SERVICE_URL");
  const ocrSecret = Deno.env.get("OCR_SERVICE_SECRET");
  if (!ocrUrl || !ocrSecret) {
    console.warn("Large-docx fallback not configured (OCR_SERVICE_URL/OCR_SERVICE_SECRET unset) — skipping.");
    return null;
  }
  try {
    const resp = await fetch(`${ocrUrl}/extract/docx`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ocrSecret}`,
        "Content-Type": "application/octet-stream",
      },
      body: docxBytes,
      signal: AbortSignal.timeout(150_000),
    });
    if (!resp.ok) {
      console.error(`Docx extraction service error: ${resp.status} ${await resp.text()}`);
      return null;
    }
    const data = await resp.json();
    return data.html as string;
  } catch (err) {
    console.error("Large-docx fallback request failed:", err);
    return null;
  }
}

// PowerPoint. A .pptx is a zip of small XML parts plus (usually) large media;
// the slide text is tiny, so the in-process path only inflates the XML parts
// it needs and never touches the images. The threshold is about how much
// zipped file we're comfortable holding in this function's memory at all,
// not about parsing cost — above it the whole file goes to ocr-service's
// /extract/pptx (python-pptx) instead, same posture as docx.
//
// Output must be deterministic: suggest-redline and redline-chat re-extract
// the same file and require a suggestion's original_text to be a verbatim
// substring of it. Both this path and the Python one emit the same shape —
// "[Slide N]" blocks, one line per paragraph, notes appended as "Notes: …".
const LARGE_PPTX_BYTES = 20 * 1024 * 1024;

async function pptxTextFallback(pptxBytes: Uint8Array): Promise<{ text: string; slides: number } | null> {
  const ocrUrl = Deno.env.get("OCR_SERVICE_URL");
  const ocrSecret = Deno.env.get("OCR_SERVICE_SECRET");
  if (!ocrUrl || !ocrSecret) {
    console.warn("Large-pptx fallback not configured (OCR_SERVICE_URL/OCR_SERVICE_SECRET unset) — skipping.");
    return null;
  }
  try {
    const resp = await fetch(`${ocrUrl}/extract/pptx`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ocrSecret}`,
        "Content-Type": "application/octet-stream",
      },
      body: pptxBytes,
      signal: AbortSignal.timeout(150_000),
    });
    if (!resp.ok) {
      console.error(`Pptx extraction service error: ${resp.status} ${await resp.text()}`);
      return null;
    }
    const data = await resp.json();
    return { text: data.text as string, slides: data.slides as number };
  } catch (err) {
    console.error("Large-pptx fallback request failed:", err);
    return null;
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, "&");
}

// DrawingML → lines: one line per <a:p> paragraph, runs joined with nothing
// (a run boundary is a formatting change, not a word boundary), <a:br/> as a
// newline. Tables and grouped shapes use the same <a:p>/<a:t> markup, so
// document order of the XML is the reading order for all of them.
function drawingMlToLines(xml: string): string[] {
  const lines: string[] = [];
  for (const paragraph of xml.split("</a:p>")) {
    const runs: string[] = [];
    const re = /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\s*\/>/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(paragraph)) !== null) {
      runs.push(match[0].startsWith("<a:br") ? "\n" : decodeXmlEntities(match[1]));
    }
    const line = runs.join("").trim();
    if (line) lines.push(line);
  }
  return lines;
}

async function extractPptxInProcess(bytes: Uint8Array): Promise<{ text: string; slides: number }> {
  const { unzipSync } = await import("https://esm.sh/fflate@0.8.3");
  const wanted =
    /^ppt\/(presentation\.xml|_rels\/presentation\.xml\.rels|slides\/slide\d+\.xml|slides\/_rels\/slide\d+\.xml\.rels|notesSlides\/notesSlide\d+\.xml)$/;
  const entries = unzipSync(bytes, { filter: (file) => wanted.test(file.name) });
  const decoder = new TextDecoder();
  const part = (name: string) => (entries[name] ? decoder.decode(entries[name]) : "");

  // Presentation order is the <p:sldId> list, resolved through the rels file
  // — slideN numbering is just creation order and goes stale on reordering.
  const rels = new Map<string, string>();
  for (const m of part("ppt/_rels/presentation.xml.rels").matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1])?.[1];
    const target = /\bTarget="([^"]+)"/.exec(m[1])?.[1];
    if (id && target) rels.set(id, target.replace(/^\/?ppt\//, "").replace(/^\//, ""));
  }
  const ordered: string[] = [];
  for (const m of part("ppt/presentation.xml").matchAll(/<p:sldId\b[^>]*\br:id="([^"]+)"/g)) {
    const target = rels.get(m[1]);
    if (target) ordered.push(`ppt/${target}`);
  }
  const slidePaths =
    ordered.length > 0
      ? ordered
      : Object.keys(entries)
          .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
          .sort((a, b) => Number(/slide(\d+)/.exec(a)![1]) - Number(/slide(\d+)/.exec(b)![1]));

  const blocks: string[] = [];
  slidePaths.forEach((slidePath, index) => {
    const lines = drawingMlToLines(part(slidePath));

    // The notes slide is linked from the slide's own rels, and only its body
    // placeholder is the lawyer's notes — the other shapes on a notes page
    // are the slide thumbnail and the page-number field.
    const slideFile = slidePath.split("/").pop()!;
    const notesTarget = /<Relationship\b[^>]*Type="[^"]*\/notesSlide"[^>]*Target="([^"]+)"/.exec(
      part(`ppt/slides/_rels/${slideFile}.rels`)
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

export async function extractTextFromFile(fileData: Blob, fileName: string): Promise<ExtractResult> {
  const fileExtension = fileName.toLowerCase().split(".").pop();

  if (fileExtension === "pdf") {
    const { extractText, getDocumentProxy } = await import("https://esm.sh/unpdf@0.11.0");
    const arrayBuffer = await fileData.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    const documentProxy = await getDocumentProxy(uint8Array);
    const numPages = documentProxy.numPages;
    const { text } = await extractText(uint8Array, { mergePages: true });

    if (text.trim().length < 20) {
      const ocrText = await ocrPdfFallback(uint8Array);
      if (ocrText && ocrText.trim().length >= 20) {
        return { text: ocrText, metadata: { page_count: numPages, original_format: "pdf", ocr: true } };
      }
    }

    return { text, metadata: { page_count: numPages, original_format: "pdf" } };
  }

  if (fileExtension === "docx") {
    const arrayBuffer = await fileData.arrayBuffer();

    if (arrayBuffer.byteLength > LARGE_DOCX_BYTES) {
      const html = await docxHtmlFallback(new Uint8Array(arrayBuffer));
      if (html) {
        return { text: html, metadata: { original_format: "docx", large_docx_offloaded: true } };
      }
      // ocr-service unreachable/misconfigured — fall through and attempt
      // mammoth in-process anyway. Worse odds than the normal path, but
      // silently returning no text at all is a worse outcome than a shot
      // at it, and this is the same posture the PDF OCR fallback takes.
    }

    const mammoth = await import("https://esm.sh/mammoth@1.6.0");
    // esm.sh can resolve either mammoth's browser build (wants `arrayBuffer`)
    // or its Node build (wants a Node `buffer`) depending on how it infers
    // the target — pass both so extraction works regardless of which loads.
    // convertToHtml (not extractRawText) — preserves headings/bold/italic/
    // lists as semantic HTML instead of discarding all structure, so
    // precedent/template/statute text fed to the AI (and stored for RAG)
    // retains far more of the original document's real formatting signal.
    const result = await mammoth.convertToHtml({ arrayBuffer, buffer: Buffer.from(arrayBuffer) } as any);
    return { text: result.value, metadata: { original_format: "docx" } };
  }

  if (fileExtension === "pptx") {
    const arrayBuffer = await fileData.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    if (bytes.byteLength > LARGE_PPTX_BYTES) {
      const offloaded = await pptxTextFallback(bytes);
      if (offloaded) {
        return {
          text: offloaded.text,
          metadata: { original_format: "pptx", slide_count: offloaded.slides, large_pptx_offloaded: true },
        };
      }
      // ocr-service unreachable/misconfigured — fall through and try in-process
      // anyway, same as the docx path: a shot at it beats silently no text.
    }

    const { text, slides } = await extractPptxInProcess(bytes);
    return { text, metadata: { original_format: "pptx", slide_count: slides } };
  }

  if (fileExtension === "xlsx" || fileExtension === "xls") {
    const XLSX = await import("https://esm.sh/xlsx@0.18.5");
    const arrayBuffer = await fileData.arrayBuffer();
    const workbook = XLSX.read(new Uint8Array(arrayBuffer), { type: "array" });
    const sheets: string[] = [];

    workbook.SheetNames.forEach((sheetName: string) => {
      const worksheet = workbook.Sheets[sheetName];
      const sheetData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
      let sheetText = `[Sheet: ${sheetName}]\n`;
      sheetData.forEach((row: any, index: number) => {
        if (row && row.length > 0) {
          sheetText += `Row ${index + 1}: ${row.join(", ")}\n`;
        }
      });
      sheets.push(sheetText);
    });

    return {
      text: sheets.join("\n\n"),
      metadata: { sheet_count: workbook.SheetNames.length, original_format: "excel" },
    };
  }

  throw new Error(`Unsupported file type: ${fileExtension}`);
}
