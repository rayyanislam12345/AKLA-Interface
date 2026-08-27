import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import type { Enums } from "@/integrations/supabase/types";

export type AppRole = Enums<"app_role">;
export type ProfileStatus = Enums<"profile_status">;

export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  role: AppRole | null;
}

export interface PendingProfile {
  id: string;
  email: string;
  full_name: string | null;
  created_at: string;
}

// The Team page, and every "assign this to a lawyer" picker elsewhere,
// should only ever offer approved firm members — filtered explicitly here
// rather than relying on RLS alone, since an admin's session can also see
// pending/rejected rows (needed for the approval queue) and that shouldn't
// leak into unrelated dropdowns.
export function useProfiles() {
  return useQuery({
    queryKey: ["profiles"],
    queryFn: async (): Promise<Profile[]> => {
      const [{ data: profiles, error: profilesError }, { data: roles, error: rolesError }] =
        await Promise.all([
          supabase.from("profiles").select("id, email, full_name").eq("status", "approved").order("full_name"),
          supabase.from("user_roles").select("user_id, role"),
        ]);
      if (profilesError) throw profilesError;
      if (rolesError) throw rolesError;

      const roleByUser = new Map(roles.map((r) => [r.user_id, r.role]));
      return profiles.map((p) => ({ ...p, role: roleByUser.get(p.id) ?? null }));
    },
  });
}

// A signed-in user can always read their own row regardless of status (see
// the "Users can view their own profile" RLS policy) — this is what
// ProtectedRoute uses to decide whether to show the app or an
// awaiting-approval screen.
export function useOwnProfileStatus() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["own-profile-status", user?.id],
    enabled: !!user,
    queryFn: async (): Promise<ProfileStatus> => {
      const { data, error } = await supabase
        .from("profiles")
        .select("status")
        .eq("id", user!.id)
        .single();
      if (error) throw error;
      return data.status;
    },
  });
}

// Admin-only: signups awaiting a decision. Relies on the "Admins can view
// all profiles" RLS policy — a non-admin gets zero rows here regardless.
export function usePendingProfiles() {
  return useQuery({
    queryKey: ["pending-profiles"],
    queryFn: async (): Promise<PendingProfile[]> => {
      const { data, error } = await supabase
        .from("profiles")
        .select("id, email, full_name, created_at")
        .eq("status", "pending")
        .order("created_at");
      if (error) throw error;
      return data;
    },
  });
}

export function useDecideProfileApproval() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ userId, status }: { userId: string; status: "approved" | "rejected" }) => {
      const { error } = await supabase.from("profiles").update({ status }).eq("id", userId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["pending-profiles"] });
      queryClient.invalidateQueries({ queryKey: ["profiles"] });
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
