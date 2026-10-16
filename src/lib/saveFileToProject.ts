import { supabase } from "@/integrations/supabase/client";
import { indexStoredVersion, SEARCHABLE_EXTENSIONS } from "@/lib/saveDraftToMatter";
import { sanitizeStorageFilename } from "@/lib/utils";

// Copies a file the firm already holds — one dropped into the assistant
// (bucket ai-chat-files) or one captured from WhatsApp (whatsapp-documents) —
// into a project as a document of its own, version 1. The browser can read
// both buckets (firm members read chat files; WhatsApp files are readable by
// their owner, and by the firm once the WhatsApp matter is linked), so the
// copy is made here and saved through the same save_document_version RPC as
// every other project document.
//
// "Is it already in that project?" is answered by the database, not by memory:
// the new document's id is derived from the source file and the project
// (a name-based UUID), so the same file saved to the same project always
// names the same document. A second click, a second tab or a later "Add all"
// finds it there and saves nothing twice.

// Fixed namespace for these ids. Changing it would make every earlier save
// look new again, so it never changes.
const NAMESPACE = "4cc5eb63-5332-4709-82a8-b25ae5c45434";

/** The source a project document was copied from, as a stable key. */
export type SourceFile =
  | { kind: "chat"; path: string }
  | { kind: "whatsapp"; id: string };

export const sourceKey = (s: SourceFile) => (s.kind === "chat" ? `chat:ai-chat-files/${s.path}` : `whatsapp:${s.id}`);

// RFC 4122 version-5 UUID of `${sourceKey}|${matterId}`.
export async function projectDocumentIdFor(source: SourceFile, matterId: string): Promise<string> {
  const ns = NAMESPACE.replace(/-/g, "");
  const nsBytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) nsBytes[i] = parseInt(ns.slice(i * 2, i * 2 + 2), 16);
  const name = new TextEncoder().encode(`${sourceKey(source)}|${matterId}`);
  const input = new Uint8Array(nsBytes.length + name.length);
  input.set(nsBytes);
  input.set(name, nsBytes.length);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-1", input)).slice(0, 16);
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Of the given sources, which are already documents of the project: source key → document title. */
export async function findSavedInProject(sources: SourceFile[], matterId: string): Promise<Map<string, { matterDocumentId: string; title: string }>> {
  const found = new Map<string, { matterDocumentId: string; title: string }>();
  if (!sources.length) return found;
  const ids = await Promise.all(sources.map((s) => projectDocumentIdFor(s, matterId)));
  const { data, error } = await supabase.from("matter_documents").select("id, title").eq("matter_id", matterId).in("id", ids);
  if (error) throw new Error("Could not check which files are already in the project.");
  const byId = new Map((data ?? []).map((r) => [r.id, r.title]));
  sources.forEach((s, i) => {
    const title = byId.get(ids[i]);
    if (title !== undefined) found.set(sourceKey(s), { matterDocumentId: ids[i], title });
  });
  return found;
}

export interface SaveFileResult {
  // "already": the file was in the project before this call; nothing was added.
  status: "saved" | "already";
  matterDocumentId: string;
  title: string;
  versionNumber?: number;
  // Settles once the new version has been read for search: true when it can
  // be searched, false when reading failed, "unsupported" for file types the
  // search does not read (audio, images). Absent when nothing was saved.
  indexing?: Promise<boolean | "unsupported">;
}

const BUCKET: Record<SourceFile["kind"], string> = { chat: "ai-chat-files", whatsapp: "whatsapp-documents" };

const EXTENSION_FOR_TYPE: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "audio/ogg": "ogg",
};

function splitName(fileName: string, mimeType?: string | null) {
  const dot = fileName.lastIndexOf(".");
  const fromName = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
  const fromType = EXTENSION_FOR_TYPE[(mimeType ?? "").split(";")[0].trim()] ?? "";
  const extension = /^[a-z0-9]{1,10}$/.test(fromName) ? fromName : fromType || "bin";
  const title = (dot > 0 ? fileName.slice(0, dot) : fileName).trim() || "Document";
  return { extension, title };
}

// In-flight saves, so two clicks on the same file for the same project share
// one save instead of racing each other.
const inFlight = new Map<string, Promise<SaveFileResult>>();

