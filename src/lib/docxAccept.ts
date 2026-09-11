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
  const entry = zip.file("word/document.xml");
  if (!entry) throw new Error("Not a Word file");
  let xml = await entry.async("string");

  const child = (source: string, tag: string) =>
    new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</${tag}>)`).exec(source)?.[0];

  // A struck-through paragraph mark — the w:del inside the paragraph
  // properties' own w:rPr — means the whole paragraph goes. A deletion
  // anywhere else in the paragraph is ordinary struck-out text.
  xml = xml.replace(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (p) => {
    const pPr = child(p, "w:pPr");
    const rPr = pPr && child(pPr, "w:rPr");
    return rPr && /<w:del[\s/>]/.test(rPr) ? "" : p;
  });
  xml = xml
    .replace(/<w:del\b[\s\S]*?<\/w:del>/g, "")
    .replace(/<w:ins\s[^>]*\/>/g, "")
    .replace(/<w:ins\s[^>]*>([\s\S]*?)<\/w:ins>/g, "$1");

  zip.file("word/document.xml", xml);
  return zip.generateAsync({ type: "blob", mimeType: DOCX_MIME, compression: "DEFLATE" });
}
