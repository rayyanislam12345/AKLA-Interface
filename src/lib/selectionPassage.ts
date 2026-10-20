// A passage the lawyer highlighted in a document, tidied for the companion
// (hub-companion/), which quotes it in the claude.ai message box. The
// companion's passage.js tidies it the same way again, so the two agree.

export const PASSAGE_LIMIT = 4000;

export interface Passage {
  text: string;
  /** Cut at PASSAGE_LIMIT characters, with "…" at the end. */
  truncated: boolean;
}

/** The selected text as shown: plain line ends, no spaces at line ends, one blank line at most, trimmed, capped with "…". */
export function tidyPassage(raw: string): Passage {
  const s = raw
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (s.length <= PASSAGE_LIMIT) return { text: s, truncated: false };
  return { text: `${s.slice(0, PASSAGE_LIMIT).replace(/\s+$/, "")}…`, truncated: true };
}
