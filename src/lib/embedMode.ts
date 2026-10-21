import { useLocation, type Location } from "react-router-dom";

// The Hub inside the companion's side panel (hub-companion/, a Chrome
// extension that shows the Hub beside a claude.ai chat). The panel opens a
// page with ?embed=1; from then on the workspace hides its sidebar and shows
// a one-line header instead, and links out to the site's own pages open in
// a new tab. The choice is kept in sessionStorage so links inside the app
// keep the mode without carrying the parameter; ?embed=0 switches it off
// (the "Open in the Hub" link uses it, so the new tab is the ordinary Hub).
// Being inside a frame (window.self !== window.top) is only a hint: it
// never switches the mode on, but it does send site links to a new tab.

const KEY = "hub-embed";
export const EMBED_PARAM = "embed";

// ?host=companion: the companion frames this page and draws its own bar (the
// page's name, Back, Open in the Hub), so the workspace drops its one-line
// header and tells the companion where it is instead. Kept like the embed
// flag, for the life of the tab. The companion's extension id is fixed by
// the key in hub-companion/manifest.json, so its origin can be named here
// and nothing is posted to any other framer.
//
// ?host=pane: the pane page. The Claude desktop app shows a link Claude
// prints in its own browser pane beside the chat, and the connector's "Open
// in Hub" links carry ?embed=1&host=pane for that. Nothing frames the page
// and nothing draws a bar for it, so the workspace draws its own slim bar
// (Back, the page's name, Copy for Claude, Full Hub). Like the companion,
// Claude is the chat there: no Hub chat buttons, a read-only project view,
// and a highlighted passage is copied for the chat. Nothing is posted to a
// parent and the browser's history is left alone (those are the frame's).
const HOST_KEY = "hub-embed-host";
export const HOST_PARAM = "host";
export type EmbedHost = "companion" | "pane";
// The unpacked install's id (fixed by hub-companion/manifest.json's key) and,
// once it is listed, the Chrome Web Store's id for the same extension. Add the
// store's id here AND to frame-ancestors in vercel.json (docs/companion-web-store.md).
export const COMPANION_ORIGINS: readonly string[] = [
  "chrome-extension://djjhabnppnfpboomokbikdjdoimgogdp",
];
/** True when a message or a framer is the companion (any of its ids). */
export function isCompanionOrigin(origin: string): boolean {
  return COMPANION_ORIGINS.includes(origin);
}

