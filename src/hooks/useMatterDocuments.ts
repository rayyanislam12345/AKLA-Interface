import { saveDraftToMatter } from "@/lib/saveDraftToMatter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Enums } from "@/integrations/supabase/types";
import { parseFileName, versionLabel } from "@/lib/fileNames";
import { sha256 } from "@/components/documents/collectFiles";

export type DocumentStatus = Enums<"document_status">;

export interface DocumentType {
  id: string;
  name: string;
  category: string;
}

export function useDocumentTypes() {
  return useQuery({
    queryKey: ["document-types"],
    queryFn: async (): Promise<DocumentType[]> => {
      const { data, error } = await supabase
        .from("document_types")
        .select("id, name, category")
        .order("category")
        .order("name");
      if (error) throw error;
      return data;
    },
  });
}

export function useCreateDocumentType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { name: string; category: string }) => {
      const { error } = await supabase.from("document_types").insert(input);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document-types"] });
    },
  });
}

export function useUpdateDocumentType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name, category }: { id: string; name: string; category: string }) => {
      const { error } = await supabase.from("document_types").update({ name, category }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document-types"] });
    },
  });
}

export function useDeleteDocumentType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("document_types").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["document-types"] });
    },
  });
}

// The documents list. The index worker's version columns
// (20261017090000_indexing_pipeline.sql) are asked for too; until that
// migration is applied PostgREST rejects them, the list notices once and asks
// without them, and the page keeps its old reading behaviour.
const DOCUMENTS_SELECT =
  "*, document_type:document_types(name), versions:document_versions(id, version_number, created_at, storage_path, file_name, label, is_ai_generated, uploaded_by, indexing_status)";
const DOCUMENTS_SELECT_WITH_INDEXING =
  "*, document_type:document_types(name), versions:document_versions(id, version_number, created_at, storage_path, file_name, label, is_ai_generated, uploaded_by, indexing_status, indexing_error, indexing_attempts, indexing_started_at)";
let indexingColumnsMissing = false;

const isMissingColumn = (error: { code?: string; message?: string } | null) =>
  !!error && (error.code === "42703" || error.code === "PGRST204" || /indexing_(error|attempts|started_at)/.test(error.message ?? ""));

const loadDocuments = (matterId: string, select: typeof DOCUMENTS_SELECT) =>
  supabase
    .from("matter_documents")
    .select(select)
    .eq("matter_id", matterId)
    .order("created_at", { ascending: false })
    .order("version_number", { ascending: false, foreignTable: "document_versions" });

type DocumentRow = NonNullable<Awaited<ReturnType<typeof loadDocuments>>["data"]>[number];
export type MatterDocumentVersion = DocumentRow["versions"][number] & {
  // Present once the indexing migration is applied (undefined before).
  indexing_error?: string | null;
  indexing_attempts?: number | null;
  indexing_started_at?: string | null;
};
export type MatterDocumentRow = Omit<DocumentRow, "versions"> & { versions: MatterDocumentVersion[] };

export function useMatterDocuments(matterId: string | undefined) {
  return useQuery({
    queryKey: ["matter-documents", matterId],
    enabled: !!matterId,
    queryFn: async (): Promise<MatterDocumentRow[]> => {
      if (!indexingColumnsMissing) {
        // Not in the generated types until the migration is applied.
        const { data, error } = await loadDocuments(matterId!, DOCUMENTS_SELECT_WITH_INDEXING as unknown as typeof DOCUMENTS_SELECT);
        if (!error) return data;
        if (!isMissingColumn(error)) throw error;
        indexingColumnsMissing = true;
      }
      const { data, error } = await loadDocuments(matterId!, DOCUMENTS_SELECT);
      if (error) throw error;
      return data;
    },
    // While any version is waiting or being read (by this browser, a
    // colleague's or the index worker), check again so its badge moves on by
    // itself: every 10 seconds for a fresh one, every minute for one that has
    // been in the queue a while (a long scanned PDF). Before the index worker,
    // only for ten minutes, as the old in-request reading could not take longer.
    refetchInterval: (query) => {
      let interval: number | false = false;
      for (const d of query.state.data ?? []) {
        for (const v of d.versions ?? []) {
          if (v.indexing_status !== "pending") continue;
          const age = Date.now() - new Date(v.indexing_started_at ?? v.created_at).getTime();
          if (v.indexing_attempts === undefined) {
            if (age < 10 * 60 * 1000) interval = 15_000;
          } else {
            const next = age < 15 * 60 * 1000 ? 10_000 : 60_000;
            interval = interval === false ? next : Math.min(interval, next);
          }
        }
      }
      return interval;
    },
  });
}

