import { useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Json, Tables } from "@/integrations/supabase/types";
import { toast } from "@/hooks/use-toast";
import { saveDraftToMatter } from "@/lib/saveDraftToMatter";
import {
  chooseExpectedVersionId,
  pickClientKeys,
  saveStateOf,
  saveTargetFor,
  savedMessage,
  versionLabelFor,
  waitingOf,
  type ChangeCounts,
  type WorkingDocData,
} from "@/lib/documentSaveRules";

// One save and one download for the chat's Word documents.
//
// A working document is the chain of copies a chat makes of one Word file;
// the newest copy (the head) is what is shown, downloaded and saved. Saving
// stores the head's own file as the next version of the project document it
// came from (or as a new document), labels the version, and records on the
// head which version it became, touching no other key of the artifact.
// Downloads come from the chat service's /documents/file, which refuses a
// clean copy while anything is left to decide and says why.
//
// The panel (DocxArtifact), the other chat panels (drafts, files) and the
// legacy review panel all save through here; so does the automatic save
// after an AI turn (scheduleAutoSave, called from useChat).

type ArtifactRow = Tables<"ai_artifacts">;
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// ------------------------------------------------------------- chat service

export function chatApiBase(): string | null {
  const base = (import.meta.env.VITE_CHAT_API_URL as string | undefined)?.replace(/\/$/, "");
  return base || null;
}

async function chatApiHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your sign-in has expired. Sign in again, then try again.");
  return {
    Authorization: `Bearer ${token}`,
    apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    "Content-Type": "application/json",
  };
}

/** An answer from the chat service other than success, carrying its sentence and body. */
export class ChatApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, message: string, body: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

const NO_SERVICE = "This needs the firm's chat service, which isn't set up on this site.";

async function postChatApi(path: string, body: unknown): Promise<Response> {
  const base = chatApiBase();
  if (!base) throw new ChatApiError(0, NO_SERVICE);
  let resp: Response;
  try {
    resp = await fetch(`${base}${path}`, { method: "POST", headers: await chatApiHeaders(), body: JSON.stringify(body) });
  } catch {
    throw new ChatApiError(0, "The chat service couldn't be reached. Check your connection and try again.");
  }
  if (!resp.ok) {
    const payload = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
    const sentence = typeof payload.error === "string" && payload.error ? payload.error : `The chat service answered with an error (${resp.status}). Try again.`;
    throw new ChatApiError(resp.status, sentence, payload);
  }
  return resp;
}

// ------------------------------------------------------------ the change list

export type ChangeState = "waiting" | "accepted" | "rejected" | "could_not_place" | "needs_word" | "replaced";

export interface ChangeCard {
  id: string;
  number: number;
  source: "edit" | "standard_fill" | "legal_clauses" | "formatting" | "content_conflicts" | "chat";
  sourceLabel: string;
  kind: "change" | "addition" | "deletion";
  where: { part: "body" | "header" | "footer" | "footnotes" | "endnotes"; paragraph: number | null; clause: string | null };
  before: string;
  after: string;
  why: string | null;
  state: ChangeState;
  stateLabel: string;
  stateNote: string | null;
  decided: { by: { id: string; name: string | null } | null; at: string } | null;
  turn: { messageId: string | null; at: string };
  replacedBy: string | null;
  canAccept: boolean;
  canReject: boolean;
}

export type { ChangeCounts };

export interface HeadSummary {
  id: string;
  bucket: string;
  storagePath: string | null;
  fileName: string | null;
  title: string;
  updatedAt: string | null;
}

export interface ChangesList {
  workingDocumentId: string;
  head: HeadSummary;
  changes: ChangeCard[];
  counts: ChangeCounts;
}

export interface Decision {
  changeId: string;
  decision: "accepted" | "rejected";
}

/** A change the service left alone, with the sentence saying why. */
export interface NotDone {
  changeId: string;
  reason: string;
  note: string;
}

export interface DecideResult {
  workingDocumentId: string;
  head: ArtifactRow;
  changes: ChangeCard[];
  counts: ChangeCounts;
  notDone: NotDone[];
}

