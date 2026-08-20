import { useRef, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { Check, Circle, CircleDot, FileText, Plus, ScanSearch, Sparkles, Upload } from "lucide-react";
import { useMatter, useMatterStages, useSetStageStatus } from "@/hooks/useMatters";
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
  type DocumentStatus,
} from "@/hooks/useMatterDocuments";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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

  const { toast } = useToast();
  const { data: documentTypes } = useDocumentTypes();
  const { data: matterDocuments } = useMatterDocuments(matterId);
  const createMatterDocument = useCreateMatterDocument();
  const setDocumentStatus = useSetMatterDocumentStatus();
  const uploadVersion = useUploadDocumentVersion();
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

  if (isLoading || !matter) {
    return <p className="text-muted-foreground">Loading…</p>;
  }

  const cycleStage = (stageId: string, current: string) => {
    const next = STAGE_CYCLE[(STAGE_CYCLE.indexOf(current as any) + 1) % STAGE_CYCLE.length];
    setStageStatus.mutate({ stageId, status: next, matterId: matterId! });
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{matter.name}</h1>
          <Badge variant={matter.status === "active" ? "default" : "secondary"}>{matter.status}</Badge>
        </div>
        <p className="text-muted-foreground">
          {(matter as any).client?.name || "No client"}
          {matter.sector ? ` · ${matter.sector}` : ""}
          {(matter as any).lead_partner?.full_name ? ` · Lead: ${(matter as any).lead_partner.full_name}` : ""}
        </p>
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
                    className="flex items-center gap-3 border rounded-md px-3 py-2"
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
                      <SelectTrigger className="w-44 h-8 text-xs">
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
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <Input
                placeholder="Document title"
                value={newDocTitle}
                onChange={(e) => setNewDocTitle(e.target.value)}
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
      </div>
    </div>
  );
}
