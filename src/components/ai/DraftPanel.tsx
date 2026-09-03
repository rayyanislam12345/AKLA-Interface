import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Editor } from "@tiptap/react";
import { marked } from "marked";
import { renderAsync } from "docx-preview";
import { FileText, Save } from "lucide-react";
import RichTextEditor from "@/components/editor/RichTextEditor";
import { useDocumentTypes } from "@/hooks/useMatterDocuments";
import { useDraftingInterview, useGenerateDraft, useReviseDraft } from "@/hooks/useDrafting";
import { supabase } from "@/integrations/supabase/client";
import DocumentChatPanel, { type DocumentChatMessage } from "@/components/chat/DocumentChatPanel";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { buildFirmDocxBlob, type PMNode } from "@/lib/firmDocx";
import { sanitizeStorageFilename } from "@/lib/utils";

interface DraftPanelProps {
  matterId: string;
  matterName: string | undefined;
}

// Interview → draft → edit/preview → save as a matter document version. All
// the firm .docx styling lives in src/lib/firmDocx.ts; this panel only owns
// the conversation and editor state.
export default function DraftPanel({ matterId, matterName }: DraftPanelProps) {
  const navigate = useNavigate();
  const { toast } = useToast();

  const { data: documentTypes } = useDocumentTypes();
  const interviewMutation = useDraftingInterview();
  const draftMutation = useGenerateDraft();
  const reviseMutation = useReviseDraft();

  const [documentTypeId, setDocumentTypeId] = useState<string>("");
  const [started, setStarted] = useState(false);

  const [messages, setMessages] = useState<DocumentChatMessage[]>([]);
  const [threadId, setThreadId] = useState<string | undefined>();
  const [isReadyToDraft, setIsReadyToDraft] = useState(false);

  const [draft, setDraft] = useState<string | null>(null);
  const [precedentCount, setPrecedentCount] = useState(0);
  const [hasTemplate, setHasTemplate] = useState(false);
  const [saving, setSaving] = useState(false);

  const editorRef = useRef<Editor | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<"edit" | "preview">("edit");
  const [buildingPreview, setBuildingPreview] = useState(false);

  const documentTypeName = useMemo(
    () => documentTypes?.find((t) => t.id === documentTypeId)?.name ?? "Document",
    [documentTypes, documentTypeId]
  );

  const editorContent = useMemo(
    () => (draft ? (marked.parse(draft, { async: false }) as string) : ""),
    [draft]
  );

  const handleStart = async () => {
    if (!documentTypeId) return;
    setStarted(true);
    try {
      const result = await interviewMutation.mutateAsync({ matterId, documentTypeId });
      setThreadId(result.threadId);
      setMessages([{ role: "assistant", content: result.reply }]);
      setIsReadyToDraft(result.isReadyToDraft);
    } catch (err: any) {
      setStarted(false);
      toast({ title: "Couldn't start the interview", description: err.message, variant: "destructive" });
    }
  };

  // Continues the same chat log before and after a draft exists — before,
  // it's the intake interview (drafting-interview); after, each message is
  // a follow-up revision/question against the live draft (draft-document's
  // revise branch), so the conversation reads as one continuous session.
  const handleSendChatMessage = async (text: string) => {
    if (!documentTypeId) return;
    setMessages((prev) => [...prev, { role: "user", content: text }]);
    try {
      if (!draft) {
        const result = await interviewMutation.mutateAsync({
          matterId,
          documentTypeId,
          threadId,
          message: text,
        });
        setThreadId(result.threadId);
        setMessages((prev) => [...prev, { role: "assistant", content: result.reply }]);
        setIsReadyToDraft(result.isReadyToDraft);
      } else {
        const result = await reviseMutation.mutateAsync({
          matterId,
          documentTypeId,
          threadId,
          currentDraft: draft,
          instruction: text,
        });
        setMessages((prev) => [...prev, { role: "assistant", content: result.reply }]);
        if (result.documentChanged) setDraft(result.updatedDraft);
      }
    } catch (err: any) {
      toast({ title: "Message failed", description: err.message, variant: "destructive" });
    }
  };

  const handleGenerateDraft = async () => {
    if (!documentTypeId) return;
    try {
      const result = await draftMutation.mutateAsync({
        matterId,
        documentTypeId,
        threadId,
      });
      setDraft(result.draft);
      setPrecedentCount(result.precedentCount);
      setHasTemplate(result.hasTemplate);
    } catch (err: any) {
      toast({ title: "Draft generation failed", description: err.message, variant: "destructive" });
    }
  };

  // Builds the same firm-styled .docx both "Save as Document Version" and
  // the live preview tab use — reads the editor's *current* ProseMirror
  // JSON at call time, so it reflects manual in-editor edits too, not just
  // whatever the AI last generated.
  const buildDocxBlob = async (): Promise<Blob | null> => {
    const editor = editorRef.current;
    if (!editor) return null;
    const draftDate = new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
    const headerTitle = `${matterName ?? ""} — ${documentTypeName} — AKLA — Draft, For Internal Purposes Only — ${draftDate}`;
    return buildFirmDocxBlob(editor.getJSON() as PMNode, headerTitle);
  };

  const renderPreview = async () => {
    setBuildingPreview(true);
    try {
      const blob = await buildDocxBlob();
      if (blob && previewRef.current) {
        previewRef.current.innerHTML = "";
        await renderAsync(blob, previewRef.current, previewRef.current, { inWrapper: true });
      }
    } catch (err: any) {
      toast({ title: "Failed to build preview", description: err.message, variant: "destructive" });
    } finally {
      setBuildingPreview(false);
    }
  };

  const handleTabChange = (value: string) => {
    setActiveTab(value as "edit" | "preview");
    if (value === "preview") renderPreview();
  };

  // A chat revision can update the draft while the preview tab is already
  // open — keep it in sync rather than showing stale content.
  useEffect(() => {
    if (activeTab === "preview") renderPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const handleSaveAsVersion = async () => {
    if (!documentTypeId) return;
    setSaving(true);
    try {
      // Build the file first — if the export can't be produced there's nothing
      // to save, and creating the matter document before knowing that would
      // leave an empty, version-less document behind on the matter.
      const blob = await buildDocxBlob();
      if (!blob) throw new Error("Editor is not ready yet");

      const { data: userData } = await supabase.auth.getUser();

      // Find or create the matter_document for this document type
      const { data: existing } = await supabase
        .from("matter_documents")
        .select("id")
        .eq("matter_id", matterId)
        .eq("document_type_id", documentTypeId)
        .limit(1)
        .maybeSingle();

      let matterDocumentId = existing?.id;
      if (!matterDocumentId) {
        const { data: created, error: createError } = await supabase
          .from("matter_documents")
          .insert({
            matter_id: matterId,
            document_type_id: documentTypeId,
            title: `${documentTypeName} (AI draft)`,
            status: "drafting",
            created_by: userData.user?.id,
          })
          .select("id")
          .single();
        if (createError) throw createError;
        matterDocumentId = created.id;
      }

      const { count } = await supabase
        .from("document_versions")
        .select("id", { count: "exact", head: true })
        .eq("matter_document_id", matterDocumentId);
      const nextVersion = (count ?? 0) + 1;

      const fileName = `${documentTypeName.replace(/\s+/g, "-")}-v${nextVersion}.docx`;
      const storagePath = `${matterId}/${matterDocumentId}/v${nextVersion}-${sanitizeStorageFilename(fileName)}`;

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
        file_name: fileName,
        is_ai_generated: true,
        uploaded_by: userData.user?.id,
      });
      if (versionError) throw versionError;

      // Same RAG ingestion + statute auto-detection every other uploaded
      // document version gets — an AI-drafted save shouldn't be invisible to
      // matter chat or skip Relevant Laws detection just because it didn't
      // come from the file picker.
      const { error: processError } = await supabase.functions.invoke("process-document", {
        body: {
          filePath: storagePath,
          fileName,
          fileType: blob.type,
          bucket: "matter-documents",
          matterId,
          documentTypeId,
          isPrecedent: false,
        },
      });
      if (processError) console.error("Draft saved but RAG ingestion failed:", processError);

      toast({ title: "Draft saved as a document version" });
      navigate(`/matters/${matterId}`);
    } catch (err: any) {
      toast({ title: "Failed to save draft", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      {!started ? (
        <Card>
          <CardContent className="pt-6 space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">Document type</label>
              <Select value={documentTypeId} onValueChange={setDocumentTypeId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a document type" />
                </SelectTrigger>
                <SelectContent>
                  {documentTypes?.map((type) => (
                    <SelectItem key={type.id} value={type.id}>
                      {type.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <p className="text-xs text-muted-foreground">
              Claude asks the key commercial terms one at a time, then drafts from your answers —
              grounded in the firm's standard template and past precedent for this document type.
            </p>

            <Button onClick={handleStart} disabled={!documentTypeId || interviewMutation.isPending}>
              Start Interview
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {!draft && (
            <Card>
              <CardContent className="pt-6 space-y-4">
                <p className="text-xs text-muted-foreground">Drafting a {documentTypeName}.</p>
                <DocumentChatPanel
                  messages={messages}
                  onSend={handleSendChatMessage}
                  sending={interviewMutation.isPending}
                  placeholder="Type your answer…"
                />
                <Button
                  variant={isReadyToDraft ? "default" : "outline"}
                  onClick={handleGenerateDraft}
                  disabled={draftMutation.isPending}
                >
                  <FileText className="h-4 w-4 mr-2" />
                  {isReadyToDraft ? "Generate Draft" : "Draft Now Anyway"}
                </Button>
              </CardContent>
            </Card>
          )}

          {draftMutation.isPending && (
            <p className="text-muted-foreground">Drafting — this can take a moment…</p>
          )}

          {draft && (
            <>
              <Card>
                <CardContent className="pt-6 space-y-4">
                  <p className="text-xs text-muted-foreground">
                    {hasTemplate
                      ? "Drafted using the firm's standard template for this document type"
                      : precedentCount > 0
                      ? `Drafted using ${precedentCount} precedent document${precedentCount === 1 ? "" : "s"} of this type`
                      : "No precedent or standard template of this type in the library yet — drafted from standard practice"}
                    {precedentCount > 0 && hasTemplate
                      ? `, plus ${precedentCount} supplementary precedent document${precedentCount === 1 ? "" : "s"}.`
                      : "."}
                    {" "}Review and edit before saving — this is a first draft, not final.
                  </p>
                  {/* Tabs only for the triggers — Radix TabsContent unmounts the
                      inactive pane, which would take the TipTap editor (and its
                      ref) with it while the preview is showing, so "Save as
                      Document Version" from the preview tab had nothing to
                      export. Bare hidden divs keep both panes mounted. */}
                  <Tabs value={activeTab} onValueChange={handleTabChange}>
                    <TabsList>
                      <TabsTrigger value="edit">Editable Draft</TabsTrigger>
                      <TabsTrigger value="preview">Preview as Word Document</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <div hidden={activeTab !== "edit"}>
                    <RichTextEditor ref={editorRef} content={editorContent} className="border rounded-md p-4 prose prose-sm max-w-none min-h-[400px]" />
                  </div>
                  <div hidden={activeTab !== "preview"}>
                    {buildingPreview && <p className="text-sm text-muted-foreground mb-2">Building preview…</p>}
                    <div ref={previewRef} className="border rounded-md p-4 max-h-[600px] overflow-y-auto overflow-x-auto" />
                  </div>
                  <Button onClick={handleSaveAsVersion} disabled={saving}>
                    <Save className="h-4 w-4 mr-2" />
                    Save as Document Version
                  </Button>
                </CardContent>
              </Card>

              <Card>
                <CardContent className="pt-6 space-y-4">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    Continue the conversation
                  </p>
                  <DocumentChatPanel
                    messages={messages}
                    onSend={handleSendChatMessage}
                    sending={reviseMutation.isPending}
                    placeholder="Ask a follow-up or request a change…"
                    emptyHint="Ask a question about this draft, or tell Claude what to change — e.g. &quot;shorten the definitions section&quot;."
                  />
                </CardContent>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}
