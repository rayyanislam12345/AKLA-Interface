// A stored version as the document viewer, the preview sheet and the AI
// workspace's document window pass it around.

export interface PreviewVersion {
  id: string;
  version_number: number;
  storage_path: string;
  file_name: string | null;
  label: string | null;
  created_at: string;
}

export function versionOptionLabel(v: PreviewVersion) {
  return `v${v.version_number}${v.label ? ` · ${v.label}` : ""}`;
}

/** Newest first. */
export function sortVersions(versions: PreviewVersion[] | null | undefined): PreviewVersion[] {
  return [...(versions ?? [])].sort((a, b) => b.version_number - a.version_number);
}
