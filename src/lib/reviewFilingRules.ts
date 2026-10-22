// Where a finished review went, as the review panel says it.
//
// A review of a project's Word version is filed into the Hub on its own
// (chat-service/reviewFiling.js): its findings become AKLA AI tracked
// changes in the document's next version, and the lawyer decides them in
// that version's Changes list. The run records what happened in
// coverage.filing; the panel reads it from there. Pure, so the rules can be
// tested without a browser (tests/reviewFiling.test.js).

export type ReviewFilingStatus =
  | "filed"
  | "newer_version"
  | "none_placed"
  | "format_refused"
  | "nothing_found"
  | "not_word"
  | "failed";

export interface ReviewFiling {
  status: ReviewFilingStatus | string;
  at?: string;
  reviewedVersionId?: string;
  reviewedVersionNumber?: number;
  versionId?: string;
  versionNumber?: number;
  fileName?: string | null;
  label?: string | null;
  placed?: number;
  waiting?: number;
  notPlaced?: Array<{ suggestionId: string; reason: string }>;
  latestVersionId?: string | null;
  latestVersionNumber?: number | null;
  note?: string | null;
  formatNote?: string | null;
  rowsError?: string | null;
}

/** The filing record a run carries, or null (not filed yet, or a review from before filing). */
export function filingOf(coverage: unknown): ReviewFiling | null {
  if (!coverage || typeof coverage !== "object") return null;
  const f = (coverage as { filing?: unknown }).filing;
  if (!f || typeof f !== "object" || typeof (f as { status?: unknown }).status !== "string") return null;
  return f as ReviewFiling;
}

/**
 * How the panel shows a review:
 * - "filed": the filed version and its Changes list, where every placed
 *   finding is decided; the findings that could not be placed are listed
 *   for reading only;
 * - "read-only": nothing was filed because the document moved on while the
 *   review ran; the findings are listed for reading, never decided here;
 * - "interactive": the review's own list with Accept and Reject, as before
 *   filing existed: a review from before then, a PDF (never filed), or one
 *   whose filing failed or placed nothing, so the list is the only place
 *   its findings are.
 */
export function reviewView(filing: ReviewFiling | null): "filed" | "read-only" | "interactive" {
  if (filing?.status === "filed" && filing.versionId) return "filed";
  if (filing?.status === "newer_version") return "read-only";
  return "interactive";
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

/** The panel's one line about the filing, or null when there is nothing to say. */
export function filingHeadline(filing: ReviewFiling | null): string | null {
  if (!filing) return null;
  switch (filing.status) {
    case "filed": {
      const waiting = filing.waiting ?? filing.placed ?? 0;
      const notPlaced = filing.notPlaced?.length ?? 0;
      return `Filed as v${filing.versionNumber}: ${waiting} ${plural(waiting, "change")} waiting in its Changes list below.${notPlaced ? ` ${notPlaced} ${plural(notPlaced, "finding")} could not be placed and ${notPlaced === 1 ? "is" : "are"} listed for reading.` : ""}`;
    }
    case "newer_version":
      return `Not filed: v${filing.latestVersionNumber ?? "?"} was saved while the review ran, and these findings quote v${filing.reviewedVersionNumber ?? "?"}'s words, so nothing was placed over it. They are listed for reading; review the newest version to have one filed.`;
    case "none_placed":
      return "Not filed: none of the findings' quoted wording could be found once in the file, so no new version was made.";
    case "format_refused":
      return filing.note ? `Not filed. ${filing.note}` : "Not filed: the format check refused the marked-up file.";
    case "failed":
      return `Not filed: ${filing.note ?? "the findings could not be filed"}.`;
    default:
      return null;
  }
}
