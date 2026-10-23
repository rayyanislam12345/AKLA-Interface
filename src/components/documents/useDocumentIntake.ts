import { useCallback, useEffect, useReducer, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { indexStoredVersion, saveDraftToMatter, storageStem } from "@/lib/saveDraftToMatter";
import {
  compareVersionOrder,
  findMatchingDocument,
  parseFileName,
  versionLabel,
  type ParsedFileName,
} from "@/lib/fileNames";
import {
  fetchProjectContentHashes,
  fetchStoredFileSizes,
  saveVersionDetails,
} from "@/hooks/useMatterDocuments";
import { useCompanionBusy } from "@/lib/companionBusy";
import { guessDocumentType, statusFromStage } from "@/lib/documentDefaults";
import { collectFromDrop, collectFromFileList, extensionOf, sha256, type Collected } from "./collectFiles";
import { plainUploadError } from "./uploadErrors";

// The project page's bulk intake. Files dropped or picked are checked
// (fingerprinted, matched to the project's documents, duplicates set aside),
// shown as a list the lawyer confirms with one Start, then sent two at a
// time. Versions of one document go up one after another, oldest first, so
// version numbers follow the dates in the names.

export interface IntakeDocument {
  id: string;
  title: string;
  document_type_id: string | null;
  versions?: Array<{ id: string; storage_path: string; file_name: string | null }> | null;
}

export type IntakeStatus =
  | "checking"
  | "ready"
  | "waiting"
  | "uploading"
  | "reading"
  | "searchable"
  | "saved"
  | "duplicate"
  | "failed";

export interface IntakeItem {
  id: string;
  file: File;
  path: string;
  parsed: ParsedFileName;
  label: string;
  hash: string | null;
  /** A project document this file looks like a version of. */
  match: { id: string; title: string; exact: boolean } | null;
  /** The lawyer's choice; null means "go with the suggestion's default". */
  asVersion: boolean | null;
  /** Which document chain it joins; fixed when Start is pressed. */
  chainKey: string | null;
  status: IntakeStatus;
  note?: string;
  duplicateOf?: "project" | "upload";
  result?: { matterDocumentId: string; versionId: string; versionNumber: number };
}

export type IntakeAction =
  | { kind: "existing"; docId: string; title: string }
  | { kind: "batch"; leaderId: string; title: string }
  | { kind: "new"; title: string }
  | { kind: "skip" };

export interface IntakePlanRow {
  action: IntakeAction;
  /** What the toggle offers, if anything. */
  suggestion: { kind: "existing"; title: string; exact: boolean } | { kind: "batch"; title: string } | null;
  asVersion: boolean;
}

const UPLOAD_SLOTS = 2;
const READ_SLOTS = 2;

const FINISHED: IntakeStatus[] = ["searchable", "saved", "duplicate"];
const ACTIVE: IntakeStatus[] = ["waiting", "uploading"];

/** What will happen to each file, recomputed from the list as it stands. */
export function computePlan(items: IntakeItem[]): Map<string, IntakePlanRow> {
  const plan = new Map<string, IntakePlanRow>();
  const leaders = new Map<string, IntakeItem>();
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const item of items) {
    if (item.status === "duplicate") {
      plan.set(item.id, { action: { kind: "skip" }, suggestion: null, asVersion: false });
      continue;
    }
    if (item.chainKey) {
      // Already started: the chain decides.
      if (item.chainKey.startsWith("doc:")) {
        plan.set(item.id, { action: { kind: "existing", docId: item.chainKey.slice(4), title: item.match?.title ?? item.parsed.title }, suggestion: null, asVersion: true });
      } else {
        const leaderId = item.chainKey.slice(4);
        if (leaderId === item.id) {
          plan.set(item.id, { action: { kind: "new", title: item.parsed.title }, suggestion: null, asVersion: false });
          if (!leaders.has(item.parsed.familyKey)) leaders.set(item.parsed.familyKey, item);
        } else {
          const leader = byId.get(leaderId);
          plan.set(item.id, { action: { kind: "batch", leaderId, title: leader?.parsed.title ?? item.parsed.title }, suggestion: null, asVersion: true });
        }
      }
      continue;
    }
    // Files of one family share a match. Once an earlier one is set to become
    // a new document, the later ones follow it rather than the project's
    // document it declined, so one family never splits into two documents.
    const leader = leaders.get(item.parsed.familyKey);
    const suggestion: IntakePlanRow["suggestion"] = leader
      ? { kind: "batch", title: leader.parsed.title }
      : item.match
        ? { kind: "existing", title: item.match.title, exact: item.match.exact }
        : null;
    const asVersion = item.asVersion ?? (suggestion ? (suggestion.kind === "batch" ? true : suggestion.exact) : false);
    let action: IntakeAction;
    if (asVersion && leader) action = { kind: "batch", leaderId: leader.id, title: leader.parsed.title };
    else if (asVersion && item.match) action = { kind: "existing", docId: item.match.id, title: item.match.title };
    else {
      action = { kind: "new", title: item.parsed.title };
      if (!leader) leaders.set(item.parsed.familyKey, item);
    }
    plan.set(item.id, { action, suggestion, asVersion: !!suggestion && asVersion });
  }
  return plan;
}

