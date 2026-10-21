// Inside the companion's drawer the Hub is a frame in the claude.ai tab, and a
// frame's history entries join the tab's own: every page opened in the drawer
// would be one more press of claude.ai's Back before the chat moved. So while
// the companion frames the page, a navigation replaces the current entry
// instead of adding one. The companion keeps its own Back trail from the
// hub:location messages the layout posts on every navigation.
//
// The router numbers its entries (history.state.idx) and works out a Back
// from them; written as 0 every time, a page's own Back sees nothing behind
// it and goes to its fallback (AiDocumentPage goes to the project page).

type HistoryLike = Pick<History, "pushState" | "replaceState">;

/** Makes `history.pushState` replace the current entry, with the router's index held at 0. */
export function pushAsReplace(history: HistoryLike): void {
  const replace = history.replaceState.bind(history);
  history.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
    const state = data && typeof data === "object" && "idx" in data ? { ...(data as object), idx: 0 } : data;
    replace(state, unused, url);
  };
}
