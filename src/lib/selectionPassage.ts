// A passage the lawyer highlighted in a document, tidied for the claude.ai
// chat. In the companion's drawer the Hub posts it to the companion
// (hub-companion/), which tidies it again with its own passage.js and quotes
// it in the message box; on the pane page (?host=pane) the Hub puts the very
// same message on the clipboard itself. selectionMessage is passage.js's,
// line for line, so both ways give the chat identical text
// (tests/selectionPassage.test.js runs the two side by side).

export const PASSAGE_LIMIT = 4000;

export interface Passage {
  text: string;
  /** Cut at PASSAGE_LIMIT characters, with "…" at the end. */
  truncated: boolean;
}

/** The selected text as shown: plain line ends, no spaces at line ends, one blank line at most, trimmed, capped with "…". */
export function tidyPassage(raw: string): Passage {
  const s = String(raw ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (s.length <= PASSAGE_LIMIT) return { text: s, truncated: false };
  return { text: `${s.slice(0, PASSAGE_LIMIT).replace(/\s+$/, "")}…`, truncated: true };
}

/** The Hub's hub:selection message: the passage and the version it is from. */
export interface SelectionPayload {
  text: string;
  truncated: boolean;
  title: string;
  versionId: string;
  versionNumber: number;
  fileName: string | null;
  projectName: string | null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

/**
 * The text for the chat's message box, or null when there is no passage or
 * no version to name:
 *
 *   In "<title>" v<n> (<file name>), project <name> — versionId: <id>
 *   > first line of the passage
 *   > second line
 *   <blank line, where the lawyer writes what to do with it>
 */
export function selectionMessage(d: Partial<SelectionPayload> | null | undefined): string | null {
  if (!d || typeof d !== "object") return null;
  const versionId = str(d.versionId).trim();
  const passage = tidyPassage(str(d.text));
  if (!versionId || !passage.text) return null;
  const title = str(d.title).trim() || "Untitled document";
  const n = Number(d.versionNumber);
  let head = `In "${title}"${Number.isFinite(n) && n > 0 ? ` v${n}` : ""}`;
  const fileName = str(d.fileName).trim();
  if (fileName) head += ` (${fileName})`;
  const projectName = str(d.projectName).trim();
  if (projectName) head += `, project ${projectName}`;
  head += ` — versionId: ${versionId}`;
  const quoted = passage.text.split("\n").map((line) => (line ? `> ${line}` : ">"));
  const lines = [head, ...quoted];
  if (passage.truncated || d.truncated === true) lines.push(`(Only the first ${PASSAGE_LIMIT.toLocaleString("en-US")} characters of the passage are quoted.)`);
  return `${lines.join("\n")}\n\n`;
}
