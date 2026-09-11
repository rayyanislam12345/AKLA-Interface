import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { sanitizeStorageFilename } from "@/lib/utils";
import { describeTemplateDocx } from "@/lib/templateDocx";

export interface DocumentTypeTemplateRow {
  document_type_id: string;
  document_type_name: string;
  document_type_category: string;
  filename: string | null;
  updated_by_name: string | null;
  updated_at: string | null;
}

export function useDocumentTypeTemplates() {
  return useQuery({
    queryKey: ["document-type-templates"],
    queryFn: async (): Promise<DocumentTypeTemplateRow[]> => {
      const { data, error } = await supabase
        .from("document_types")
        .select(
          "id, name, category, document_type_templates(filename, updated_at, updated_by:profiles(full_name))"
        )
        .order("category")
        .order("name");
      if (error) throw error;
      return data.map((row: any) => ({
        document_type_id: row.id,
        document_type_name: row.name,
        document_type_category: row.category,
        filename: row.document_type_templates?.filename ?? null,
        updated_by_name: row.document_type_templates?.updated_by?.full_name ?? null,
        updated_at: row.document_type_templates?.updated_at ?? null,
      }));
    },
  });
}

export function useDocumentTypeTemplate(documentTypeId: string | undefined) {
  return useQuery({
    queryKey: ["document-type-template", documentTypeId],
    enabled: !!documentTypeId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("document_type_templates")
        .select("storage_path, filename, updated_at, format_rules")
        .eq("document_type_id", documentTypeId!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

export function useDeleteDocumentTypeTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ documentTypeId, storagePath }: { documentTypeId: string; storagePath: string | null }) => {
      if (storagePath) {
        await supabase.storage.from("precedent-library").remove([storagePath]);
      }
      const { error } = await supabase
        .from("document_type_templates")
        .delete()
        .eq("document_type_id", documentTypeId);
      if (error) throw error;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["document-type-templates"] });
      queryClient.invalidateQueries({ queryKey: ["document-type-template", variables.documentTypeId] });
    },
  });
}

// Standard versions are uploaded (a real .docx), not edited inline — this
// uploads the file, extracts its text via the shared extraction pipeline
// (same one every other ingestion path uses) for AI-prompt purposes, and
// records both the storage path (so the actual document can be opened) and
// the extracted text (content_html column name is legacy — it now just
// holds plain extracted text, not HTML).
export function useUploadDocumentTypeTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ documentTypeId, file }: { documentTypeId: string; file: File }) => {
      const storagePath = `standards/${documentTypeId}/${Date.now()}-${sanitizeStorageFilename(file.name)}`;

      const { error: uploadError } = await supabase.storage.from("precedent-library").upload(storagePath, file);
      if (uploadError) throw uploadError;

      const { data: extracted, error: extractError } = await supabase.functions.invoke("extract-document-text", {
        body: { bucket: "precedent-library", storagePath, fileName: file.name },
      });
      if (extractError) throw extractError;

      // How the file is formatted — its numbering scheme, heading treatment,
      // body font — read off the .docx itself. The words go into the drafting
      // prompt; the file itself is what a draft is later exported inside of.
      let formatRules: string | null = null;
      try {
        formatRules = await describeTemplateDocx(await file.arrayBuffer());
      } catch (err) {
        console.warn("Could not analyse the standard's formatting:", err);
      }

      const { data: userData } = await supabase.auth.getUser();
      const { error } = await supabase.from("document_type_templates").upsert(
        {
          document_type_id: documentTypeId,
          content_html: extracted.text,
          storage_path: storagePath,
          filename: file.name,
          format_rules: formatRules,
          updated_by: userData.user?.id,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "document_type_id" }
      );
      if (error) throw error;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["document-type-templates"] });
      queryClient.invalidateQueries({ queryKey: ["document-type-template", variables.documentTypeId] });
    },
  });
}

// The standard's .docx itself, for building a draft inside it.
export async function fetchTemplateDocxBytes(storagePath: string): Promise<ArrayBuffer> {
  const { data, error } = await supabase.storage.from("precedent-library").download(storagePath);
  if (error || !data) throw new Error(error?.message ?? "Could not download the standard");
  return data.arrayBuffer();
}

// A file the chat produced or is working on, from whichever bucket holds it.
export function useChatFile(bucket: string | undefined, storagePath: string | undefined) {
  return useQuery({
    queryKey: ["chat-file", bucket, storagePath],
    enabled: !!bucket && !!storagePath,
    staleTime: Infinity,
    queryFn: async () => {
      const { data, error } = await supabase.storage.from(bucket!).download(storagePath!);
      if (error || !data) throw new Error(error?.message ?? "Could not download the file");
      return data;
    },
  });
}
