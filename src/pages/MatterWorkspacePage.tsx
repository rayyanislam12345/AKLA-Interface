import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, Circle, CircleDot, FileText, Gavel, Loader2, MessageCircle, MessageSquare, Plus, ScanSearch, Search, Sparkles, Trash2, Upload, Wand2 } from "lucide-react";
import { useMatter, useMatterStages, useSetStageStatus, useDeleteMatter } from "@/hooks/useMatters";
import { useMatterContext, useUpsertMatterContext } from "@/hooks/useMatterContext";
import {
  useMatterRelevantLaws,
  useAddSelectedRelevantLaw,
  useResolveRelevantLaw,
  useUploadRelevantLawFile,
  useDeleteRelevantLaw,
} from "@/hooks/useMatterRelevantLaws";
import { useStatuteSources } from "@/hooks/useLawLibrary";
import { supabase } from "@/integrations/supabase/client";
import {
  useWhatsAppMattersForMatter,
  useWhatsAppDocuments,
  openWhatsAppDocument,
} from "@/hooks/useWhatsAppMatters";
import {
  useMatterParties,
  useAddMatterParty,
  useMatterTasks,
  useAddMatterTask,
  useToggleTaskStatus,
  useMatterNotes,
  useAddMatterNote,
} from "@/hooks/useMatterDetail";
import {
  useDocumentTypes,
  useMatterDocuments,
  useCreateMatterDocument,
  useSetMatterDocumentStatus,
  useUploadDocumentVersion,
  useDeleteMatterDocument,
  type DocumentStatus,
} from "@/hooks/useMatterDocuments";
import { MatterTimeslips } from "@/components/MatterTimeslips";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const DOCUMENT_STATUSES: DocumentStatus[] = [
  "not_started",
  "drafting",
  "internal_review",
  "with_counterparty",
  "negotiation",
  "finalized",
  "executed",
];

function statusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function statusVariant(status: string): "default" | "secondary" | "outline" {
  if (status === "finalized" || status === "executed") return "default";
  if (status === "not_started") return "outline";
  return "secondary";
}

const STAGE_CYCLE = ["not_started", "in_progress", "complete"] as const;

function StageIcon({ status }: { status: string }) {
  if (status === "complete") return <Check className="h-4 w-4 text-green-600" />;
  if (status === "in_progress") return <CircleDot className="h-4 w-4 text-amber-500" />;
  return <Circle className="h-4 w-4 text-muted-foreground" />;
}

function WhatsAppMatterDocuments({ whatsappMatterId }: { whatsappMatterId: string }) {
  const { data: files, isLoading } = useWhatsAppDocuments(whatsappMatterId);
  const { toast } = useToast();

  const handleOpen = async (path: string) => {
    try {
      await openWhatsAppDocument(path);
    } catch (err: any) {
      toast({ title: "Failed to open document", description: err.message, variant: "destructive" });
    }
  };

  if (isLoading) return null;
  if (!files?.length) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {files.map((file) => (
        <Button key={file.id} variant="outline" size="sm" onClick={() => handleOpen(file.storage_path)} className="gap-1.5">
          <FileText className="h-3.5 w-3.5" />
          {file.filename}
        </Button>
      ))}
    </div>
  );
}