// A stored project version marked up from claude.ai (the connector's
// apply_tracked_changes) has a Changes list of its own, named by the
// version's id: its decisions land in a decided copy kept beside the
// version's own file (public.version_change_heads), never in the file
// itself. Same cards, counts and sentences as a chat's list.

/** The file a version's changes are decided in: the decided copy, or the version's own file before any decision. */
export interface VersionHeadSummary {
  id: string;
  versionId: string;
  versionNumber: number;
  bucket: string;
  storagePath: string;
  fileName: string | null;
  title: string | null;
  updatedAt: string | null;
  decided: boolean;
}

export interface VersionChangesList {
  workingDocumentId: null;
  versionId: string;
  head: VersionHeadSummary;
  changes: ChangeCard[];
  counts: ChangeCounts;
}

export interface VersionDecideResult extends VersionChangesList {
  notDone: NotDone[];
}

/** What a call names: a chat's working document (by any of its copies) or a stored project version. */
type DocumentTarget = { artifactId: string } | { versionId: string };

export async function listChanges(artifactId: string): Promise<ChangesList> {
  const resp = await postChatApi("/changes/list", { artifactId });
  return (await resp.json()) as ChangesList;
}

/** The Changes list of a stored version. A version with no changes (or not a Word file) comes back with none. */
export async function listVersionChanges(versionId: string): Promise<VersionChangesList> {
  const resp = await postChatApi("/changes/list", { versionId });
  return (await resp.json()) as VersionChangesList;
}

const MAX_DECISIONS = 200;

/** Decides changes in batches the service accepts; the last batch's head and counts are the result. */
async function decideIn<R extends { changes: ChangeCard[]; notDone: NotDone[] }>(target: DocumentTarget, decisions: Decision[]): Promise<R> {
  let result: R | null = null;
  for (let i = 0; i < decisions.length; i += MAX_DECISIONS) {
    const resp = await postChatApi("/changes/decide", { ...target, decisions: decisions.slice(i, i + MAX_DECISIONS) });
    const part = (await resp.json()) as R;
    result = result
      ? { ...part, changes: [...result.changes, ...part.changes], notDone: [...result.notDone, ...part.notDone] }
      : part;
  }
  if (!result) throw new Error("Choose at least one change to decide.");
  return result;
}

export function decideChanges(artifactId: string, decisions: Decision[]): Promise<DecideResult> {
  return decideIn<DecideResult>({ artifactId }, decisions);
}

/** Decides changes in a stored version's working copy; the version's own file is never touched. */
export function decideVersionChanges(versionId: string, decisions: Decision[]): Promise<VersionDecideResult> {
  return decideIn<VersionDecideResult>({ versionId }, decisions);
}

// ------------------------------------------------------------------ the file

export interface DocumentFile {
  blob: Blob;
  fileName: string;
  waiting: number;
  notPlaced: number;
  otherRevisions: number;
}

/** A clean copy the service would not make yet. `message` is its sentence, verbatim. */
export class CleanCopyRefused extends Error {
  counts: Partial<ChangeCounts> | null;
  constructor(message: string, counts: Partial<ChangeCounts> | null) {
    super(message);
    this.counts = counts;
  }
  /** Only other people's tracked changes stand in the way, so a copy with them accepted can be asked for. */
  get onlyOthers(): boolean {
    const c = this.counts ?? {};
    return (c.othersRevisions ?? 0) > 0 && !(c.waiting ?? 0) && !(c.needsWord ?? 0) && !(c.unlisted ?? 0);
  }
}

function fileNameFrom(disposition: string | null, fallback: string): string {
  if (!disposition) return fallback;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(disposition);
  return plain ? plain[1].trim() : fallback;
}

/** The head file of a working document: "tracked" is the file as it is, "clean" has the AI's changes accepted. */
export function fetchDocumentFile(artifactId: string, form: "tracked" | "clean", opts: { acceptOthers?: boolean } = {}): Promise<DocumentFile> {
  return fetchFileFor({ artifactId }, form, opts);
}

