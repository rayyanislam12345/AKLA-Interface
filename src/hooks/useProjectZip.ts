import { useState } from "react";
import { useToast } from "@/hooks/use-toast";
import { downloadZip, todayLabel, versionDownloadName, type ZipEntry, type ZipProgress } from "@/components/documents/zipDownload";
import { plainUploadError } from "@/components/documents/uploadErrors";

// Several project files as one .zip, with progress to show while the files
// are fetched one at a time. Shared by the project page on the site and the
// AI workspace's Files panel; one zip at a time per page.

export type ZipDocVersion = { id: string; version_number: number; storage_path: string; file_name: string | null; label: string | null; created_at: string };
export type ZipDoc = { title: string; versions?: ZipDocVersion[] | null };

export const latestOf = (versions: ZipDocVersion[] | null | undefined) =>
  (versions ?? []).reduce<ZipDocVersion | null>((a, b) => (!a || b.version_number > a.version_number ? b : a), null);

export function useProjectZip({ projectName }: { projectName?: string | null } = {}) {
  const { toast } = useToast();
  const [zipProgress, setZipProgress] = useState<(ZipProgress & { what: string }) | null>(null);

  // One zip, files fetched one at a time, with progress on the card.
  const runZip = async (what: string, entries: ZipEntry[], zipName: string) => {
    if (zipProgress) return;
    if (!entries.length) {
      toast({ title: "Nothing to download", description: "None of these documents has a file yet." });
      return;
    }
    setZipProgress({ what, phase: "fetching", done: 0, total: entries.length, percent: 0 });
    try {
      const { failed } = await downloadZip(entries, zipName, (p) => setZipProgress({ what, ...p }));
      if (failed.length) {
        toast({
          title: `${failed.length} file${failed.length === 1 ? "" : "s"} couldn't be added to the zip`,
          description: `${failed.slice(0, 5).join(", ")}${failed.length > 5 ? "…" : ""}. The rest were downloaded.`,
          variant: "destructive",
        });
      }
    } catch (err) {
      toast({ title: "Couldn't make the zip", description: plainUploadError(err), variant: "destructive" });
    } finally {
      setZipProgress(null);
    }
  };

  /** The latest version of each document, as one zip. */
  const downloadLatestOf = (docs: ZipDoc[], what: string) =>
    runZip(
      what,
      docs.flatMap((d) => {
        const v = latestOf(d.versions);
        return v ? [{ storagePath: v.storage_path, name: versionDownloadName(d.title, v) }] : [];
      }),
      `${projectName ?? "Project"} - documents - ${todayLabel()}.zip`,
    );

  /** Every version of one document, oldest first, as one zip. */
  const downloadAllVersions = (doc: ZipDoc) =>
    runZip(
      `every version of "${doc.title}"`,
      [...(doc.versions ?? [])]
        .sort((a, b) => a.version_number - b.version_number)
        .map((v) => ({ storagePath: v.storage_path, name: versionDownloadName(doc.title, v) })),
      `${doc.title} - all versions - ${todayLabel()}.zip`,
    );

  return { zipProgress, runZip, downloadLatestOf, downloadAllVersions };
}