// A firm Matter can have more than one linked whatsapp_matters row — different
// lawyers each capturing the same deal on their own WhatsApp, or one lawyer's
// LLM splitting a matter across chats — so this renders a list, not a card
// for a single entity. No "link" control here: linking is initiated from the
// WhatsApp Activity page, where the row a lawyer is looking at is already one
// they have SELECT visibility into (their own capture, or already linked) —
// surfacing a cross-user picker here would need an endpoint that leaks the
// existence of other lawyers' private, unlinked data.
function WhatsAppActivityCard({ matterId }: { matterId: string | undefined }) {
  const navigate = useNavigate();
  const { data: whatsappMatters, isLoading } = useWhatsAppMattersForMatter(matterId);

  return (
    <Card className="md:col-span-2">
      <CardHeader>
        <CardTitle className="text-base">WhatsApp Activity</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !whatsappMatters?.length ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">No WhatsApp activity linked yet.</p>
            <Button size="sm" variant="outline" onClick={() => navigate("/whatsapp-activity")}>
              <MessageCircle className="h-4 w-4 mr-2" />
              Link from WhatsApp Activity
            </Button>
          </div>
        ) : (
          <div className="space-y-4">
            {whatsappMatters.map((wm) => (
              <div key={wm.id} className="border rounded-md px-3 py-2.5">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">{wm.owner_name ?? "Unknown lawyer"}</p>
                  <span className="text-xs text-muted-foreground">{wm.message_count} messages</span>
                </div>
                {wm.summary && <p className="text-sm text-muted-foreground mt-1">{wm.summary}</p>}
                {wm.chats.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-2">
                    {wm.chats.map((chat) => (
                      <Badge key={chat} variant="outline" className="text-[10px] font-normal">
                        {chat}
                      </Badge>
                    ))}
                  </div>
                )}
                <WhatsAppMatterDocuments whatsappMatterId={wm.id} />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function relevantLawSourceLabel(source: string) {
  if (source === "manual_selected") return "Selected";
  if (source === "manual_typed") return "Typed";
  return "Auto-detected";
}

// AI context for this matter is scoped to whatever's listed here (falling
// back to a whole-library search if nothing's attached yet) — see
// _shared/retrieval.ts. Rows arrive two ways: an associate adds one
// directly (dropdown or typed, resolved via resolve-statute), or
// process-document auto-detects a mention on upload and adds it itself.
function MatterRelevantLawsCard({ matterId }: { matterId: string | undefined }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: laws, isLoading } = useMatterRelevantLaws(matterId);
  const { data: libraryActs } = useStatuteSources();
  const addSelected = useAddSelectedRelevantLaw();
  const resolveLaw = useResolveRelevantLaw();
  const uploadLawFile = useUploadRelevantLawFile();
  const deleteLaw = useDeleteRelevantLaw();

  const [selectedAct, setSelectedAct] = useState("");
  const [typedAct, setTypedAct] = useState("");
  const [resolvingRowId, setResolvingRowId] = useState<string | null>(null);
  // Typed acts being searched for don't have a row yet (resolve-statute only
  // inserts once it knows available vs needs_upload) — tracked here purely
  // so the list can show a "Searching web for law…" placeholder immediately
  // instead of the whole add-row going quiet/disabled until it settles.
  const [pendingSearches, setPendingSearches] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<{ lawId: string; actName: string } | null>(null);

  const attachedNames = new Set((laws ?? []).map((l) => l.act_name));
  const availableToAdd = (libraryActs ?? []).filter((s) => !attachedNames.has(s.act_name));

  const handleAddSelected = async () => {
    if (!matterId || !selectedAct) return;
    try {
      await addSelected.mutateAsync({ matterId, actName: selectedAct });
      setSelectedAct("");
    } catch (err: any) {
      toast({ title: "Failed to add", description: err.message, variant: "destructive" });
    }
  };

  const handleAddTyped = async () => {
    if (!matterId || !typedAct.trim()) return;
    const actName = typedAct.trim();
    setTypedAct("");
    if (attachedNames.has(actName) || pendingSearches.includes(actName)) return;
    setPendingSearches((prev) => [...prev, actName]);
    try {
      const result = await resolveLaw.mutateAsync({ matterId, actName, source: "manual_typed" });
      if (result.status === "needs_upload") {
        toast({ title: "Not found online", description: `${result.actName} — upload it manually.` });
      }
    } catch (err: any) {
      toast({ title: "Failed to add", description: err.message, variant: "destructive" });
    } finally {
      await queryClient.refetchQueries({ queryKey: ["matter-relevant-laws", matterId] });
      setPendingSearches((prev) => prev.filter((n) => n !== actName));
    }
  };

  const handleFindAndAdd = async (rowId: string, actName: string) => {
    if (!matterId) return;
    setResolvingRowId(rowId);
    try {
      const result = await resolveLaw.mutateAsync({ matterId, actName, source: "manual_typed" });
      if (result.status === "needs_upload") {
        toast({ title: "Still couldn't find it online", description: "Upload it manually instead." });
      } else {
        toast({ title: "Found and added" });
      }
    } catch (err: any) {
      toast({ title: "Failed to search", description: err.message, variant: "destructive" });
    } finally {
      setResolvingRowId(null);
    }
  };

  const triggerFileUpload = (lawId: string, actName: string) => {
    uploadTargetRef.current = { lawId, actName };
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const target = uploadTargetRef.current;
    e.target.value = "";
    if (!file || !target || !matterId) return;
    try {
      await uploadLawFile.mutateAsync({ matterId, lawId: target.lawId, actName: target.actName, file });
      toast({ title: "Uploaded" });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    }
  };

  const handleDelete = async (id: string) => {
    if (!matterId) return;
    try {
      await deleteLaw.mutateAsync({ id, matterId });
    } catch (err: any) {
      toast({ title: "Failed to remove", description: err.message, variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Gavel className="h-4 w-4" />
          Relevant Laws
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Statutes the AI grounds drafting/review in for this matter specifically — falls back to
          searching the whole law library until at least one is attached here.
        </p>

        <input ref={fileInputRef} type="file" accept=".pdf,.docx" className="hidden" onChange={handleFileSelected} />

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !laws?.length && pendingSearches.length === 0 ? (
          <p className="text-sm text-muted-foreground">None attached yet.</p>
        ) : (
          <div className="space-y-2">
            {pendingSearches.map((actName) => (
              <div
                key={`pending-${actName}`}
                className="flex items-center gap-2 flex-wrap border rounded-md px-3 py-2 border-dashed"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{actName}</p>
                </div>
                <Button size="sm" variant="outline" disabled className="shrink-0">
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  Searching web for law
                </Button>
              </div>
            ))}
            {laws?.map((law) => {
              const isSearching = resolvingRowId === law.id;
              const needsUpload = law.status === "needs_upload";
              return (
                <div
                  key={law.id}
                  className={cn(
                    "flex items-center gap-2 flex-wrap border rounded-md px-3 py-2",
                    needsUpload && !isSearching && "border-destructive/40 bg-destructive/5"
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {needsUpload && !isSearching && (
                        <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />
                      )}
                      <p className="text-sm font-medium truncate">{law.act_name}</p>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Badge variant="outline" className="text-[10px] font-normal">
                        {relevantLawSourceLabel(law.source)}
                      </Badge>
                      {!needsUpload && (
                        <Badge variant="default" className="text-[10px] font-normal">
                          In Library
                        </Badge>
                      )}
                    </div>
                  </div>
                  {isSearching ? (
                    <Button size="sm" variant="outline" disabled className="shrink-0">
                      <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                      Searching web for law
                    </Button>
                  ) : (
                    needsUpload && (
                      <>
                        <Button
                          size="icon"
                          variant="ghost"
                          title="Search online again"
                          onClick={() => handleFindAndAdd(law.id, law.act_name)}
                        >
                          <Search className="h-4 w-4" />
                        </Button>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => triggerFileUpload(law.id, law.act_name)}
                        >
                          <Upload className="h-4 w-4 mr-1.5" />
                          Upload Law
                        </Button>
                      </>
                    )
                  )}
                  <Button
                    size="icon"
                    variant="ghost"
                    title="Remove"
                    disabled={isSearching}
                    onClick={() => handleDelete(law.id)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        <div className="border-t pt-3 space-y-2">
          <div className="flex gap-2">
            <Select value={selectedAct} onValueChange={setSelectedAct}>
              <SelectTrigger className="flex-1">
                <SelectValue placeholder="Add from the law library…" />
              </SelectTrigger>
              <SelectContent>
                {availableToAdd.map((s) => (
                  <SelectItem key={s.act_name} value={s.act_name}>
                    {s.act_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button size="icon" variant="outline" disabled={!selectedAct} onClick={handleAddSelected}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="Or type a law not in the dropdown…"
              value={typedAct}
              onChange={(e) => setTypedAct(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAddTyped()}
            />
            <Button size="icon" variant="outline" disabled={!typedAct.trim()} onClick={handleAddTyped}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// Permanent and cascades everything DB-side (documents, versions, redlines,
// chats, context, relevant laws — see useDeleteMatter) plus the matter's
// files in Storage, so this asks the associate to type the matter's exact
// name before enabling the confirm button, same friction as GitHub's repo
// delete, rather than a single dismissible confirm dialog.
function DeleteMatterDialog({ matterId, matterName }: { matterId: string; matterName: string }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const deleteMatter = useDeleteMatter();
  const [confirmText, setConfirmText] = useState("");
  const [open, setOpen] = useState(false);

  const handleDelete = async () => {
    try {
      await deleteMatter.mutateAsync(matterId);
      toast({ title: "Matter deleted" });
      navigate("/matters");
    } catch (err: any) {
      toast({ title: "Failed to delete matter", description: err.message, variant: "destructive" });
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setConfirmText(""); }}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" className="text-destructive hover:text-destructive">
          <Trash2 className="h-4 w-4 mr-2" />
          Delete Matter
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete "{matterName}"?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes the matter and everything under it — all documents and their file
            versions, AI drafts and chat history, redline suggestions, matter context, and relevant laws.
            This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <label className="text-sm font-medium">
            Type <span className="font-semibold">{matterName}</span> to confirm
          </label>
          <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className={cn(buttonVariants({ variant: "destructive" }))}
            disabled={confirmText !== matterName || deleteMatter.isPending}
            onClick={handleDelete}
          >
            {deleteMatter.isPending ? "Deleting…" : "Delete Matter"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function MatterWorkspacePage() {
  const { matterId } = useParams<{ matterId: string }>();
  const navigate = useNavigate();
  const { data: matter, isLoading } = useMatter(matterId);
  const { data: stages } = useMatterStages(matterId);
  const setStageStatus = useSetStageStatus();

  const { data: parties } = useMatterParties(matterId);
  const addParty = useAddMatterParty();
  const [partyName, setPartyName] = useState("");
  const [partyRole, setPartyRole] = useState("");

  const { data: tasks } = useMatterTasks(matterId);
  const addTask = useAddMatterTask();
  const toggleTask = useToggleTaskStatus();
  const [taskTitle, setTaskTitle] = useState("");

  const { data: notes } = useMatterNotes(matterId);
  const addNote = useAddMatterNote();
  const [noteContent, setNoteContent] = useState("");

  const { data: matterContext } = useMatterContext(matterId);
  const upsertMatterContext = useUpsertMatterContext();
  const [contextDraft, setContextDraft] = useState("");
  const [contextLoaded, setContextLoaded] = useState(false);
  const [summarizing, setSummarizing] = useState(false);

  const { toast } = useToast();
  const { data: documentTypes } = useDocumentTypes();
  const { data: matterDocuments } = useMatterDocuments(matterId);
  const createMatterDocument = useCreateMatterDocument();
  const setDocumentStatus = useSetMatterDocumentStatus();
  const uploadVersion = useUploadDocumentVersion();
  const deleteMatterDocument = useDeleteMatterDocument();
  const [newDocTitle, setNewDocTitle] = useState("");
  const [newDocTypeId, setNewDocTypeId] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<{ matterDocumentId: string; documentTypeId: string | null; nextVersion: number } | null>(null);

  const triggerUpload = (matterDocumentId: string, documentTypeId: string | null, versionCount: number) => {
    uploadTargetRef.current = { matterDocumentId, documentTypeId, nextVersion: versionCount + 1 };
    fileInputRef.current?.click();
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const target = uploadTargetRef.current;
    e.target.value = "";
    if (!file || !target || !matterId) return;
    try {
      await uploadVersion.mutateAsync({
        matterId,
        matterDocumentId: target.matterDocumentId,
        documentTypeId: target.documentTypeId,
        file,
        nextVersionNumber: target.nextVersion,
      });
      toast({ title: "Document version uploaded" });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    }
  };

  const handleDeleteDocument = async (matterDocumentId: string, title: string) => {
    if (!matterId) return;
    if (!window.confirm(`Remove "${title}" and all its versions from this matter?`)) return;
    try {
      await deleteMatterDocument.mutateAsync({ matterDocumentId, matterId });
      toast({ title: "Document removed" });
    } catch (err: any) {
      toast({ title: "Failed to remove document", description: err.message, variant: "destructive" });
    }
  };

  useEffect(() => {
    if (contextLoaded || matterContext === undefined) return;
    setContextDraft(matterContext?.content ?? "");
    setContextLoaded(true);
  }, [matterContext, contextLoaded]);

  const handleSaveContext = () => {
    if (!matterId) return;
    upsertMatterContext.mutate(
      { matterId, content: contextDraft },
      {
        onSuccess: () => toast({ title: "Matter context saved" }),
        onError: (err: any) => toast({ title: "Failed to save", description: err.message, variant: "destructive" }),
      }
    );
  };

  const handleSummarizeContext = async () => {
    if (!matterId) return;
    setSummarizing(true);
    try {
      const { data, error } = await supabase.functions.invoke("summarize-matter-context", {
        body: { matterId },
      });
      if (error) throw error;
      if (!data.summary) {
        toast({ title: "Nothing to summarize yet — no documents or past AI sessions on this matter" });
        return;
      }
      setContextDraft((prev) => (prev.trim() ? `${prev.trim()}\n\n${data.summary}` : data.summary));
      toast({
        title: "Summary added — review before saving",
        description: `Pulled from ${data.documentCount} document${data.documentCount === 1 ? "" : "s"} and ${data.messageCount} past AI message${data.messageCount === 1 ? "" : "s"}.`,
      });
    } catch (err: any) {
      toast({ title: "Failed to summarize", description: err.message, variant: "destructive" });
    } finally {
      setSummarizing(false);
    }
  };

  if (isLoading || !matter) {
    return <p className="text-muted-foreground">Loading…</p>;
  }

  const cycleStage = (stageId: string, current: string) => {
    const next = STAGE_CYCLE[(STAGE_CYCLE.indexOf(current as any) + 1) % STAGE_CYCLE.length];
    setStageStatus.mutate({ stageId, status: next, matterId: matterId! });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-semibold break-words">{matter.name}</h1>
            <Badge variant={matter.status === "active" ? "default" : "secondary"}>{matter.status}</Badge>
          </div>
          <p className="text-muted-foreground">
            {(matter as any).client?.name || "No client"}
            {matter.sector ? ` · ${matter.sector}` : ""}
            {(matter as any).lead_partner?.full_name ? ` · Lead: ${(matter as any).lead_partner.full_name}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" onClick={() => navigate(`/matters/${matterId}/chat`)}>
            <MessageSquare className="h-4 w-4 mr-2" />
            Ask AI
          </Button>
          <DeleteMatterDialog matterId={matterId!} matterName={matter.name} />
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Stages</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {stages?.map((stage) => (
              <button
                key={stage.id}
                onClick={() => cycleStage(stage.id, stage.status)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2 rounded-md text-left hover:bg-muted transition-colors",
                  stage.status === "complete" && "text-muted-foreground line-through"
                )}
              >
                <StageIcon status={stage.status} />
                <span>{stage.name}</span>
              </button>
            ))}
          </CardContent>
        </Card>

        <Card className="md:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-base">Documents</CardTitle>
            <Button size="sm" variant="outline" onClick={() => navigate(`/matters/${matterId}/draft`)}>
              <Sparkles className="h-4 w-4 mr-2" />
              Draft with AI
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.xlsx,.xls"
              className="hidden"
              onChange={handleFileSelected}
            />
            {!matterDocuments?.length ? (
              <p className="text-sm text-muted-foreground">No documents yet.</p>
            ) : (
              <div className="space-y-2">
                {matterDocuments.map((doc) => (
                  <div
                    key={doc.id}
                    className="flex items-center gap-3 flex-wrap border rounded-md px-3 py-2"
                  >
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium truncate">{doc.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {(doc as any).document_type?.name || "No type"} ·{" "}
                        {(doc as any).versions?.length || 0} version
                        {(doc as any).versions?.length === 1 ? "" : "s"}
                      </p>
                    </div>
                    <Select
                      value={doc.status}
                      onValueChange={(value) =>
                        setDocumentStatus.mutate({
                          matterDocumentId: doc.id,
                          status: value as DocumentStatus,
                          matterId: matterId!,
                        })
                      }
                    >
                      <SelectTrigger className="w-44 h-8 text-xs shrink-0">
                        <Badge variant={statusVariant(doc.status)} className="pointer-events-none">
                          <SelectValue />
                        </Badge>
                      </SelectTrigger>
                      <SelectContent>
                        {DOCUMENT_STATUSES.map((status) => (
                          <SelectItem key={status} value={status} className="capitalize">
                            {statusLabel(status)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        size="icon"
                        variant="outline"
                        title="Upload a new version"
                        onClick={() =>
                          triggerUpload(doc.id, doc.document_type_id, (doc as any).versions?.length || 0)
                        }
                      >
                        <Upload className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="outline"
                        title="Review with AI"
                        disabled={!(doc as any).versions?.length}
                        onClick={() => navigate(`/matters/${matterId}/documents/${doc.id}/review`)}
                      >
                        <ScanSearch className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="outline"
                        title="Remove document"
                        onClick={() => handleDeleteDocument(doc.id, doc.title)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2 pt-2 flex-wrap">
              <Input
                placeholder="Document title"
                value={newDocTitle}
                onChange={(e) => setNewDocTitle(e.target.value)}
                className="flex-1 min-w-[10rem]"
              />
              <Select value={newDocTypeId} onValueChange={setNewDocTypeId}>
                <SelectTrigger className="w-56">
                  <SelectValue placeholder="Document type" />
                </SelectTrigger>
                <SelectContent>
                  {documentTypes?.map((type) => (
                    <SelectItem key={type.id} value={type.id}>
                      {type.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="icon"
                variant="outline"
                disabled={!newDocTitle.trim()}
                onClick={() => {
                  createMatterDocument.mutate({
                    matter_id: matterId!,
                    title: newDocTitle.trim(),
                    document_type_id: newDocTypeId || undefined,
                  });
                  setNewDocTitle("");
                  setNewDocTypeId("");
                }}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Parties</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {parties?.map((party) => (
              <div key={party.id} className="flex items-center justify-between text-sm">
                <span className="font-medium">{party.name}</span>
                <span className="text-muted-foreground">{party.role}</span>
              </div>
            ))}
            <div className="flex gap-2 pt-2">
              <Input placeholder="Name" value={partyName} onChange={(e) => setPartyName(e.target.value)} />
              <Input placeholder="Role" value={partyRole} onChange={(e) => setPartyRole(e.target.value)} />
              <Button
                size="icon"
                variant="outline"
                disabled={!partyName.trim() || !partyRole.trim()}
                onClick={() => {
                  addParty.mutate({ matter_id: matterId!, name: partyName.trim(), role: partyRole.trim() });
                  setPartyName("");
                  setPartyRole("");
                }}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tasks</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {tasks?.map((task) => (
              <div key={task.id} className="flex items-center gap-3 text-sm">
                <Checkbox
                  checked={task.status === "done"}
                  onCheckedChange={(checked) =>
                    toggleTask.mutate({
                      taskId: task.id,
                      status: checked ? "done" : "open",
                      matterId: matterId!,
                    })
                  }
                />
                <span className={cn(task.status === "done" && "line-through text-muted-foreground")}>
                  {task.title}
                </span>
                {(task as any).assignee?.full_name && (
                  <span className="text-xs text-muted-foreground ml-auto">
                    {(task as any).assignee.full_name}
                  </span>
                )}
              </div>
            ))}
            <div className="flex gap-2 pt-2">
              <Input
                placeholder="New task"
                value={taskTitle}
                onChange={(e) => setTaskTitle(e.target.value)}
              />
              <Button
                size="icon"
                variant="outline"
                disabled={!taskTitle.trim()}
                onClick={() => {
                  addTask.mutate({ matter_id: matterId!, title: taskTitle.trim() });
                  setTaskTitle("");
                }}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>

        {matterId && (
          <MatterTimeslips matterId={matterId} matterName={matter?.name ?? "matter"} />
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Notes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Textarea
                placeholder="Add a note…"
                value={noteContent}
                onChange={(e) => setNoteContent(e.target.value)}
              />
              <Button
                size="icon"
                variant="outline"
                disabled={!noteContent.trim()}
                onClick={() => {
                  addNote.mutate({ matter_id: matterId!, content: noteContent.trim() });
                  setNoteContent("");
                }}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <div className="space-y-3 max-h-64 overflow-y-auto">
              {notes?.map((note) => (
                <div key={note.id} className="text-sm border-b pb-2 last:border-0">
                  <p>{note.content}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {(note as any).author?.full_name || "Unknown"} ·{" "}
                    {new Date(note.created_at).toLocaleDateString()}
                  </p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Matter Context</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Curated facts carried forward across "Draft with AI" sessions on this matter, so the next
              document doesn't have to re-ask what an earlier one already established. Use "Summarize"
              to pull a first draft of this from the matter's existing documents and past AI sessions —
              review and edit before saving.
            </p>
            <Textarea
              placeholder="Key facts, decisions, and preferences for this matter…"
              value={contextDraft}
              onChange={(e) => setContextDraft(e.target.value)}
              className="min-h-[140px]"
            />
            {(matterContext as any)?.updated_by?.full_name && (
              <p className="text-xs text-muted-foreground">
                Last updated by {(matterContext as any).updated_by.full_name} ·{" "}
                {new Date(matterContext!.updated_at).toLocaleDateString()}
              </p>
            )}
            <div className="flex gap-2 flex-wrap">
              <Button size="sm" onClick={handleSaveContext} disabled={upsertMatterContext.isPending}>
                Save
              </Button>
              <Button size="sm" variant="outline" onClick={handleSummarizeContext} disabled={summarizing}>
                <Wand2 className="h-4 w-4 mr-2" />
                {summarizing ? "Summarizing…" : "Summarize from documents & AI sessions"}
              </Button>
            </div>
          </CardContent>
        </Card>

        <MatterRelevantLawsCard matterId={matterId} />

        <WhatsAppActivityCard matterId={matterId} />
      </div>
    </div>
  );
}
