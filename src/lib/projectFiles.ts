// The AI workspace's Files panel: a project's documents grouped by the
// category of their document type, each with its latest version to hand.
// Pure, so tests/projectFiles.test.js runs it in Node.

export interface FileVersionLike {
  id: string;
  version_number: number;
  created_at: string;
  storage_path: string;
  file_name: string | null;
}

export interface FileDocumentLike<V extends FileVersionLike = FileVersionLike> {
  id: string;
  title: string;
  document_type_id: string | null;
  versions?: V[] | null;
}

export interface DocumentTypeLike {
  id: string;
  name: string;
  category: string;
}

export const NO_TYPE_GROUP = "Other documents";

export interface FileGroup<D extends FileDocumentLike> {
  category: string;
  documents: Array<{ doc: D; latest: NonNullable<D["versions"]>[number] | null; typeName: string | null }>;
}

/** The newest version of a document, by version number. */
export function latestVersionOf<V extends FileVersionLike>(versions: V[] | null | undefined): V | null {
  return (versions ?? []).reduce<V | null>((a, b) => (!a || b.version_number > a.version_number ? b : a), null);
}

/**
 * Groups documents by their type's category, categories in the order the
 * types list gives them (the library's order), untyped documents last.
 * Within a group, documents keep the order they came in (newest first).
 */
export function groupDocumentsByCategory<D extends FileDocumentLike>(documents: D[], types: DocumentTypeLike[]): FileGroup<D>[] {
  const typeById = new Map(types.map((t) => [t.id, t]));
  const order: string[] = [];
  for (const t of types) if (!order.includes(t.category)) order.push(t.category);
  const groups = new Map<string, FileGroup<D>>();
  for (const doc of documents) {
    const type = doc.document_type_id ? typeById.get(doc.document_type_id) : undefined;
    const category = type?.category ?? NO_TYPE_GROUP;
    const group = groups.get(category) ?? { category, documents: [] };
    group.documents.push({ doc, latest: latestVersionOf(doc.versions) as FileGroup<D>["documents"][number]["latest"], typeName: type?.name ?? null });
    groups.set(category, group);
  }
  const rank = (c: string) => (c === NO_TYPE_GROUP ? Number.MAX_SAFE_INTEGER : order.indexOf(c) === -1 ? order.length : order.indexOf(c));
  return [...groups.values()].sort((a, b) => rank(a.category) - rank(b.category) || a.category.localeCompare(b.category));
}

/** The attachment a chat is handed for a stored version: the file as the chat server reads it. */
export function attachmentForVersion(doc: { id: string; title: string }, version: FileVersionLike) {
  return {
    bucket: "matter-documents",
    path: version.storage_path,
    name: version.file_name || `${doc.title} v${version.version_number}`,
    matterDocumentId: doc.id,
    versionId: version.id,
  };
}