function chainKeyFor(item: IntakeItem, row: IntakePlanRow | undefined): string {
  if (row?.action.kind === "existing") return `doc:${row.action.docId}`;
  if (row?.action.kind === "batch") return `own:${row.action.leaderId}`;
  return `own:${item.id}`;
}

// The stored name is "<stem>-v<n>.<ext>"; this is the stem part.
function storedStem(fileName: string | null): string | null {
  if (!fileName) return null;
  return fileName.replace(/-v\d+\.[a-z0-9]+$/i, "");
}

function sortItems(items: IntakeItem[]) {
  items.sort((a, b) => {
    const fam = a.parsed.familyKey.localeCompare(b.parsed.familyKey);
    if (fam) return fam;
    return (
      compareVersionOrder({ parsed: a.parsed, lastModified: a.file.lastModified }, { parsed: b.parsed, lastModified: b.file.lastModified }) ||
      a.file.name.localeCompare(b.file.name)
    );
  });
}

export function useDocumentIntake({
  matterId,
  documents,
  onSaved,
  onReading,
}: {
  matterId: string | undefined;
  documents: IntakeDocument[];
  onSaved: () => void;
  onReading: (versionId: string, on: boolean) => void;
}) {
  const itemsRef = useRef<IntakeItem[]>([]);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const problemsRef = useRef<string[]>([]);
  const gatheringRef = useRef(0);
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  const callbacks = useRef({ onSaved, onReading });
  callbacks.current = { onSaved, onReading };

  const chains = useRef(new Map<string, { docId: string | null; busy: boolean }>());
  const uploadsRunning = useRef(0);
  const readQueue = useRef<Array<() => Promise<void>>>([]);
  const readsRunning = useRef(0);
  // Hashes known to be in the project → the document they belong to.
  const projectHashes = useRef(new Map<string, string>());
  const sizeCache = useRef(new Map<string, Promise<Map<string, number>>>());

  const update = useCallback((id: string, patch: Partial<IntakeItem>) => {
    const item = itemsRef.current.find((i) => i.id === id);
    if (item) Object.assign(item, patch);
    rerender();
  }, []);

  // A new project means a new list.
  useEffect(() => {
    itemsRef.current = [];
    problemsRef.current = [];
    chains.current.clear();
    projectHashes.current.clear();
    sizeCache.current.clear();
    rerender();
  }, [matterId]);

  // Suggestions follow the project's documents as they change (a colleague
  // adds one, or this upload creates one) until the lawyer presses Start.
  useEffect(() => {
    let changed = false;
    for (const item of itemsRef.current) {
      if (item.status !== "ready" && item.status !== "checking") continue;
      const m = findMatchingDocument(item.parsed.familyKey, documents);
      const next = m ? { id: m.document.id, title: m.document.title, exact: m.exact } : null;
      if (next?.id !== item.match?.id || next?.exact !== item.match?.exact) {
        item.match = next;
        changed = true;
      }
    }
    if (changed) rerender();
  }, [documents]);

  // Leaving the page mid-upload would drop the rest of the list.
  const hasActive = itemsRef.current.some((i) => ACTIVE.includes(i.status));
  useEffect(() => {
    if (!hasActive) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasActive]);

  // Beside a claude.ai chat, a list being read, waiting for Start or going up
  // keeps the companion from switching the page (src/lib/companionBusy.ts).
  useCompanionBusy(
    gatheringRef.current > 0 ||
      itemsRef.current.some((i) => i.status === "checking" || i.status === "ready" || ACTIVE.includes(i.status) || i.status === "reading"),
  );

  const isAlreadyStored = async (item: IntakeItem): Promise<string | null> => {
    if (!matterId) return null;
    const stem = storageStem(item.file.name.replace(/\.[^.]+$/, ""));
    const ext = extensionOf(item.file.name);
    for (const doc of documentsRef.current) {
      for (const v of doc.versions ?? []) {
        if (storedStem(v.file_name) !== stem || extensionOf(v.file_name ?? "") !== ext) continue;
        let sizes = sizeCache.current.get(doc.id);
        if (!sizes) {
          sizes = fetchStoredFileSizes(matterId, doc.id);
          sizeCache.current.set(doc.id, sizes);
        }
        // Same name is not enough: a document is often re-saved under one name.
        if ((await sizes).get(v.storage_path) === item.file.size) return doc.title;
      }
    }
    return null;
  };

  const check = async (fresh: IntakeItem[]) => {
    if (matterId) {
      const hashes = await fetchProjectContentHashes(matterId);
      if (hashes) {
        const titleByVersion = new Map<string, string>();
        for (const d of documentsRef.current) for (const v of d.versions ?? []) titleByVersion.set(v.id, d.title);
        for (const [versionId, hash] of hashes) projectHashes.current.set(hash, titleByVersion.get(versionId) ?? "");
      }
    }
    for (const item of fresh) {
      if (!itemsRef.current.includes(item)) continue;
      const hash = await sha256(item.file);
      item.hash = hash;
      const earlier = itemsRef.current.find(
        (o) =>
          o !== item &&
          o.status !== "duplicate" &&
          o.status !== "checking" &&
          o.status !== "failed" &&
          (hash && o.hash ? o.hash === hash : o.file.name === item.file.name && o.file.size === item.file.size && o.file.lastModified === item.file.lastModified),
      );
      const inProject = hash ? projectHashes.current.get(hash) : undefined;
      if (inProject !== undefined) {
        update(item.id, { status: "duplicate", duplicateOf: "project", note: inProject ? `Already in the project as "${inProject}".` : "Already in the project." });
        continue;
      }
      if (earlier) {
        update(item.id, { status: "duplicate", duplicateOf: "upload", note: `Same file as "${earlier.file.name}" in this list.` });
        continue;
      }
      const storedAs = await isAlreadyStored(item).catch(() => null);
      if (storedAs !== null) {
        update(item.id, { status: "duplicate", duplicateOf: "project", note: `Already in the project as "${storedAs}" (same name and size).` });
        continue;
      }
      update(item.id, { status: "ready" });
    }
  };

  const addCollected = useCallback(
    async (collected: Collected) => {
      if (collected.problems.length) problemsRef.current = [...problemsRef.current, ...collected.problems];
      const fresh: IntakeItem[] = collected.files.map(({ file, path }) => {
        const parsed = parseFileName(file.name);
        const m = findMatchingDocument(parsed.familyKey, documentsRef.current);
        return {
          id: crypto.randomUUID(),
          file,
          path,
          parsed,
          label: versionLabel(parsed),
          hash: null,
          match: m ? { id: m.document.id, title: m.document.title, exact: m.exact } : null,
          asVersion: null,
          chainKey: null,
          status: "checking" as const,
        };
      });
      itemsRef.current.push(...fresh);
      sortItems(itemsRef.current);
      rerender();
      await check(fresh);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [matterId],
  );

  const gather = async (collecting: Promise<Collected>) => {
    gatheringRef.current++;
    rerender();
    try {
      await addCollected(await collecting);
    } finally {
      gatheringRef.current--;
      rerender();
    }
  };

  /** From a file picker (files or a folder). */
  const addFiles = (list: FileList | File[]) => void gather(collectFromFileList(list));
  /** From a drop: call straight from the drop handler. */
  const addDrop = (dataTransfer: DataTransfer) => void gather(collectFromDrop(dataTransfer));

  const pumpReads = () => {
    while (readsRunning.current < READ_SLOTS && readQueue.current.length) {
      const job = readQueue.current.shift()!;
      readsRunning.current++;
      void job().finally(() => {
        readsRunning.current--;
        pumpReads();
      });
    }
  };

  // The firm's document types, read once per batch for the type a file's
  // name implies.
  const documentTypes = useRef<Promise<Array<{ id: string; name: string }>> | null>(null);
  const loadDocumentTypes = () =>
    (documentTypes.current ??= Promise.resolve(supabase.from("document_types").select("id, name"))
      .then(({ data }) => data ?? [])
      .catch(() => []));

  const upload = async (item: IntakeItem) => {
    const chain = chains.current.get(item.chainKey!)!;
    update(item.id, { status: "uploading", note: undefined });
    let result: Awaited<ReturnType<typeof saveDraftToMatter>>;
    let documentTypeId: string | null = null;
    let documentTitle = item.parsed.title;
    try {
      const extension = extensionOf(item.file.name) || "bin";
      const fileStem = item.file.name.replace(/\.[^.]+$/, "");
      if (chain.docId) {
        // Read the document's type and latest version just before saving, as
        // a single upload does, so a colleague's change a moment ago is fine.
        const [{ data: stored }, { data: latest }] = await Promise.all([
          supabase.from("matter_documents").select("document_type_id, title").eq("id", chain.docId).maybeSingle(),
          supabase.from("document_versions").select("id").eq("matter_document_id", chain.docId)
            .order("version_number", { ascending: false }).limit(1).maybeSingle(),
        ]);
        if (!stored) throw new Error("The document this was going to be added to has been removed from the project.");
        documentTypeId = stored.document_type_id;
        documentTitle = stored.title;
        result = await saveDraftToMatter({
          matterId: matterId!, matterDocumentId: chain.docId, documentTypeId, documentTypeName: item.file.name,
          title: item.parsed.title, fileStem, blob: item.file, expectedVersionId: latest?.id ?? null,
          isAiGenerated: false, extension, skipIndex: true,
        });
      } else {
        documentTypeId = guessDocumentType(item.parsed.title, await loadDocumentTypes())?.id ?? null;
        result = await saveDraftToMatter({
          matterId: matterId!, documentTypeId, documentTypeName: item.file.name,
          title: item.parsed.title, fileStem, blob: item.file, isAiGenerated: false, extension, skipIndex: true,
        });
        chain.docId = result.matterDocumentId;
      }
    } catch (err) {
      update(item.id, { status: "failed", note: plainUploadError(err) });
      return;
    }
    await saveVersionDetails(result.versionId, { label: item.label || null, contentHash: item.hash }).catch(() => undefined);
    // A new document starts as "drafting" unless its name says more; a new
    // version moves the status only when its name carries a stage tag.
    const status = statusFromStage(item.parsed.stage) ?? (result.versionNumber === 1 ? "drafting" : null);
    if (status) {
      await Promise.resolve(supabase.from("matter_documents").update({ status }).eq("id", result.matterDocumentId)).catch(() => undefined);
    }
    if (item.hash) projectHashes.current.set(item.hash, documentTitle);
    const saved = { matterDocumentId: result.matterDocumentId, versionId: result.versionId, versionNumber: result.versionNumber };
    callbacks.current.onSaved();
    if (result.unsupported) {
      update(item.id, { status: "saved", result: saved, note: "This file type can't be read for search. It is saved and can be downloaded." });
      return;
    }
    update(item.id, { status: "reading", result: saved });
    readQueue.current.push(async () => {
      callbacks.current.onReading(result.versionId, true);
      const indexed = await indexStoredVersion({
        versionId: result.versionId, matterId: matterId!, documentTypeId, storagePath: result.storagePath,
        fileName: result.fileName, fileType: item.file.type,
      }).catch(() => false);
      callbacks.current.onReading(result.versionId, false);
      callbacks.current.onSaved();
      update(item.id, indexed
        ? { status: "searchable", note: undefined }
        : { status: "saved", note: "Saved, but search and Ask AI couldn't read it yet. It will be tried again; you can also press Try again on the version." });
    });
    pumpReads();
  };

  const pump = () => {
    while (uploadsRunning.current < UPLOAD_SLOTS) {
      const next = itemsRef.current.find((i) => i.status === "waiting" && i.chainKey && !chains.current.get(i.chainKey)?.busy);
      if (!next) return;
      const key = next.chainKey!;
      if (!chains.current.has(key)) chains.current.set(key, { docId: key.startsWith("doc:") ? key.slice(4) : null, busy: false });
      const chain = chains.current.get(key)!;
      chain.busy = true;
      uploadsRunning.current++;
      next.status = "uploading";
      void upload(next).finally(() => {
        chain.busy = false;
        uploadsRunning.current--;
        pump();
        rerender();
      });
    }
  };

  const start = () => {
    if (!matterId) return;
    const plan = computePlan(itemsRef.current);
    for (const item of itemsRef.current) {
      if (item.status !== "ready") continue;
      item.chainKey = chainKeyFor(item, plan.get(item.id));
      item.status = "waiting";
    }
    rerender();
    pump();
  };

  const retry = (id: string) => {
    const item = itemsRef.current.find((i) => i.id === id);
    if (!item || item.status !== "failed") return;
    if (!item.chainKey) item.chainKey = `own:${item.id}`;
    update(id, { status: "waiting", note: undefined });
    pump();
  };

  const remove = (id: string) => {
    itemsRef.current = itemsRef.current.filter((i) => i.id !== id || ACTIVE.includes(i.status) || i.status === "reading");
    rerender();
  };

  const clearFinished = () => {
    itemsRef.current = itemsRef.current.filter((i) => !FINISHED.includes(i.status));
    problemsRef.current = [];
    rerender();
  };

  const clearAll = () => {
    itemsRef.current = itemsRef.current.filter((i) => ACTIVE.includes(i.status) || i.status === "reading");
    problemsRef.current = [];
    rerender();
  };

  const setAsVersion = (id: string, value: boolean) => update(id, { asVersion: value });

  const applyAllSuggestions = () => {
    const plan = computePlan(itemsRef.current);
    for (const item of itemsRef.current) {
      if (item.status === "ready" && plan.get(item.id)?.suggestion) item.asVersion = true;
    }
    rerender();
  };

  const items = itemsRef.current;
  return {
    items,
    plan: computePlan(items),
    problems: problemsRef.current,
    gathering: gatheringRef.current > 0,
    checking: items.some((i) => i.status === "checking"),
    readyCount: items.filter((i) => i.status === "ready").length,
    running: items.some((i) => ACTIVE.includes(i.status) || i.status === "reading"),
    addFiles,
    addDrop,
    start,
    retry,
    remove,
    clearFinished,
    clearAll,
    setAsVersion,
    applyAllSuggestions,
  };
}

export type DocumentIntake = ReturnType<typeof useDocumentIntake>;
