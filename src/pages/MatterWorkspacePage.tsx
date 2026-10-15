import { indexStoredVersion } from "@/lib/saveDraftToMatter";
import { useEffect, useRef, useState } from "react";
import { useParams, useNavigate, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Archive, ArchiveRestore, Check, ChevronDown, ChevronRight, Circle, CircleDot, Download, FileText, Gavel, Loader2, MessageCircle, MessageSquare, MoreHorizontal, Pencil, Plus, ScanSearch, Search, Sparkles, Tag, Trash2, Upload, Wand2, X } from "lucide-react";
import {
  useMatter,
  useMatterStages,
  useSetStageStatus,
  useDeleteMatter,
  useSetMatterStatus,
  normalizeMatterStatus,
  matterStatusLabel,
  matterStatusBadgeVariant,
} from "@/hooks/useMatters";
import { EditProjectDialog } from "@/pages/MattersPage";
import { LoadState } from "@/components/LoadState";
import { useMatterContext, useUpsertMatterContext } from "@/hooks/useMatterContext";
import {
  useMatterRelevantLaws,
  useAddSelectedRelevantLaw,
  useResolveRelevantLaw,
  useUploadRelevantLawFile,
  useDeleteRelevantLaw,
} from "@/hooks/useMatterRelevantLaws";
import { useStatuteSources } from "@/hooks/useLawLibrary";
import {
  useMatterLawUpdates,
  useAcknowledgeLawUpdate,
  lawUpdateTypeLabel,
  type LawUpdate,
} from "@/hooks/useLawUpdates";
import { supabase } from "@/integrations/supabase/client";
import {
  useWhatsAppMattersForMatter,
  useWhatsAppDocuments,
  openWhatsAppDocument,
  downloadWhatsAppDocument,
} from "@/hooks/useWhatsAppMatters";
import {
  useMatterParties,
  useAddMatterParty,
  useMatterTasks,
  useAddMatterTask,
  useToggleTaskStatus,
  useDeleteMatterTask,
  useMatterNotes,
  useAddMatterNote,
} from "@/hooks/useMatterDetail";
import { useAuth } from "@/hooks/useAuth";
import { useProfiles } from "@/hooks/useProfiles";
import {
  useDocumentTypes,
  useMatterDocuments,
  useCreateMatterDocument,
  useSetMatterDocumentStatus,
  useUploadDocumentVersion,
  useDeleteMatterDocument,
  useDeleteDocumentVersion,
  useUpdateVersionLabel,
  useUpdateMatterDocument,
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

// Whether search and Ask AI can read a version, in words a lawyer can act
// on. "unknown" (versions saved before the status was recorded) and a
// "pending" that has sat for more than ten minutes are treated as failed:
// they get the one automatic retry and a Try again button, never a spinner
// that turns forever.
const READING_TIMEOUT_MS = 10 * 60 * 1000;
type ReadState = "searchable" | "reading" | "failed" | "unsupported";

function versionReadState(v: { indexing_status: string; created_at: string }, now: number): ReadState {
  if (v.indexing_status === "indexed") return "searchable";
  if (v.indexing_status === "unsupported") return "unsupported";
  if (v.indexing_status === "pending" && now - new Date(v.created_at).getTime() < READING_TIMEOUT_MS) return "reading";
  return "failed";
}

const READ_STATE_LABEL: Record<ReadState, string> = {
  searchable: "Searchable",
  reading: "Reading…",
  failed: "Couldn't be read",
  unsupported: "Not searchable (file type)",
};

const READ_STATE_HINT: Record<ReadState, string> = {
  searchable: "Search and Ask AI can read this version.",
  reading: "Reading the text so search and Ask AI can use it. This usually takes under a minute.",
  failed: "The file is saved, but search and Ask AI can't read it yet. Press Try again.",
  unsupported: "This file type can't be read for search. The file is saved and can be downloaded.",
};

// Turns a failed upload into a sentence a lawyer can act on.
function plainUploadError(err: unknown): string {
  const message = err instanceof Error ? err.message : typeof err === "object" && err && "message" in err ? String((err as { message: unknown }).message) : String(err ?? "");
  const m = message.toLowerCase();
  if (m.includes("failed to fetch") || m.includes("network") || m.includes("load failed")) return "The file couldn't be sent. Check your connection and try again.";
  if (m.includes("maximum allowed size") || m.includes("too large") || m.includes("payload")) return "This file is too large to upload.";
  if (m.includes("newer document version")) return "A colleague added a version of this document a moment ago. Try the upload again.";
  if (m.includes("does not belong to this project and type")) return "This document's type was changed while you were uploading. Try the upload again.";
  if (m.includes("jwt") || m.includes("not authenticated") || m.includes("forbidden")) return "Your sign-in has expired. Sign in again, then retry the upload.";
  return message || "Something went wrong. Please try again.";
}

// Every mutation on this page used to fire with no error handling: a failed
// add, tick, status change or dismiss simply did nothing, and the lawyer was
// left wondering whether it had worked. Each call now names what failed.
const onFail = (toast: ReturnType<typeof useToast>["toast"], title: string) => ({
  onError: (err: any) => toast({ title, description: err?.message ?? "Please try again.", variant: "destructive" as const }),
});

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

  const handleDownload = async (path: string, fileName: string) => {
    try {
      await downloadWhatsAppDocument(path, fileName);
    } catch (err: any) {
      toast({ title: "Failed to download document", description: err.message, variant: "destructive" });
    }
  };

  if (isLoading) return null;
  if (!files?.length) return null;

  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {files.map((file) => (
        <div key={file.id} className="flex items-center gap-0.5 border rounded-md">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleOpen(file.storage_path)}
            className="gap-1.5 rounded-r-none"
          >
            <FileText className="h-3.5 w-3.5" />
            {file.filename}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Download"
            onClick={() => handleDownload(file.storage_path, file.filename)}
            className="h-8 w-8 rounded-l-none border-l"
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
        </div>
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

  const navigate = useNavigate();
  const { data: lawUpdates } = useMatterLawUpdates(matterId);
  const acknowledgeUpdate = useAcknowledgeLawUpdate();

  // Newest unacknowledged development per Act, so a law that changed twice
  // shows the most recent change rather than a stale one. useMatterLawUpdates
  // already returns newest-first and excludes bills.
  const updateByAct = new Map<string, LawUpdate>();
  for (const update of lawUpdates ?? []) {
    if (update.act_name && !updateByAct.has(update.act_name)) updateByAct.set(update.act_name, update);
  }

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
          The laws the AI relies on for this project. Until one is added here, it searches the
          firm's whole law library.
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
              const update = updateByAct.get(law.act_name);
              const wasUpdated = !!update && !needsUpload && !isSearching;
              return (
                <div
                  key={law.id}
                  className={cn(
                    "flex items-center gap-2 flex-wrap border rounded-md px-3 py-2",
                    needsUpload && !isSearching && "border-destructive/40 bg-destructive/5",
                    wasUpdated && "border-amber-400/60 bg-amber-50 dark:border-amber-700/50 dark:bg-amber-950/20"
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      {needsUpload && !isSearching && (
                        <AlertTriangle className="h-3.5 w-3.5 text-destructive shrink-0" />
                      )}
                      {wasUpdated && (
                        <AlertTriangle className="h-3.5 w-3.5 text-amber-600 dark:text-amber-500 shrink-0" />
                      )}
                      <p className="text-sm font-medium truncate">{law.act_name}</p>
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      <Badge variant="outline" className="text-[10px] font-normal">
                        {relevantLawSourceLabel(law.source)}
                      </Badge>
                      {!needsUpload && (
                        <Badge variant="default" className="text-[10px] font-normal">
                          In Library
                        </Badge>
                      )}
                      {wasUpdated && (
                        <Badge
                          variant="outline"
                          className="text-[10px] font-normal border-amber-500/60 text-amber-700 dark:text-amber-400"
                        >
                          Updated
                        </Badge>
                      )}
                    </div>
                    {wasUpdated && update && (
                      <p className="text-xs text-amber-800/90 dark:text-amber-300/90 mt-1">
                        {lawUpdateTypeLabel(update.update_type)}: {update.title}
                        {update.published_date ? ` (${update.published_date})` : ""}
                        {update.library_action === "replaced_act" || update.library_action === "ingested_amendment"
                          ? " — the law library has been updated."
                          : ""}
                      </p>
                    )}
                  </div>
                  {wasUpdated && update && (
                    <>
                      <Button
                        size="sm"
                        className="shrink-0 bg-amber-600 hover:bg-amber-700 text-white"
                        onClick={() =>
                          navigate(`/matters/${matterId}/ai?mode=review&update=${update.id}`)
                        }
                      >
                        <Wand2 className="h-4 w-4 mr-1.5" />
                        Revise
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        title="Dismiss on this project only"
                        onClick={() =>
                          acknowledgeUpdate.mutate({ matterId: matterId!, lawUpdateId: update.id }, onFail(toast, "Couldn't dismiss the update"))
                        }
                      >
                        Dismiss
                      </Button>
                    </>
                  )}
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
      toast({ title: "Project deleted" });
      navigate("/matters");
    } catch (err: any) {
      toast({ title: "Failed to delete project", description: err.message, variant: "destructive" });
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(next) => { setOpen(next); if (!next) setConfirmText(""); }}>
      <AlertDialogTrigger asChild>
        <Button variant="outline" className="text-destructive hover:text-destructive">
          <Trash2 className="h-4 w-4 mr-2" />
          Delete Project
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete "{matterName}"?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently deletes the project and everything under it — all documents and their file
            versions, AI drafts and chat history, redline suggestions, project context, and relevant laws.
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
            {deleteMatter.isPending ? "Deleting…" : "Delete Project"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default function MatterWorkspacePage() {
  const queryClient = useQueryClient();
  const location = useLocation();
  const scrolledTo = useRef("");
  const { matterId } = useParams<{ matterId: string }>();
  const navigate = useNavigate();
  const { data: matter, isLoading, error: matterError, refetch: refetchMatter } = useMatter(matterId);
  const setMatterStatus = useSetMatterStatus();
  const [editProjectOpen, setEditProjectOpen] = useState(false);
  const { data: stages } = useMatterStages(matterId);
  const setStageStatus = useSetStageStatus();

  const { data: parties } = useMatterParties(matterId);
  const addParty = useAddMatterParty();
  const [partyName, setPartyName] = useState("");
  const [partyRole, setPartyRole] = useState("");

  const { data: tasks, isLoading: tasksLoading, error: tasksError, refetch: refetchTasks } = useMatterTasks(matterId);
  const addTask = useAddMatterTask();
  const toggleTask = useToggleTaskStatus();
  const deleteTask = useDeleteMatterTask();
  const [taskTitle, setTaskTitle] = useState("");
  const { user } = useAuth();
  const { data: profiles } = useProfiles();
  const currentRole = profiles?.find((p) => p.id === user?.id)?.role;
  const isAdmin = currentRole === "admin" || currentRole === "founder";

  const { data: notes, isLoading: notesLoading, error: notesError, refetch: refetchNotes } = useMatterNotes(matterId);
  const addNote = useAddMatterNote();
  const [noteContent, setNoteContent] = useState("");

  const { data: matterContext } = useMatterContext(matterId);
  const upsertMatterContext = useUpsertMatterContext();
  const [contextDraft, setContextDraft] = useState("");
  const [contextLoaded, setContextLoaded] = useState(false);
  const [summarizing, setSummarizing] = useState(false);

  const { toast } = useToast();
  const { data: documentTypes } = useDocumentTypes();
  const { data: matterDocuments, isLoading: documentsLoading, error: documentsError, refetch: refetchDocuments } = useMatterDocuments(matterId);
  const updateMatterDocument = useUpdateMatterDocument();
  const createMatterDocument = useCreateMatterDocument();
  const setDocumentStatus = useSetMatterDocumentStatus();
  const uploadVersion = useUploadDocumentVersion();
  const deleteMatterDocument = useDeleteMatterDocument();
  const deleteDocumentVersion = useDeleteDocumentVersion();
  const updateVersionLabel = useUpdateVersionLabel();
  const [newDocTitle, setNewDocTitle] = useState("");
  const [newDocTypeId, setNewDocTypeId] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRef = useRef<{ matterDocumentId: string; title: string; documentTypeId: string | null; expectedVersionId: string | null } | null>(null);
  // Documents with an upload in flight, and the file being sent: the row
  // shows it at once and its Upload button is disabled until it lands.
  const [uploadingDocs, setUploadingDocs] = useState<Record<string, string>>({});
  // Versions being read for search right now, from this page.
  const [readingVersions, setReadingVersions] = useState<Set<string>>(() => new Set());
  const autoRetried = useRef(new Set<string>());
  const [confirmDelete, setConfirmDelete] = useState<
    | { kind: "document"; id: string; title: string; versionCount: number }
    | { kind: "version"; id: string; storagePath: string; title: string; versionNumber: number }
    | null
  >(null);
  const [renameTarget, setRenameTarget] = useState<{ id: string; title: string } | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [retypeTarget, setRetypeTarget] = useState<{ id: string; title: string } | null>(null);
  const [retypeDraft, setRetypeDraft] = useState("none");
  // Re-evaluated every minute, so a version stuck "Reading…" for ten minutes
  // turns into "Couldn't be read — Try again" without a reload.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);
  useEffect(() => {
    const documentId = new URLSearchParams(location.search).get("document");
    if (documentId) setExpandedDocId(documentId);
  }, [location.search]);
  useEffect(() => {
    const key = `${location.key}:${location.hash}`;
    if (!location.hash || scrolledTo.current === key) return;
    const target = document.getElementById(location.hash.slice(1));
    if (target) { target.scrollIntoView({ block: "center" }); scrolledTo.current = key; }
  }, [location.key, location.hash, matterDocuments, tasks, notes, expandedDocId]);
  const [editingVersionId, setEditingVersionId] = useState<string | null>(null);
  const [editingLabelDraft, setEditingLabelDraft] = useState("");

  const triggerUpload = (matterDocumentId: string, title: string, documentTypeId: string | null, expectedVersionId: string | null) => {
    if (uploadingDocs[matterDocumentId]) return;
    uploadTargetRef.current = { matterDocumentId, title, documentTypeId, expectedVersionId };
    fileInputRef.current?.click();
  };

  const markReading = (versionId: string, on: boolean) =>
    setReadingVersions((prev) => {
      const next = new Set(prev);
      if (on) next.add(versionId); else next.delete(versionId);
      return next;
    });

  const refreshDocuments = () => {
    queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] });
    queryClient.invalidateQueries({ queryKey: ["project-search"] });
  };

  // Reads a saved version for search. Quiet when it is the automatic retry;
  // otherwise says how it went.
  const readVersion = async (
    version: { id: string; storage_path: string; file_name: string | null },
    documentTypeId: string | null,
    opts: { quiet?: boolean; label?: string; fileType?: string } = {},
  ) => {
    if (!matterId) return;
    markReading(version.id, true);
    try {
      const indexed = await indexStoredVersion({ versionId: version.id, matterId, documentTypeId, storagePath: version.storage_path, fileName: version.file_name ?? version.storage_path.split('/').pop() ?? 'document', fileType: opts.fileType });
      if (!opts.quiet) {
        toast(indexed
          ? { title: `${opts.label ?? "This version"} is now searchable`, description: "Search and Ask AI can read it." }
          : { title: `Couldn't read ${opts.label ?? "this version"}`, description: "The file is saved and can be downloaded. Press Try again next to it, or upload it as a PDF or Word file.", variant: "destructive" });
      }
    } catch (err) {
      if (!opts.quiet) toast({ title: `Couldn't read ${opts.label ?? "this version"}`, description: plainUploadError(err), variant: "destructive" });
    } finally {
      markReading(version.id, false);
      refreshDocuments();
    }
  };

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const target = uploadTargetRef.current;
    e.target.value = "";
    if (!file || !target || !matterId) return;
    const docId = target.matterDocumentId;
    setUploadingDocs((prev) => ({ ...prev, [docId]: file.name }));
    setExpandedDocId(docId);
    try {
      const result = await uploadVersion.mutateAsync({
        matterId,
        matterDocumentId: docId,
        documentTypeId: target.documentTypeId,
        file,
        expectedVersionId: target.expectedVersionId,
      });
      const label = `v${result.versionNumber} of "${target.title}"`;
      if (result.unsupported) {
        toast({ title: `Saved as v${result.versionNumber}`, description: "This file type can't be read for search, so Ask AI won't see its contents. The file is saved and can be downloaded." });
      } else {
        toast({ title: `Saved as v${result.versionNumber}`, description: "Reading it now so search and Ask AI can use it. This usually takes under a minute." });
        // This upload is read here, so the automatic retry leaves it alone.
        autoRetried.current.add(result.versionId);
        void readVersion({ id: result.versionId, storage_path: result.storagePath, file_name: result.fileName }, result.documentTypeId, { label, fileType: result.fileType });
      }
    } catch (err) {
      toast({ title: "Upload failed", description: plainUploadError(err), variant: "destructive" });
      refreshDocuments();
    } finally {
      setUploadingDocs((prev) => {
        const next = { ...prev };
        delete next[docId];
        return next;
      });
    }
  };

  // A version that couldn't be read (including ones saved before the status
  // was recorded, and ones left "Reading…" for over ten minutes) is retried
  // once on its own, one at a time, so the usual transient failure never
  // needs a lawyer to notice a badge and press a button.
  const autoRetryQueue = useRef(Promise.resolve());
  useEffect(() => {
    for (const d of matterDocuments ?? []) {
      for (const v of d.versions ?? []) {
        if (versionReadState(v, now) === "failed" && !autoRetried.current.has(v.id)) {
          autoRetried.current.add(v.id);
          autoRetryQueue.current = autoRetryQueue.current.then(() => readVersion(v, d.document_type_id ?? null, { quiet: true }));
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matterDocuments, now]);

  // Only an admin or the person who added the document can remove it.
  // created_by records who added it; older rows without one fall back to
  // whoever uploaded its first version.
  const canRemoveDocument = (doc: { created_by: string | null }, versions: Array<{ version_number: number; uploaded_by: string | null }>) => {
    if (isAdmin) return true;
    if (!user) return false;
    if (doc.created_by) return doc.created_by === user.id;
    const first = versions.reduce<(typeof versions)[number] | null>((a, b) => (!a || b.version_number < a.version_number ? b : a), null);
    return !!first && first.uploaded_by === user.id;
  };

  const handleConfirmDelete = async () => {
    if (!matterId || !confirmDelete) return;
    const target = confirmDelete;
    try {
      if (target.kind === "document") {
        await deleteMatterDocument.mutateAsync({ matterDocumentId: target.id, matterId });
        toast({ title: "Document removed", description: `"${target.title}" and its versions have been removed.` });
      } else {
        await deleteDocumentVersion.mutateAsync({ versionId: target.id, storagePath: target.storagePath, matterId });
        toast({ title: "Version deleted" });
      }
      setConfirmDelete(null);
    } catch (err) {
      toast({
        title: target.kind === "document" ? "Couldn't remove the document" : "Couldn't delete the version",
        description: plainUploadError(err),
        variant: "destructive",
      });
    }
  };

  const handleRename = () => {
    if (!matterId || !renameTarget || !renameDraft.trim()) return;
    updateMatterDocument.mutate(
      { matterDocumentId: renameTarget.id, matterId, title: renameDraft.trim() },
      {
        onSuccess: () => { toast({ title: "Document renamed" }); setRenameTarget(null); },
        onError: (err) => toast({ title: "Couldn't rename the document", description: plainUploadError(err), variant: "destructive" }),
      },
    );
  };

  const handleRetype = () => {
    if (!matterId || !retypeTarget) return;
    updateMatterDocument.mutate(
      { matterDocumentId: retypeTarget.id, matterId, documentTypeId: retypeDraft === "none" ? null : retypeDraft },
      {
        onSuccess: () => { toast({ title: "Document type changed" }); setRetypeTarget(null); },
        onError: (err) => toast({ title: "Couldn't change the type", description: plainUploadError(err), variant: "destructive" }),
      },
    );
  };

  const handleSetProjectStatus = (status: "active" | "closed") => {
    if (!matterId) return;
    setMatterStatus.mutate(
      { id: matterId, status },
      {
        onSuccess: () =>
          toast(status === "closed"
            ? { title: "Project closed", description: "It no longer appears in project lists and pickers. Reopen it any time from this page." }
            : { title: "Project reopened", description: "It appears in project lists and pickers again." }),
        onError: (err) => toast({ title: status === "closed" ? "Couldn't close the project" : "Couldn't reopen the project", description: plainUploadError(err), variant: "destructive" }),
      },
    );
  };

  const handleDeleteTask = async (taskId: string, title: string) => {
    if (!matterId) return;
    if (!window.confirm(`Delete task "${title}"?`)) return;
    try {
      await deleteTask.mutateAsync({ taskId, matterId });
      toast({ title: "Task deleted" });
    } catch (err: any) {
      toast({ title: "Failed to delete task", description: err.message, variant: "destructive" });
    }
  };

  // Downloads the original file exactly as uploaded — process-document only
  // ever reads a copy of this object to extract text for RAG, it never
  // writes back to it, so what's in Storage is always the untouched original.
  const handleDownloadVersion = async (storagePath: string, fileName: string) => {
    try {
      const { data, error } = await supabase.storage.from("matter-documents").download(storagePath);
      if (error) throw error;
      const url = URL.createObjectURL(data);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      toast({ title: "Failed to download file", description: err.message, variant: "destructive" });
    }
  };

  const handleDeleteVersion = (versionId: string, storagePath: string, versionCount: number, title: string, versionNumber: number) => {
    if (!matterId) return;
    if (versionCount <= 1) {
      toast({
        title: "Can't delete the only version",
        description: "Upload a new version first, or remove the whole document instead.",
        variant: "destructive",
      });
      return;
    }
    setConfirmDelete({ kind: "version", id: versionId, storagePath, title, versionNumber });
  };

  const startEditingLabel = (versionId: string, currentLabel: string | null) => {
    setEditingVersionId(versionId);
    setEditingLabelDraft(currentLabel ?? "");
  };

  const cancelEditingLabel = () => {
    setEditingVersionId(null);
    setEditingLabelDraft("");
  };

  const saveVersionLabel = async (versionId: string) => {
    if (!matterId) return;
    try {
      await updateVersionLabel.mutateAsync({ versionId, label: editingLabelDraft, matterId });
    } catch (err: any) {
      toast({ title: "Failed to save tag", description: err.message, variant: "destructive" });
    } finally {
      setEditingVersionId(null);
      setEditingLabelDraft("");
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
        onSuccess: () => toast({ title: "Project context saved" }),
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
        toast({ title: "Nothing to summarize yet — no documents or past AI sessions on this project" });
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

  if (isLoading || matterError) {
    return <LoadState isLoading={isLoading} error={matterError} onRetry={() => refetchMatter()} what="this project" />;
  }

  // Deleted, or never existed — a stale link or a bookmark to something that
  // has since been removed. Saying so beats sitting on "Loading…" forever.
  if (!matter) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center p-6">
        <Card className="max-w-md">
          <CardContent className="space-y-4 pt-6">
            <div className="space-y-1">
              <h2 className="font-semibold">This project isn't available</h2>
              <p className="text-sm text-muted-foreground">
                It may have been deleted, or the link may be out of date.
              </p>
            </div>
            <Button onClick={() => navigate("/matters")}>Back to Projects</Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const cycleStage = (stageId: string, current: string) => {
    const next = STAGE_CYCLE[(STAGE_CYCLE.indexOf(current as any) + 1) % STAGE_CYCLE.length];
    setStageStatus.mutate({ stageId, status: next, matterId: matterId! }, onFail(toast, "Couldn't update the stage"));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-semibold break-words">{matter.name}</h1>
            <Badge variant={matterStatusBadgeVariant(matter.status)}>{matterStatusLabel(matter.status)}</Badge>
          </div>
          <p className="text-muted-foreground">
            {(matter as any).client?.name || "No client"}
            {matter.sector ? ` · ${matter.sector}` : ""}
            {(matter as any).lead_partner?.full_name ? ` · Project Lead: ${(matter as any).lead_partner.full_name}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button variant="outline" onClick={() => setEditProjectOpen(true)}><Pencil className="mr-2 h-4 w-4"/>Edit</Button>
          {normalizeMatterStatus(matter.status) === "closed" ? (
            <Button variant="outline" disabled={setMatterStatus.isPending} onClick={() => handleSetProjectStatus("active")}>
              <ArchiveRestore className="mr-2 h-4 w-4" />Reopen
            </Button>
          ) : (
            <Button variant="outline" disabled={setMatterStatus.isPending} onClick={() => handleSetProjectStatus("closed")}>
              <Archive className="mr-2 h-4 w-4" />Close project
            </Button>
          )}
          <Button variant="outline" onClick={() => navigate(`/search?matter=${matterId}`)}><Search className="mr-2 h-4 w-4"/>Search project</Button>
          <Button variant="outline" onClick={() => navigate(`/matters/${matterId}/ai?mode=ask`)}>
            <MessageSquare className="h-4 w-4 mr-2" />
            Ask AI
          </Button>
          {/* Deleting a project removes it for everyone; any approved member
              could do it. Admins only until the partners decide otherwise. */}
          {isAdmin && <DeleteMatterDialog matterId={matterId!} matterName={matter.name} />}
        </div>
      </div>
      <EditProjectDialog
        matter={editProjectOpen ? matter : null}
        onClose={() => setEditProjectOpen(false)}
      />

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
            <Button size="sm" variant="outline" onClick={() => navigate(`/matters/${matterId}/ai?mode=draft`)}>
              <Sparkles className="h-4 w-4 mr-2" />
              Draft with AI
            </Button>
          </CardHeader>
          <CardContent className="space-y-3">
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.docx,.xlsx,.xls,.pptx"
              className="hidden"
              onChange={handleFileSelected}
            />
            <LoadState
              isLoading={documentsLoading}
              error={documentsError}
              onRetry={() => refetchDocuments()}
              what="documents"
              isEmpty={!matterDocuments?.length}
              empty="No documents yet."
              compact
            >
              <div className="space-y-2">
                {(matterDocuments ?? []).map((doc) => {
                  const versions = (doc.versions ?? []) as Array<{
                    id: string;
                    version_number: number;
                    created_at: string;
                    storage_path: string;
                    file_name: string | null;
                    label: string | null;
                    is_ai_generated: boolean;
                    uploaded_by: string | null;
                    indexing_status: string;
                  }>;
                  const isExpanded = expandedDocId === doc.id;
                  const uploadingFile = uploadingDocs[doc.id];
                  const readState = (v: (typeof versions)[number]): ReadState =>
                    readingVersions.has(v.id) ? "reading" : versionReadState(v, now);
                  const latest = versions.reduce<(typeof versions)[number] | null>((a, b) => (!a || b.version_number > a.version_number ? b : a), null);
                  const latestState = latest ? readState(latest) : null;
                  const typeName = (doc as { document_type?: { name: string } | null }).document_type?.name;
                  const canRemove = canRemoveDocument(doc, versions);
                  return (
                  <div
                    key={doc.id}
                    id={`document-${doc.id}`}
                    className="border rounded-md px-3 py-2"
                  >
                  <div
                    className="flex items-center gap-3 flex-wrap"
                  >
                    <button
                      type="button"
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      title={isExpanded ? "Hide versions" : "Show versions"}
                      onClick={() => setExpandedDocId(isExpanded ? null : doc.id)}
                    >
                      {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                    <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      onClick={() => setExpandedDocId(isExpanded ? null : doc.id)}
                    >
                      <p className="text-sm font-medium truncate">{doc.title}</p>
                      <p className="text-xs text-muted-foreground">
                        {typeName || "No type"} ·{" "}
                        {versions.length || 0} version
                        {versions.length === 1 ? "" : "s"}
                        {uploadingFile
                          ? " · Uploading…"
                          : latestState && latestState !== "searchable"
                            ? ` · Latest: ${READ_STATE_LABEL[latestState]}`
                            : ""}
                      </p>
                    </button>
                    <Select
                      value={doc.status}
                      onValueChange={(value) =>
                        setDocumentStatus.mutate({
                          matterDocumentId: doc.id,
                          status: value as DocumentStatus,
                          matterId: matterId!,
                        }, onFail(toast, "Couldn't change the document's status"))
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
                        title="Download latest version"
                        aria-label="Download latest version"
                        disabled={!latest}
                        onClick={() => {
                          if (latest) handleDownloadVersion(latest.storage_path, latest.file_name || `${doc.title}-v${latest.version_number}`);
                        }}
                      >
                        <Download className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="outline"
                        title={uploadingFile ? `Uploading ${uploadingFile}…` : "Upload a new version"}
                        aria-label={uploadingFile ? "Uploading" : "Upload a new version"}
                        disabled={!!uploadingFile}
                        onClick={() => triggerUpload(doc.id, doc.title, doc.document_type_id, latest?.id ?? null)}
                      >
                        {uploadingFile ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                      </Button>
                      <Button
                        size="icon"
                        variant="outline"
                        title="Review with AI"
                        aria-label="Review with AI"
                        disabled={!versions.length}
                        onClick={() => navigate(`/matters/${matterId}/ai?mode=review&doc=${doc.id}`)}
                      >
                        <ScanSearch className="h-4 w-4" />
                      </Button>
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button size="icon" variant="outline" title="More actions" aria-label="More actions">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem
                            onSelect={() => {
                              setRenameTarget({ id: doc.id, title: doc.title });
                              setRenameDraft(doc.title);
                            }}
                          >
                            <Pencil className="mr-2 h-4 w-4" />
                            Rename
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => {
                              setRetypeTarget({ id: doc.id, title: doc.title });
                              setRetypeDraft(doc.document_type_id ?? "none");
                            }}
                          >
                            <Tag className="mr-2 h-4 w-4" />
                            Change type
                          </DropdownMenuItem>
                          {canRemove && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onSelect={() => setConfirmDelete({ kind: "document", id: doc.id, title: doc.title, versionCount: versions.length })}
                              >
                                <Trash2 className="mr-2 h-4 w-4" />
                                Remove document
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="mt-2 pl-9 space-y-1.5">
                      {uploadingFile && (
                        <div className="flex items-center gap-2 flex-wrap text-sm bg-muted/40 rounded-md px-2 py-1.5" aria-live="polite">
                          <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground shrink-0" />
                          <span className="text-xs font-medium truncate flex-1 min-w-[8rem]" title={uploadingFile}>
                            {uploadingFile}
                          </span>
                          <Badge variant="outline" className="text-[10px]">Uploading…</Badge>
                        </div>
                      )}
                      {versions.length === 0 && !uploadingFile ? (
                        <p className="text-xs text-muted-foreground">No versions uploaded yet.</p>
                      ) : (
                        [...versions]
                          .sort((a, b) => b.version_number - a.version_number)
                          .map((v) => {
                            const state = readState(v);
                            return (
                            <div
                              key={v.id}
                              id={`version-${v.id}`}
                              className="flex items-center gap-2 flex-wrap text-sm bg-muted/40 rounded-md px-2 py-1.5 target:ring-2 target:ring-primary scroll-mt-20"
                            >
                              <span
                                className="text-xs font-medium truncate flex-1 min-w-[8rem]"
                                title={v.file_name ?? undefined}
                              >
                                {v.file_name || `Version ${v.version_number}`}
                              </span>
                              <Badge
                                variant="outline"
                                className={cn("text-[10px] gap-1", state === "failed" && "border-amber-500 text-amber-700 dark:text-amber-400")}
                                title={READ_STATE_HINT[state]}
                              >
                                {state === "reading" && <Loader2 className="h-3 w-3 animate-spin" />}
                                v{v.version_number} · {READ_STATE_LABEL[state]}
                              </Badge>
                              {state === "failed" && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 text-xs"
                                  onClick={() => readVersion(v, doc.document_type_id, { label: `v${v.version_number} of "${doc.title}"` })}
                                >
                                  Try again
                                </Button>
                              )}
                              {editingVersionId === v.id ? (
                                <>
                                  <Input
                                    autoFocus
                                    value={editingLabelDraft}
                                    onChange={(e) => setEditingLabelDraft(e.target.value)}
                                    placeholder="e.g. v1, v2, Execution"
                                    className="h-7 text-xs w-40 shrink-0"
                                    onKeyDown={(e) => {
                                      if (e.key === "Enter") saveVersionLabel(v.id);
                                      if (e.key === "Escape") cancelEditingLabel();
                                    }}
                                  />
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7 shrink-0"
                                    title="Save tag"
                                    onClick={() => saveVersionLabel(v.id)}
                                  >
                                    <Check className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7 shrink-0"
                                    title="Cancel"
                                    onClick={cancelEditingLabel}
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </Button>
                                </>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="shrink-0 text-left"
                                    title="Click to edit tag"
                                    onClick={() => startEditingLabel(v.id, v.label)}
                                  >
                                    {v.label ? (
                                      <Badge variant="outline" className="font-normal">
                                        {v.label}
                                      </Badge>
                                    ) : (
                                      <span className="text-xs text-muted-foreground italic">No tag</span>
                                    )}
                                  </button>
                                  <span className="text-xs text-muted-foreground shrink-0">
                                    {new Date(v.created_at).toLocaleDateString()}
                                    {v.is_ai_generated ? " · AI-generated" : ""}
                                  </span>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7 shrink-0"
                                    title="Edit tag"
                                    onClick={() => startEditingLabel(v.id, v.label)}
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7 shrink-0"
                                    title="Download this version"
                                    onClick={() =>
                                      handleDownloadVersion(v.storage_path, v.file_name || `${doc.title}-v${v.version_number}`)
                                    }
                                  >
                                    <Download className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button
                                    size="icon"
                                    variant="ghost"
                                    className="h-7 w-7 shrink-0"
                                    title="Delete this version"
                                    disabled={versions.length <= 1}
                                    onClick={() => handleDeleteVersion(v.id, v.storage_path, versions.length, doc.title, v.version_number)}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </>
                              )}
                            </div>
                            );
                          })
                      )}
                    </div>
                  )}
                  </div>
                  );
                })}
              </div>
            </LoadState>

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
                title="Add document"
                disabled={!newDocTitle.trim()}
                onClick={() => {
                  createMatterDocument.mutate({
                    matter_id: matterId!,
                    title: newDocTitle.trim(),
                    document_type_id: newDocTypeId || undefined,
                  }, onFail(toast, "Couldn't add the document"));
                  setNewDocTitle("");
                  setNewDocTypeId("");
                }}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>

        <AlertDialog open={!!confirmDelete} onOpenChange={(next) => { if (!next) setConfirmDelete(null); }}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirmDelete?.kind === "document"
                  ? `Remove "${confirmDelete.title}"?`
                  : confirmDelete
                    ? `Delete version ${confirmDelete.versionNumber} of "${confirmDelete.title}"?`
                    : ""}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirmDelete?.kind === "document"
                  ? confirmDelete.versionCount === 0
                    ? "This permanently removes the document from the project. It has no uploaded versions. This can't be undone."
                    : `This permanently removes the document and ${confirmDelete.versionCount === 1 ? "its 1 version" : `all ${confirmDelete.versionCount} of its versions`}: the files themselves and what search and Ask AI can read from them. This can't be undone.`
                  : "This permanently removes this version's file. The other versions stay. This can't be undone."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                className={cn(buttonVariants({ variant: "destructive" }))}
                disabled={deleteMatterDocument.isPending || deleteDocumentVersion.isPending}
                onClick={(e) => { e.preventDefault(); void handleConfirmDelete(); }}
              >
                {deleteMatterDocument.isPending || deleteDocumentVersion.isPending
                  ? "Removing…"
                  : confirmDelete?.kind === "document" ? "Remove document" : "Delete version"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Dialog open={!!renameTarget} onOpenChange={(next) => { if (!next) setRenameTarget(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Rename document</DialogTitle>
              <DialogDescription>The versions and their files keep their names; only the document's title changes.</DialogDescription>
            </DialogHeader>
            <form onSubmit={(e) => { e.preventDefault(); handleRename(); }} className="space-y-4">
              <Input autoFocus value={renameDraft} onChange={(e) => setRenameDraft(e.target.value)} aria-label="Document title" />
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setRenameTarget(null)}>Cancel</Button>
                <Button type="submit" disabled={!renameDraft.trim() || renameDraft.trim() === renameTarget?.title || updateMatterDocument.isPending}>
                  {updateMatterDocument.isPending ? "Saving…" : "Save"}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <Dialog open={!!retypeTarget} onOpenChange={(next) => { if (!next) setRetypeTarget(null); }}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Change type</DialogTitle>
              <DialogDescription>{retypeTarget ? `What kind of document is "${retypeTarget.title}"?` : ""}</DialogDescription>
            </DialogHeader>
            <Select value={retypeDraft} onValueChange={setRetypeDraft}>
              <SelectTrigger aria-label="Document type">
                <SelectValue placeholder="Choose a type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No type</SelectItem>
                {documentTypes?.map((type) => (
                  <SelectItem key={type.id} value={type.id}>
                    {type.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DialogFooter>
              <Button variant="outline" onClick={() => setRetypeTarget(null)}>Cancel</Button>
              <Button onClick={handleRetype} disabled={updateMatterDocument.isPending}>
                {updateMatterDocument.isPending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

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
                  addParty.mutate({ matter_id: matterId!, name: partyName.trim(), role: partyRole.trim() }, onFail(toast, "Couldn't add the party"));
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
            <LoadState
              isLoading={tasksLoading}
              error={tasksError}
              onRetry={() => refetchTasks()}
              what="tasks"
              isEmpty={!tasks?.length}
              empty="No tasks yet."
              compact
            >
            {tasks?.map((task) => (
              <div key={task.id} id={`task-${task.id}`} className="flex items-center gap-3 text-sm target:ring-2 target:ring-primary scroll-mt-20">
                <Checkbox
                  checked={task.status === "done"}
                  onCheckedChange={(checked) =>
                    toggleTask.mutate({
                      taskId: task.id,
                      status: checked ? "done" : "open",
                      matterId: matterId!,
                    }, onFail(toast, "Couldn't update the task"))
                  }
                />
                <span className={cn(task.status === "done" && "line-through text-muted-foreground")}>
                  {task.title}
                </span>
                <div className="flex items-center gap-2 ml-auto">
                  {(task as any).assignee?.full_name && (
                    <span className="text-xs text-muted-foreground">
                      {(task as any).assignee.full_name}
                    </span>
                  )}
                  {isAdmin && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-6 w-6 shrink-0"
                      title="Delete task"
                      onClick={() => handleDeleteTask(task.id, task.title)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
            </LoadState>
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
                  addTask.mutate({ matter_id: matterId!, title: taskTitle.trim() }, onFail(toast, "Couldn't add the task"));
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
                  addNote.mutate({ matter_id: matterId!, content: noteContent.trim() }, onFail(toast, "Couldn't add the note"));
                  setNoteContent("");
                }}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <LoadState
              isLoading={notesLoading}
              error={notesError}
              onRetry={() => refetchNotes()}
              what="notes"
              isEmpty={!notes?.length}
              empty="No notes yet."
              compact
            >
            <div className="space-y-3 max-h-64 overflow-y-auto">
              {notes?.map((note) => (
                <div key={note.id} id={`note-${note.id}`} className="text-sm border-b pb-2 last:border-0 target:ring-2 target:ring-primary scroll-mt-20">
                  <p>{note.content}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {(note as any).author?.full_name || "Unknown"} ·{" "}
                    {new Date(note.created_at).toLocaleDateString()}
                  </p>
                </div>
              ))}
            </div>
            </LoadState>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Project Context</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">
              Curated facts carried forward across "Draft with AI" sessions on this project, so the next
              document doesn't have to re-ask what an earlier one already established. Use "Summarise"
              to pull a first draft of this from the project's existing documents and past AI sessions —
              review and edit before saving.
            </p>
            <Textarea
              placeholder="Key facts, decisions, and preferences for this project…"
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
                {summarizing ? "Summarising…" : "Summarise from documents & AI sessions"}
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
