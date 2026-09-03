import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { renderAsync } from "docx-preview";
import { ArrowLeftRight, Check, Download, Save, ScanSearch, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useMatterDocuments } from "@/hooks/useMatterDocuments";
import {
  useApplyRedlinesPreview,
  useLatestDocumentVersion,
  useRedlineChat,
  useRedlinePreviewFile,
  useRedlineSuggestions,
  useRunRedlineReview,
  useSetSuggestionStatus,
  type RedlineReviewType,
  type RedlineSuggestion,
} from "@/hooks/useRedline";
import DocumentChatPanel, { type DocumentChatMessage } from "@/components/chat/DocumentChatPanel";
import DocumentUploadCard from "@/components/ai/DocumentUploadCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn, sanitizeStorageFilename } from "@/lib/utils";

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
  content_conflicts: "Content against precedent, and against this matter's other documents for conflicts.",
  chat: "",
};

// For a Word document the before/after text is visible directly in the
// rendered tracked-changes preview, so the list item is just the clause
// reference, rationale and status. For anything else (PDF, Excel,
// PowerPoint) there's no preview to show it in, so `showText` puts the
// original → suggested text on the item itself.
function SuggestionListItem({
  suggestion,
  onAccept,
  onReject,
  disabled,
  showText,
}: {
  suggestion: RedlineSuggestion;
  onAccept: () => void;
  onReject: () => void;
  disabled: boolean;
  showText: boolean;
}) {
  const isPending = suggestion.status === "pending";

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        isPending && "border-amber-300/60 bg-amber-50 dark:border-amber-800/50 dark:bg-amber-950/20",
        suggestion.status === "accepted" &&
          "border-emerald-300/60 bg-emerald-50 dark:border-emerald-800/50 dark:bg-emerald-950/20",
        suggestion.status === "rejected" && "border-border bg-muted/40"
      )}
    >
      {suggestion.clause_reference && (
        <div className="text-xs font-medium text-muted-foreground mb-1">{suggestion.clause_reference}</div>
      )}
      {showText && (suggestion.original_text || suggestion.suggested_text) && (
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
      {suggestion.rationale && <div className="text-xs text-muted-foreground">{suggestion.rationale}</div>}
      {isPending ? (
        <div className="flex gap-2 mt-2">
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

interface VerifyPanelProps {
  matterId: string;
  matterDocumentId: string | undefined;
  onSelectDocument: (matterDocumentId: string | undefined) => void;
}

// Picker (which document to review) wrapping the review session itself. The
// session is keyed on the document id so preview/summary/chat state starts
// clean for every document — the old standalone page got that for free by
// being remounted per route.
export default function VerifyPanel({ matterId, matterDocumentId, onSelectDocument }: VerifyPanelProps) {
  if (!matterDocumentId) {
    return <DocumentPicker matterId={matterId} onSelectDocument={onSelectDocument} />;
  }
  return (
    <ReviewSession
      key={matterDocumentId}
      matterId={matterId}
      matterDocumentId={matterDocumentId}
      onChangeDocument={() => onSelectDocument(undefined)}
    />
  );
}

function DocumentPicker({
  matterId,
  onSelectDocument,
}: {
  matterId: string;
  onSelectDocument: (matterDocumentId: string) => void;
}) {
  const { data: matterDocuments, isLoading } = useMatterDocuments(matterId);

  const reviewable = (matterDocuments ?? []).filter((doc) => ((doc as any).versions?.length ?? 0) > 0);

  return (
    <div className="space-y-6 max-w-4xl">
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Document to review</label>
            {isLoading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : reviewable.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No documents with an uploaded version on this matter yet — upload one below.
              </p>
            ) : (
              <Select value="" onValueChange={onSelectDocument}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a document" />
                </SelectTrigger>
                <SelectContent>
                  {reviewable.map((doc) => {
                    const versions = (doc as any).versions as Array<{ version_number: number; file_name: string | null }>;
                    const latest = versions.reduce((a, b) => (b.version_number > a.version_number ? b : a));
                    const typeName = (doc as any).document_type?.name as string | undefined;
                    return (
                      <SelectItem key={doc.id} value={doc.id}>
                        {doc.title}
                        {typeName ? ` · ${typeName}` : ""}
                        {latest.file_name ? ` · ${latest.file_name}` : ""}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Three review passes — legal clauses &amp; citations, formatting, and content &amp; conflicts — against
            the firm's precedent and this matter's other documents. Word documents get a tracked-changes preview.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <DocumentUploadCard
            matterId={matterId}
            hint="…or upload a new document to review. It's added to the matter like any other upload."
            onUploaded={onSelectDocument}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function ReviewSession({
  matterId,
  matterDocumentId,
  onChangeDocument,
}: {
  matterId: string;
  matterDocumentId: string;
  onChangeDocument: () => void;
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

  const { data: version, isLoading: versionLoading } = useLatestDocumentVersion(matterDocumentId);
  const { data: suggestions } = useRedlineSuggestions(version?.id);
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
  const [applySummary, setApplySummary] = useState<{ appliedCount: number; skippedCount: number } | null>(null);
  const { data: previewBlob } = useRedlinePreviewFile(previewStoragePath);
  const previewRef = useRef<HTMLDivElement>(null);

  const [chatMessages, setChatMessages] = useState<DocumentChatMessage[]>([]);
  const [chatThreadId, setChatThreadId] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const regeneratePreview = async (documentVersionId: string) => {
    if (!canPreview) return;
    try {
      const result = await applyPreview.mutateAsync(documentVersionId);
      setPreviewStoragePath(result.previewStoragePath);
      setApplySummary({ appliedCount: result.appliedCount, skippedCount: result.skippedCount });
    } catch (err: any) {
      toast({ title: "Failed to build tracked-changes preview", description: err.message, variant: "destructive" });
    }
  };

  // Rebuild the preview automatically once suggestions exist and nothing's
  // been generated yet this visit — apply-redlines-to-docx re-downloads the
  // original file itself, so there's nothing that needs to have been
  // generated earlier in the same session.
  useEffect(() => {
    if (canPreview && version?.id && suggestions && suggestions.length > 0 && !previewStoragePath && !applyPreview.isPending) {
      regeneratePreview(version.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version?.id, suggestions, canPreview]);

  useEffect(() => {
    if (previewBlob && previewRef.current) {
      renderAsync(previewBlob, previewRef.current, previewRef.current, {
        renderChanges: true,
        inWrapper: true,
      });
    }
  }, [previewBlob]);

  const handleRunReview = async () => {
    if (!version?.id) return;
    try {
      await runReview.mutateAsync(version.id);
      await regeneratePreview(version.id);
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

  const handleDownload = () => {
    if (!previewBlob) return;
    const url = URL.createObjectURL(previewBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(matterDocument?.title ?? "document").replace(/\s+/g, "-")}-redlined.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // Saves the current tracked-changes preview into the matter's own version
  // history, the same way every other document on the matter is versioned.
  const handleSaveAsVersion = async () => {
    if (!previewBlob) return;
    setSaving(true);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const { count } = await supabase
        .from("document_versions")
        .select("id", { count: "exact", head: true })
        .eq("matter_document_id", matterDocumentId);
      const nextVersion = (count ?? 0) + 1;

      const title = matterDocument?.title ?? "document";
      const fileName = `${title.replace(/\s+/g, "-")}-v${nextVersion}-redlined.docx`;
      const storagePath = `${matterId}/${matterDocumentId}/v${nextVersion}-${sanitizeStorageFilename(fileName)}`;

      const { error: uploadError } = await supabase.storage
        .from("matter-documents")
        .upload(storagePath, previewBlob, {
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
      if (uploadError) throw uploadError;

      const { error: versionError } = await supabase.from("document_versions").insert({
        matter_document_id: matterDocumentId,
        version_number: nextVersion,
        storage_path: storagePath,
        file_name: fileName,
        is_ai_generated: true,
        uploaded_by: userData.user?.id,
      });
      if (versionError) throw versionError;

      // Same RAG ingestion + statute auto-detection every other uploaded
      // document version gets — a redlined save shouldn't be invisible to
      // matter chat or skip Relevant Laws detection just because it didn't
      // come from the file picker.
      const { error: processError } = await supabase.functions.invoke("process-document", {
        body: {
          filePath: storagePath,
          fileName,
          fileType: previewBlob.type,
          bucket: "matter-documents",
          matterId,
          documentTypeId: matterDocument?.document_type_id ?? null,
          isPrecedent: false,
        },
      });
      if (processError) console.error("Redlined draft saved but RAG ingestion failed:", processError);

      toast({ title: "Redlined draft saved as a new document version" });
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
    <div className="space-y-6 max-w-6xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{matterDocument?.title ?? "…"}</span>
          {(matterDocument as any)?.document_type?.name ? ` · ${(matterDocument as any).document_type.name}` : ""}
          {version?.file_name ? ` · ${version.file_name}` : ""}
        </p>
        <Button size="sm" variant="outline" onClick={onChangeDocument}>
          <ArrowLeftRight className="h-4 w-4 mr-2" />
          Choose a different document
        </Button>
      </div>

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
                <Button variant="outline" onClick={handleDownload}>
                  <Download className="h-4 w-4 mr-2" />
                  Download .docx
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
                ? "Running three review passes — legal clauses, formatting, and content — this can take a moment…"
                : "Building tracked-changes preview…"}
            </p>
          )}

          {applySummary && applySummary.skippedCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {applySummary.appliedCount} of {applySummary.appliedCount + applySummary.skippedCount} suggestions
              applied to the document preview — {applySummary.skippedCount} couldn't be precisely located in the
              real file and are only shown in the list below.
            </p>
          )}

          {suggestions && suggestions.length > 0 && (
            canPreview ? (
              <div className="grid md:grid-cols-[1fr_320px] gap-6 items-start">
                <Card>
                  <CardContent className="pt-6">
                    <div ref={previewRef} className="max-h-[75vh] overflow-y-auto overflow-x-auto" />
                  </CardContent>
                </Card>
                {suggestionGroups}
              </div>
            ) : (
              <div className="max-w-3xl">{suggestionGroups}</div>
            )
          )}

          {suggestions && suggestions.length === 0 && !runReview.isPending && runReview.isSuccess && (
            <p className="text-muted-foreground">No material issues flagged.</p>
          )}

          {(runReview.isSuccess || (suggestions && suggestions.length > 0)) && (
            <Card>
              <CardContent className="pt-6 space-y-4">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Continue the conversation
                </p>
                <DocumentChatPanel
                  messages={chatMessages}
                  onSend={handleSendReviewMessage}
                  sending={redlineChat.isPending}
                  placeholder="Ask a question or request another check…"
                  emptyHint='Ask about a suggestion, or request another pass — e.g. "also check the indemnity clause".'
                />
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
