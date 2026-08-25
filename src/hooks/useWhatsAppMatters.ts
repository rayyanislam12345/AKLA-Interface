import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

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
}

export function useWhatsAppDocuments(whatsappMatterId: string | null) {
  return useQuery({
    queryKey: ["whatsapp-documents", whatsappMatterId],
    queryFn: async (): Promise<WhatsAppDocument[]> => {
      const { data, error } = await supabase
        .from("whatsapp_documents")
        .select("id, filename, mimetype, chat_name, sender, message_at, storage_path")
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
