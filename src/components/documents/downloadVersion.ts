import { supabase } from "@/integrations/supabase/client";
import { saveBlob } from "./zipDownload";

// Downloads one stored version exactly as it was uploaded: nothing on the
// server ever writes back to the file, so what is in Storage is the
// untouched original. Throws when the file cannot be fetched; the caller
// says so.
export async function downloadStoredVersion(storagePath: string, fileName: string): Promise<void> {
  const { data, error } = await supabase.storage.from("matter-documents").download(storagePath);
  if (error || !data) throw error ?? new Error("The file couldn't be fetched.");
  saveBlob(data, fileName);
}