export function saveFileToProject(input: { source: SourceFile; storagePath: string; fileName: string; mimeType?: string | null; matterId: string }): Promise<SaveFileResult> {
  const key = `${sourceKey(input.source)}|${input.matterId}`;
  const running = inFlight.get(key);
  if (running) return running;
  const p = doSave(input).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function existing(matterId: string, docId: string) {
  const { data } = await supabase.from("matter_documents").select("id, title").eq("id", docId).eq("matter_id", matterId).maybeSingle();
  return data;
}

async function doSave({ source, storagePath, fileName, mimeType, matterId }: { source: SourceFile; storagePath: string; fileName: string; mimeType?: string | null; matterId: string }): Promise<SaveFileResult> {
  const docId = await projectDocumentIdFor(source, matterId);
  const before = await existing(matterId, docId);
  if (before) return { status: "already", matterDocumentId: docId, title: before.title };

  const { data: blob, error: readError } = await supabase.storage.from(BUCKET[source.kind]).download(storagePath);
  if (readError || !blob) {
    throw new Error(source.kind === "chat"
      ? `"${fileName}" could not be read from the chat; it may have been removed.`
      : `"${fileName}" could not be read from WhatsApp storage; it may have been removed, or you may not have access to it.`);
  }

  const { extension, title } = splitName(fileName, mimeType ?? blob.type);
  const stem = sanitizeStorageFilename(title.replace(/[^\w\s-]+/g, " ").trim().replace(/[\s-]+/g, "-")).slice(0, 180) || "Document";
  const target = `${matterId}/${docId}/${crypto.randomUUID()}-${stem}.${extension}`;
  const contentType = (mimeType ?? blob.type ?? "").split(";")[0].trim() || "application/octet-stream";
  const { error: uploadError } = await supabase.storage.from("matter-documents").upload(target, blob, { contentType });
  if (uploadError) throw new Error(`"${fileName}" could not be copied into the project. Please try again.`);

  const { data, error } = await supabase.rpc("save_document_version", {
    p_matter_id: matterId, p_document_type_id: null, p_document_id: docId, p_create_new: true, p_expected_version_id: null,
    p_title: title, p_storage_path: target, p_file_stem: stem, p_is_ai_generated: false, p_extension: extension,
  });
  let saved = data as { matterDocumentId: string; versionId: string; versionNumber: number; fileName: string } | null;
  if (error) {
    // A lost response after the save went through, or a save from another
    // tab a moment earlier: if the document is there now, the file is in the
    // project either way.
    const after = await existing(matterId, docId);
    const { data: mine } = after
      ? await supabase.from("document_versions").select("id, version_number, file_name").eq("storage_path", target).maybeSingle()
      : { data: null };
    if (mine) saved = { matterDocumentId: docId, versionId: mine.id, versionNumber: mine.version_number, fileName: mine.file_name ?? fileName };
    else if (after) {
      await supabase.storage.from("matter-documents").remove([target]);
      return { status: "already", matterDocumentId: docId, title: after.title };
    }
  }
  if (!saved) {
    await supabase.storage.from("matter-documents").remove([target]);
    const msg = error?.message ?? "";
    if (/Project is unavailable/i.test(msg)) throw new Error("That project is no longer available.");
    if (/Forbidden/i.test(msg)) throw new Error("Only members of the firm can add project documents.");
    throw new Error(`"${fileName}" could not be added to the project's documents. Please try again.`);
  }

  const result = saved;
  const indexing: Promise<boolean | "unsupported"> = SEARCHABLE_EXTENSIONS.includes(extension)
    ? indexStoredVersion({ versionId: result.versionId, matterId, documentTypeId: null, storagePath: target, fileName: result.fileName, fileType: contentType }).catch(() => false)
    : Promise.resolve(supabase.from("document_versions").update({ indexing_status: "unsupported" }).eq("id", result.versionId)).then(() => "unsupported" as const, () => "unsupported" as const);
  return { status: "saved", matterDocumentId: docId, title, versionNumber: result.versionNumber, indexing };
}

/** What to tell the lawyer about one save: a toast title and a sentence. */
export function describeSave(result: SaveFileResult, matterName: string): { title: string; description: string } {
  return result.status === "already"
    ? { title: `Already in ${matterName}`, description: `"${result.title}" is already one of its documents, so nothing was added.` }
    : { title: `Saved to ${matterName}`, description: `Added to its documents as "${result.title}".` };
}

/** The follow-up sentence once reading the new document for search has finished, or null when there is nothing to say. */
export function describeIndexing(outcome: boolean | "unsupported", title: string): string | null {
  if (outcome === true) return null;
  if (outcome === "unsupported") return `"${title}" is saved; the assistant cannot read this kind of file, so it will not come up in searches.`;
  return `"${title}" is saved, but the assistant could not read it yet. The project's documents page tries again on its own, and has a Try again button.`;
}
