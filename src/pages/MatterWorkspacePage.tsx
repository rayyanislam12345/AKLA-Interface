import { useState } from "react";
import { useParams } from "react-router-dom";
import { Check, Circle, CircleDot, Plus } from "lucide-react";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const STAGE_CYCLE = ["not_started", "in_progress", "complete"] as const;

function StageIcon({ status }: { status: string }) {
  if (status === "complete") return <Check className="h-4 w-4 text-green-600" />;
  if (status === "in_progress") return <CircleDot className="h-4 w-4 text-amber-500" />;
  return <Circle className="h-4 w-4 text-muted-foreground" />;
}

export default function MatterWorkspacePage() {
  const { matterId } = useParams<{ matterId: string }>();
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
