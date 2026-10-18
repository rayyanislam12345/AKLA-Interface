import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ExternalLink, FileText, PanelRightOpen } from "lucide-react";
import type { ImperativePanelGroupHandle } from "react-resizable-panels";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import { useDocumentTypes } from "@/hooks/useMatterDocuments";
import {
  type ActiveSkill,
  type ChatArtifact,
  type ChatAttachment,
  type EditTarget,
  type GuideState,
  EMPTY_STREAM,
  messageMetadata,
  openDocumentForEdit,
  useChatMessages,
  useChatThread,
  useCustomSkills,
  useThreadArtifacts,
} from "@/hooks/useChat";
import { resolveThreadSkill, seedSkillFor, shouldClearSkill, type StoredSkill } from "@/lib/threadSkill";
import { openParam, parseOpenParam } from "@/lib/aiLinks";
import { useAiPageTitle, useAiWorkspace } from "@/ai/AiWorkspaceContext";
import { useSplitLayout } from "@/ai/useMediaQuery";
import SiteLink from "@/ai/components/SiteLink";
import ScopePill from "@/ai/components/ScopePill";
import MessageList from "@/components/ai/chat/MessageList";
import Composer from "@/components/ai/chat/Composer";
import ArtifactPanel from "@/components/ai/chat/ArtifactPanel";
import GuideQuestionCard from "@/components/ai/chat/GuideQuestionCard";
import ProjectPickerDialog from "@/components/ai/chat/ProjectPickerDialog";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

// One conversation (/ai/c/:threadId). "new" is a chat whose row does not
// exist yet: its first reply is being written under the workspace's
// placeholder turn, and the address moves to the real id when it arrives.
// The chat's scope (its project, or none) comes from its row, not the
// address; a brand-new chat's comes from ?matter=.
export default function AiChatPage() {
  const { threadId } = useParams<{ threadId: string }>();
  // Keyed so moving between chats resets every pane.
  return <ChatView key={threadId} threadId={threadId === "new" ? null : threadId!} />;
}

