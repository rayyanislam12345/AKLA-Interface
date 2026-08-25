import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface MandateOpportunity {
  id: string;
  dedupe_key: string;
  source: string;
  title: string;
  department: string | null;
  category: string | null;
  notice_type: string | null;
  publish_date: string | null;
  close_date: string | null;
  matched_keywords: string[];
  notice_url: string | null;
  document_url: string | null;
  extra_urls: string[];
  tender_ref: string | null;
  storage_folder: string | null;
  found_at: string;
}

export function useMandateOpportunities() {
  return useQuery({
    queryKey: ["mandate-opportunities"],
    queryFn: async (): Promise<MandateOpportunity[]> => {
      const { data, error } = await supabase
        .from("mandate_opportunities")
        .select("*")
        .order("found_at", { ascending: false });
      if (error) throw error;
      return data;
    },
    // Mandate Bot's own sync runs on its own schedule (GitHub Actions, daily
    // + manual triggers) — poll so a page left open picks up new matches
    // without a manual reload, same as the WhatsApp Activity page.
    refetchInterval: 30000,
  });
}

export interface MandateDocument {
  name: string;
  path: string;
}

export function useMandateDocuments(storageFolder: string | null) {
  return useQuery({
    queryKey: ["mandate-documents", storageFolder],
    queryFn: async (): Promise<MandateDocument[]> => {
      const { data, error } = await supabase.storage.from("mandate-documents").list(storageFolder!);
      if (error) throw error;
      return (data ?? [])
        .filter((entry) => entry.id !== null)
        .map((entry) => ({ name: entry.name, path: `${storageFolder}/${entry.name}` }));
    },
    enabled: !!storageFolder,
  });
}

export async function openMandateDocument(path: string) {
  const { data, error } = await supabase.storage.from("mandate-documents").createSignedUrl(path, 60);
  if (error) throw error;
  window.open(data.signedUrl, "_blank", "noopener,noreferrer");
}
