// What the companion's "Copy for Claude" buttons put on the clipboard, for
// the lawyer to paste into the claude.ai chat beside the drawer, and the
// project's recent arrivals the drawer lists. Pure, so
// tests/copyForClaude.test.js runs it in Node.

export interface VersionForClaude {
  title: string;
  versionId: string;
  versionNumber: number;
  fileName?: string | null;
  projectName?: string | null;
}

/** A stored version: its name, its version id and its Hub address, so Claude can reach the exact version through the connector. */
export function versionForClaudeText({ title, versionId, versionNumber, fileName, projectName }: VersionForClaude, origin: string): string {
  const what = [`v${versionNumber}`, fileName ? `(${fileName})` : null, projectName ? `in project ${projectName}` : null].filter(Boolean).join(" ");
  return [`Hub document: ${title}, ${what}`, `versionId: ${versionId}`, `Open in Hub: ${origin}/ai/d/${versionId}`].join("\n");
}

/** A project's standing instructions, ready to paste; null when there are none. */
export function instructionsForClaudeText(projectName: string, content: string | null | undefined): string | null {
  const body = (content ?? "").trim();
  if (!body) return null;
  return `Standing instructions for project ${projectName}:\n\n${body}`;
}

interface VersionLike {
  id: string;
  version_number: number;
  created_at: string;
}

/** The newest versions added across a project's documents, newest first, each with its document. */
export function recentVersions<D extends { versions?: VersionLike[] | null }>(documents: D[], limit = 5): Array<{ doc: D; version: NonNullable<D["versions"]>[number] }> {
  const all = documents.flatMap((doc) => (doc.versions ?? []).map((version) => ({ doc, version: version as NonNullable<D["versions"]>[number] })));
  all.sort((a, b) => new Date(b.version.created_at).getTime() - new Date(a.version.created_at).getTime() || b.version.version_number - a.version.version_number);
  return all.slice(0, Math.max(0, limit));
}
