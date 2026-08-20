import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { marked } from "marked";
import { Document, Packer, Paragraph, TextRun } from "docx";
import { Sparkles, Send, Save, FileText } from "lucide-react";
import { useMatter } from "@/hooks/useMatters";
import { useDocumentTypes } from "@/hooks/useMatterDocuments";
import { useDraftingInterview, useGenerateDraft } from "@/hooks/useDrafting";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type Mode = "precedent" | "interview";
interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export default function DraftDocumentPage() {
  const { matterId } = useParams<{ matterId: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const { data: matter } = useMatter(matterId);
  const { data: documentTypes } = useDocumentTypes();
  const interviewMutation = useDraftingInterview();
  const draftMutation = useGenerateDraft();

  const [documentTypeId, setDocumentTypeId] = useState<string>("");
  const [mode, setMode] = useState<Mode>("precedent");
  const [started, setStarted] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [threadId, setThreadId] = useState<string | undefined>();
  const [isReadyToDraft, setIsReadyToDraft] = useState(false);
  const [chatInput, setChatInput] = useState("");

  const [draft, setDraft] = useState<string | null>(null);
  const [precedentCount, setPrecedentCount] = useState(0);
  const [saving, setSaving] = useState(false);

  const chatEndRef = useRef<HTMLDivElement>(null);

  const documentTypeName = useMemo(
    () => documentTypes?.find((t) => t.id === documentTypeId)?.name ?? "Document",
    [documentTypes, documentTypeId]
  );

  const editor = useEditor({
    extensions: [StarterKit],
    content: "",
  });

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (draft && editor) {
      editor.commands.setContent(marked.parse(draft, { async: false }) as string);
    }
  }, [draft, editor]);

  const handleStart = async () => {
    if (!documentTypeId || !matterId) return;
    setStarted(true);
    if (mode === "interview") {
      const result = await interviewMutation.mutateAsync({ matterId, documentTypeId });
      setThreadId(result.threadId);
      setMessages([{ role: "assistant", content: result.reply }]);
      setIsReadyToDraft(result.isReadyToDraft);
    } else {
      await handleGenerateDraft();
    }
  };

  const handleSendChatMessage = async () => {
    if (!chatInput.trim() || !matterId || !documentTypeId) return;
    const userMessage = chatInput.trim();
    setChatInput("");
    setMessages((prev) => [...prev, { role: "user", content: userMessage }]);
    const result = await interviewMutation.mutateAsync({
      matterId,
      documentTypeId,
      threadId,
      message: userMessage,
    });
    setThreadId(result.threadId);
    setMessages((prev) => [...prev, { role: "assistant", content: result.reply }]);
    setIsReadyToDraft(result.isReadyToDraft);
  };

  const handleGenerateDraft = async () => {
    if (!matterId || !documentTypeId) return;
    try {
      const result = await draftMutation.mutateAsync({
        matterId,
        documentTypeId,
        mode,
        threadId,
      });
      setDraft(result.draft);
      setPrecedentCount(result.precedentCount);
    } catch (err: any) {
      toast({ title: "Draft generation failed", description: err.message, variant: "destructive" });
    }
  };

  const handleSaveAsVersion = async () => {
    if (!editor || !matterId || !documentTypeId) return;
    setSaving(true);
    try {
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

      // Build a .docx from the editor's plain text. Rich formatting (headings,
      // bold) from the draft isn't preserved here — the `docx` package builds
      // from structured Paragraph/TextRun objects, not arbitrary HTML, so a
      // faithful HTML->docx conversion is a later-phase upgrade, not a v1 need.
      const paragraphs = editor
        .getText()
        .split(/\n+/)
        .filter((line) => line.trim().length > 0)
        .map((line) => new Paragraph({ children: [new TextRun(line)] }));

      const document = new Document({ sections: [{ children: paragraphs }] });
      const blob = await Packer.toBlob(document);
      const fileName = `${documentTypeName.replace(/\s+/g, "-")}-v${nextVersion}.docx`;
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
        is_ai_generated: true,
        uploaded_by: userData.user?.id,
      });
      if (versionError) throw versionError;

      toast({ title: "Draft saved as a document version" });
      navigate(`/matters/${matterId}`);
    } catch (err: any) {
      toast({ title: "Failed to save draft", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  if (!matterId) return null;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          Draft with AI
        </h1>
        <p className="text-muted-foreground">{matter?.name}</p>
      </div>

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

            <div className="space-y-2">
              <label className="text-sm font-medium">How should the draft be built?</label>
              <Tabs value={mode} onValueChange={(v) => setMode(v as Mode)}>
                <TabsList>
                  <TabsTrigger value="precedent">From precedent</TabsTrigger>
                  <TabsTrigger value="interview">Guided interview</TabsTrigger>
                </TabsList>
              </Tabs>
              <p className="text-xs text-muted-foreground">
                {mode === "precedent"
                  ? "Drafts from the firm's past agreements of this type, plus known matter parties. Best when close precedent exists."
                  : "Claude asks you the key commercial terms one at a time, then drafts from your answers. Best when no close precedent exists yet."}
              </p>
            </div>

            <Button onClick={handleStart} disabled={!documentTypeId}>
              {mode === "precedent" ? "Generate Draft" : "Start Interview"}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {mode === "interview" && !draft && (
            <Card>
              <CardContent className="pt-6 space-y-4">
                <div className="space-y-3 max-h-96 overflow-y-auto">
                  {messages.map((m, i) => (
                    <div
                      key={i}
                      className={cn(
                        "rounded-lg px-3 py-2 text-sm max-w-[85%]",
                        m.role === "assistant"
                          ? "bg-muted"
                          : "bg-primary text-primary-foreground ml-auto"
                      )}
                    >
                      {m.content}
                    </div>
                  ))}
                  <div ref={chatEndRef} />
                </div>
                <div className="flex gap-2">
                  <Input
                    placeholder="Type your answer…"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSendChatMessage()}
                    disabled={interviewMutation.isPending}
                  />
                  <Button
                    size="icon"
                    onClick={handleSendChatMessage}
                    disabled={!chatInput.trim() || interviewMutation.isPending}
                  >
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
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
            <Card>
              <CardContent className="pt-6 space-y-4">
                <p className="text-xs text-muted-foreground">
                  {precedentCount > 0
                    ? `Drafted using ${precedentCount} precedent document${precedentCount === 1 ? "" : "s"} of this type.`
                    : "No precedent of this type in the library yet — drafted from standard practice."}
                  {" "}Review and edit before saving — this is a first draft, not final.
                </p>
                <div className="border rounded-md p-4 prose prose-sm max-w-none min-h-[400px]">
                  <EditorContent editor={editor} />
                </div>
                <Button onClick={handleSaveAsVersion} disabled={saving}>
                  <Save className="h-4 w-4 mr-2" />
                  Save as Document Version
                </Button>
              </CardContent>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
