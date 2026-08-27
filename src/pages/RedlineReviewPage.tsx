import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { Check, Download, ScanSearch, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import {
  useLatestDocumentVersion,
  useRedlineSuggestions,
  useRunRedlineReview,
  useSetSuggestionStatus,
  type RedlineSuggestion,
} from "@/hooks/useRedline";
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

type Segment =
  | { type: "text"; content: string }
  | { type: "change"; suggestion: RedlineSuggestion };

// suggest-redline returns each suggestion's flagged clause as a verbatim
// substring of fullText — locate each one's real position so changes can
// render inline, in reading order, instead of as detached snippet cards
// with no surrounding context. A suggestion whose original_text doesn't
// match verbatim (the LLM paraphrased instead of quoting exactly) can't be
// placed in the flow — those fall back to a plain list below the document
// rather than silently disappearing.
function buildRedlineSegments(fullText: string, suggestions: RedlineSuggestion[]) {
  const located = suggestions
    .filter((s) => s.original_text)
    .map((s) => {
      const start = fullText.indexOf(s.original_text!);
      return start === -1 ? null : { start, end: start + s.original_text!.length, suggestion: s };
    })
    .filter((m): m is { start: number; end: number; suggestion: RedlineSuggestion } => m !== null)
    .sort((a, b) => a.start - b.start);

  const matches: typeof located = [];
  let cursor = 0;
  for (const m of located) {
    if (m.start < cursor) continue; // overlapping match — keep the earlier one
    matches.push(m);
    cursor = m.end;
  }

  const segments: Segment[] = [];
  let pos = 0;
  for (const m of matches) {
    if (m.start > pos) segments.push({ type: "text", content: fullText.slice(pos, m.start) });
    segments.push({ type: "change", suggestion: m.suggestion });
    pos = m.end;
  }
  if (pos < fullText.length) segments.push({ type: "text", content: fullText.slice(pos) });

  const matchedIds = new Set(matches.map((m) => m.suggestion.id));
  const unanchored = suggestions.filter((s) => !matchedIds.has(s.id));
  return { segments, unanchored };
}

function RedlineChangeBlock({
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
  const isRejected = suggestion.status === "rejected";

  return (
    <div
      className={cn(
        "my-2 rounded-md border px-3 py-2 text-sm",
        isPending && "border-amber-300/60 bg-amber-50 dark:border-amber-800/50 dark:bg-amber-950/20",
        suggestion.status === "accepted" &&
          "border-emerald-300/60 bg-emerald-50 dark:border-emerald-800/50 dark:bg-emerald-950/20",
        isRejected && "border-border bg-muted/40"
      )}
    >
      {suggestion.clause_reference && (
        <div className="text-xs font-medium text-muted-foreground mb-1">{suggestion.clause_reference}</div>
      )}
      {suggestion.original_text && (
        <div
          className={cn(
            "whitespace-pre-wrap",
            !isRejected && "text-destructive/80 line-through"
          )}
        >
          {suggestion.original_text}
        </div>
      )}
      {!isRejected && suggestion.suggested_text && (
        <div className="whitespace-pre-wrap text-emerald-700 underline decoration-emerald-400/60 dark:text-emerald-400">
          {suggestion.suggested_text}
        </div>
      )}
      {suggestion.rationale && (
        <div className="text-xs text-muted-foreground italic mt-1">{suggestion.rationale}</div>
      )}
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

  const [fullText, setFullText] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const handleRunReview = async () => {
    if (!version?.id) return;
    try {
      const result = await runReview.mutateAsync(version.id);
      setFullText(result.fullText);
    } catch (err: any) {
      toast({ title: "Review failed", description: err.message, variant: "destructive" });
    }
  };

  const acceptedCount = suggestions?.filter((s) => s.status === "accepted").length ?? 0;

  const { segments: redlineSegments, unanchored: unanchoredSuggestions } = useMemo(
    () => (fullText && suggestions ? buildRedlineSegments(fullText, suggestions) : { segments: [], unanchored: [] }),
    [fullText, suggestions]
  );

  const handleExport = async () => {
    if (!fullText || !version || !matterDocumentId || !matterId) return;
    setExporting(true);
    try {
      let finalText = fullText;
      for (const s of suggestions ?? []) {
        if (s.status === "accepted" && s.original_text && s.suggested_text) {
          finalText = finalText.replace(s.original_text, s.suggested_text);
        }
      }

      const { data: userData } = await supabase.auth.getUser();
      const { count } = await supabase
        .from("document_versions")
        .select("id", { count: "exact", head: true })
        .eq("matter_document_id", matterDocumentId);
      const nextVersion = (count ?? 0) + 1;

      const paragraphs = finalText
        .split(/\n+/)
        .filter((line) => line.trim().length > 0)
        .map((line) => new Paragraph({ children: [new TextRun(line)] }));
      const document = new Document({ sections: [{ children: paragraphs }] });
      const blob = await Packer.toBlob(document);

      const title = matterDocument?.title ?? "document";
      const fileName = `${title.replace(/\s+/g, "-")}-v${nextVersion}-redlined.docx`;
      const storagePath = `${matterId}/${matterDocumentId}/v${nextVersion}-${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from("matter-documents")
        .upload(storagePath, blob, {
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
      if (uploadError) throw uploadError;

      const { error: versionError } = await supabase.from("document_versions").insert({
        matter_document_id: matterDocumentId,
        version_number: nextVersion,
        storage_path: storagePath,
        is_ai_generated: false,
        uploaded_by: userData.user?.id,
      });
      if (versionError) throw versionError;

      toast({ title: "Clean revised draft saved as a new version" });
      navigate(`/matters/${matterId}`);
    } catch (err: any) {
      toast({ title: "Export failed", description: err.message, variant: "destructive" });
    } finally {
      setExporting(false);
    }
  };

  if (!matterId || !matterDocumentId) return null;

  return (
    <div className="space-y-6 max-w-4xl">
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
          <Button onClick={handleRunReview} disabled={runReview.isPending}>
            <ScanSearch className="h-4 w-4 mr-2" />
            {suggestions?.length ? "Re-run AI Review" : "Run AI Review"}
          </Button>

          {runReview.isPending && (
            <p className="text-muted-foreground">Reviewing against precedent — this can take a moment…</p>
          )}

          {suggestions && suggestions.length > 0 && fullText && (
            <Card>
              <CardContent className="pt-6">
                <div className="max-w-none text-sm leading-relaxed">
                  {redlineSegments.map((seg, i) =>
                    seg.type === "text" ? (
                      <div key={i} className="whitespace-pre-wrap">
                        {seg.content}
                      </div>
                    ) : (
                      <RedlineChangeBlock
                        key={seg.suggestion.id}
                        suggestion={seg.suggestion}
                        disabled={setStatus.isPending}
                        onAccept={() =>
                          setStatus.mutate({ suggestionId: seg.suggestion.id, status: "accepted", documentVersionId: version.id })
                        }
                        onReject={() =>
                          setStatus.mutate({ suggestionId: seg.suggestion.id, status: "rejected", documentVersionId: version.id })
                        }
                      />
                    )
                  )}
                </div>

                {unanchoredSuggestions.length > 0 && (
                  <div className="mt-6 pt-4 border-t space-y-3">
                    <p className="text-xs text-muted-foreground">
                      These flagged clauses couldn't be matched back to an exact spot in the document text, so they're
                      listed separately instead of inline:
                    </p>
                    {unanchoredSuggestions.map((s) => (
                      <RedlineChangeBlock
                        key={s.id}
                        suggestion={s}
                        disabled={setStatus.isPending}
                        onAccept={() =>
                          setStatus.mutate({ suggestionId: s.id, status: "accepted", documentVersionId: version.id })
                        }
                        onReject={() =>
                          setStatus.mutate({ suggestionId: s.id, status: "rejected", documentVersionId: version.id })
                        }
                      />
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {suggestions && suggestions.length > 0 && !fullText && (
            <p className="text-sm text-muted-foreground">
              Run the review again in this session to see suggestions in context against the full document (the
              source text isn't cached across visits yet).
            </p>
          )}

          {suggestions && suggestions.length === 0 && !runReview.isPending && runReview.isSuccess && (
            <p className="text-muted-foreground">No material issues flagged.</p>
          )}

          {fullText && (
            <Button
              onClick={handleExport}
              disabled={exporting || acceptedCount === 0}
              className={cn(acceptedCount === 0 && "opacity-60")}
            >
              <Download className="h-4 w-4 mr-2" />
              Export Clean Revised Draft ({acceptedCount} accepted)
            </Button>
          )}
        </>
      )}
    </div>
  );
}
