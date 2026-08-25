import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface WhatsAppAccountLink {
  id: string;
  whatsapp_user_id: string;
  profile_id: string;
  profile_name: string | null;
  profile_email: string;
}

export function useWhatsAppAccountLinks() {
  return useQuery({
    queryKey: ["whatsapp-account-links"],
    queryFn: async (): Promise<WhatsAppAccountLink[]> => {
      const { data, error } = await supabase
        .from("whatsapp_account_links")
        .select("id, whatsapp_user_id, profile_id, profile:profiles(full_name, email)")
        .order("whatsapp_user_id");
      if (error) throw error;
      return data.map((row) => ({
        id: row.id,
        whatsapp_user_id: row.whatsapp_user_id,
        profile_id: row.profile_id,
        profile_name: (row.profile as any)?.full_name ?? null,
        profile_email: (row.profile as any)?.email ?? "",
      }));
    },
  });
}

export function useLinkWhatsAppAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ whatsappUserId, profileId }: { whatsappUserId: string; profileId: string }) => {
      const { error } = await supabase
        .from("whatsapp_account_links")
        .upsert({ whatsapp_user_id: whatsappUserId, profile_id: profileId }, { onConflict: "whatsapp_user_id" });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-account-links"] });
    },
  });
}

export function useUnlinkWhatsAppAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("whatsapp_account_links").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-account-links"] });
    },
  });
}
