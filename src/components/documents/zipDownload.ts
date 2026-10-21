import JSZip from "jszip";
import { supabase } from "@/integrations/supabase/client";
import { formatShortDate, safeDownloadName } from "@/lib/fileNames";
import { whileCompanionBusy } from "@/lib/companionBusy";

// Several project files as one .zip, built in the browser. Files are fetched
// one at a time and stored without recompression (Word and PDF files are
// already compressed), so a large bundle costs little more memory than the
// files themselves.

export interface ZipEntry {
  storagePath: string;
  /** The name inside the zip. */
  name: string;
}

export interface ZipProgress {
  phase: "fetching" | "packing";
  done: number;
  total: number;
  /** 0..100 */
  percent: number;
}

export function extensionFor(version: { file_name: string | null; storage_path: string }): string {
  const m = (version.file_name || version.storage_path).match(/\.([a-z0-9]{1,10})$/i);
  return m ? m[1].toLowerCase() : "bin";
}

/** "<Title> v<n> <label>.<ext>" */
export function versionDownloadName(title: string, version: { version_number: number; label: string | null; file_name: string | null; storage_path: string }): string {
  const label = version.label?.trim();
  return safeDownloadName(`${title} v${version.version_number}${label ? ` ${label}` : ""}.${extensionFor(version)}`);
}

export function todayLabel(): string {
  const d = new Date();
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return formatShortDate(iso);
}

export function saveBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Some browsers read the blob after click() returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function uniqueName(name: string, used: Set<string>): string {
  let candidate = name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base} (${n})${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Fetches each file, packs them and saves the zip. Returns the names that
 * could not be fetched; throws if none could.
 */
export async function downloadZip(
  entries: ZipEntry[],
  zipName: string,
  onProgress: (p: ZipProgress) => void,
): Promise<{ failed: string[] }> {
  // Being made: the companion leaves the page alone meanwhile.
  return whileCompanionBusy(() => packZip(entries, zipName, onProgress));
}

async function packZip(entries: ZipEntry[], zipName: string, onProgress: (p: ZipProgress) => void): Promise<{ failed: string[] }> {
  const zip = new JSZip();
  const used = new Set<string>();
  const failed: string[] = [];
  const total = entries.length;
  onProgress({ phase: "fetching", done: 0, total, percent: 0 });
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const { data, error } = await supabase.storage.from("matter-documents").download(entry.storagePath);
    if (error || !data) failed.push(entry.name);
    else zip.file(uniqueName(entry.name, used), data, { binary: true });
    onProgress({ phase: "fetching", done: i + 1, total, percent: Math.round(((i + 1) / total) * 90) });
  }
  if (failed.length === total) throw new Error("None of the files could be downloaded. Check your connection and try again.");
  const blob = await zip.generateAsync({ type: "blob", compression: "STORE", streamFiles: true }, (meta) =>
    onProgress({ phase: "packing", done: total, total, percent: 90 + Math.round(meta.percent / 10) }),
  );
  saveBlob(blob, safeDownloadName(zipName, 180));
  return { failed };
}
