import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Enums } from "@/integrations/supabase/types";

export type AppRole = Enums<"app_role">;

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  role: AppRole | null;
}

export function useProfiles() {
  return useQuery({
    queryKey: ["profiles"],
    queryFn: async (): Promise<Profile[]> => {
      const [{ data: profiles, error: profilesError }, { data: roles, error: rolesError }] =
        await Promise.all([
          supabase.from("profiles").select("id, email, full_name").order("full_name"),
          supabase.from("user_roles").select("user_id, role"),
        ]);
      if (profilesError) throw profilesError;
      if (rolesError) throw rolesError;

      const roleByUser = new Map(roles.map((r) => [r.user_id, r.role]));
      return profiles.map((p) => ({ ...p, role: roleByUser.get(p.id) ?? null }));
    },
  });
}

export function useSetUserRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, role }: { userId: string; role: AppRole }) => {
      await supabase.from("user_roles").delete().eq("user_id", userId);
      const { error } = await supabase.from("user_roles").insert({ user_id: userId, role });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profiles"] });
    },
  });
}