export function useCreateMatterDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { matter_id: string; title: string; document_type_id?: string }) => {
      const { data: userData } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("matter_documents")
        .insert({
          matter_id: input.matter_id,
          title: input.title,
          document_type_id: input.document_type_id || null,
          created_by: userData.user?.id,
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["matter-documents", variables.matter_id] });
    },
  });
}

export function useSetMatterDocumentStatus() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      matterDocumentId,
      status,
      matterId,
    }: {
      matterDocumentId: string;
      status: DocumentStatus;
      matterId: string;
    }) => {
      const { error } = await supabase
        .from("matter_documents")
        .update({ status })
        .eq("id", matterDocumentId);
      if (error) throw error;
      return matterId;
    },
    onSuccess: (matterId) => {
      queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] });
      queryClient.invalidateQueries({ queryKey: ["project-search"] });
    },
  });
}

// Rename a document or change its type. A document created without a type
// can be given one later (or have it cleared), without re-uploading anything.
export function useUpdateMatterDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ matterDocumentId, matterId, title, documentTypeId }: {
      matterDocumentId: string; matterId: string; title?: string; documentTypeId?: string | null;
    }) => {
      const patch: { title?: string; document_type_id?: string | null } = {};
      if (title !== undefined) patch.title = title.trim();
      if (documentTypeId !== undefined) patch.document_type_id = documentTypeId;
      const { error } = await supabase.from("matter_documents").update(patch).eq("id", matterDocumentId);
      if (error) throw error;
      return matterId;
    },
    onSuccess: (matterId) => {
      queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] });
      queryClient.invalidateQueries({ queryKey: ["project-search"] });
    },
  });
}

// A plain upload adds the next version of the document. It reads the
// document's stored type (null included) and its latest version just before
// saving, so a type changed a moment ago, or a version a colleague added
// since the page loaded, does not make the save fail with a message about
// editing. Reading the file for search is left to the caller (the version
// shows as "Reading…" meanwhile); the result says whether the file type can
// be searched at all.
export function useUploadDocumentVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ matterId, matterDocumentId, documentTypeId, file, expectedVersionId }: {
      matterId: string; matterDocumentId: string; documentTypeId: string | null; file: File; expectedVersionId: string | null;
    }) => {
      const [{ data: stored }, { data: latest }] = await Promise.all([
        supabase.from("matter_documents").select("document_type_id").eq("id", matterDocumentId).maybeSingle(),
        supabase.from("document_versions").select("id").eq("matter_document_id", matterDocumentId)
          .order("version_number", { ascending: false }).limit(1).maybeSingle(),
      ]);
      const extension = file.name.split(".").pop()?.toLowerCase() || "bin";
      const result = await saveDraftToMatter({ matterId, matterDocumentId,
        documentTypeId: stored ? stored.document_type_id : documentTypeId, documentTypeName: file.name,
        title: file.name.replace(/\.[^.]+$/, ""), blob: file,
        expectedVersionId: stored ? (latest?.id ?? null) : expectedVersionId,
        isAiGenerated: false, extension, skipIndex: true });
      // The same label and fingerprint a bulk upload records, so either way in
      // the version says what the file name says and is recognised if re-sent.
      await saveVersionDetails(result.versionId, { label: versionLabel(parseFileName(file.name)) || null, contentHash: await sha256(file) }).catch(() => undefined);
      return { matterId, matterDocumentId, documentTypeId: stored ? stored.document_type_id : documentTypeId, fileType: file.type, ...result };
    },
    // Awaited, so the real version row is on screen before the
    // "uploading" placeholder goes away.
    onSuccess: async ({ matterId }) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] }),
        queryClient.invalidateQueries({ queryKey: ["project-search"] }),
      ]);
    },
  });
}

export function useDeleteMatterDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ matterDocumentId, matterId }: { matterDocumentId: string; matterId: string }) => {
      const { data: versions, error: versionsError } = await supabase
        .from("document_versions")
        .select("storage_path")
        .eq("matter_document_id", matterDocumentId);
      if (versionsError) throw versionsError;

      // The row goes first: the database decides who may remove a document,
      // and a refused delete comes back empty rather than as an error. Files
      // and search passages are only removed once the row is really gone.
      const { data: removed, error: deleteError } = await supabase.from("matter_documents").delete().eq("id", matterDocumentId).select("id");
      if (deleteError) throw deleteError;
      if (!removed?.length) throw new Error("Only an administrator or the person who added this document can remove it.");

      const paths = (versions ?? []).map((v) => v.storage_path);
      if (paths.length > 0) {
        await supabase.storage.from("matter-documents").remove(paths);
        for (const path of paths) {
          await supabase.from("documents").delete().eq("metadata->>storage_path", path);
        }
      }

      return matterId;
    },
    onSuccess: (matterId) => {
      queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] });
      queryClient.invalidateQueries({ queryKey: ["project-search"] });
    },
  });
}

