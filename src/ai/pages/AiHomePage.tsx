import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useMyProfile } from "@/hooks/useProfiles";
import { type ActiveSkill, type ChatAttachment, type EditTarget, openDocumentForEdit, useRecentChats } from "@/hooks/useChat";
import { seedSkillFor } from "@/lib/threadSkill";
import { chatStatus, greeting, relativeDay } from "@/lib/chatStatus";
import { openParam } from "@/lib/aiLinks";
import { NEW_CHAT_PATH, useAiPageTitle, useAiWorkspace } from "@/ai/AiWorkspaceContext";
import ScopePill, { type ChatScopeChoice } from "@/ai/components/ScopePill";
import ActionTiles, { type ActionTileKey } from "@/ai/components/ActionTiles";
import StatusDot from "@/ai/components/StatusDot";
import Composer from "@/components/ai/chat/Composer";
import ProjectPickerDialog from "@/components/ai/chat/ProjectPickerDialog";
import { LoadState } from "@/components/LoadState";

const TABLE_SEED = "Make a table across these documents: one row per document, columns for ";
const RECENTS_SHOWN = 6;

// Home (/ai): the composer, what the chat is about, the four things people
// come for, and the chats they were in last. Sending starts a new chat and
// moves to it; the reply is written by the workspace's one chat engine, so
// it carries on wherever the lawyer goes next.
export default function AiHomePage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user: me } = useAuth();
  const { data: profile } = useMyProfile();
  const { chat } = useAiWorkspace();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  useAiPageTitle("AI workspace");

  // ?project=<id> opens Home with that project chosen; ?mode= with a skill
  // in force (review, edit, draft, summarise). Both are read on arrival and
  // again whenever they change while Home is already on screen (a project
  // picked in the sidebar or the search), then cleared from the address.
  const projectParam = searchParams.get("project") ?? undefined;
  const modeParam = searchParams.get("mode");
  const [scope, setScope] = useState<ChatScopeChoice>({ matterId: projectParam });
  const [skill, setSkill] = useState<ActiveSkill | null>(() => seedSkillFor(modeParam) ?? null);
  const [editPickerOpen, setEditPickerOpen] = useState(modeParam === "edit" && !!projectParam);
  const [seedText, setSeedText] = useState<string | undefined>(undefined);
  const [hint, setHint] = useState<string | null>(null);
  const [projectPicker, setProjectPicker] = useState<null | "review" | "edit">(null);
  const attached = useRef<ChatAttachment[]>([]);

  // Files upload under the scope they were added in, so changing the scope
  // starts the composer afresh (by key) and says so if files were attached.
  const changeScope = (next: ChatScopeChoice) => {
    if ((next.matterId ?? null) === (scope.matterId ?? null)) return;
    if (attached.current.length) {
      toast({ title: "Attached files were removed", description: "Files belong to the scope they were added in. Attach them again for the new scope." });
    }
    setScope(next);
  };
  const changeScopeRef = useRef(changeScope);
  changeScopeRef.current = changeScope;

  useEffect(() => {
    if (!projectParam && !modeParam) return;
    if (projectParam) changeScopeRef.current({ matterId: projectParam });
    const seeded = seedSkillFor(modeParam);
    if (seeded) setSkill(seeded);
    setEditPickerOpen(modeParam === "edit" && !!projectParam);
    setSearchParams(new URLSearchParams(), { replace: true });
  }, [projectParam, modeParam, setSearchParams]);

  const handleSend = async (input: { message: string; attachments: ChatAttachment[]; skill: ActiveSkill | null }) => {
    if (chat.turnFor(null)?.inFlight) {
      toast({ title: "A new chat is still being started", description: "Give it a moment; you'll find it in Recents.", variant: "destructive" });
      return;
    }
    const matterId = scope.matterId;
    chat.send({ matterId, general: matterId ? undefined : me?.id, threadId: null, ...input }).catch((err: Error) => {
      toast({ title: "Couldn't send", description: err.message, variant: "destructive" });
    });
    navigate(matterId ? `${NEW_CHAT_PATH}?matter=${matterId}` : NEW_CHAT_PATH);
  };

  // Edit: the chosen version opens in a chat of its own, beside the composer.
  const handleEditDocument = async (target: EditTarget) => {
    if (!scope.matterId) return;
    try {
      const { threadId, artifact } = await openDocumentForEdit(scope.matterId, target, me?.id);
      queryClient.setQueryData(["chat-artifacts", threadId], [artifact]);
      queryClient.invalidateQueries({ queryKey: ["chat-recent"] });
      navigate(`/ai/c/${threadId}?open=${openParam({ kind: "artifact", id: artifact.id })}`);
    } catch (err) {
      toast({ title: "Couldn't open that document", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    }
  };

  const pickTile = (key: ActionTileKey) => {
    setHint(null);
    switch (key) {
      case "draft":
        setSkill({ key: "draft", label: "Draft" });
        break;
      case "review":
        if (scope.matterId) setSkill({ key: "review", label: "Review" });
        else setProjectPicker("review");
        break;
      case "summarise":
        setSkill({ key: "summarise", label: "Summarise" });
        break;
      case "table":
        setSkill(null);
        setSeedText(TABLE_SEED);
        setHint("Attach the documents with the + button, then say which columns you want.");
        break;
    }
  };

  const recents = useRecentChats({ running: chat.busyThreadIds.size > 0 });
  const recentRows = useMemo(() => (recents.data ?? []).slice(0, RECENTS_SHOWN), [recents.data]);
  const name = greeting(profile?.full_name);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="ai-home">
      <div className="mx-auto w-full max-w-[44rem] px-4 pb-16 pt-10 md:px-8 md:pt-16">
        <h1 className="text-2xl font-semibold tracking-tight md:text-3xl" style={{ fontFamily: "var(--ai-serif)" }}>{name}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {scope.matterId ? "Grounded in this project's documents, the firm's precedents and the law library." : "Grounded in the firm's precedents and the law library. Choose a project to work on its documents."}
        </p>

        <div className="-mx-4 mt-6 md:-mx-8">
          <Composer
            key={scope.matterId ?? "general"}
            matterId={scope.matterId}
            sending={false}
            initialText={seedText}
            initialSkill={skill}
            onSend={handleSend}
            onStop={() => undefined}
            onEditDocument={handleEditDocument}
            editPickerOpen={editPickerOpen}
            onEditPickerOpenChange={setEditPickerOpen}
            onNeedsProject={setProjectPicker}
            onAttachmentsChange={(a) => {
              attached.current = a;
            }}
            // Once the Table sentence has been changed or cleared it is no
            // longer the seed: a scope change does not bring it back, and
            // clicking Table again puts it in afresh.
            onTextChange={(t) => setSeedText((s) => (s !== undefined && t !== s ? undefined : s))}
            appearance="ai"
            toolbar={<ScopePill scope={scope} onChange={changeScope} />}
            autoFocus
          />
        </div>
        {hint && <p className="px-1 text-xs text-muted-foreground" data-testid="home-hint">{hint}</p>}

        <div className="mt-6">
          <ActionTiles onPick={pickTile} />
        </div>

        <section className="mt-10" data-testid="home-recents">
          <div className="mb-2 flex items-baseline justify-between px-1">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recent chats</h2>
          </div>
          <LoadState
            isLoading={recents.isLoading}
            error={recents.error}
            onRetry={() => recents.refetch()}
            what="chats"
            compact
            isEmpty={recentRows.length === 0}
            empty={<p className="px-1 text-sm text-muted-foreground">No chats yet. Ask something above, or pick one of the four.</p>}
          >
            <ul className="divide-y rounded-2xl border bg-card">
              {recentRows.map((t) => (
                <li key={t.id}>
                  <Link to={`/ai/c/${t.id}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{t.title || "New chat"}</div>
                      <div className="truncate text-xs text-muted-foreground">{t.matter?.name ?? "General"}</div>
                    </div>
                    <StatusDot status={chatStatus({ questionnaire: t.questionnaire, busy: chat.busyThreadIds.has(t.id), failed: !!chat.turnFor(t.id)?.stream.error })} />
                    <span className="shrink-0 text-xs text-muted-foreground">{relativeDay(t.last_message_at ?? t.created_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </LoadState>
        </section>
      </div>

      <ProjectPickerDialog
        open={!!projectPicker}
        onOpenChange={(o) => {
          if (!o) setProjectPicker(null);
        }}
        title={projectPicker === "edit" ? "Edit which project's document?" : "Review which project's document?"}
        description="The chat will be about that project, so its documents are to hand."
        onPick={(id) => {
          const purpose = projectPicker;
          setProjectPicker(null);
          changeScope({ matterId: id });
          if (purpose === "review") setSkill({ key: "review", label: "Review" });
          else setEditPickerOpen(true);
        }}
      />
    </div>
  );
}
