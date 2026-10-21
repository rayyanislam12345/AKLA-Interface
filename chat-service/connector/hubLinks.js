// Links back into the Hub, so a result in claude.ai can be opened where it
// lives: a project at /ai/p/<matterId>, a document version at
// /ai/d/<versionId> (src/App.tsx, the /ai routes) and the precedent library
// at /precedent-library. The site's address is CONNECTOR_HUB_URL
// (connector.js); the default is the production deploy the smoke scripts
// use (scripts/ask.mjs SITE). A plain address in a tool's text is the only
// way a link reaches the lawyer: claude.ai shows no link affordance for
// connector results, so each one is written out on its own line.
//
// A project or version link carries ?embed=1&host=pane: the Claude desktop
// app opens a link Claude prints in its own browser pane beside the chat,
// and those two flags make the Hub there a page made for the pane (no
// sidebar, a slim bar with Copy for Claude and Full Hub, the document scaled
// to fit; src/lib/embedMode.ts). Clicked anywhere else (a browser tab, a
// phone) the page reads the same way. The companion extension strips both
// flags when it opens a Hub link in its drawer (hub-companion/links.js
// FRAME_PARAMS), so it is unaffected. The precedent library is a page of the
// site, not of the workspace, so its link stays plain.

export const DEFAULT_HUB_URL = "https://akla-interface.vercel.app";

/** The pane page's flags, on every project and version link. */
export const PANE_QUERY = "?embed=1&host=pane";

const PATHS = {
  project: (id) => `/ai/p/${id}${PANE_QUERY}`,
  version: (id) => `/ai/d/${id}${PANE_QUERY}`,
  precedents: () => "/precedent-library",
};

/** The site's address without a trailing slash; the default when unset. */
export function hubBase(hubUrl) {
  const s = String(hubUrl ?? "").trim().replace(/\/+$/, "");
  return s || DEFAULT_HUB_URL;
}

/**
 * The Hub page for one thing: `hubLink("project", matterId)`,
 * `hubLink("version", versionId)` or `hubLink("precedents")`, on `hubUrl`
 * (the default site when omitted). An unknown kind, or a missing id for a
 * kind that needs one, throws: a wrong link is worse than none.
 */
export function hubLink(kind, id, hubUrl) {
  const path = PATHS[kind];
  if (!path) throw new Error(`Unknown Hub link kind: ${kind}`);
  if (kind !== "precedents" && !id) throw new Error(`A ${kind} link needs an id.`);
  return `${hubBase(hubUrl)}${path(id)}`;
}

/** The line a result carries: "Open in Hub: https://…". */
export function openInHub(kind, id, hubUrl) {
  return `Open in Hub: ${hubLink(kind, id, hubUrl)}`;
}