export function useDeleteDocumentVersion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      versionId,
      storagePath,
      matterId,
    }: {
      versionId: string;
      storagePath: string;
      matterId: string;
    }) => {
      // Row first, as for a whole document: a refused delete leaves the file.
      const { data: removed, error } = await supabase.from("document_versions").delete().eq("id", versionId).select("id");
      if (error) throw error;
      if (!removed?.length) throw new Error("Only an administrator, the person who uploaded this version, or the document's creator can remove it.");

      await supabase.storage.from("matter-documents").remove([storagePath]);
      await supabase.from("documents").delete().eq("metadata->>storage_path", storagePath);

      return matterId;
    },
    onSuccess: (matterId) => {
      queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] });
      queryClient.invalidateQueries({ queryKey: ["project-search"] });
    },
  });
}

export function useUpdateVersionLabel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      versionId,
      label,
      matterId,
    }: {
      versionId: string;
      label: string;
      matterId: string;
    }) => {
      const { error } = await supabase
        .from("document_versions")
        .update({ label: label.trim() || null })
        .eq("id", versionId);
      if (error) throw error;
      return matterId;
    },
    onSuccess: (matterId) => {
      queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] });
      queryClient.invalidateQueries({ queryKey: ["project-search"] });
    },
  });
}

// ---- content hash (migration 20261016120000_document_content_hash) ----
// The column may not exist yet where the migration has not been applied, and
// the generated types do not know it. The first "no such column" answer is
// remembered for the rest of the session and nothing tries again; the bulk
// upload then recognises files already in the project by name and size.
let contentHashColumn: "unknown" | "present" | "missing" = "unknown";

function isMissingHashColumn(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "42703" || error.code === "PGRST204" || /content_hash/i.test(error.message ?? "");
}

/** Each version in the project that has a stored hash: version id → hash. Null when hashes can't be read. */
export async function fetchProjectContentHashes(matterId: string): Promise<Map<string, string> | null> {
  if (contentHashColumn === "missing") return null;
  const { data, error } = await supabase
    .from("document_versions")
    .select("id, content_hash, matter_documents!inner(matter_id)")
    .eq("matter_documents.matter_id", matterId)
    .not("content_hash", "is", null);
  if (error) {
    if (isMissingHashColumn(error)) contentHashColumn = "missing";
    return null;
  }
  contentHashColumn = "present";
  const map = new Map<string, string>();
  for (const row of (data ?? []) as unknown as Array<{ id: string; content_hash: string | null }>) {
    if (row.content_hash) map.set(row.id, row.content_hash);
  }
  return map;
}

/** After a save: the version's label from its file name, and its content hash when the column exists. */
export async function saveVersionDetails(versionId: string, details: { label?: string | null; contentHash?: string | null }) {
  if (details.label) {
    await supabase.from("document_versions").update({ label: details.label }).eq("id", versionId);
  }
  if (details.contentHash && contentHashColumn !== "missing") {
    const { error } = await supabase
      .from("document_versions")
      .update({ content_hash: details.contentHash } as never)
      .eq("id", versionId);
    if (isMissingHashColumn(error)) contentHashColumn = "missing";
    else if (!error) contentHashColumn = "present";
  }
}

/** Sizes of the stored files of one document, by storage path. Empty if the listing is refused. */
export async function fetchStoredFileSizes(matterId: string, matterDocumentId: string): Promise<Map<string, number>> {
  const folder = `${matterId}/${matterDocumentId}`;
  const { data, error } = await supabase.storage.from("matter-documents").list(folder, { limit: 1000 });
  const sizes = new Map<string, number>();
  if (error) return sizes;
  for (const object of data ?? []) {
    const size = (object.metadata as { size?: number } | null)?.size;
    if (typeof size === "number") sizes.set(`${folder}/${object.name}`, size);
  }
  return sizes;
}

/**
 * The summary card of each listed version (document_versions.card, written by
 * the index worker): a line under a document's title, and the type it
 * suggests. The column is not in the generated types; a database without it
 * answers with nothing.
 */
export function useVersionCards(versionIds: string[]) {
  const ids = [...versionIds].sort();
  return useQuery({
    queryKey: ["version-cards", ids],
    enabled: ids.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<Map<string, { summary?: string | null; suggested_document_type_id?: string | null }>> => {
      const { data, error } = await supabase.from("document_versions").select("id, card" as "id").in("id", ids);
      if (error) return new Map();
      const rows = (data ?? []) as unknown as Array<{ id: string; card: { summary?: string | null; suggested_document_type_id?: string | null } | null }>;
      return new Map(rows.filter((r) => r.card).map((r) => [r.id, r.card!]));
    },
  });
}
