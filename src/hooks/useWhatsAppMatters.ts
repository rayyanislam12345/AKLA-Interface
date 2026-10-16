import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { findSavedInProject, saveFileToProject, sourceKey, type SaveFileResult } from "@/lib/saveFileToProject";

export interface WhatsAppMatter {
  id: string;
  source_user_id: string;
  owner_id: string | null;
  owner_name: string | null;
  matter_id: string | null;
  matter_name: string | null;
  name: string;
  aliases: string[];
  summary: string;
  detailed_summary: string;
  chat_history: Record<string, { timestamp: number; summary: string }[]>;
  chats: string[];
  message_count: number;
  last_active_at: string | null;
  matter_created_at: string | null;
}

function mapRow(row: any): WhatsAppMatter {
  return {
    id: row.id,
    source_user_id: row.source_user_id,
    owner_id: row.owner_id,
    owner_name: row.owner?.full_name ?? null,
    matter_id: row.matter_id,
    matter_name: row.matter?.name ?? null,
    name: row.name,
    aliases: row.aliases ?? [],
    summary: row.summary ?? "",
    detailed_summary: row.detailed_summary ?? "",
    chat_history: row.chat_history ?? {},
    chats: row.chats ?? [],
    message_count: row.message_count ?? 0,
    last_active_at: row.last_active_at,
    matter_created_at: row.matter_created_at,
  };
}

const SELECT = "*, matter:matters(id, name), owner:profiles!whatsapp_matters_owner_id_fkey(full_name)";

export function useWhatsAppMatters() {
  return useQuery({
    queryKey: ["whatsapp-matters"],
    queryFn: async (): Promise<WhatsAppMatter[]> => {
      const { data, error } = await supabase
        .from("whatsapp_matters")
        .select(SELECT)
        .order("last_active_at", { ascending: false });
      if (error) throw error;
      return data.map(mapRow);
    },
    // The sync job runs on its own 5-minute cycle in the background — poll
    // so newly-synced matters (e.g. right after linking/backfill) show up
    // without the lawyer having to manually refresh the page.
    refetchInterval: 30000,
  });
}

export function useWhatsAppMattersForMatter(matterId: string | undefined) {
  return useQuery({
    queryKey: ["whatsapp-matters", "for-matter", matterId],
    queryFn: async (): Promise<WhatsAppMatter[]> => {
      const { data, error } = await supabase
        .from("whatsapp_matters")
        .select(SELECT)
        .eq("matter_id", matterId!)
        .order("last_active_at", { ascending: false });
      if (error) throw error;
      return data.map(mapRow);
    },
    enabled: !!matterId,
  });
}

export interface WhatsAppDocument {
  id: string;
  filename: string;
  mimetype: string | null;
  chat_name: string | null;
  sender: string | null;
  message_at: string | null;
  storage_path: string;
  kind: string | null;
}

export function useWhatsAppDocuments(whatsappMatterId: string | null) {
  return useQuery({
    queryKey: ["whatsapp-documents", whatsappMatterId],
    queryFn: async (): Promise<WhatsAppDocument[]> => {
      const { data, error } = await supabase
        .from("whatsapp_documents")
        .select("id, filename, mimetype, chat_name, sender, message_at, storage_path, kind")
        .eq("whatsapp_matter_id", whatsappMatterId!)
        .order("message_at", { ascending: false });
      if (error) throw error;
      return data;
    },
    enabled: !!whatsappMatterId,
  });
}

export function useLinkWhatsAppMatter() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, matterId }: { id: string; matterId: string | null }) => {
      const { error } = await supabase.from("whatsapp_matters").update({ matter_id: matterId }).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-matters"] });
    },
  });
}

export async function openWhatsAppDocument(path: string) {
  const { data, error } = await supabase.storage.from("whatsapp-documents").createSignedUrl(path, 60);
  if (error) throw error;
  window.open(data.signedUrl, "_blank", "noopener,noreferrer");
}

// Forces an actual save-to-disk (openWhatsAppDocument opens in a new tab,
// which only previews for types the browser can render inline — a PDF or
// image, e.g., never prompts a save). Fetches the original bytes exactly
// as captured, same as every other download in this app.
export async function downloadWhatsAppDocument(path: string, fileName: string) {
  const { data, error } = await supabase.storage.from("whatsapp-documents").download(path);
  if (error) throw error;
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ------------------------------------------- adding captured files to a project

// A captured file becomes a project document by copying it into the
// project's documents (see saveFileToProject). Which ones are already there
// is asked of the database: the document made from a captured file has an id
// derived from that file and the project, so there is no separate record to
// keep and nothing is added twice. The browser does the copy itself — the
// whatsapp-documents bucket lets the capturing lawyer read their files, and
// the whole firm once the WhatsApp matter is linked to a project.

const sourceOf = (doc: WhatsAppDocument) => ({ kind: "whatsapp" as const, id: doc.id });

/** Of a WhatsApp matter's files, the ones already among the project's documents, by WhatsApp document id. */
export function useWhatsAppDocumentsInProject(matterId: string | null, docs: WhatsAppDocument[] | undefined) {
  return useQuery({
    queryKey: ["whatsapp-documents-in-project", matterId, (docs ?? []).map((d) => d.id).join(",")],
    enabled: !!matterId && !!docs?.length,
    queryFn: async () => {
      const found = await findSavedInProject(docs!.map(sourceOf), matterId!);
      const byDoc = new Map<string, { matterDocumentId: string; title: string }>();
      for (const d of docs!) {
        const hit = found.get(sourceKey(sourceOf(d)));
        if (hit) byDoc.set(d.id, hit);
      }
      return byDoc;
    },
  });
}

export function addWhatsAppDocumentToProject(doc: WhatsAppDocument, matterId: string): Promise<SaveFileResult> {
  return saveFileToProject({ source: sourceOf(doc), storagePath: doc.storage_path, fileName: doc.filename, mimeType: doc.mimetype, matterId });
}

export interface AddAllOutcome {
  saved: SaveFileResult[];
  already: number;
  voiceNotes: number;
  failed: string[];
}

/**
 * Adds every captured file of a WhatsApp matter to the project's documents,
 * one at a time, skipping the ones already there. Voice notes are left out:
 * they are not documents, and can still be added one by one.
 */
export const isVoiceNote = (d: WhatsAppDocument) => d.kind === "audio" || (d.mimetype ?? "").startsWith("audio/");

export async function addAllWhatsAppDocumentsToProject(docs: WhatsAppDocument[], matterId: string): Promise<AddAllOutcome> {
  const candidates = docs.filter((d) => !isVoiceNote(d));
  const there = await findSavedInProject(candidates.map(sourceOf), matterId);
  const outcome: AddAllOutcome = { saved: [], already: 0, voiceNotes: docs.length - candidates.length, failed: [] };
  for (const d of candidates) {
    if (there.has(sourceKey(sourceOf(d)))) { outcome.already++; continue; }
    try {
      const result = await addWhatsAppDocumentToProject(d, matterId);
      if (result.status === "saved") outcome.saved.push(result);
      else outcome.already++;
    } catch (err) {
      outcome.failed.push((err as Error).message);
    }
  }
  return outcome;
}
