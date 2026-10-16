// The rules behind saving a working Word document to its project, kept free
// of the browser and the database so they can be tested on their own
// (tests/documentSave.test.js). src/lib/documentSave.ts does the saving.

export interface ChangeCounts {
  waiting: number;
  accepted: number;
  rejected: number;
  couldNotPlace: number;
  needsWord: number;
  replaced: number;
  total: number;
  othersRevisions: number;
  unlisted?: number;
}

export interface EditSource {
  matterDocumentId?: string | null;
  documentVersionId?: string | null;
  versionNumber?: number | null;
  title?: string | null;
  standard?: boolean;
}

// The keys of a docx artifact's `data` this code reads. The server owns all
// of them except the saved-version keys and the document type, which are
// the only ones the client ever writes back (see patchArtifactKeys).
export interface WorkingDocData {
  workingDocumentId?: string | null;
  producedBy?: "turn" | "decision" | "open" | null;
  bucket?: string | null;
  storagePath?: string | null;
  fileName?: string | null;
  editSource?: EditSource | null;
  changeCounts?: Partial<ChangeCounts> | null;
  documentTypeId?: string | null;
  standard?: boolean;
  original?: boolean;
  truncated?: boolean;
  savedMatterDocumentId?: string | null;
  savedVersionId?: string | null;
  savedVersion?: number | null;
  // Which file was saved: the head's storage path at the moment of saving.
  // The server copies the other saved keys onto every later copy, but not
  // this one, so a copy whose path differs has changes not yet saved.
  savedStoragePath?: string | null;
  savedAt?: string | null;
}

/** The keys the client may write into an artifact's data. Nothing else is ever patched. */
export const CLIENT_KEYS = ["documentTypeId", "savedMatterDocumentId", "savedVersionId", "savedVersion", "savedStoragePath", "savedAt", "publishedAsStandardAt"] as const;
export type ClientKey = (typeof CLIENT_KEYS)[number];

export function pickClientKeys(patch: Record<string, unknown>): Partial<Record<ClientKey, unknown>> {
  const out: Partial<Record<ClientKey, unknown>> = {};
  for (const key of CLIENT_KEYS) if (key in patch) out[key] = patch[key];
  return out;
}

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

export function formatSaveDate(date: Date): string {
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
}

/** The label a saved version carries: the lawyer's own, or "AI draft from chat — 16 October 2026". */
export function versionLabelFor(label: string | null | undefined, date: Date = new Date()): string {
  const own = (label ?? "").trim();
  return own ? own.slice(0, 200) : `AI draft from chat — ${formatSaveDate(date)}`;
}

/** The project document a "next version" save adds to: the one it was last saved to, else the one it was opened from. */
export function saveTargetFor(data: WorkingDocData | null | undefined): string | null {
  if (!data) return null;
  if (data.savedMatterDocumentId) return data.savedMatterDocumentId;
  const src = data.editSource;
  if (src && !src.standard && src.matterDocumentId) return src.matterDocumentId;
  return null;
}

/**
 * The version a save expects to be the latest, so the database can refuse a
 * save that would bury a colleague's newer version. It is the version this
 * chat last saved (on the head, or on any copy of the same document), else
 * the version the document was opened from. When the project's latest
 * version is itself one this chat saved or opened, that is the base.
 */
export function chooseExpectedVersionId({
  head,
  lineage = [],
  latestVersionId = null,
}: {
  head: WorkingDocData | null | undefined;
  lineage?: Array<WorkingDocData | null | undefined>;
  latestVersionId?: string | null;
}): string | null {
  const ours = new Set<string>();
  const saved: Array<{ id: string; n: number }> = [];
  for (const d of [head, ...lineage]) {
    if (d?.savedVersionId) {
      ours.add(d.savedVersionId);
      saved.push({ id: d.savedVersionId, n: d.savedVersion ?? 0 });
    }
    if (d?.editSource?.documentVersionId && !d.editSource.standard) ours.add(d.editSource.documentVersionId);
  }
  if (latestVersionId && ours.has(latestVersionId)) return latestVersionId;
  if (head?.savedVersionId) return head.savedVersionId;
  saved.sort((a, b) => b.n - a.n);
  if (saved.length) return saved[0].id;
  return head?.editSource?.standard ? null : head?.editSource?.documentVersionId ?? null;
}

export type SaveState = "saved" | "changed-since-save" | "unsaved" | "unchanged";

/**
 * Where the head stands against the project:
 * - saved: this very file is a saved version;
 * - changed-since-save: an earlier copy was saved, this one has more changes;
 * - unchanged: the opening copy of a project version, nothing to save;
 * - unsaved: never saved.
 */
export function saveStateOf(data: WorkingDocData | null | undefined): SaveState {
  if (!data) return "unsaved";
  if (data.savedStoragePath && data.savedStoragePath === data.storagePath) return "saved";
  if (data.producedBy === "open" && data.bucket === "matter-documents") return "unchanged";
  if (data.savedVersion != null || data.savedVersionId) {
    // A copy from before saves recorded their file was saved itself.
    if (!data.savedStoragePath && !data.producedBy) return "saved";
    return "changed-since-save";
  }
  return "unsaved";
}

