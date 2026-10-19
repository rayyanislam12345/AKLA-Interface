import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { LawUpdate } from "@/hooks/useLawUpdates";

// A legal development the morning run decided this person should know
// about: because a matter they work on depends on the Act (matter_id set),
// or because it is a bill, draft, new Act or amendment everyone should see.
export interface LawNotification {
  id: string;
  law_update_id: string;
  matter_id: string | null;
  reason: "matter" | "firm";
  created_at: string;
  read_at: string | null;
  update: Pick<
    LawUpdate,
    "id" | "title" | "act_name" | "update_type" | "source_name" | "source_url" | "document_url" | "published_date" | "summary" | "incorporation"
  > | null;
  matter: { id: string; name: string } | null;
}

export interface NotificationPreferences {
  firm_wide_law_updates: boolean;
  email_law_updates: boolean;
}

const DEFAULT_PREFERENCES: NotificationPreferences = { firm_wide_law_updates: true, email_law_updates: true };

export function useUnreadLawNotificationCount() {
  return useQuery({
    queryKey: ["law-notifications-unread"],
    queryFn: async (): Promise<number> => {
      const { data, error } = await supabase.rpc("unread_law_notification_count");
      if (error) throw error;
      return (data as number) ?? 0;
    },
    // The morning run writes these once a day; a minute's staleness is fine
    // and keeps the header from hammering the database.
    refetchInterval: 60_000,
  });
}

export function useLawNotifications(limit = 30) {
  return useQuery({
    queryKey: ["law-notifications", limit],
    queryFn: async (): Promise<LawNotification[]> => {
      const { data, error } = await supabase
        .from("law_update_notifications")
        .select(
          "id, law_update_id, matter_id, reason, created_at, read_at, update:law_updates(id, title, act_name, update_type, source_name, source_url, document_url, published_date, summary, incorporation), matter:matters(id, name)",
        )
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as unknown as LawNotification[];
    },
  });
}

export function useMarkLawNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    // No ids = everything unread.
    mutationFn: async (ids?: string[]) => {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      if (!userId) return;
      let query = supabase
        .from("law_update_notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("user_id", userId)
        .is("read_at", null);
      if (ids && ids.length > 0) query = query.in("id", ids);
      const { error } = await query;
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["law-notifications"] });
      queryClient.invalidateQueries({ queryKey: ["law-notifications-unread"] });
    },
  });
}

export function useNotificationPreferences() {
  return useQuery({
    queryKey: ["notification-preferences"],
    queryFn: async (): Promise<NotificationPreferences> => {
      const { data, error } = await supabase
        .from("notification_preferences")
        .select("firm_wide_law_updates, email_law_updates")
        .maybeSingle();
      if (error) throw error;
      return data ?? DEFAULT_PREFERENCES;
    },
  });
}

export function useSaveNotificationPreferences() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (prefs: Partial<NotificationPreferences>) => {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      if (!userId) throw new Error("Not signed in");
      const current = queryClient.getQueryData<NotificationPreferences>(["notification-preferences"]) ?? DEFAULT_PREFERENCES;
      const { error } = await supabase
        .from("notification_preferences")
        .upsert({ user_id: userId, ...current, ...prefs, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["notification-preferences"] }),
  });
}
