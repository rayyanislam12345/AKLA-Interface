import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface MatterRelevantLaw {
  id: string;
  act_name: string;
  status: "available" | "needs_upload";
  source: "manual_selected" | "manual_typed" | "auto_detected";
  created_at: string;
}

export function useMatterRelevantLaws(matterId: string | undefined) {
  return useQuery({
    queryKey: ["matter-relevant-laws", matterId],
    enabled: !!matterId,
    queryFn: async (): Promise<MatterRelevantLaw[]> => {
      const { data, error } = await supabase
        .from("matter_relevant_laws")
        .select("id, act_name, status, source, created_at")
        .eq("matter_id", matterId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}

// Direct attach for a law already in the shared library (picked from the
// dropdown) — no scraping needed, so this skips resolve-statute entirely.
export function useAddSelectedRelevantLaw() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ matterId, actName }: { matterId: string; actName: string }) => {
      const { data: userData } = await supabase.auth.getUser();
      const { error } = await supabase.from("matter_relevant_laws").insert({
        matter_id: matterId,
        act_name: actName,
        status: "available",
        source: "manual_selected",
        added_by: userData.user?.id,
      });
      if (error) throw error;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["matter-relevant-laws", variables.matterId] });
    },
  });
}

// Typed-in law (may not be in the library yet) or a retry ("Find & add") on
// an existing needs_upload row — both go through resolve-statute, which
// checks the library first and scrapes pakistancode.gov.pk if needed.
export function useResolveRelevantLaw() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      matterId,
      actName,
      source = "manual_typed",
    }: {
      matterId: string;
      actName: string;
      source?: "manual_typed" | "auto_detected";
    }) => {
      const { data, error } = await supabase.functions.invoke("resolve-statute", {
        body: { matterId, actName, source },
      });
      if (error) throw error;
      return data as { actName: string; status: "available" | "needs_upload" };
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["matter-relevant-laws", variables.matterId] });
    },
  });
}

// Manual-upload fallback for a needs_upload row (resolve-statute couldn't
// find it via scraping) — uploads straight into the shared law-library
// corpus (is_statute: true), same as an associate would upload a precedent,
// then flips this matter's row to available.
export function useUploadRelevantLawFile() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      matterId,
      lawId,
      actName,
      file,
    }: {
      matterId: string;
      lawId: string;
      actName: string;
      file: File;
    }) => {
      const storagePath = `statutes/${actName.replace(/[^a-zA-Z0-9]+/g, "-")}-${Date.now()}-${file.name}`;

      const { error: uploadError } = await supabase.storage.from("law-library").upload(storagePath, file);
      if (uploadError) throw uploadError;

      const { error: processError } = await supabase.functions.invoke("process-document", {
        body: {
          filePath: storagePath,
          fileName: file.name,
          fileType: file.type,
          bucket: "law-library",
          matterId: null,
          documentTypeId: null,
          isStatute: true,
          isPrecedent: false,
          actName,
        },
      });
      if (processError) throw processError;

      const { error: updateError } = await supabase
        .from("matter_relevant_laws")
        .update({ status: "available" })
        .eq("id", lawId);
      if (updateError) throw updateError;

      return matterId;
    },
    onSuccess: (matterId) => {
      queryClient.invalidateQueries({ queryKey: ["matter-relevant-laws", matterId] });
    },
  });
}

export function useDeleteRelevantLaw() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, matterId }: { id: string; matterId: string }) => {
      const { error } = await supabase.from("matter_relevant_laws").delete().eq("id", id);
      if (error) throw error;
      return matterId;
    },
    onSuccess: (matterId) => {
      queryClient.invalidateQueries({ queryKey: ["matter-relevant-laws", matterId] });
    },
  });
}