export function waitingOf(counts: Partial<ChangeCounts> | null | undefined): number {
  return Math.max(0, Number(counts?.waiting ?? 0) || 0);
}

/** The save button: "Save as v5 · 3 changes waiting", "Save to project as a new document". */
export function saveButtonLabel({ mode, nextVersion, waiting = 0, truncated = false }: { mode: "next-version" | "new-document"; nextVersion?: number | null; waiting?: number; truncated?: boolean }): string {
  const base = truncated
    ? mode === "new-document" ? "Save incomplete draft as a new document" : nextVersion ? `Save incomplete draft as v${nextVersion}` : "Save incomplete draft"
    : mode === "new-document"
      ? "Save to project as a new document"
      : nextVersion
        ? `Save as v${nextVersion}`
        : "Save new version";
  return waiting > 0 ? `${base} · ${waiting} ${plural(waiting, "change")} waiting` : base;
}

/** What a finished save says: "Saved as v5 · 3 changes still waiting as tracked changes". */
export function savedMessage({ versionNumber, waiting = 0, newDocument = false }: { versionNumber: number; waiting?: number; newDocument?: boolean }): string {
  const head = newDocument ? `Saved to the project as a new document (v${versionNumber})` : `Saved as v${versionNumber}`;
  return waiting > 0 ? `${head} · ${waiting} ${plural(waiting, "change")} still waiting as tracked changes` : head;
}

/**
 * Whether a new copy from an AI turn is saved to the project without being
 * asked: only in a project chat, only a copy an AI turn wrote, only when it
 * came from a project document (so there is a document to add a version
 * to), and never a standard or an unfinished draft.
 */
export function autoSaveEligible(data: WorkingDocData | null | undefined, { inProject }: { inProject: boolean }): boolean {
  if (!inProject || !data) return false;
  if (data.producedBy !== "turn") return false;
  if (data.standard || data.truncated || data.editSource?.standard) return false;
  return !!saveTargetFor(data);
}

/** The panel header's account of where the document stands, as short phrases. */
export function headerFacts({
  data,
  projectName,
  inProject,
  waiting,
}: {
  data: WorkingDocData | null | undefined;
  projectName?: string | null;
  inProject: boolean;
  waiting: number;
}): string[] {
  const facts: string[] = [];
  facts.push(projectName ? projectName : inProject ? "this project" : "not in a project");
  const src = data?.editSource;
  if (src?.standard) facts.push("from the firm's standard");
  else if (src) facts.push(src.versionNumber ? `opened from v${src.versionNumber} of ${src.title ?? "the document"}` : `opened from ${src.title ?? "a project document"}`);
  else if (data?.original) facts.push("uploaded in the chat");
  const state = saveStateOf(data);
  if (state === "saved") facts.push(`saved as v${data?.savedVersion}`);
  else if (state === "changed-since-save") facts.push(`unsaved changes since v${data?.savedVersion}`);
  else if (state === "unchanged") facts.push("no changes yet");
  else facts.push(inProject ? "not saved to the project yet" : "not saved yet");
  if (waiting > 0) facts.push(`${waiting} waiting`);
  return facts;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err && "message" in err) return String((err as { message: unknown }).message);
  return String(err ?? "");
}

/**
 * A failed save as a sentence a lawyer can act on. Used by every save to a
 * project (chat, review, meeting notes and uploads), so they all say the
 * same thing. None of these sentences contains the phrases the upload panel
 * looks for, so it passes them on as they are.
 */
export function plainSaveError(err: unknown): string {
  const message = messageOf(err);
  const m = message.toLowerCase();
  if (m.includes("failed to fetch") || m.includes("networkerror") || m.includes("network request") || m.includes("load failed")) {
    return "The file couldn't be sent. Check your connection and try again.";
  }
  if (m.includes("maximum allowed size") || m.includes("payload too large") || m.includes("entity too large")) return "This file is too large to save to the project.";
  if (m.includes("newer document version")) {
    return "Someone saved a newer version of this document a moment ago, so nothing was saved over it. Open the latest version and try again, or save this as a new document.";
  }
  if (m.includes("does not belong to this project and type")) return "This document's type was changed in the project a moment ago. Save again and it will use the new type.";
  if (m.includes("project is unavailable")) return "That project is no longer available, so nothing was saved.";
  if (m.includes("the uploaded file is unavailable")) return "The file didn't finish uploading. Try again.";
  if (m.includes("invalid file name")) return "This file's name can't be used. Rename it and try again.";
  if (m.includes("jwt") || m.includes("not authenticated") || m.includes("forbidden") || m.includes("not signed in")) return "Your sign-in has expired. Sign in again, then save again.";
  if (m.includes("row-level security")) return "You don't have permission to save to this project.";
  return message || "Something went wrong while saving. Try again.";
}
