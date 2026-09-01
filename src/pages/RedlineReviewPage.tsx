import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { renderAsync } from "docx-preview";
import { Check, Download, Save, ScanSearch, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  useApplyRedlinesPreview,
  useLatestDocumentVersion,
  useRedlineChat,
  useRedlinePreviewFile,
  useRedlineSuggestions,
  useRunRedlineReview,
  useSetSuggestionStatus,
  type RedlineSuggestion,
} from "@/hooks/useRedline";
import DocumentChatPanel, { type DocumentChatMessage } from "@/components/chat/DocumentChatPanel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

function statusBadgeVariant(status: RedlineSuggestion["status"]) {
  if (status === "accepted") return "default" as const;
  if (status === "rejected") return "secondary" as const;
  return "outline" as const;
}

// Just the clause reference/rationale/status now — the actual before/after
// text is visible directly in the real rendered document (tracked changes)
// alongside this list, so repeating it here would be redundant.
function SuggestionListItem({
  suggestion,
  onAccept,
  onReject,
  disabled,
}: {
  suggestion: RedlineSuggestion;
  onAccept: () => void;
  onReject: () => void;
  disabled: boolean;
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

export default function RedlineReviewPage() {
  const { matterId, matterDocumentId } = useParams<{ matterId: string; matterDocumentId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const { data: matterDocument } = useQuery({
    queryKey: ["matter-document", matterDocumentId],
    enabled: !!matterDocumentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("matter_documents")
        .select("id, title, document_type_id, document_type:document_types(name)")
        .eq("id", matterDocumentId!)
        .single();
      if (error) throw error;
      return data;
    },
  });

  const { data: version } = useLatestDocumentVersion(matterDocumentId);
  const { data: suggestions } = useRedlineSuggestions(version?.id);
  const runReview = useRunRedlineReview();
  const setStatus = useSetSuggestionStatus();
  const redlineChat = useRedlineChat();
  const applyPreview = useApplyRedlinesPreview();

  const [previewStoragePath, setPreviewStoragePath] = useState<string | undefined>();
  const [applySummary, setApplySummary] = useState<{ appliedCount: number; skippedCount: number } | null>(null);
  const { data: previewBlob } = useRedlinePreviewFile(previewStoragePath);
  const previewRef = useRef<HTMLDivElement>(null);

  const [chatMessages, setChatMessages] = useState<DocumentChatMessage[]>([]);
  const [chatThreadId, setChatThreadId] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  const regeneratePreview = async (documentVersionId: string) => {
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
  // original file itself, so (unlike the old plain-text flow) there's
  // nothing that needs to have been generated earlier in the same session.
  useEffect(() => {
    if (version?.id && suggestions && suggestions.length > 0 && !previewStoragePath && !applyPreview.isPending) {
      regeneratePreview(version.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version?.id, suggestions]);

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
  // history, the same way every other document on the matter is versioned
  // — previously this page only offered a plain download, with no way to
  // keep the redlined file as part of the matter's record.
  const handleSaveAsVersion = async () => {
    if (!previewBlob || !matterId || !matterDocumentId) return;
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
      const storagePath = `${matterId}/${matterDocumentId}/v${nextVersion}-${fileName}`;

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

  if (!matterId || !matterDocumentId) return null;

  return (
    <div className="space-y-6 max-w-6xl">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <ScanSearch className="h-5 w-5 text-primary" />
          Review with AI
        </h1>
        <p className="text-muted-foreground">
          {matterDocument?.title}
          {(matterDocument as any)?.document_type?.name ? ` · ${(matterDocument as any).document_type.name}` : ""}
        </p>
      </div>

      {!version ? (
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

          {(runReview.isPending || applyPreview.isPending) && (
            <p className="text-muted-foreground">
              {runReview.isPending
                ? "Reviewing against precedent — this can take a moment…"
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
            <div className="grid md:grid-cols-[1fr_320px] gap-6 items-start">
              <Card>
                <CardContent className="pt-6">
                  <div ref={previewRef} className="max-h-[75vh] overflow-y-auto overflow-x-auto" />
                </CardContent>
              </Card>
              <div className="space-y-2">
                {suggestions.map((s) => (
                  <SuggestionListItem
                    key={s.id}
                    suggestion={s}
                    disabled={setStatus.isPending || applyPreview.isPending}
                    onAccept={() => handleSetStatus(s.id, "accepted")}
                    onReject={() => handleSetStatus(s.id, "rejected")}
                  />
                ))}
              </div>
            </div>
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
