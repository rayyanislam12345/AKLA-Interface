import { useEffect, useState } from "react";

/** True while the window matches the query; false before the first measurement. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => (typeof window !== "undefined" ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    mql.addEventListener("change", onChange);
    setMatches(mql.matches);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** The document panel splits the screen from 1024px up; below that it overlays the chat. */
export const useSplitLayout = () => useMediaQuery("(min-width: 1024px)");
