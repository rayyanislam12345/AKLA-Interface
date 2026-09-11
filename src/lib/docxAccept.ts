import JSZip from "jszip";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/**
 * The same Word file with every tracked change accepted — the clean copy a
 * lawyer sends out once the redline has been read. Only word/document.xml is
 * touched: insertions lose their markers, deletions and the paragraphs whose
 * paragraph mark was struck through go.
 *
 * This mirrors acceptAllChanges in chat-service/docxAgent.js, which does the
 * same to the file the AI has just edited. Keep the two in step.
 */
export async function acceptTrackedChanges(file: Blob): Promise<Blob> {
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  if (!zip.file("word/document.xml")) throw new Error("Not a Word file");
  for (const part of Object.keys(zip.files).filter(p => /^word\/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(p))) {
  const entry = zip.file(part)!;
  let xml = await entry.async("string");
  if (/<w:(?:moveFrom|moveTo|pPrChange|rPrChange|tblPrChange|sectPrChange)\b/.test(xml)) throw new Error("This file contains revision types that must be accepted in Word. Download the tracked copy.");

  const child = (source: string, tag: string) =>
    new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</${tag}>)`).exec(source)?.[0];

  // A struck-through paragraph mark — the w:del inside the paragraph
  // properties' own w:rPr — means the whole paragraph goes. A deletion
  // anywhere else in the paragraph is ordinary struck-out text.
  xml = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (p) => {
    const pPr = child(p, "w:pPr");
    const rPr = pPr && child(pPr, "w:rPr");
    if (rPr && /<w:del[\s/>]/.test(rPr)) {
      if (/<w:t(?:\s[^>]*)?>[^<]/.test(p.replace(/<w:del\b[\s\S]*?<\/w:del>/g, ""))) throw new Error("This file contains a paragraph merge that must be accepted in Word.");
      return "";
    }
    return p;
  });
  xml = xml
    .replace(/<w:del\b[\s\S]*?<\/w:del>/g, "")
    .replace(/<w:ins\s[^>]*\/>/g, "")
    .replace(/<w:ins\s[^>]*>([\s\S]*?)<\/w:ins>/g, "$1");

  // Word requires a paragraph in every table cell after accepting deletion.
  xml = xml.replace(/<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g, cell => /<w:p(?:\s|>|\/)/.test(cell) ? cell : cell.replace('</w:tc>', '<w:p/></w:tc>'));
  zip.file(part, xml);
  }
  return zip.generateAsync({ type: "blob", mimeType: DOCX_MIME, compression: "DEFLATE" });
}
