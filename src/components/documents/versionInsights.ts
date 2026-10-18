import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

// The proof check and the comparison with the previous version that the
// index worker stores on each version (document_versions.proof_check,
// changes_from_previous, compared_with_version_id; chat-service/proofCheck.js
// and versionCompare.js), plus the chat service's on-demand routes for a
// version not read yet or a comparison with an older version.

export type Severity = "high" | "medium" | "low";

export interface ProofItem {
  category: string;
  severity: Severity;
  where: string;
  text: string;
  note: string;
  find?: string;
  kind?: string;
}

export interface ProofCheck {
  checked_at?: string;
  counts?: Record<string, number>;
  total?: number;
  items?: ProofItem[];
  omitted?: Record<string, number>;
  notes?: string[];
  error?: string;
  skipped?: string;
}

export type ChangeKind = "changed" | "added" | "removed" | "moved";

export interface ChangeItem {
  where: string;
  kind: ChangeKind;
  nature: string;
  before: string;
  after: string;
  noise?: string;
}

export interface VersionChanges {
  compared_at?: string;
  previous?: { version_id: string; version_number: number; file_name: string | null };
  counts?: Record<ChangeKind, number>;
  natures?: Record<string, number>;
  shown?: number;
  hidden?: number;
  items?: ChangeItem[];
  omitted?: number;
  notes?: string[];
  identical?: boolean;
  unrelated?: boolean;
  error?: string;
  skipped?: string;
}

export interface VersionInsights {
  /** False when the columns are not there yet (the migration is not applied). */
  available: boolean;
  indexingStatus: string | null;
  proofCheck: ProofCheck | null;
  changes: VersionChanges | null;
  comparedWithId: string | null;
}

export const CATEGORY_ORDER = ["broken_references", "number_words", "placeholders", "undefined_terms", "numbering", "unused_definitions"];

export const CATEGORY_LABELS: Record<string, string> = {
  placeholders: "Blanks and placeholders",
  undefined_terms: "Terms used but not defined",
  unused_definitions: "Definitions never used",
  broken_references: "References to clauses that don't exist",
  number_words: "Numbers in words and figures that disagree",
  numbering: "Gaps in numbering",
};

export const NATURE_LABELS: Record<string, string> = {
  wording: "Wording",
  numbers_dates_names: "Numbers, dates or names",
  definitions: "Definitions",
  clause_added: "Clause added",
  clause_removed: "Clause removed",
  schedule: "Schedule or annex",
  renumbering: "Renumbering",
  formatting_only: "Formatting only",
};

