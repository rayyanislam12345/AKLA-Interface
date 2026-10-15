import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useSearchParams, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { FileText, Menu, PanelRightOpen, PencilLine, ScanSearch, Sparkles, StickyNote, Search, FileSignature } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useMatter } from "@/hooks/useMatters";
import { useIsMobile } from "@/hooks/use-mobile";
import { buildRevisePrompt, useDocumentsCitingAct, useLawUpdate } from "@/hooks/useLawUpdates";
import { useLatestDocumentVersion } from "@/hooks/useRedline";
import { useDocumentTypes, useMatterDocuments } from "@/hooks/useMatterDocuments";
import {
  type ActiveSkill,
  type ChatArtifact,
  type ChatAttachment,
  type EditTarget,
  type GuideState,
  type MessageMetadata,
  type SkillKey,
  messageMetadata,
  openDocumentForEdit,
  useCustomSkills,
  useChatMessages,
  useChatThreads,
  useSendChatMessage,
  useThreadArtifacts,
  EMPTY_STREAM, chatScopeKey, type ChatScope } from "@/hooks/useChat";
import ProjectPickerDialog from "@/components/ai/chat/ProjectPickerDialog";
import ChatSidebar from "@/components/ai/chat/ChatSidebar";
import MessageList from "@/components/ai/chat/MessageList";
import Composer from "@/components/ai/chat/Composer";
import ArtifactPanel from "@/components/ai/chat/ArtifactPanel";
import GuideQuestionCard from "@/components/ai/chat/GuideQuestionCard";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import type { ImperativePanelGroupHandle } from "react-resizable-panels";

// The AI Workspace: a claude.ai-shaped chat per matter. Conversations on the
// left, the transcript and composer in the middle, and any document the
// assistant produced (a draft, a memo, a review) opening in a panel on the
// right. Everything the model says is grounded in this matter's documents,
// the precedent library and the law library — see functions/chat.
//
// URL contract (the matter page and Revise links depend on it):
//   ?chat=<threadId>                 open that conversation
//   ?mode=draft                      start with the Draft skill in force
//   ?mode=review&doc=<matterDocId>   start with Review + that document attached (mode=verify still works)
//   ?update=<lawUpdateId>            a Revise link — Review, the affected
//                                    document attached, the prompt pre-filled
export default function AiWorkspacePage() {
  const { matterId } = useParams<{ matterId: string }>();
  // Keyed on the matter so navigating between matters resets every pane —
  // React Router reuses this element across param changes otherwise. With no
  // matter this is the AI Assistant: the general scope, reached from the sidebar.
  return <AiWorkspace key={matterId ?? "assistant"} matterId={matterId} />;
}