function ChatView({ threadId }: { threadId: string | null }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user: me } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isMobile = useIsMobile();
  const split = useSplitLayout();
  const { chat, panel, setPanel, openArtifact: openArtifactInPanel, closePanel, autoOpenedThreads } = useAiWorkspace();

  const { data: thread, isLoading: threadLoading, error: threadError, refetch: refetchThread } = useChatThread(threadId ?? undefined);
  const newMatterId = threadId ? undefined : searchParams.get("matter") ?? undefined;
  const matterId = thread?.matter_id ?? newMatterId ?? undefined;
  const matterName = thread?.matter?.name ?? undefined;
  const { data: messages } = useChatMessages(threadId ?? undefined);
  const { data: threadArtifacts } = useThreadArtifacts(threadId ?? undefined);
  const { data: documentTypes } = useDocumentTypes();
  const { data: customSkills } = useCustomSkills();

  const turn = chat.turnFor(threadId);
  const stream = turn?.stream ?? EMPTY_STREAM;
  useAiPageTitle(thread?.title ?? "New chat");

  // Artifacts by id: the stored ones plus anything this turn has streamed.
  const artifactMap = useMemo(() => {
    const map = new Map<string, ChatArtifact>();
    for (const a of threadArtifacts ?? []) map.set(a.id, a);
    for (const a of stream.artifacts) map.set(a.id, a);
    return map;
  }, [threadArtifacts, stream.artifacts]);
  const lastArtifact = threadArtifacts?.length ? threadArtifacts[threadArtifacts.length - 1] : null;

  // The panel belongs to the chat it was opened from; it always shows the
  // freshest copy of its document (after a save, the row is refetched).
  const openArtifact = panel?.kind === "artifact" && panel.threadId === threadId ? artifactMap.get(panel.artifactId) ?? null : null;

  // ?open=a:<id> on arrival opens that document once; after that the address
  // follows the panel, so a refresh or a shared link lands on the same view.
  const openSeed = searchParams.get("open");
  const adopted = useRef(false);
  useEffect(() => {
    if (adopted.current || !threadId) return;
    const parsed = parseOpenParam(openSeed);
    if (!parsed) {
      adopted.current = true;
      return;
    }
    if (parsed.kind === "artifact" && artifactMap.has(parsed.id)) {
      adopted.current = true;
      setPanel({ kind: "artifact", artifactId: parsed.id, threadId });
    } else if (parsed.kind !== "artifact" || threadArtifacts) {
      // Not this chat's document, or no longer there: leave the panel shut.
      adopted.current = true;
    }
  }, [openSeed, artifactMap, threadArtifacts, threadId, setPanel]);
  useEffect(() => {
    if (!threadId || !adopted.current) return;
    const want = openParam(openArtifact ? { kind: "artifact", id: openArtifact.id } : null) ?? null;
    if (want === (searchParams.get("open") ?? null)) return;
    const next = new URLSearchParams(searchParams);
    if (want) next.set("open", want);
    else next.delete("open");
    setSearchParams(next, { replace: true });
  }, [openArtifact, threadId, searchParams, setSearchParams]);

  // A review puts a Word page beside its suggestions, which needs far more
  // width than a reply: the document takes most of the screen.
  const reviewing = openArtifact?.kind === "review" && split;
  const panelGroupRef = useRef<ImperativePanelGroupHandle>(null);
  useEffect(() => {
    if (openArtifact && split) panelGroupRef.current?.setLayout(reviewing ? [24, 76] : [45, 55]);
  }, [openArtifact?.id, reviewing, split]);

  // A chat handed a document before anything was said in it (minutes from
  // Record Meeting, a version opened for Edit) opens on that document. Once
  // per chat, so closing the panel sticks.
  useEffect(() => {
    if (!threadId || !messages || messages.length > 0 || turn?.pending || !lastArtifact) return;
    if (lastArtifact.thread_id !== threadId || autoOpenedThreads.has(threadId)) return;
    autoOpenedThreads.add(threadId);
    if (!panel || (panel.kind === "artifact" && panel.threadId !== threadId)) openArtifactInPanel(lastArtifact);
  }, [threadId, messages, lastArtifact, turn?.pending, panel, openArtifactInPanel, autoOpenedThreads]);

  // The skill in force: the last message's, or the one the chat was opened with.
  const lastUserMessage = useMemo(() => [...(messages ?? [])].reverse().find((m) => m.role === "user"), [messages]);
  const storedSkill: StoredSkill | null = (lastUserMessage ? messageMetadata(lastUserMessage).skill : (thread?.skill as StoredSkill | null | undefined)) ?? null;
  const storedSkillKey = threadId && storedSkill ? JSON.stringify(storedSkill) : "";
  const threadSkill = useMemo<ActiveSkill | null>(
    () => (storedSkillKey ? resolveThreadSkill(JSON.parse(storedSkillKey) as StoredSkill, { threadTitle: thread?.title, documentTypes, customSkills }) : null),
    [storedSkillKey, thread?.title, documentTypes, customSkills],
  );
  // A brand-new chat can be opened with a skill in force (?mode=).
  const mode = threadId ? null : searchParams.get("mode");
  const seedSkill = useMemo(() => seedSkillFor(mode), [mode]);
  const composerSkill = useMemo(() => seedSkill ?? threadSkill, [seedSkill, threadSkill]);

  const scopeArgs = { matterId, general: matterId ? undefined : me?.id };

  const guide = (thread?.questionnaire as unknown as GuideState | null | undefined) ?? null;
  const handleGuideAnswer = async (question: { title: string }, answer: { questionId: string; optionIds: string[]; skip?: boolean }, labels: string[]) => {
    if (!threadId) return;
    const skillOnThread = thread?.skill as { documentTypeId?: string } | null;
    const working = openArtifact && openArtifact.kind === "docx" ? openArtifact.id : (threadArtifacts ?? []).filter((a) => a.kind === "docx").at(-1)?.id ?? null;
    await chat.send({
      ...scopeArgs,
      threadId,
      message: answer.skip ? `Skip: ${question.title}` : `${question.title}: ${labels.join("; ")}`,
      attachments: [],
      skill: { key: "draft", documentTypeId: skillOnThread?.documentTypeId, label: "Draft", answer },
      workingArtifactId: working,
    });
  };

  const handleSend = async (input: { message: string; attachments: ChatAttachment[]; skill: ActiveSkill | null }) => {
    // The document open beside the chat is the one the lawyer is talking about.
    const working = openArtifact && ["docx", "draft", "memo"].includes(openArtifact.kind) ? openArtifact.id : null;
    const clearSkill = shouldClearSkill({ chipSkill: input.skill, threadId, storedSkill, threadHasSkill: !!thread?.skill, customSkillsLoaded: !!customSkills });
    try {
      await chat.send({ ...scopeArgs, threadId, ...input, clearSkill, workingArtifactId: working });
    } catch (err) {
      toast({ title: "Couldn't send", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    }
  };

  // Edit: the chosen version opens in a chat of its own.
  const [editPickerOpen, setEditPickerOpen] = useState(false);
  const [projectPicker, setProjectPicker] = useState<null | "review" | "edit">(null);
  const handleEditDocument = async (target: EditTarget) => {
    if (!matterId) return;
    try {
      const { threadId: newId, artifact } = await openDocumentForEdit(matterId, target, me?.id);
      queryClient.setQueryData(["chat-artifacts", newId], [artifact]);
      queryClient.invalidateQueries({ queryKey: ["chat-recent"] });
      navigate(`/ai/c/${newId}?open=${openParam({ kind: "artifact", id: artifact.id })}`);
    } catch (err) {
      toast({ title: "Couldn't open that document", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    }
  };

  // ---- states that replace the chat ----
  // Only a chat that never loaded is replaced by the notice: a failed
  // refresh of a chat already on screen keeps the chat and says so inline.
  if (threadId && threadError && !thread) {
    return (
      <Notice title="This chat couldn't be loaded" body="Check your connection and try again.">
        <Button variant="outline" size="sm" onClick={() => refetchThread()}>Try again</Button>
      </Notice>
    );
  }
  if (threadId && !threadLoading && thread === null) {
    return (
      <Notice title="This chat isn't available" body="It may have been deleted, or it belongs to someone else.">
        <Button asChild variant="outline" size="sm"><Link to="/ai">Home</Link></Button>
      </Notice>
    );
  }
  if (thread?.document_type_id) {
    return (
      <Notice title="This chat builds a firm standard" body="Standardisation sessions open in the Firm Library.">
        <Button asChild variant="outline" size="sm">
          <SiteLink to={`/precedent-library/standardize/${thread.document_type_id}/build?chat=${thread.id}`}>Open it there</SiteLink>
        </Button>
      </Notice>
    );
  }

  const handedDocument = threadId && lastArtifact && !(messages ?? []).length ? lastArtifact : null;
  const emptyState = (
    <div className="flex flex-col items-center gap-3 pt-16 text-center">
      <h2 className="text-xl font-semibold" style={{ fontFamily: "var(--ai-serif)" }}>
        {handedDocument ? `"${handedDocument.title}" is open beside this chat` : matterName ? `How can I help with ${matterName}?` : "What do you need help with?"}
      </h2>
      <p className="max-w-md text-sm text-muted-foreground">
        {handedDocument
          ? "Say what to do with it: tighten it, turn it into an agreement, save it to a project, or ask a question about it."
          : "Drop a file in, or type / for a skill."}
      </p>
    </div>
  );

  const chatColumn = (
    <div className="flex h-full min-w-0 flex-col">
      {(!isMobile || (!openArtifact && lastArtifact)) && (
        <div className="flex h-12 shrink-0 items-center gap-2 px-3 md:px-5">
          {!isMobile && (
            <div className="min-w-0 flex-1 truncate text-sm">
              <span className="font-medium">{thread?.title ?? "New chat"}</span>
              {matterName && <span className="text-muted-foreground"> · {matterName}</span>}
            </div>
          )}
          {isMobile && <div className="flex-1" />}
          {matterId && !isMobile && (
            <SiteLink to={`/matters/${matterId}`} className="hidden items-center gap-1 text-xs text-muted-foreground hover:text-foreground sm:inline-flex">
              <ExternalLink className="h-3.5 w-3.5" /> Open on Project Hub
            </SiteLink>
          )}
          {!openArtifact && lastArtifact && (
            <Button variant="ghost" size="sm" className="h-8" onClick={() => openArtifactInPanel(lastArtifact)} data-testid="open-last-document">
              <PanelRightOpen className="mr-2 h-4 w-4" />
              <span className="hidden max-w-[16rem] truncate sm:inline">{lastArtifact.title}</span>
              <FileText className="h-4 w-4 sm:hidden" />
            </Button>
          )}
        </div>
      )}

      {thread && threadError && (
        <div className="mx-auto flex w-full max-w-[44rem] items-center gap-2 px-4 py-1 text-xs text-muted-foreground md:px-8" role="status" data-testid="thread-refresh-failed">
          <span>Couldn't refresh this chat.</span>
          <button type="button" className="underline hover:text-foreground" onClick={() => refetchThread()}>Try again</button>
        </div>
      )}

      <MessageList
        messages={messages ?? []}
        artifacts={artifactMap}
        stream={stream}
        pending={turn?.pending ?? null}
        activeArtifactId={openArtifact?.id ?? null}
        onOpenArtifact={openArtifactInPanel}
        empty={emptyState}
        resumingMessageId={turn?.resumingMessageId ?? null}
        // Continue writing needs the chat's scope, which comes from its row:
        // not offered until the row is known, like the composer.
        onResume={thread ? (m) => chat.resume({ ...scopeArgs, threadId: thread.id, message: m }) : undefined}
        appearance="ai"
      />

      {guide?.pending && <GuideQuestionCard state={guide} busy={!!turn?.inFlight} onAnswer={handleGuideAnswer} />}

      <div className="shrink-0 pb-[env(safe-area-inset-bottom)]">
        {threadId && !thread && threadLoading ? (
          <div className="px-4 pb-3 pt-2 md:px-8">
            <div className="mx-auto h-[7.5rem] max-w-[44rem] animate-pulse rounded-[1.25rem] border bg-muted/50" aria-label="Loading the chat" />
          </div>
        ) : (
          <Composer
            key={threadId ?? "new"}
            matterId={matterId}
            sending={!!turn?.inFlight}
            initialSkill={composerSkill}
            onSend={handleSend}
            onStop={() => chat.stop(threadId)}
            onEditDocument={handleEditDocument}
            editPickerOpen={editPickerOpen}
            onEditPickerOpenChange={setEditPickerOpen}
            onNeedsProject={setProjectPicker}
            appearance="ai"
            toolbar={<ScopePill scope={{ matterId }} label={matterName} onChange={() => undefined} locked />}
          />
        )}
      </div>
    </div>
  );

  const panelContent = openArtifact && (
    <ArtifactPanel matterId={matterId} matterName={matterName} artifact={openArtifact} lawUpdate={null} onClose={closePanel} />
  );

  return (
    <div className="relative flex min-h-0 flex-1" data-testid="ai-chat">
      {split ? (
        <ResizablePanelGroup ref={panelGroupRef} direction="horizontal" className="min-w-0 flex-1">
          <ResizablePanel id="chat" order={1} defaultSize={openArtifact ? (reviewing ? 24 : 45) : 100} minSize={reviewing ? 20 : 30}>
            {chatColumn}
          </ResizablePanel>
          {openArtifact && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel id="artifact" order={2} defaultSize={reviewing ? 76 : 55} minSize={30}>
                <div className="h-full animate-in fade-in slide-in-from-right-8 duration-200">{panelContent}</div>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      ) : (
        <>
          <div className="min-w-0 flex-1">{chatColumn}</div>
          {!isMobile && openArtifact && (
            <div className="absolute inset-y-0 right-0 z-20 w-[min(100%,40rem)] border-l bg-background shadow-xl animate-in fade-in slide-in-from-right-8 duration-200" data-testid="artifact-overlay">
              {panelContent}
            </div>
          )}
          {isMobile && (
            <Sheet open={!!openArtifact} onOpenChange={(o) => !o && closePanel()}>
              <SheetContent side="right" className="w-full max-w-none p-0 sm:max-w-none [&>button]:hidden">
                <SheetTitle className="sr-only">Document</SheetTitle>
                <div className="flex h-full flex-col">
                  <div className="flex h-12 shrink-0 items-center border-b px-1">
                    <Button variant="ghost" size="sm" onClick={closePanel} aria-label="Back to the chat">
                      <ArrowLeft className="mr-1 h-4 w-4" /> Chat
                    </Button>
                  </div>
                  <div className="min-h-0 flex-1">{panelContent}</div>
                </div>
              </SheetContent>
            </Sheet>
          )}
        </>
      )}

      <ProjectPickerDialog
        open={!!projectPicker}
        onOpenChange={(o) => {
          if (!o) setProjectPicker(null);
        }}
        title={projectPicker === "edit" ? "Edit which project's document?" : "Review which project's document?"}
        description="A new chat about that project will open, with its documents to hand."
        onPick={(id) => {
          const purpose = projectPicker;
          setProjectPicker(null);
          navigate(`/ai?project=${id}&mode=${purpose}`);
        }}
      />
    </div>
  );
}

function Notice({ title, body, children }: { title: string; body: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center" data-testid="chat-notice">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="max-w-sm text-sm text-muted-foreground">{body}</p>
      {children}
    </div>
  );
}
