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