function AiWorkspace({ matterId }: { matterId?: string }) {
  const { data: matter } = useMatter(matterId);
  const navigate = useNavigate();
  const { user: me } = useAuth();
  // The conversation's scope: this project, or — with none — the user's own
  // general chats. Drives the thread list, uploads and the chat server.
  const scope: ChatScope = matterId ? { matterId } : { general: me?.id ?? "" };
  // A Review or Edit asked for with no project open: ask which project, then
  // continue inside that project's workspace, where its documents are.
  const [projectPicker, setProjectPicker] = useState<null | "review" | "edit">(null);
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();

  const activeThreadId = searchParams.get("chat");
  const mode = searchParams.get("mode");
  const docParam = searchParams.get("doc") ?? undefined;
  const lawUpdateId = searchParams.get("update") ?? undefined;

  const { data: threads } = useChatThreads(scope);
  const { data: messages } = useChatMessages(activeThreadId ?? undefined);
  const { data: threadArtifacts } = useThreadArtifacts(activeThreadId ?? undefined);

  const [openArtifactState, setOpenArtifact] = useState<ChatArtifact | null>(null);
  // The panel belongs to the chat it was opened from: switching chats hides
  // it, and switching back brings it back.
  const openArtifact = openArtifactState && openArtifactState.thread_id === activeThreadId ? openArtifactState : null;
  // A review puts a Word page beside its suggestions, and a page needs far
  // more width than a reply does. While one is open the document takes most
  // of the screen and the chat list steps aside; it is one click away.
  const reviewing = openArtifact?.kind === "review" && !isMobile;
  const panelGroupRef = useRef<ImperativePanelGroupHandle>(null);
  useEffect(() => {
    if (openArtifact) panelGroupRef.current?.setLayout(reviewing ? [24, 76] : [45, 55]);
  }, [openArtifact?.id, reviewing]);
  // For the streaming callbacks, which outlive the render they started in.
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editPickerOpen, setEditPickerOpen] = useState(false);
  useEffect(() => {
    if (mode === "edit" && matterId) setEditPickerOpen(true);
  }, [mode, matterId]);
  const [editSkill, setEditSkill] = useState<ActiveSkill | null>(null);
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const selectThread = useCallback(
    (threadId: string | null) => {
      const params = new URLSearchParams();
      if (threadId) params.set("chat", threadId);
      setSearchParams(params);
      setOpenArtifact(null);
      setSidebarOpen(false);
      setEditSkill(null);
    },
    [setSearchParams],
  );

  // Edit mode: open the chosen version in the panel straight away, on a
  // thread of its own, with the Edit skill in force for what gets typed next.
  const handleEditDocument = async (target: EditTarget) => {
    try {
      const { threadId, artifact } = await openDocumentForEdit(matterId!, target, user?.id);
      setEditSkill({
        key: "edit",
        documentVersionId: target.versionId,
        matterDocumentId: target.matterDocumentId,
        documentTypeId: target.documentTypeId ?? undefined,
        label: `Edit · ${target.title} v${target.versionNumber}`,
      });
      setSearchParams(new URLSearchParams({ chat: threadId }));
      setOpenArtifact(artifact);
      queryClient.invalidateQueries({ queryKey: ["chat-threads", chatScopeKey(scope)] });
      queryClient.invalidateQueries({ queryKey: ["chat-artifacts", threadId] });
    } catch (err: any) {
      toast({ title: "Couldn't open that document", description: err.message, variant: "destructive" });
    }
  };

  const chat = useSendChatMessage(
    (threadId) => {
      // The first message of a new chat gives it a row — reflect it in the URL
      // (dropping any ?mode/?doc seed) so a refresh lands back on it. Unless
      // the lawyer has already moved to another chat in the meantime: then
      // the new one keeps writing in the background and stays where it is.
      if (activeThreadIdRef.current === null) setSearchParams(new URLSearchParams({ chat: threadId }), { replace: true });
    },
    (artifact) => {
      if (artifact.thread_id === activeThreadIdRef.current) setOpenArtifact(artifact);
    },
  );
  // This chat's turn in progress, if any. Other chats' turns carry on
  // unseen until the lawyer switches back to them.
  const turn = chat.turnFor(activeThreadId);
  const stream = turn?.stream ?? EMPTY_STREAM;

  // Artifacts by id — the persisted ones for this thread plus anything this
  // chat's current turn has streamed so far.
  const artifactMap = useMemo(() => {
    const map = new Map<string, ChatArtifact>();
    for (const a of threadArtifacts ?? []) map.set(a.id, a);
    for (const a of stream.artifacts) map.set(a.id, a);
    return map;
  }, [threadArtifacts, stream.artifacts]);

  // Keep the open panel on the freshest copy of its artifact (after a save).
  useEffect(() => {
    if (openArtifact) {
      const fresh = artifactMap.get(openArtifact.id);
      if (fresh && fresh !== openArtifact) setOpenArtifact(fresh);
    }
  }, [artifactMap, openArtifact]);

  // ---- seeds from the URL: Draft / Review buttons and Revise links ----
  const { data: lawUpdate } = useLawUpdate(lawUpdateId);
  const { data: citingDocs } = useDocumentsCitingAct(matterId, lawUpdate?.act_name);
  const { data: matterDocuments } = useMatterDocuments(matterId);
  const reviewableIds = useMemo(
    () => new Set((matterDocuments ?? []).filter((d) => (d.versions?.length ?? 0) > 0).map((d) => d.id)),
    [matterDocuments],
  );
  // The document to pre-attach: ?doc= if given, else the single document that
  // cites the amended Act — if several do, the lawyer picks via Add from matter.
  const affected = (citingDocs ?? []).filter((d) => reviewableIds.has(d.matter_document_id));
  const seedDocId = docParam ?? (lawUpdateId && affected.length === 1 ? affected[0].matter_document_id : undefined);
  const { data: seedVersion } = useLatestDocumentVersion(seedDocId);
  const seedDoc = matterDocuments?.find((d) => d.id === seedDocId);

  const seedAttachments = useMemo<ChatAttachment[] | undefined>(() => {
    if (!seedVersion || !seedDoc) return undefined;
    return [
      {
        bucket: "matter-documents",
        path: seedVersion.storage_path,
        name: seedVersion.file_name,
        matterDocumentId: seedDoc.id,
        versionId: seedVersion.id,
      },
    ];
  }, [seedVersion, seedDoc]);

  const seedSkill = useMemo<ActiveSkill | null | undefined>(() => {
    if (mode === "draft") return { key: "draft", label: "Draft" };
    if (mode === "agreement") return { key: "agreement", label: "Agreement" };
    if (mode === "summarise") return { key: "summarise", label: "Summarise" };
    if (mode === "review" || mode === "verify" || lawUpdateId) return { key: "review", label: "Review" };
    return undefined;
  }, [mode, lawUpdateId]);

  const seedText = useMemo(() => {
    if (!lawUpdate) return undefined;
    return buildRevisePrompt(lawUpdate, seedDoc?.title);
  }, [lawUpdate, seedDoc?.title]);

  const activeThread = threads?.find((t) => t.id === activeThreadId);
  // The skill in force in this chat: the one its last message was sent with
  // (or, before any message, the one the chat was opened with — an Edit). It
  // stays in force on every later message until the lawyer takes the chip
  // off, so the chip shows it rather than disappearing after the first send.
  const { data: documentTypes } = useDocumentTypes();
  const { data: customSkills } = useCustomSkills();
  const lastUserMessage = useMemo(() => [...(messages ?? [])].reverse().find((m) => m.role === "user"), [messages]);
  const storedSkill = (lastUserMessage ? messageMetadata(lastUserMessage).skill : (activeThread?.skill as MessageMetadata["skill"] | undefined)) ?? null;
  const storedSkillKey = activeThreadId && storedSkill ? JSON.stringify(storedSkill) : "";
  const threadSkill = useMemo<ActiveSkill | null>(() => {
    if (!storedSkillKey) return null;
    const sk = JSON.parse(storedSkillKey) as NonNullable<MessageMetadata["skill"]>;
    const key: SkillKey = sk.key === "verify" ? "review" : sk.key;
    const base = { documentTypeId: sk.documentTypeId, customSkillId: sk.customSkillId, documentVersionId: sk.documentVersionId, matterDocumentId: sk.matterDocumentId };
    switch (key) {
      case "edit":
        if (!sk.documentVersionId) return null;
        return { key, ...base, label: (activeThread?.title ?? "Edit").replace(/^Edit: /, "Edit · ") };
      case "draft": {
        const type = documentTypes?.find((t) => t.id === sk.documentTypeId)?.name;
        return { key, ...base, label: type ? `Draft · ${type}` : "Draft" };
      }
      case "custom": {
        const custom = customSkills?.find((c) => c.id === sk.customSkillId);
        // A firm skill deleted since: nothing is applied, so nothing is shown.
        return custom ? { key, ...base, label: custom.name } : null;
      }
      case "review":
        return { key, ...base, label: "Review" };
      case "summarise":
        return { key, ...base, label: "Summarise" };
      case "agreement":
        return { key, ...base, label: "Agreement" };
      default:
        return null;
    }
  }, [storedSkillKey, activeThread?.title, documentTypes, customSkills]);
  const lastArtifact = threadArtifacts?.length ? threadArtifacts[threadArtifacts.length - 1] : null;

  // A chat handed a document before anything was said in it — minutes from
  // Record Meeting, a version opened for Edit — opens on that document, not
  // on the general welcome. Once per chat, so closing the panel sticks.
  const autoOpened = useRef(new Set<string>());
  useEffect(() => {
    if (!activeThreadId || !messages || messages.length > 0 || turn?.pending || !lastArtifact) return;
    if (lastArtifact.thread_id !== activeThreadId || autoOpened.current.has(activeThreadId)) return;
    autoOpened.current.add(activeThreadId);
    if (!openArtifactState || openArtifactState.thread_id !== activeThreadId) setOpenArtifact(lastArtifact);
  }, [activeThreadId, messages, lastArtifact, turn?.pending, openArtifactState]);

  // Guided drafting: the question this conversation is on, if any.
  const guide = (activeThread?.questionnaire as unknown as GuideState | null | undefined) ?? null;
  const handleGuideAnswer = async (question: { title: string }, answer: { questionId: string; optionIds: string[]; skip?: boolean }, labels: string[]) => {
    if (!activeThreadId) return;
    const threadSkill = activeThread?.skill as { documentTypeId?: string } | null;
    const working = openArtifact && openArtifact.kind === "docx" ? openArtifact.id : (threadArtifacts ?? []).filter((a) => a.kind === "docx").at(-1)?.id ?? null;
    await chat.send({
      matterId, general: matterId ? undefined : me?.id,
      threadId: activeThreadId,
      message: answer.skip ? `Skip: ${question.title}` : `${question.title}: ${labels.join("; ")}`,
      attachments: [],
      skill: { key: "draft", documentTypeId: threadSkill?.documentTypeId, label: "Draft", answer },
      workingArtifactId: working,
    });
  };

  const handleSend = async (input: { message: string; attachments: ChatAttachment[]; skill: ActiveSkill | null }) => {
    // A chat can hold several documents; the one open beside it is the one
    // the lawyer is talking about.
    const working = openArtifact && ["docx", "draft", "memo"].includes(openArtifact.kind) ? openArtifact.id : null;
    // The chip was taken off a chat that has a skill in force: say so, or
    // the chat's skill would carry on regardless.
    // (Not while the firm skills are still loading: the chip for one is
    // only shown once they have, and its absence then means nothing.)
    const skillsLoading = storedSkill?.key === "custom" && !customSkills;
    const clearSkill = !input.skill && !!activeThreadId && !skillsLoading && (!!storedSkill || !!activeThread?.skill);
    const sentFrom = activeThreadId;
    const seeded = !!(mode || docParam || lawUpdateId);
    await chat.send({ matterId, general: matterId ? undefined : me?.id, threadId: activeThreadId, ...input, clearSkill, workingArtifactId: working });
    // A seed (?mode=, ?doc=, ?update=) has done its job once sent in an
    // existing chat; left in the address it would come back on reload. (A
    // new chat's address is replaced when it gets its id.)
    if (sentFrom && seeded && activeThreadIdRef.current === sentFrom) setSearchParams(new URLSearchParams({ chat: sentFrom }), { replace: true });
  };
  // A suggestion chip seeds the composer of the chat that is open, keeping a
  // chat that was handed a document rather than leaving it behind.
  const seedMode = (next: string) => {
    const params = new URLSearchParams();
    if (activeThreadId) params.set("chat", activeThreadId);
    params.set("mode", next);
    setSearchParams(params, { replace: true });
  };

  const sidebar = (
    <ChatSidebar
      scopeKey={chatScopeKey(scope)}
      subtitle={matter?.name ?? (matterId ? undefined : "Your assistant")}
      threads={threads ?? []}
      activeThreadId={activeThreadId}
      busyThreadIds={chat.busyThreadIds}
      onSelect={selectThread}
    />
  );

  // A chat handed a document before anything was said in it.
  const handedDocument = activeThreadId && lastArtifact && !(messages ?? []).length ? lastArtifact : null;
  const emptyState = (
    <div className="flex flex-col items-center gap-6 pt-16 text-center">
      <div>
        <h2 className="text-2xl font-semibold">
          {handedDocument ? `"${handedDocument.title}" is open beside this chat` : matterId ? `How can I help with ${matter?.name ?? "this project"}?` : "What do you need help with?"}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {handedDocument
            ? "Say what to do with it: tighten it, turn it into an agreement, save it to a project, or ask a question about it. "
            : matterId
            ? "Grounded in this project's documents, the firm's precedents and the law library. "
            : "Drop in a document or ask a question. Grounded in the firm's precedents and the law library. "}
          Drop a file in, or type <kbd className="rounded border px-1">/</kbd> for a skill.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <SuggestionChip Icon={Sparkles} label="Draft a document" onClick={() => seedMode("draft")} />
        <SuggestionChip Icon={ScanSearch} label="Review a document" onClick={() => (matterId ? seedMode("review") : setProjectPicker("review"))} />
        <SuggestionChip Icon={StickyNote} label="Summarise a document" onClick={() => seedMode("summarise")} />
        <SuggestionChip Icon={PencilLine} label="Edit a document" onClick={() => (matterId ? setEditPickerOpen(true) : setProjectPicker("edit"))} />
        <SuggestionChip Icon={Search} label="Find a document or clause" onClick={() => navigate("/assistant/search")} />
        <SuggestionChip Icon={FileSignature} label="Turn a meeting into an agreement" onClick={() => seedMode("agreement")} />
      </div>
    </div>
  );

  // What the composer's chip starts as: an Edit just opened, a seed from the
  // address (a chip, a Draft or Review button, a Revise link), else the skill
  // in force in this chat. Memoised: the composer resets its chip when this
  // changes identity.
  const composerSkill = useMemo(() => editSkill ?? seedSkill ?? threadSkill, [editSkill, seedSkill, threadSkill]);

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] overflow-hidden md:-m-6" data-testid="ai-workspace">
      {isMobile || reviewing ? (
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" className="w-80 p-0">{sidebar}</SheetContent>
        </Sheet>
      ) : (
        <div className="hidden w-64 shrink-0 md:block lg:w-72">{sidebar}</div>
      )}

      <ResizablePanelGroup ref={panelGroupRef} direction="horizontal" className="min-w-0 flex-1">
        <ResizablePanel id="chat" order={1} defaultSize={openArtifact ? (reviewing ? 24 : 45) : 100} minSize={reviewing ? 20 : 30}>
          <div className="flex h-full min-w-0 flex-col">
            <div className="flex h-11 items-center gap-2 border-b px-3">
              {(isMobile || reviewing) && (
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSidebarOpen(true)} aria-label="Open chats">
                  <Menu className="h-4 w-4" />
                </Button>
              )}
              <div className="min-w-0 flex-1 truncate text-sm">
                <span className="font-medium">{activeThread?.title ?? "New chat"}</span>
                {matter?.name && <span className="text-muted-foreground"> · {matter.name}</span>}
              </div>
              {!openArtifact && lastArtifact && (
                <Button variant="ghost" size="sm" className="h-8" onClick={() => setOpenArtifact(lastArtifact)}>
                  <PanelRightOpen className="mr-2 h-4 w-4" />
                  <span className="hidden sm:inline">{lastArtifact.title}</span>
                  <FileText className="h-4 w-4 sm:hidden" />
                </Button>
              )}
            </div>

            <MessageList
              messages={messages ?? []}
              artifacts={artifactMap}
              stream={stream}
              pending={turn?.pending ?? null}
              activeArtifactId={openArtifact?.id ?? null}
              onOpenArtifact={setOpenArtifact}
              empty={emptyState}
              resumingMessageId={turn?.resumingMessageId ?? null}
              onResume={(m) => activeThreadId && chat.resume({ matterId, general: matterId ? undefined : me?.id, threadId: activeThreadId, message: m })}
            />

            {guide?.pending && (
              <GuideQuestionCard state={guide} busy={!!turn?.inFlight} onAnswer={handleGuideAnswer} />
            )}

            <Composer
              key={activeThreadId ?? "new"}
              matterId={matterId}
              sending={!!turn?.inFlight}
              initialText={seedText}
              initialSkill={composerSkill}
              initialAttachments={seedAttachments}
              onSend={handleSend}
              onStop={() => chat.stop(activeThreadId)}
              onEditDocument={handleEditDocument}
              editPickerOpen={editPickerOpen}
              onEditPickerOpenChange={setEditPickerOpen}
              onNeedsProject={setProjectPicker}
            />
          </div>
        </ResizablePanel>

        {openArtifact && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel id="artifact" order={2} defaultSize={reviewing ? 76 : 55} minSize={30}>
              <ArtifactPanel
                matterId={matterId}
                matterName={matter?.name}
                artifact={openArtifact}
                lawUpdate={lawUpdate ?? null}
                onClose={() => setOpenArtifact(null)}
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
      <ProjectPickerDialog
        open={!!projectPicker}
        onOpenChange={(o) => { if (!o) setProjectPicker(null); }}
        title={projectPicker === "edit" ? "Edit which project's document?" : "Review which project's document?"}
        description="You'll continue inside that project, where its documents are."
        onPick={(id) => { const purpose = projectPicker; setProjectPicker(null); navigate(`/matters/${id}/ai?mode=${purpose}`); }}
      />
    </div>
  );
}

function SuggestionChip({ Icon, label, onClick }: { Icon: typeof Sparkles; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-2 rounded-full border bg-background px-4 py-2 text-sm hover:bg-accent"
    >
      <Icon className="h-4 w-4 text-muted-foreground" />
      {label}
    </button>
  );
}
