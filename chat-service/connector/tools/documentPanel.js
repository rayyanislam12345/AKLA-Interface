// The document panel (the MCP Apps trial, connector/apps.js): only
// registered when CONNECTOR_APPS=on.
//
// The Chrome companion frames the Hub's document page beside claude.ai and
// relays a highlighted passage into the message box (hub-companion
// passage.js). Inside Claude's own apps that frame is not possible: Claude
// serves an app under a fixed frame-src 'self' blob: data: and ignores
// _meta.ui.csp.frameDomains ("restricted in Claude pending security
// review", claude.com/docs/connectors/building/mcp-apps/design-guidelines;
// anthropics/claude-ai-mcp#40). So this panel draws the version's text
// itself, from the same stored passages read_document reads, and the
// lawyer selects a passage in it; the page builds the companion's own
// quoted message (passage.js selectionMessage, ported) and hands it to
// Claude with ui/message, where claude.ai has been seen to put it in the
// message box unsent for the lawyer to finish (hadarge/lakeshore-air-mcp-app,
// 6 Oct 2026). The page can go full screen (ui/request-display-mode).
//
// open_document_panel (read): the version's text in pages of paragraphs as
// structuredContent (the page asks for the next page itself, through the
// host's tools/call), and a short text for a host that draws no app.
// Node 20.

import { z } from "zod";
import { DOCUMENT_UI } from "../apps.js";

export const OPEN_TOOL = "open_document_panel";
export const DOCUMENT_KIND = "akla.document";
/** Characters of the document's text in one page of the panel's data (well under Claude's ~150,000). */
export const DOCUMENT_PAGE_CHARS = 60_000;
/** One paragraph's text at most; a longer block is split at this size. */
const MAX_PARAGRAPH_CHARS = 8_000;

/** The text as numbered paragraphs: blocks split on line breaks, empty ones dropped, an over-long one split. */
export function paragraphsOf(text) {
  const out = [];
  for (const raw of String(text ?? "").replace(/\r\n?/g, "\n").split(/\n+/)) {
    const t = raw.replace(/\s+/g, " ").trim();
    if (!t) continue;
    for (let at = 0; at < t.length; at += MAX_PARAGRAPH_CHARS) out.push(t.slice(at, at + MAX_PARAGRAPH_CHARS));
  }
  return out.map((t, i) => ({ n: i + 1, text: t }));
}

/** The paragraphs from `from` (1-based) that fit in one page: { paragraphs, next } (next null at the end). */
export function pageOf(paragraphs, from = 1, budget = DOCUMENT_PAGE_CHARS) {
  const start = Math.max(1, Math.floor(Number(from) || 1));
  const page = [];
  let used = 0;
  for (let i = start - 1; i < paragraphs.length; i++) {
    const p = paragraphs[i];
    if (page.length && used + p.text.length > budget) return { paragraphs: page, next: p.n };
    page.push(p);
    used += p.text.length + 1;
  }
  return { paragraphs: page, next: null };
}

/** The panel's data for a version: its first page of paragraphs and where the next starts. */
export function documentPanelContent({ versionId, versionNumber, title, fileName, projectName, hubUrl, text, source, from = 1 }) {
  const all = paragraphsOf(text);
  const page = pageOf(all, from);
  return {
    kind: DOCUMENT_KIND,
    versionId,
    versionNumber,
    title: title ?? null,
    fileName: fileName ?? null,
    projectName: projectName ?? null,
    hubUrl,
    source,
    total: all.length,
    from: page.paragraphs[0]?.n ?? from,
    next: page.next,
    paragraphs: page.paragraphs,
  };
}

export function createDocumentPanelTools(deps) {
  const { helpers } = deps;
  const { needVersion, versionName, textOf, open, link } = helpers;
  return [
    {
      name: OPEN_TOOL,
      title: "Open a document in a panel to quote from",
      description: `Open a project document version in an interactive panel under the reply (where Claude shows one): the document's text, which the lawyer can read full screen, select a passage in, and send to the chat as a quoted passage with its versionId, the same as highlighting it in the Hub beside the chat. Use it when the lawyer asks to open, show or look through a document to pick a clause. The panel sits under your reply, with Full screen (and Keep in view, where Claude offers it); it cannot sit beside the chat. When the lawyer wants the document beside the chat, give its "Open in Hub:" address written out on its own line: in the Claude desktop app a click opens it in the side pane next to the chat, and in Chrome with the firm's AKLA Hub companion it opens in the drawer beside the chat. It returns no document text to you: read_document reads the text, and show_document_paragraphs opens a Word version for a mark-up. Nothing is changed.`,
      inputSchema: {
        versionId: z.string().describe("The version's id, from list_project_documents or find_document_by_title."),
        from: z.number().int().min(1).optional().describe("Used by the panel to fetch the next page: the paragraph to start from."),
      },
      ui: DOCUMENT_UI,
      async run(input) {
        const v = await needVersion(input, "id, version_number, file_name, storage_path, is_ai_generated, created_at, indexing_status");
        const { text, source } = await textOf(v);
        const from = Number.isInteger(input.from) && input.from > 0 ? input.from : 1;
        const structuredContent = documentPanelContent({
          versionId: v.id, versionNumber: v.version_number, title: v.matter_document?.title, fileName: v.file_name,
          projectName: v.matter_document?.matter?.name, hubUrl: link("version", v.id), text, source, from,
        });
        const name = versionName(v);
        const lines = [
          `Opened ${name} on ${v.matter_document.matter.name} in the document panel (${structuredContent.total.toLocaleString("en")} paragraphs, ${source}). Where Claude shows the panel, the lawyer can select a passage there and send it to the chat; it arrives as a quoted passage with this versionId.`,
          `versionId: ${v.id}`,
          open("version", v.id),
          "Where no panel shows, read_document reads the text and the lawyer can highlight a passage in the Hub.",
          "The panel sits under the reply and cannot be moved beside the chat; for that, give the lawyer the Open in Hub address above, written out: a click opens it in the Claude desktop app's side pane, or in the AKLA Hub companion's drawer in Chrome.",
        ];
        return { text: lines.join("\n"), structuredContent };
      },
    },
  ];
}

/** Registered only when the trial is on (deps.apps, from CONNECTOR_APPS). */
export default (deps) => (deps.apps === true ? createDocumentPanelTools(deps) : []);