function readStored(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function store(on: boolean) {
  try {
    if (on) sessionStorage.setItem(KEY, "1");
    else sessionStorage.removeItem(KEY);
  } catch {
    /* a private window, or storage blocked: the mode lasts while the page does */
  }
}

/** Whether embed mode is on for this page, given the address's query string. Writes the choice when the address makes one. */
export function resolveEmbedMode(search: string = typeof window !== "undefined" ? window.location.search : ""): boolean {
  const value = new URLSearchParams(search).get(EMBED_PARAM);
  if (value === "1") {
    store(true);
    return true;
  }
  if (value === "0") {
    store(false);
    return false;
  }
  return readStored();
}

/** True inside a frame (the companion's panel, or any other). A hint only. */
export function isFramed(): boolean {
  try {
    return typeof window !== "undefined" && window.self !== window.top;
  } catch {
    // A cross-origin parent throws on some browsers; that is still a frame.
    return true;
  }
}

/** The same address with embed mode switched off: for a link that opens the ordinary Hub in a new tab. */
export function withoutEmbed(to: string | Location): string {
  const url = typeof to === "string" ? new URL(to, "http://x") : new URL(`${to.pathname}${to.search}${to.hash}`, "http://x");
  url.searchParams.delete(EMBED_PARAM);
  url.searchParams.delete(HOST_PARAM);
  url.searchParams.set(EMBED_PARAM, "0");
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The same address with embed mode switched on (and the pane's host, when given): for a sign-in redirect that must come back embedded. */
export function withEmbed(to: string, host?: "pane"): string {
  const url = new URL(to, "http://x");
  url.searchParams.set(EMBED_PARAM, "1");
  if (host) url.searchParams.set(HOST_PARAM, host);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Embed mode for the page on screen; follows the address, so ?embed=0 in a link switches it off. */
export function useEmbedMode(): boolean {
  const { search } = useLocation();
  return resolveEmbedMode(search);
}

/** True when the companion frames the page (embed mode with host=companion): its chat is claude.ai's. */
export function useCompanionHost(): boolean {
  return useEmbedHost() === "companion";
}

/** True on the pane page (embed mode with host=pane): the Hub in the Claude desktop app's browser pane, or any tab a pane link opened in. */
export function usePaneHost(): boolean {
  return useEmbedHost() === "pane";
}

/**
 * True when Claude is the chat here: the companion's drawer or the pane page.
 * Either way the Hub offers no chat of its own (no "Ask about this", no "Edit
 * with AI", a read-only project view) and "Copy for Claude" hands things to
 * the claude.ai chat instead.
 */
export function useClaudeIsTheChat(): boolean {
  return useEmbedHost() !== null;
}

/** Who shows this embedded page, for the page on screen: the companion, the pane, or nobody (null; also whenever embed mode is off). */
export function useEmbedHost(): EmbedHost | null {
  const { search } = useLocation();
  return embedHostFor(resolveEmbedMode(search), resolveEmbedHost(search));
}

/** The host that counts: none unless embed mode is on. */
export function embedHostFor(embed: boolean, host: EmbedHost | null): EmbedHost | null {
  return embed ? host : null;
}

/** Opens one of the site's pages: in the ordinary Hub when embedded or framed (a new tab), else here. */
export function openSitePage(navigate: (to: string) => void, to: string) {
  if (resolveEmbedMode() || isFramed()) window.open(withoutEmbed(to), "_blank", "noopener");
  else navigate(to);
}

/** Whether the companion frames this page and draws the bar itself (?host=companion), kept for the tab. */
export function resolveCompanionHost(search: string = typeof window !== "undefined" ? window.location.search : ""): boolean {
  return resolveEmbedHost(search) === "companion";
}

/** Whether this is the pane page (?host=pane), kept for the tab. */
export function resolvePaneHost(search: string = typeof window !== "undefined" ? window.location.search : ""): boolean {
  return resolveEmbedHost(search) === "pane";
}

/**
 * Who shows the page, from ?host= or the tab's earlier choice: "companion",
 * "pane", or null. Any other ?host= value clears the choice. Kept like the
 * embed flag, for the life of the tab; it counts only while embed mode is on.
 */
export function resolveEmbedHost(search: string = typeof window !== "undefined" ? window.location.search : ""): EmbedHost | null {
  const value = new URLSearchParams(search).get(HOST_PARAM);
  const named = isEmbedHost(value) ? value : null;
  try {
    // The companion's flag has always been stored as "1"; kept so.
    if (named) sessionStorage.setItem(HOST_KEY, named === "companion" ? "1" : named);
    else if (value !== null) sessionStorage.removeItem(HOST_KEY);
    const stored = sessionStorage.getItem(HOST_KEY);
    return stored === "1" ? "companion" : stored === "pane" ? "pane" : named;
  } catch {
    return named;
  }
}

function isEmbedHost(value: unknown): value is EmbedHost {
  return value === "companion" || value === "pane";
}

/** The page's address for the companion: this origin and path, without the frame's own parameters. */
export function companionHref(loc: Pick<Location, "pathname" | "search" | "hash">): string {
  const params = new URLSearchParams(loc.search);
  for (const k of [EMBED_PARAM, HOST_PARAM, "aiTheme"]) params.delete(k);
  const search = params.toString();
  return `${window.location.origin}${loc.pathname}${search ? `?${search}` : ""}${loc.hash}`;
}

/** Tells the companion (and only the companion) where the page is and what it is called. */
export function postToCompanion(message: Record<string, unknown>) {
  try {
    // The browser drops a message whose target origin is not the parent's,
    // so posting to each of the companion's ids reaches only the real one.
    if (window.parent && window.parent !== window) for (const origin of COMPANION_ORIGINS) window.parent.postMessage(message, origin);
  } catch {
    /* no parent to tell */
  }
}

// Note the companion flag as soon as the app loads: a page that sends the
// person to sign in first (ProtectedRoute) never reaches the layout that
// would otherwise read it, and the sign-in page still owes the bar its name.
// The pane's flag is noted the same way.
if (typeof window !== "undefined") resolveEmbedHost();
