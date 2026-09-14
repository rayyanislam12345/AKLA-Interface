import { useEffect, useRef, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { renderAsync } from "docx-preview";
import { clearOutline, outlineSuggestion, suggestionAtPoint } from "@/lib/locateInPreview";
import { AlertTriangle, ArrowLeftRight, Check, Download, ExternalLink, Save, ScanSearch, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { lawUpdateTypeLabel, buildRevisePrompt, type LawUpdate } from "@/hooks/useLawUpdates";
import {
  useApplyRedlinesPreview,
  useLatestDocumentVersion,
  useRedlineChat,
  useReviewRun,
  useRedlinePreviewFile,
  useRedlineSuggestions,
  useRunRedlineReview,
  useSetSuggestionStatus,
  type RedlineReviewType,
  type RedlineSuggestion,
} from "@/hooks/useRedline";
import DocumentChatPanel, { type DocumentChatMessage } from "@/components/chat/DocumentChatPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { saveDraftToMatter } from "@/lib/saveDraftToMatter";
import { cn, sanitizeStorageFilename } from "@/lib/utils";

// The three-pass AI review of one matter document — suggestions grouped by
// pass, accept/reject, a tracked-changes preview of the real .docx, download
// and save-as-version. It used to be the body of the Verify tab; it is now
// what the AI Workspace's artifact panel opens for a "review" artifact, and
// what a Revise link lands on. Everything here is unchanged from that page.

function statusBadgeVariant(status: RedlineSuggestion["status"]) {
  if (status === "accepted") return "default" as const;
  if (status === "rejected") return "secondary" as const;
  return "outline" as const;
}

// "Run AI Review" runs three separate, purpose-built passes (see
// suggest-redline) instead of one generic one — grouping the sidebar by
// review_type keeps that visible instead of flattening them into one list.
const STRUCTURED_REVIEW_TYPES: RedlineReviewType[] = ["legal_clauses", "formatting", "content_conflicts"];

const REVIEW_TYPE_LABELS: Record<RedlineReviewType, string> = {
  legal_clauses: "Legal Clauses & Citations",
  formatting: "Formatting",
  content_conflicts: "Content & Conflicts",
  chat: "From Follow-up Chat",
};

const REVIEW_TYPE_DESCRIPTIONS: Record<RedlineReviewType, string> = {
  legal_clauses: "Clause correctness against statute and precedent, and legal assertions made without citation.",
  formatting: "Structure and formatting against the firm's template and precedent — not clause substance.",
  content_conflicts: "Content against precedent, and against this project's other documents for conflicts.",
  chat: "",
};

// For a Word document the before/after text is visible directly in the
// rendered tracked-changes preview, so the list item is just the clause
// reference, rationale and status. For anything else (PDF, Excel,
// PowerPoint) there's no preview to show it in, so `showText` puts the
// original → suggested text on the item itself.
// Why a suggestion is on the list but not marked in the document, in the
// lawyer's terms. Keys are the reasons the redline builder reports.
const NOT_IN_DOCUMENT: Record<string, string> = {
  overlaps_another_suggestion: "Not marked in the document: another suggestion changes the same words.",
  formatting_only: "Not marked in the document: it changes formatting, not wording.",
  paragraph_structure: "Not marked in the document: it restructures paragraphs or table cells.",
  not_found: "Not marked in the document: its quoted text could not be found in the file.",
  formatting: "Not marked in the document: this passage's formatting cannot be edited safely.",
  missing_text: "Not marked in the document: it has no proposed wording.",
  no_change: "Not marked in the document: the proposed wording is the same as the original.",
};

function SuggestionListItem({
  suggestion,
  onAccept,
  onReject,
  disabled,
  showText,
  selected,
  onSelect,
  notInDocument,
}: {
  suggestion: RedlineSuggestion;
  onAccept: () => void;
  onReject: () => void;
  disabled: boolean;
  showText: boolean;
  selected: boolean;
  onSelect?: () => void;
  notInDocument?: string;
}) {
  const isPending = suggestion.status === "pending";

  return (
    <div
      data-suggestion-id={suggestion.id}
      role={onSelect ? "button" : undefined}
      tabIndex={onSelect ? 0 : undefined}
      aria-pressed={onSelect ? selected : undefined}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (onSelect && (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget) {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        onSelect && "cursor-pointer transition-shadow hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "ring-2 ring-red-600",
        isPending && "border-amber-300/60 bg-amber-50 dark:border-amber-800/50 dark:bg-amber-950/20",
        suggestion.status === "accepted" &&
          "border-emerald-300/60 bg-emerald-50 dark:border-emerald-800/50 dark:bg-emerald-950/20",
        suggestion.status === "rejected" && "border-border bg-muted/40"
      )}
    >
      {suggestion.clause_reference && (
        <div className="text-xs font-medium text-muted-foreground mb-1">{suggestion.clause_reference}</div>
      )}
      {notInDocument && <p className="mb-1.5 text-xs font-medium text-amber-800 dark:text-amber-300">{notInDocument}</p>}
      {(showText || notInDocument) && (suggestion.original_text || suggestion.suggested_text) && (
        <div className="space-y-1 mb-2">
          {suggestion.original_text && (
            <p className="text-xs whitespace-pre-wrap line-through text-red-700/80 dark:text-red-400/80">
              {suggestion.original_text}
            </p>
          )}
          {suggestion.suggested_text && (
            <p className="text-xs whitespace-pre-wrap text-emerald-800 dark:text-emerald-300">
              {suggestion.suggested_text}
            </p>
          )}
        </div>
      )}
      {suggestion.rationale && <div className="whitespace-pre-line text-xs text-muted-foreground">{suggestion.rationale}</div>}
      {isPending ? (
        <div className="flex gap-2 mt-2" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="outline" onClick={onAccept} disabled={disabled}>
            <Check className="h-3.5 w-3.5 mr-1" />
            Accept
          </Button>
          <Button size="sm" variant="ghost" onClick={onReject} disabled={disabled}>
            <X className="h-3.5 w-3.5 mr-1" />
            Reject
          </Button>
        </div>
      ) : (
        <Badge variant={statusBadgeVariant(suggestion.status)} className="capitalize mt-1.5">
          {suggestion.status}
        </Badge>
      )}
    </div>
  );
}


export default function ReviewSession({
  matterId,
  matterDocumentId,
  lawUpdate,
  onChangeDocument,
  documentVersionId,
  reviewRunId,
}: {
  matterId: string;
  matterDocumentId: string;
  documentVersionId?: string;
  reviewRunId?: string;
  lawUpdate: LawUpdate | null;
  // Absent when hosted in the AI Workspace's document panel, where the chat
  // decides which document is under review.
  onChangeDocument?: () => void;
}) {
  const navigate = useNavigate();
  const { toast } = useToast();

  const { data: matterDocument } = useQuery({
    queryKey: ["matter-document", matterDocumentId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("matter_documents")
        .select("id, title, document_type_id, document_type:document_types(name)")
        .eq("id", matterDocumentId)
        .single();
      if (error) throw error;
      return data;
    },
  });

  const { data: version, isLoading: versionLoading } = useLatestDocumentVersion(matterDocumentId, documentVersionId);
  const { data: latestVersion } = useLatestDocumentVersion(matterDocumentId);
  const [selectedRunId, setSelectedRunId] = useState(reviewRunId);
  const { data: reviewRun } = useReviewRun(version?.id, selectedRunId);
  const { data: suggestions } = useRedlineSuggestions(version?.id, reviewRun?.id);
  const runReview = useRunRedlineReview();
  const setStatus = useSetSuggestionStatus();
  const redlineChat = useRedlineChat();
  const applyPreview = useApplyRedlinesPreview();

  // apply-redlines-to-docx patches the real uploaded .docx with OOXML
  // revision marks — it refuses anything else, so for a PDF/Excel/PowerPoint
  // version the review still runs but there's no preview, download or
  // save-as-version, only the suggestion list.
  const canPreview = !!version && version.storage_path.toLowerCase().endsWith(".docx");

  const [previewStoragePath, setPreviewStoragePath] = useState<string | undefined>();
  const [applySummary, setApplySummary] = useState<{ appliedCount: number; skippedCount: number; skipped: Map<string, string> } | null>(null);
  const { data: previewBlob } = useRedlinePreviewFile(previewStoragePath);
  const previewRef = useRef<HTMLDivElement>(null);

  const [chatMessages, setChatMessages] = useState<DocumentChatMessage[]>([]);
  const [chatThreadId, setChatThreadId] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const regeneratePreview = async (documentVersionId: string, runId = reviewRun?.id) => {
    if (!canPreview) return;
    try {
      const result = await applyPreview.mutateAsync({ documentVersionId, reviewRunId: runId });
      setPreviewStoragePath(result.previewStoragePath);
      setApplySummary({
        appliedCount: result.appliedCount,
        skippedCount: result.skippedCount,
        skipped: new Map((result.skipped ?? []).map((item) => [item.suggestionId, item.reason])),
      });
    } catch (err: any) {
      toast({ title: "Failed to build tracked-changes preview", description: err.message, variant: "destructive" });
    }
  };

  useEffect(() => {
    setPreviewStoragePath(undefined);
    setApplySummary(null);
    setChatMessages([]);
    setChatThreadId(undefined);
  }, [version?.id, reviewRun?.id]);

  // Rebuild the preview automatically once suggestions exist and nothing's
  // been generated yet this visit — apply-redlines-to-docx re-downloads the
  // original file itself, so there's nothing that needs to have been
  // generated earlier in the same session.
  useEffect(() => {
    if (canPreview && version?.id && suggestions && suggestions.length > 0 && !previewStoragePath && !applyPreview.isPending) {
      regeneratePreview(version.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version?.id, reviewRun?.id, suggestions, canPreview]);

  // A Word page renders at its real width, about 800 pixels for A4, which is
  // wider than the column beside the suggestions on most screens — so the
  // right-hand side of every page was cut off. Scale the pages down to fit
  // the column instead, and follow the column as the panel is resized.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef<RedlineSuggestion | null>(null);
  // Accepting changes the suggestion's status after it was clicked; the
  // outline redrawn on the rebuilt page has to know which wording it now shows.
  useEffect(() => {
    if (selectedId) selectedRef.current = suggestions?.find((item) => item.id === selectedId) ?? selectedRef.current;
  }, [suggestions, selectedId]);
  const handleSelect = (suggestion: RedlineSuggestion) => {
    const frame = previewRef.current;
    setSelectedId(suggestion.id);
    selectedRef.current = suggestion;
    if (!frame) return;
    if (!outlineSuggestion(frame, suggestion.original_text, suggestion.suggested_text, { accepted: suggestion.status === "accepted" })) {
      clearOutline(frame);
      toast({
        title: "Couldn't find this passage in the document",
        description: "It may not have been applied to the preview. Its wording is on the review record.",
      });
    }
  };

  // Clicking a change in the page opens its suggestion on the right.
  const listRef = useRef<HTMLDivElement>(null);
  const handlePreviewClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const frame = previewRef.current;
    if (!frame || !suggestions?.length) return;
    if (window.getSelection()?.toString()) return; // selecting text to copy
    const open = suggestions.filter((item) => item.status !== "rejected");
    const hit = suggestionAtPoint(frame, event.target as Node, event.clientX, event.clientY, open);
    if (!hit) return;
    setSelectedId(hit.id);
    selectedRef.current = hit;
    outlineSuggestion(frame, hit.original_text, hit.suggested_text, { scroll: false, accepted: hit.status === "accepted" });
    const card = listRef.current?.querySelector<HTMLElement>(`[data-suggestion-id="${hit.id}"]`);
    const list = listRef.current;
    if (!card || !list) return;
    if (list.scrollHeight > list.clientHeight + 1) {
      // Beside the page: scroll the list alone, so the page stays put.
      // A card taller than the list is shown from its heading down.
      const top = card.offsetHeight > list.clientHeight - 16 ? card.offsetTop - 8 : card.offsetTop - list.clientHeight / 2 + card.offsetHeight / 2;
      list.scrollTo({ top, behavior: "smooth" });
    } else {
      card.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  };

  const pageWidth = useRef(0);
  const fitPreview = useCallback(() => {
    const frame = previewRef.current;
    const wrapper = frame?.querySelector<HTMLElement>(".docx-wrapper");
    if (!frame || !wrapper || !pageWidth.current) return;
    wrapper.style.setProperty("zoom", String(Math.min(1, frame.clientWidth / pageWidth.current)));
    const selected = selectedRef.current;
    if (selected && frame.querySelector(".review-locate-outline")) outlineSuggestion(frame, selected.original_text, selected.suggested_text, { scroll: false, accepted: selected.status === "accepted" });
  }, []);

  useEffect(() => {
    if (!previewBlob || !previewRef.current) return;
    const frame = previewRef.current;
    let cancelled = false;
    renderAsync(previewBlob, frame, frame, { renderChanges: true, inWrapper: true }).then(() => {
      const wrapper = frame.querySelector<HTMLElement>(".docx-wrapper");
      if (cancelled || !wrapper) return;
      const pages = [...wrapper.querySelectorAll<HTMLElement>("section.docx")];
      const padding = parseFloat(getComputedStyle(wrapper).paddingLeft) + parseFloat(getComputedStyle(wrapper).paddingRight);
      pageWidth.current = Math.max(0, ...pages.map((page) => page.offsetWidth)) + padding;
      fitPreview();
      // Accepting or rejecting rebuilds the page; keep the clicked item marked.
      const selected = selectedRef.current;
      if (selected) outlineSuggestion(frame, selected.original_text, selected.suggested_text, { accepted: selected.status === "accepted" });
    });
    const observer = new ResizeObserver(fitPreview);
    observer.observe(frame);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [previewBlob, fitPreview]);

  const handleRunReview = async () => {
    if (!version?.id) return;
    try {
      const result = await runReview.mutateAsync(version.id);
      setSelectedRunId(result.reviewRunId);
      setPreviewStoragePath(undefined);
      await regeneratePreview(version.id, result.reviewRunId);
    } catch (err: any) {
      toast({ title: "Review failed", description: err.message, variant: "destructive" });
    }
  };

  const handleSendReviewMessage = async (text: string) => {
    if (!version?.id) return;
    setChatMessages((prev) => [...prev, { role: "user", content: text }]);
    try {
      const result = await redlineChat.mutateAsync({
        documentVersionId: version.id,
        threadId: chatThreadId,
        reviewRunId: reviewRun?.id,
        instruction: text,
      });
      setChatThreadId(result.threadId);
      setChatMessages((prev) => [...prev, { role: "assistant", content: result.reply }]);
      if (result.newSuggestions.length > 0) await regeneratePreview(version.id);
    } catch (err: any) {
      toast({ title: "Message failed", description: err.message, variant: "destructive" });
    }
  };

  const handleSetStatus = async (suggestionId: string, status: "accepted" | "rejected") => {
    if (!version?.id) return;
    try {
      await setStatus.mutateAsync({ suggestionId, status, documentVersionId: version.id });
      await regeneratePreview(version.id);
    } catch (err: any) {
      toast({ title: "Failed to update suggestion", description: err.message, variant: "destructive" });
    }
  };

  // The download is for deciding changes in Word, so every suggestion that
  // has not been rejected arrives as a tracked change, accepted ones too.
  // The page shows accepted ones written in; that copy is not what Word needs.
  const [downloading, setDownloading] = useState(false);
  const handleDownload = async () => {
    if (!previewBlob || !version?.id) return;
    setDownloading(true);
    try {
      let blob: Blob = previewBlob;
      let untracked = 0;
      const base = (import.meta.env.VITE_CHAT_API_URL as string | undefined)?.replace(/\/$/, "");
      if (base) {
        const { data: sessionData } = await supabase.auth.getSession();
        const token = sessionData.session?.access_token;
        if (!token) throw new Error("Not signed in");
        const resp = await fetch(`${base}/review/download`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ documentVersionId: version.id, reviewRunId: reviewRun?.id }),
        });
        if (!resp.ok) {
          const payload = await resp.json().catch(() => ({}));
          throw new Error(payload.error ?? `Could not build the Word file (${resp.status})`);
        }
        blob = await resp.blob();
        untracked = Number(resp.headers.get("X-Changes-Not-Tracked") ?? 0);
      }
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(matterDocument?.title ?? "document").replace(/\s+/g, "-")}-redlined.docx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      if (untracked > 0) {
        toast({
          title: "Downloaded with tracked changes",
          description: `${untracked} suggestion${untracked === 1 ? "" : "s"} could not be written as tracked changes. Their cards say why.`,
        });
      }
    } catch (err: any) {
      toast({ title: "Download failed", description: err.message, variant: "destructive" });
    } finally {
      setDownloading(false);
    }
  };

  // Saves the current tracked-changes preview into the matter's own version
  // history, the same way every other document on the matter is versioned.
  const handleSaveAsVersion = async () => {
    if (!previewBlob) return;
    setSaving(true);
    try {
      if (!matterDocument?.document_type_id || !version) throw new Error("Document type and source version are required");
      const result = await saveDraftToMatter({ matterId, documentTypeId: matterDocument.document_type_id, documentTypeName: matterDocument.title, blob: previewBlob,
        matterDocumentId, title: matterDocument.title, expectedVersionId: version.id });
      toast({ title: `Saved as v${result.versionNumber}`, description: result.indexed ? result.fileName : "Saved, but search indexing failed. Reprocess the document before using it in Ask AI." });
      navigate(`/matters/${matterId}`);
    } catch (err: any) {
      toast({ title: "Failed to save version", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const suggestionGroups = (
    <div className="space-y-5">
      {STRUCTURED_REVIEW_TYPES.map((type) => {
        const group = (suggestions ?? []).filter((s) => s.review_type === type);
        return (
          <div key={type} className="space-y-2">
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                {REVIEW_TYPE_LABELS[type]}
                {group.length > 0 ? ` (${group.length})` : ""}
              </p>
              <p className="text-[11px] text-muted-foreground/80">{REVIEW_TYPE_DESCRIPTIONS[type]}</p>
            </div>
            {group.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">Nothing flagged in this pass.</p>
            ) : (
              group.map((s) => (
                <SuggestionListItem
                  key={s.id}
                  suggestion={s}
                  showText={!canPreview}
                  selected={selectedId === s.id}
                  onSelect={canPreview ? () => handleSelect(s) : undefined}
                  notInDocument={canPreview && s.status !== "rejected" && applySummary?.skipped.has(s.id) ? NOT_IN_DOCUMENT[applySummary.skipped.get(s.id)!] ?? "Not marked in the document." : undefined}
                  disabled={setStatus.isPending || applyPreview.isPending}
                  onAccept={() => handleSetStatus(s.id, "accepted")}
                  onReject={() => handleSetStatus(s.id, "rejected")}
                />
              ))
            )}
          </div>
        );
      })}
      {(suggestions ?? []).some((s) => s.review_type === "chat") && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            {REVIEW_TYPE_LABELS.chat}
          </p>
          {(suggestions ?? [])
            .filter((s) => s.review_type === "chat")
            .map((s) => (
              <SuggestionListItem
                key={s.id}
                suggestion={s}
                showText={!canPreview}
                selected={selectedId === s.id}
                onSelect={canPreview ? () => handleSelect(s) : undefined}
                  notInDocument={canPreview && s.status !== "rejected" && applySummary?.skipped.has(s.id) ? NOT_IN_DOCUMENT[applySummary.skipped.get(s.id)!] ?? "Not marked in the document." : undefined}
                disabled={setStatus.isPending || applyPreview.isPending}
                onAccept={() => handleSetStatus(s.id, "accepted")}
                onReject={() => handleSetStatus(s.id, "rejected")}
              />
            ))}
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{matterDocument?.title ?? "…"}</span>
          {(matterDocument as any)?.document_type?.name ? ` · ${(matterDocument as any).document_type.name}` : ""}
          {version?.file_name ? ` · ${version.file_name}` : ""}
        </p>
        {onChangeDocument && (
          <Button size="sm" variant="outline" onClick={onChangeDocument}>
            <ArrowLeftRight className="h-4 w-4 mr-2" />
            Choose a different document
          </Button>
        )}
      </div>

      {documentVersionId && latestVersion && latestVersion.id !== documentVersionId && (
        <p className="rounded border border-amber-400 p-3 text-sm">This review is pinned to v{version?.version_number}. The project now has v{latestVersion.version_number}; that newer version has not been checked by this review.</p>
      )}
      {reviewRun && (
        <div className="rounded border p-3 text-sm space-y-1" data-testid="review-status">
          <p className="font-medium">Review {reviewRun.status === "complete" ? "checks finished — lawyer review required" : reviewRun.status}</p>
          {reviewRun.error && <p className="text-destructive">{reviewRun.error}</p>}
          {(() => {
            const research = (reviewRun.coverage as { research?: { status: string; unresolved?: string[]; sourcesChecked?: number } | null } | null)?.research;
            if (!research) return <p className="text-muted-foreground">Law lookup: not run for this review.</p>;
            return (
              <p>
                Law lookup: {research.status === "failed" ? "could not finish" : `${research.sourcesChecked ?? 0} official source${research.sourcesChecked === 1 ? "" : "s"} checked (${research.status})`}
                {research.unresolved?.length ? ` — ${research.unresolved.slice(0, 3).join("; ")}` : ""}
              </p>
            );
          })()}
          {Object.entries((reviewRun.passes ?? {}) as Record<string, { status: string; note?: string }>).map(([key, pass]) => (
            <p key={key}>{REVIEW_TYPE_LABELS[key as RedlineReviewType] ?? key}: {pass.status.replace(/_/g, " ")}{pass.note ? ` — ${pass.note}` : ""}</p>
          ))}
          <p className="text-muted-foreground">Results apply to this file and the retrieved evidence. An empty list is not a legal clearance.</p>
        </div>
      )}
      {lawUpdate && (
        <Card className="border-amber-400/60 bg-amber-50 dark:border-amber-700/50 dark:bg-amber-950/20">
          <CardContent className="pt-6">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-500 shrink-0 mt-0.5" />
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">
                  Reviewing against a change to {lawUpdate.act_name ?? "a relevant law"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {lawUpdateTypeLabel(lawUpdate.update_type)}: {lawUpdate.title}
                  {lawUpdate.authority_ref ? ` · ${lawUpdate.authority_ref}` : ""}
                  {lawUpdate.published_date ? ` · ${lawUpdate.published_date}` : ""} · {lawUpdate.source_name}
                </p>
                {lawUpdate.summary && <p className="text-xs text-muted-foreground">{lawUpdate.summary}</p>}
                {(lawUpdate.document_url || lawUpdate.source_url) && (
                  <a
                    href={lawUpdate.document_url || lawUpdate.source_url || undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-primary inline-flex items-center gap-1 hover:underline"
                  >
                    Read the source <ExternalLink className="h-3 w-3" />
                  </a>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {versionLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !version ? (
        <p className="text-muted-foreground">No document version to review yet — upload one first.</p>
      ) : (
        <>
          <div className="flex gap-2 items-center flex-wrap">
            <Button onClick={handleRunReview} disabled={runReview.isPending || applyPreview.isPending}>
              <ScanSearch className="h-4 w-4 mr-2" />
              {suggestions?.length ? "Re-run AI Review" : "Run AI Review"}
            </Button>
            {previewBlob && (
              <>
                <Button variant="outline" onClick={handleDownload} disabled={downloading}>
                  <Download className="h-4 w-4 mr-2" />
                  {downloading ? "Preparing…" : "Download .docx with tracked changes"}
                </Button>
                <Button variant="outline" onClick={handleSaveAsVersion} disabled={saving}>
                  <Save className="h-4 w-4 mr-2" />
                  {saving ? "Saving…" : "Save as Document Version"}
                </Button>
              </>
            )}
          </div>

          {!canPreview && (
            <p className="text-xs text-muted-foreground">
              Tracked-changes preview, download and save-as-version are only available for Word (.docx) documents —
              for this file the suggestions are listed with their original and proposed text.
            </p>
          )}

          {(runReview.isPending || applyPreview.isPending) && (
            <p className="text-muted-foreground">
              {runReview.isPending
                ? "Looking up the law that applies on official sources, then running three review passes — legal clauses, formatting, and content. This takes a few minutes…"
                : "Building tracked-changes preview…"}
            </p>
          )}

          {applySummary && applySummary.skippedCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {applySummary.appliedCount} of {applySummary.appliedCount + applySummary.skippedCount} open suggestions
              are marked in the document. Each of the others says on its card why it is not, and shows its wording there.
            </p>
          )}

          {suggestions && suggestions.length > 0 && (
            canPreview ? (
              // Sized by the space the panel actually has, not the screen: the
              // suggestions sit beside the page when both fit, and drop below
              // it when they do not.
              <div className="flex flex-wrap items-start gap-6">
                <Card className="min-w-0 flex-[1_1_560px]">
                  <CardContent className="p-3">
                    <div
                      ref={previewRef}
                      onClick={handlePreviewClick}
                      className="relative max-h-[80vh] overflow-y-auto overflow-x-hidden [&_del]:cursor-pointer [&_del]:text-[#c00000] [&_del]:line-through [&_ins]:cursor-pointer [&_ins]:text-[#c00000] [&_ins]:underline"
                    />
                  </CardContent>
                </Card>
                <div ref={listRef} className="relative min-w-[260px] flex-[0_1_340px] lg:max-h-[80vh] lg:overflow-y-auto lg:pr-1">{suggestionGroups}</div>
              </div>
            ) : (
              <div className="max-w-3xl">{suggestionGroups}</div>
            )
          )}

          {suggestions && suggestions.length === 0 && !runReview.isPending && runReview.isSuccess && (
            <p className="text-muted-foreground">No material issues flagged.</p>
          )}

          {/* Normally the conversation opens once a review has produced
              something to talk about. Arriving from a "Revise" link is the
              exception: the pre-written instruction has to have somewhere to
              land even on a document nobody has reviewed yet. */}
          {(runReview.isSuccess || (suggestions && suggestions.length > 0) || lawUpdate) && (
            <Card className={cn(lawUpdate && "border-amber-400/60")}>
              <CardContent className="pt-6 space-y-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  {lawUpdate ? "Revise against this change" : "Continue the conversation"}
                </p>
                <DocumentChatPanel
                  messages={chatMessages}
                  onSend={handleSendReviewMessage}
                  sending={redlineChat.isPending}
                  placeholder="Ask a question or request another check…"
                  emptyHint={
                    lawUpdate
                      ? "Read the instruction below, adjust it if you want, then send it to review this document against the change."
                      : 'Ask about a suggestion, or request another pass — e.g. "also check the indemnity clause".'
                  }
                  initialInput={
                    lawUpdate ? buildRevisePrompt(lawUpdate, matterDocument?.title ?? undefined) : undefined
                  }
                />
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
