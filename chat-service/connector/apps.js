// MCP Apps in the connector: interactive UI inside Claude's replies (the
// "io.modelcontextprotocol/ui" extension, SEP-1865, spec 2026-01-26). A
// trial, behind CONNECTOR_APPS=on (default off): with the switch off the
// connector lists, declares and answers exactly what it did before.
//
// Two apps: the changes panel (ui://akla/changes, changesPanelHtml.js), a
// version's tracked changes with Accept / Reject per change, Accept all /
// Reject all and Open in Hub, drawn under the reply of list_changes,
// apply_tracked_changes and decide_changes; and the document panel
// (ui://akla/document, documentPanelHtml.js), a version's text to read full
// screen and quote from into the chat, under open_document_panel
// (connector/tools/documentPanel.js says why it draws the text itself
// instead of framing the Hub). What the spec asks of a server, and what
// this module does for it:
//
// - the UI is a resource with a ui:// URI and the mimeType
//   "text/html;profile=mcp-app", served by resources/list and resources/read
//   (the read's content item carries _meta.ui: prefersBorder, and csp when
//   the page loads anything from outside, which this one does not: every
//   style and script is inline, so the host's default CSP stands);
// - a tool points at it with _meta.ui.resourceUri; the flat
//   _meta["ui/resourceUri"] is written too, as the MCP Apps SDK's
//   registerAppTool does, for hosts that still read the old key;
// - the tool's result carries structuredContent, which the host hands the
//   app (ui/notifications/tool-result), and the full text result as before,
//   so a host that draws no app loses nothing;
// - the server names the extension in its initialize capabilities. The
//   2026-01-26 spec asks only the client to declare it, but one report
//   (anthropics/claude-ai-mcp#165, 18 Sep 2026) had a custom connector's app
//   render only once the server declared it too; it costs nothing.
//
// The tools are not gated on the client's own declaration: the server is
// stateless (one McpServer per request), so a tools/list never sees the
// initialize, and reports say claude.ai renders apps without always sending
// the extension (anthropics/claude-ai-mcp#61). Node 20.

import { changesPanelHtml } from "./changesPanelHtml.js";
import { documentPanelHtml } from "./documentPanelHtml.js";

export const APPS_EXTENSION = "io.modelcontextprotocol/ui";
export const APP_MIME_TYPE = "text/html;profile=mcp-app";
/** The changes panel's resource. */
export const CHANGES_UI = "ui://akla/changes";
/** The document panel's resource. */
export const DOCUMENT_UI = "ui://akla/document";
/** The tools only the trial adds (connector/tools/changesPanel.js, documentPanel.js), in registration order; decide_changes writes. */
export const APP_TOOL_NAMES = Object.freeze(["list_changes", "decide_changes", "open_document_panel"]);
export const APP_WRITE_TOOL_NAMES = Object.freeze(["decide_changes"]);
/**
 * How long a host may keep the page (resources/read). Protocol 2026-07-28
 * makes ttlMs and cacheScope required on cacheable results, and one client
 * rejected a read without them (simonives/redwrench#83, Sep 2026). This SDK
 * negotiates 2025-11-25 at most, where they are optional; they are sent
 * anyway. The page is the same for every caller and holds no data, so it
 * may be shared; five minutes keeps a deploy's new page from waiting long.
 */
export const CHANGES_UI_TTL_MS = 5 * 60 * 1000;

/** Whether the trial is on: CONNECTOR_APPS=on (or 1, true, yes). */
export const appsOn = (env = process.env) => /^(on|1|true|yes)$/i.test(String(env?.CONNECTOR_APPS ?? "").trim());

/** The capability the server declares when the trial is on (initialize result). */
export const appsCapability = () => ({ extensions: { [APPS_EXTENSION]: { mimeTypes: [APP_MIME_TYPE] } } });

/** A tool's _meta pointing at a UI resource: the spec's nested key and the SDK's flat one. */
export const toolUiMeta = (resourceUri) => ({ ui: { resourceUri }, "ui/resourceUri": resourceUri });

/** A resource's _meta.ui: a bordered card on every surface (Claude draws web borderless when unset). No csp: nothing is loaded from outside. */
export const CHANGES_UI_META = Object.freeze({ ui: Object.freeze({ prefersBorder: true }) });

/**
 * Serves the UI resources on one request's McpServer: resources/list lists
 * both panels and resources/read returns each page. The McpServer declares the
 * resources capability itself when a resource is registered.
 */
export function registerAppResources(server) {
  server.registerResource("AKLA changes panel", CHANGES_UI, {
    title: "AKLA changes panel",
    description: "A version's tracked changes with Accept and Reject, drawn under list_changes, apply_tracked_changes and decide_changes.",
    mimeType: APP_MIME_TYPE,
    _meta: CHANGES_UI_META,
  }, async () => ({
    contents: [{ uri: CHANGES_UI, mimeType: APP_MIME_TYPE, text: changesPanelHtml, _meta: CHANGES_UI_META }],
    ttlMs: CHANGES_UI_TTL_MS,
    cacheScope: "public",
  }));
  server.registerResource("AKLA document panel", DOCUMENT_UI, {
    title: "AKLA document panel",
    description: "A document version's text to read and quote from into the chat, drawn under open_document_panel.",
    mimeType: APP_MIME_TYPE,
    _meta: CHANGES_UI_META,
  }, async () => ({
    contents: [{ uri: DOCUMENT_UI, mimeType: APP_MIME_TYPE, text: documentPanelHtml, _meta: CHANGES_UI_META }],
    ttlMs: CHANGES_UI_TTL_MS,
    cacheScope: "public",
  }));
}
