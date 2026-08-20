import { useState } from "react";
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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

function statusBadgeVariant(status: RedlineSuggestion["status"]) {
  if (status === "accepted") return "default" as const;
  if (status === "rejected") return "secondary" as const;
  return "outline" as const;
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

          {suggestions && suggestions.length > 0 && (
            <div className="space-y-3">
              {suggestions.map((s) => (
                <Card key={s.id}>
                  <CardHeader className="flex flex-row items-center justify-between pb-2">
                    <CardTitle className="text-sm font-medium">{s.clause_reference}</CardTitle>
                    <Badge variant={statusBadgeVariant(s.status)} className="capitalize">
                      {s.status}
                    </Badge>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <p className="text-muted-foreground line-through">{s.original_text}</p>
                    <p>{s.suggested_text}</p>
                    <p className="text-xs text-muted-foreground italic">{s.rationale}</p>
                    {s.status === "pending" && (
                      <div className="flex gap-2 pt-1">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setStatus.mutate({ suggestionId: s.id, status: "accepted", documentVersionId: version.id })
                          }
                        >
                          <Check className="h-4 w-4 mr-1" />
                          Accept
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setStatus.mutate({ suggestionId: s.id, status: "rejected", documentVersionId: version.id })
                          }
                        >
                          <X className="h-4 w-4 mr-1" />
                          Reject
                        </Button>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
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
          {!fullText && suggestions && suggestions.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Run the review again in this session to enable export (the source text isn't cached across visits yet).
            </p>
          )}
        </>
      )}
    </div>
  );
}