export const KIND_LABELS: Record<ChangeKind, string> = { changed: "Changed", added: "Added", removed: "Removed", moved: "Moved" };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Loads one version's stored checks; re-run with reload(). */
export function useVersionInsights(versionId: string | undefined) {
  const [state, setState] = useState<{ forId: string | null; loading: boolean; error: string | null; data: VersionInsights | null }>({ forId: null, loading: false, error: null, data: null });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!versionId) return;
    let cancelled = false;
    // A reload keeps what is on screen; another version starts empty.
    setState((s) => ({ forId: versionId, loading: true, error: null, data: s.forId === versionId ? s.data : null }));
    (async () => {
      // select("*"): the new columns are not in the generated types, and a
      // database without them still answers.
      const { data, error } = await supabase.from("document_versions").select("*").eq("id", versionId).maybeSingle();
      if (cancelled) return;
      if (error || !data) {
        setState({ forId: versionId, loading: false, error: "The checks for this version couldn't be loaded.", data: null });
        return;
      }
      const row = data as unknown as Record<string, unknown>;
      setState({
        forId: versionId,
        loading: false,
        error: null,
        data: {
          available: "proof_check" in row,
          indexingStatus: typeof row.indexing_status === "string" ? row.indexing_status : null,
          proofCheck: isObject(row.proof_check) ? (row.proof_check as ProofCheck) : null,
          changes: isObject(row.changes_from_previous) ? (row.changes_from_previous as VersionChanges) : null,
          comparedWithId: typeof row.compared_with_version_id === "string" ? row.compared_with_version_id : null,
        },
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [versionId, tick]);

  const current = state.forId === versionId;
  return { loading: !current || state.loading, error: current ? state.error : null, data: current ? state.data : null, reload };
}

// ------------------------------------------------------------ on demand

export const chatApiBase = () => (import.meta.env.VITE_CHAT_API_URL as string | undefined)?.replace(/\/$/, "") || null;

async function getJson<T>(path: string): Promise<T> {
  const base = chatApiBase();
  if (!base) throw new Error("Checking on request isn't available here.");
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData.session?.access_token;
  if (!token) throw new Error("Not signed in");
  const resp = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error((payload as { error?: string }).error ?? `The server answered ${resp.status}`);
  return payload as T;
}

export const checkOnDemand = (versionId: string) => getJson<ProofCheck>(`/documents/check?versionId=${encodeURIComponent(versionId)}`);
export const compareOnDemand = (fromId: string, toId: string) =>
  getJson<VersionChanges>(`/documents/compare?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}`);

// ------------------------------------------------------------ word highlights

export interface Segment {
  text: string;
  changed: boolean;
}

/** Marks the words that differ between before and after (whole words, spaces kept). */
export function wordSegments(before: string, after: string): { before: Segment[]; after: Segment[] } {
  const a = before.split(/(\s+)/).filter((t) => t !== "");
  const b = after.split(/(\s+)/).filter((t) => t !== "");
  if (!a.length || !b.length || a.length * b.length > 250_000) {
    return { before: before ? [{ text: before, changed: !after }] : [], after: after ? [{ text: after, changed: !before }] : [] };
  }
  const n = a.length;
  const m = b.length;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const outA: Segment[] = [];
  const outB: Segment[] = [];
  const push = (list: Segment[], text: string, changed: boolean) => {
    const changedNow = changed && /\S/.test(text);
    const last = list[list.length - 1];
    if (last && last.changed === changedNow) last.text += text;
    else list.push({ text, changed: changedNow });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { push(outA, a[i], false); push(outB, b[j], false); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push(outA, a[i], true); i++; }
    else { push(outB, b[j], true); j++; }
  }
  for (; i < n; i++) push(outA, a[i], true);
  for (; j < m; j++) push(outB, b[j], true);
  return { before: outA, after: outB };
}

// ------------------------------------------------------------ finding text in the preview

const squash = (s: string) => s.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();

/** Scrolls the Word preview to the paragraph holding the text, and flashes it. */
export function scrollPreviewTo(container: HTMLElement | null, text: string): boolean {
  if (!container) return false;
  const needle = squash(text.replace(/^…|…$/g, ""));
  if (!needle) return false;
  const tries = [needle, needle.slice(0, 40), needle.slice(-40), needle.slice(0, 20)].filter((t) => t.length >= 8);
  const blocks = Array.from(container.querySelectorAll<HTMLElement>("p, td, li"));
  for (const t of tries) {
    const hit = blocks.find((el) => squash(el.textContent ?? "").includes(t));
    if (hit) {
      // Found now; scrolled once the Document tab is showing again.
      window.setTimeout(() => {
        hit.scrollIntoView({ block: "center", behavior: "smooth" });
        const previous = hit.style.backgroundColor;
        hit.style.transition = "background-color 0.3s";
        hit.style.backgroundColor = "rgba(250, 204, 21, 0.45)";
        window.setTimeout(() => {
          hit.style.backgroundColor = previous;
        }, 2500);
      }, 80);
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------------ export

const safeName = (s: string) => s.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Document";

/** Builds the change list as a Word table (A4 landscape) and downloads it. */
export async function exportChangesToWord({
  title,
  fromVersion,
  toVersion,
  items,
  hiddenFormatting,
}: {
  title: string;
  fromVersion: number;
  toVersion: number;
  items: ChangeItem[];
  hiddenFormatting: number;
}) {
  const { AlignmentType, Document, Packer, PageOrientation, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, WidthType } = await import("docx");
  const font = "Arial";
  const size = 18; // 9 pt, in half-points
  const cell = (text: string, opts: { bold?: boolean; header?: boolean; width: number }) =>
    new TableCell({
      width: { size: opts.width, type: WidthType.PERCENTAGE },
      shading: opts.header ? { type: ShadingType.CLEAR, color: "auto", fill: "002060" } : undefined,
      children: (text || "—").split("\n").map((line) => new Paragraph({ children: [new TextRun({ text: line, font, size, bold: opts.bold || opts.header, color: opts.header ? "FFC000" : undefined })] })),
    });
  const widths = [14, 9, 13, 32, 32];
  const header = new TableRow({
    tableHeader: true,
    children: ["Where", "Change", "Nature", `Before (v${fromVersion})`, `After (v${toVersion})`].map((t, i) => cell(t, { header: true, width: widths[i] })),
  });
  const rows = items.map((it) => new TableRow({
    children: [
      cell(it.where, { bold: true, width: widths[0] }),
      cell(KIND_LABELS[it.kind] ?? it.kind, { width: widths[1] }),
      cell(NATURE_LABELS[it.nature] ?? it.nature, { width: widths[2] }),
      cell(it.before, { width: widths[3] }),
      cell(it.after, { width: widths[4] }),
    ],
  }));
  const doc = new Document({
    sections: [{
      properties: { page: { size: { orientation: PageOrientation.LANDSCAPE } } },
      children: [
        new Paragraph({ alignment: AlignmentType.LEFT, children: [new TextRun({ text: `${title}: what changed from v${fromVersion} to v${toVersion}`, font, size: 28, bold: true })] }),
        new Paragraph({
          spacing: { after: 200 },
          children: [new TextRun({
            text: `${items.length} change${items.length === 1 ? "" : "s"}${hiddenFormatting ? `; ${hiddenFormatting} formatting-only change${hiddenFormatting === 1 ? "" : "s"} left out` : ""}. Exported ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}.`,
            font,
            size,
            color: "595959",
          })],
        }),
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [header, ...rows] }),
      ],
    }],
  });
  const blob = await Packer.toBlob(doc);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${safeName(title)} - changes v${fromVersion} to v${toVersion}.docx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