/** A stored version's working file (its decided copy once a change has been decided), tracked or clean. */
export function fetchVersionFile(versionId: string, form: "tracked" | "clean", opts: { acceptOthers?: boolean } = {}): Promise<DocumentFile> {
  return fetchFileFor({ versionId }, form, opts);
}

async function fetchFileFor(target: DocumentTarget, form: "tracked" | "clean", { acceptOthers = false }: { acceptOthers?: boolean } = {}): Promise<DocumentFile> {
  let resp: Response;
  try {
    resp = await postChatApi("/documents/file", { ...target, form, ...(acceptOthers ? { acceptOthers: true } : {}) });
  } catch (err) {
    if (err instanceof ChatApiError && err.status === 409 && form === "clean") {
      throw new CleanCopyRefused(err.message, (err.body.counts as Partial<ChangeCounts> | undefined) ?? null);
    }
    throw err;
  }
  const bytes = await resp.blob();
  const header = (name: string) => Number(resp.headers.get(name) ?? 0) || 0;
  return {
    blob: new Blob([bytes], { type: DOCX_MIME }),
    fileName: fileNameFrom(resp.headers.get("Content-Disposition"), form === "clean" ? "document.docx" : "document (tracked changes).docx"),
    waiting: header("X-Changes-Waiting"),
    notPlaced: header("X-Changes-Not-Placed"),
    otherRevisions: header("X-Other-Revisions"),
  };
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Downloads the working document in either form. A refused clean copy throws CleanCopyRefused with the service's sentence. */
export async function downloadWorkingDocument(artifactId: string, form: "tracked" | "clean", opts: { acceptOthers?: boolean } = {}): Promise<DocumentFile> {
  const file = await fetchDocumentFile(artifactId, form, opts);
  downloadBlob(file.blob, file.fileName);
  return file;
}

/** Downloads a stored version's working file in either form. A refused clean copy throws CleanCopyRefused with the service's sentence. */
export async function downloadVersionFile(versionId: string, form: "tracked" | "clean", opts: { acceptOthers?: boolean } = {}): Promise<DocumentFile> {
  const file = await fetchVersionFile(versionId, form, opts);
  downloadBlob(file.blob, file.fileName);
  return file;
}

// --------------------------------------------------------------- the head

export interface ResolvedHead {
  workingDocumentId: string;
  head: ArtifactRow;
  root: ArtifactRow | null;
  lineage: ArtifactRow[];
  counts: Partial<ChangeCounts> | null;
}

export const dataOf = (artifact: Pick<ArtifactRow, "data"> | null | undefined): WorkingDocData => ((artifact?.data ?? {}) as WorkingDocData);
export const workingDocumentIdOf = (artifact: Pick<ArtifactRow, "id" | "data">): string => dataOf(artifact).workingDocumentId ?? artifact.id;

/**
 * The newest copy of the document `artifact` is a copy of, read fresh: the
 * service names the head; its row (and every copy of the same document in
 * the chat) is read from the database. Without the service, the newest copy
 * in the chat stands in.
 */
export async function resolveWorkingHead(artifact: ArtifactRow): Promise<ResolvedHead> {
  let list: ChangesList | null = null;
  if (chatApiBase()) {
    try {
      list = await listChanges(artifact.id);
    } catch (err) {
      if (err instanceof ChatApiError && err.status === 404) throw new Error("This document is no longer in the chat.");
      throw err;
    }
  }
  const { data: rows, error } = await supabase.from("ai_artifacts").select("*").eq("thread_id", artifact.thread_id).eq("kind", "docx").order("created_at", { ascending: true });
  if (error) throw new Error("The chat's documents couldn't be read. Check your connection and try again.");
  const all = rows ?? [];
  const wd = list?.workingDocumentId ?? workingDocumentIdOf(artifact);
  const lineage = all.filter((a) => workingDocumentIdOf(a) === wd);
  const head = (list ? all.find((a) => a.id === list!.head.id) : lineage.at(-1)) ?? all.find((a) => a.id === artifact.id) ?? artifact;
  return {
    workingDocumentId: wd,
    head,
    root: all.find((a) => a.id === wd) ?? null,
    lineage,
    counts: list?.counts ?? dataOf(head).changeCounts ?? null,
  };
}

// ------------------------------------------------------------ artifact keys

/**
 * Writes the client's own keys (the document type and the saved-version
 * keys) into an artifact's data, and nothing else: the row is read fresh
 * and the write only lands if no one changed it meanwhile, so the server's
 * file path and counts are never overwritten with stale ones.
 */
export async function patchArtifactKeys(id: string, patch: Record<string, unknown>): Promise<void> {
  const keys = pickClientKeys(patch);
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: row, error } = await supabase.from("ai_artifacts").select("data, updated_at").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!row) throw new Error("The chat's copy of this document is gone.");
    const current = (row.data ?? {}) as Record<string, unknown>;
    let query = supabase
      .from("ai_artifacts")
      .update({ data: { ...current, ...keys } as Json, updated_at: new Date().toISOString() })
      .eq("id", id)
      .eq("updated_at", row.updated_at);
    if (typeof current.storagePath === "string") query = query.eq("data->>storagePath", current.storagePath);
    const { data: updated, error: updateError } = await query.select("id");
    if (updateError) throw updateError;
    if (updated?.length) return;
  }
  throw new Error("The chat's copy of this document kept changing, so it doesn't show the save yet. The version itself is saved.");
}

