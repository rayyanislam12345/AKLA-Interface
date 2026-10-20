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
const HOST_KEY = "hub-embed-host";
export const HOST_PARAM = "host";
export const COMPANION_ORIGIN = "chrome-extension://djjhabnppnfpboomokbikdjdoimgogdp";

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
  url.searchParams.set(EMBED_PARAM, "0");
  return `${url.pathname}${url.search}${url.hash}`;
}

/** The same address with embed mode switched on: for a sign-in redirect that must come back embedded. */
export function withEmbed(to: string): string {
  const url = new URL(to, "http://x");
  url.searchParams.set(EMBED_PARAM, "1");
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Embed mode for the page on screen; follows the address, so ?embed=0 in a link switches it off. */
export function useEmbedMode(): boolean {
  const { search } = useLocation();
  return resolveEmbedMode(search);
}

/** Opens one of the site's pages: in the ordinary Hub when embedded or framed (a new tab), else here. */
export function openSitePage(navigate: (to: string) => void, to: string) {
  if (resolveEmbedMode() || isFramed()) window.open(withoutEmbed(to), "_blank", "noopener");
  else navigate(to);
}

/** Whether the companion frames this page and draws the bar itself (?host=companion), kept for the tab. */
export function resolveCompanionHost(search: string = typeof window !== "undefined" ? window.location.search : ""): boolean {
  const value = new URLSearchParams(search).get(HOST_PARAM);
  try {
    if (value === "companion") sessionStorage.setItem(HOST_KEY, "1");
    else if (value !== null) sessionStorage.removeItem(HOST_KEY);
    return sessionStorage.getItem(HOST_KEY) === "1" || value === "companion";
  } catch {
    return value === "companion";
  }
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
    if (window.parent && window.parent !== window) window.parent.postMessage(message, COMPANION_ORIGIN);
  } catch {
    /* no parent to tell */
  }
}

// Note the companion flag as soon as the app loads: a page that sends the
// person to sign in first (ProtectedRoute) never reaches the layout that
// would otherwise read it, and the sign-in page still owes the bar its name.
if (typeof window !== "undefined") resolveCompanionHost();