// --------------------------------------------------------------------- save

export interface SaveResult {
  matterId: string;
  matterDocumentId: string;
  versionId: string;
  versionNumber: number;
  fileName: string;
  documentTypeId: string | null;
  label: string | null;
  waiting: number;
  /** One sentence for the toast: "Saved as v5 · 3 changes still waiting as tracked changes". */
  message: string;
  /** Set when the file is saved but is not searchable yet, or the chat's link to it could not be recorded. */
  note: string | null;
  alreadySaved?: boolean;
}

function invalidateAfterSave(queryClient: QueryClient | undefined, matterId: string, matterDocumentId: string, threadId?: string) {
  if (!queryClient) return;
  queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] });
  queryClient.invalidateQueries({ queryKey: ["project-search"] });
  queryClient.invalidateQueries({ queryKey: ["project-document-latest", matterDocumentId] });
  if (threadId) queryClient.invalidateQueries({ queryKey: ["chat-artifacts", threadId] });
}

async function setVersionLabel(versionId: string, label: string | null) {
  if (!label) return;
  await supabase.from("document_versions").update({ label }).eq("id", versionId);
}

async function readProjectDocument(matterDocumentId: string) {
  const [{ data: md, error }, { data: latest }] = await Promise.all([
    supabase.from("matter_documents").select("id, title, matter_id, document_type_id").eq("id", matterDocumentId).maybeSingle(),
    supabase.from("document_versions").select("id, version_number").eq("matter_document_id", matterDocumentId).order("version_number", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (error) throw new Error("The project document couldn't be read. Check your connection and try again.");
  if (!md) throw new Error("The project document this came from has been removed. Save it as a new document instead.");
  return { md, latest };
}

/**
 * The save every chat panel and the review panel use, for a file built or
 * held in the browser: as the next version of a project document (its type
 * read from the database now, as the database requires) or as a new one.
 */
export async function saveBlobToProject({
  matterId,
  blob,
  mode,
  matterDocumentId,
  expectedVersionId,
  expectedFrom,
  title,
  documentTypeId = null,
  label,
  extension = "docx",
  isAiGenerated = true,
  queryClient,
  threadId,
}: {
  matterId: string;
  blob: Blob;
  mode: "next-version" | "new-document";
  matterDocumentId?: string | null;
  /** The version this file was made from, when the caller knows it exactly. */
  expectedVersionId?: string | null;
  /** Or the artifact data to work it out from (its saved keys and source). */
  expectedFrom?: WorkingDocData | null;
  title?: string | null;
  documentTypeId?: string | null;
  /** The lawyer's label; undefined gives "AI draft from chat — <date>", null none. */
  label?: string | null;
  extension?: string;
  isAiGenerated?: boolean;
  queryClient?: QueryClient;
  threadId?: string;
}): Promise<SaveResult> {
  let project = matterId;
  let target: string | undefined;
  let typeId: string | null = documentTypeId;
  let docTitle = title?.trim() || "AI draft";
  let expected: string | null = null;
  if (mode === "next-version") {
    if (!matterDocumentId) throw new Error("There's no project document to add a version to. Save it as a new document instead.");
    const { md, latest } = await readProjectDocument(matterDocumentId);
    target = md.id;
    project = md.matter_id;
    typeId = md.document_type_id ?? null;
    docTitle = md.title;
    expected = expectedVersionId !== undefined ? expectedVersionId : chooseExpectedVersionId({ head: expectedFrom, latestVersionId: latest?.id ?? null });
  }
  const versionLabel = label === null ? null : versionLabelFor(label);
  const result = await saveDraftToMatter({
    matterId: project,
    documentTypeId: typeId,
    documentTypeName: docTitle,
    blob,
    title: docTitle,
    matterDocumentId: target,
    expectedVersionId: expected,
    extension,
    isAiGenerated,
  });
  await setVersionLabel(result.versionId, versionLabel).catch(() => undefined);
  invalidateAfterSave(queryClient, project, result.matterDocumentId, threadId);
  return {
    matterId: project,
    matterDocumentId: result.matterDocumentId,
    versionId: result.versionId,
    versionNumber: result.versionNumber,
    fileName: result.fileName,
    documentTypeId: typeId,
    label: versionLabel,
    waiting: 0,
    message: savedMessage({ versionNumber: result.versionNumber, newDocument: mode === "new-document" }),
    note: result.indexed || result.unsupported ? null : "It couldn't be prepared for search yet. Open the project and press Try again.",
  };
}

// One save at a time per working document, so an automatic save and a click
// on Save never both add a version of the same file.
const saveLocks = new Map<string, Promise<unknown>>();
function withSaveLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = saveLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.then(() => undefined, () => undefined);
  saveLocks.set(key, tail);
  void tail.then(() => {
    if (saveLocks.get(key) === tail) saveLocks.delete(key);
  });
  return run;
}

async function headBytes(head: ArtifactRow): Promise<Blob> {
  const d = dataOf(head);
  if (d.storagePath) {
    const { data: blob } = await supabase.storage.from(d.bucket ?? "ai-chat-files").download(d.storagePath);
    if (blob) return new Blob([blob], { type: DOCX_MIME });
  }
  if (chatApiBase()) return (await fetchDocumentFile(head.id, "tracked")).blob;
  throw new Error("The Word file couldn't be read. Reload the chat and try again.");
}

/**
 * Saves the working document's head file to the project.
 *
 * - next-version: as the next version of the project document it was last
 *   saved to, or opened from. The base it expects is the version this chat
 *   last saved, else the one it was opened from, so a colleague's newer
 *   version is never buried; the document's type is read now.
 * - new-document: as a new project document, titled after the working
 *   document (or `title`), with `documentTypeId` or the type the AI used.
 *
 * Changes still waiting are saved as Word tracked changes, and the result
 * says how many. The version is labelled ("AI draft from chat — <date>",
 * or `label`), and the head records which version it became.
 */
export async function saveWorkingDocument({
  artifact,
  matterId,
  mode,
  title,
  label,
  documentTypeId,
  queryClient,
}: {
  artifact: ArtifactRow;
  matterId?: string | null;
  mode: "next-version" | "new-document";
  title?: string | null;
  label?: string | null;
  documentTypeId?: string | null;
  queryClient?: QueryClient;
}): Promise<SaveResult> {
  return withSaveLock(workingDocumentIdOf(artifact), async () => {
    const resolved = await resolveWorkingHead(artifact);
    const { head } = resolved;
    const data = dataOf(head);
    const waiting = waitingOf(resolved.counts);
    if (!data.storagePath) throw new Error("This document has no Word file yet.");
    const target = mode === "next-version" ? saveTargetFor(data) : null;
    if (mode === "next-version" && !target) {
      throw new Error("This document didn't come from a project document, so there's no document to add a version to. Save it as a new document instead.");
    }
    // Saved already (a click while the automatic save ran): say so, add nothing.
    if (mode === "next-version" && !label && saveStateOf(data) === "saved" && data.savedVersion && data.savedVersionId && data.savedMatterDocumentId) {
      return {
        matterId: head.matter_id ?? matterId ?? "",
        matterDocumentId: data.savedMatterDocumentId,
        versionId: data.savedVersionId,
        versionNumber: data.savedVersion,
        fileName: data.fileName ?? "",
        documentTypeId: data.documentTypeId ?? null,
        label: null,
        waiting,
        message: `Already saved as v${data.savedVersion}`,
        note: null,
        alreadySaved: true,
      };
    }
    const project = matterId ?? head.matter_id ?? null;
    if (!project && mode === "new-document") throw new Error("Choose a project to save to first.");
    const blob = await headBytes(head);
    let projectId = project ?? "";
    let typeId: string | null;
    let docTitle: string;
    let expected: string | null = null;
    if (target) {
      const { md, latest } = await readProjectDocument(target);
      projectId = md.matter_id;
      typeId = md.document_type_id ?? null;
      docTitle = md.title;
      expected = chooseExpectedVersionId({ head: data, lineage: resolved.lineage.map(dataOf), latestVersionId: latest?.id ?? null });
    } else {
      typeId = documentTypeId !== undefined ? documentTypeId : data.documentTypeId ?? null;
      docTitle = title?.trim() || resolved.root?.title || head.title || "AI draft";
    }
    const versionLabel = label === null ? null : versionLabelFor(label);
    const result = await saveDraftToMatter({
      matterId: projectId,
      documentTypeId: typeId,
      documentTypeName: docTitle,
      blob,
      title: docTitle,
      matterDocumentId: target ?? undefined,
      expectedVersionId: expected,
    });
    await setVersionLabel(result.versionId, versionLabel).catch(() => undefined);
    const linked = await patchArtifactKeys(head.id, {
      documentTypeId: typeId,
      savedMatterDocumentId: result.matterDocumentId,
      savedVersionId: result.versionId,
      savedVersion: result.versionNumber,
      savedStoragePath: data.storagePath,
      savedAt: new Date().toISOString(),
    }).then(
      () => true,
      () => false,
    );
    invalidateAfterSave(queryClient, projectId, result.matterDocumentId, head.thread_id);
    const notes = [
      result.indexed || result.unsupported ? null : "It couldn't be prepared for search yet. Open the project and press Try again.",
      linked ? null : "The chat couldn't record the save; the version is in the project's Documents.",
    ].filter(Boolean);
    return {
      matterId: projectId,
      matterDocumentId: result.matterDocumentId,
      versionId: result.versionId,
      versionNumber: result.versionNumber,
      fileName: result.fileName,
      documentTypeId: typeId,
      label: versionLabel,
      waiting,
      message: savedMessage({ versionNumber: result.versionNumber, waiting, newDocument: mode === "new-document" }),
      note: notes.length ? notes.join(" ") : null,
    };
  });
}

// ---------------------------------------------------------- decisions gate

// Decisions under way, per working document. An automatic save waits for
// them to finish, so it never saves a file that is about to be replaced.
const deciding = new Map<string, number>();
export function beginDecision(workingDocumentId: string) {
  deciding.set(workingDocumentId, (deciding.get(workingDocumentId) ?? 0) + 1);
}
export function endDecision(workingDocumentId: string) {
  const n = (deciding.get(workingDocumentId) ?? 1) - 1;
  if (n > 0) deciding.set(workingDocumentId, n);
  else deciding.delete(workingDocumentId);
}

// ------------------------------------------------------------ auto-save

// The per-chat "Save AI drafts automatically" switch. On by default in a
// project chat; remembered in this browser per chat.
const PREF_PREFIX = "akla.autoSaveAiDrafts.";
const prefs = new Map<string, boolean>();
const prefListeners = new Set<() => void>();

export function autoSaveOn(threadId: string | null | undefined, inProject: boolean): boolean {
  if (!threadId || !inProject) return false;
  if (prefs.has(threadId)) return prefs.get(threadId)!;
  try {
    const stored = window.localStorage.getItem(PREF_PREFIX + threadId);
    if (stored === "0" || stored === "1") {
      prefs.set(threadId, stored === "1");
      return stored === "1";
    }
  } catch {
    /* storage blocked: the default stands */
  }
  return true;
}

export function setAutoSave(threadId: string, on: boolean) {
  prefs.set(threadId, on);
  try {
    window.localStorage.setItem(PREF_PREFIX + threadId, on ? "1" : "0");
  } catch {
    /* kept for this visit only */
  }
  prefListeners.forEach((fn) => fn());
}

function subscribePrefs(fn: () => void) {
  prefListeners.add(fn);
  return () => prefListeners.delete(fn);
}

export function useAutoSavePreference(threadId: string | null | undefined, inProject: boolean): boolean {
  return useSyncExternalStore(subscribePrefs, () => autoSaveOn(threadId, inProject), () => false);
}

export type AutoSaveStatus = { state: "scheduled" | "saving" | "saved" | "failed"; message?: string } | null;
const statuses = new Map<string, AutoSaveStatus>();
const statusListeners = new Set<() => void>();
function setStatus(workingDocumentId: string, status: AutoSaveStatus) {
  if (status) statuses.set(workingDocumentId, status);
  else statuses.delete(workingDocumentId);
  statusListeners.forEach((fn) => fn());
}
function subscribeStatus(fn: () => void) {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}
export function useAutoSaveStatus(workingDocumentId: string | null | undefined): AutoSaveStatus {
  return useSyncExternalStore(subscribeStatus, () => (workingDocumentId ? statuses.get(workingDocumentId) ?? null : null), () => null);
}

const AUTO_SAVE_DELAY_MS = 1500;
const DECISION_WAIT_MS = 120_000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Saves a new AI copy as the next version of its project document shortly
 * after the turn that wrote it. Several copies in quick succession make one
 * save of the newest; a save waits while decisions are being made; a copy
 * already saved is left alone. The lawyer is told either way.
 */
export function scheduleAutoSave({ artifact, matterId, queryClient }: { artifact: ArtifactRow; matterId: string; queryClient?: QueryClient }) {
  const wd = workingDocumentIdOf(artifact);
  const pending = timers.get(wd);
  if (pending) clearTimeout(pending);
  setStatus(wd, { state: "scheduled" });
  timers.set(
    wd,
    setTimeout(() => {
      timers.delete(wd);
      void runAutoSave(wd, artifact, matterId, queryClient);
    }, AUTO_SAVE_DELAY_MS),
  );
}

async function runAutoSave(wd: string, artifact: ArtifactRow, matterId: string, queryClient?: QueryClient) {
  const until = Date.now() + DECISION_WAIT_MS;
  while (deciding.get(wd)) {
    if (Date.now() > until) {
      setStatus(wd, null);
      return;
    }
    await sleep(400);
  }
  // A newer copy arrived while this one waited: its own timer saves it.
  if (timers.has(wd)) return;
  if (!autoSaveOn(artifact.thread_id, true)) {
    setStatus(wd, null);
    return;
  }
  setStatus(wd, { state: "saving" });
  try {
    const result = await saveWorkingDocument({ artifact, matterId, mode: "next-version", queryClient });
    setStatus(wd, { state: "saved", message: result.message });
    if (!result.alreadySaved) {
      toast({
        title: result.message,
        description: [`Saved to the project automatically${result.label ? ` as "${result.label}"` : ""}.`, result.note].filter(Boolean).join(" "),
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus(wd, { state: "failed", message });
    toast({
      title: "The AI draft wasn't saved to the project",
      description: `${message} It is still here in the chat; save it from the document panel.`,
      variant: "destructive",
    });
  }
}
