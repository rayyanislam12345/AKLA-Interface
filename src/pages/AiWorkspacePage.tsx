import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { FileText, Menu, PanelRightOpen, PencilLine, ScanSearch, Sparkles, StickyNote } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useMatter } from "@/hooks/useMatters";
import { useIsMobile } from "@/hooks/use-mobile";
import { buildRevisePrompt, useDocumentsCitingAct, useLawUpdate } from "@/hooks/useLawUpdates";
import { useLatestDocumentVersion } from "@/hooks/useRedline";
import { useMatterDocuments } from "@/hooks/useMatterDocuments";
import {
  type ActiveSkill,
  type ChatArtifact,
  type ChatAttachment,
  type EditTarget,
  openDocumentForEdit,
  useChatMessages,
  useChatThreads,
  useSendChatMessage,
  useThreadArtifacts,
} from "@/hooks/useChat";
import ChatSidebar from "@/components/ai/chat/ChatSidebar";
import MessageList from "@/components/ai/chat/MessageList";
import Composer from "@/components/ai/chat/Composer";
import ArtifactPanel from "@/components/ai/chat/ArtifactPanel";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

// The AI Workspace: a claude.ai-shaped chat per matter. Conversations on the
// left, the transcript and composer in the middle, and any document the
// assistant produced (a draft, a memo, a review) opening in a panel on the
// right. Everything the model says is grounded in this matter's documents,
// the precedent library and the law library — see functions/chat.
//
// URL contract (the matter page and Revise links depend on it):
//   ?chat=<threadId>                 open that conversation
//   ?mode=draft                      start with the Draft skill in force
//   ?mode=verify&doc=<matterDocId>   start with Verify + that document attached
//   ?update=<lawUpdateId>            a Revise link — Verify, the affected
//                                    document attached, the prompt pre-filled
export default function AiWorkspacePage() {
  const { matterId } = useParams<{ matterId: string }>();
  if (!matterId) return null;
  // Keyed on the matter so navigating between matters resets every pane —
  // React Router reuses this element across param changes otherwise.
  return <AiWorkspace key={matterId} matterId={matterId} />;
}

function AiWorkspace({ matterId }: { matterId: string }) {
  const { data: matter } = useMatter(matterId);
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();

  const activeThreadId = searchParams.get("chat");
  const mode = searchParams.get("mode");
  const docParam = searchParams.get("doc") ?? undefined;
  const lawUpdateId = searchParams.get("update") ?? undefined;

  const { data: threads } = useChatThreads(matterId);
  const { data: messages } = useChatMessages(activeThreadId ?? undefined);
  const { data: threadArtifacts } = useThreadArtifacts(activeThreadId ?? undefined);

  const [openArtifact, setOpenArtifact] = useState<ChatArtifact | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [editPickerOpen, setEditPickerOpen] = useState(false);
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
      const { threadId, artifact } = await openDocumentForEdit(matterId, target, user?.id);
      setEditSkill({
        key: "edit",
        documentVersionId: target.versionId,
        matterDocumentId: target.matterDocumentId,
        documentTypeId: target.documentTypeId ?? undefined,
        label: `Edit · ${target.title} v${target.versionNumber}`,
      });
      setSearchParams(new URLSearchParams({ chat: threadId }));
      setOpenArtifact(artifact);
      queryClient.invalidateQueries({ queryKey: ["chat-threads", matterId] });
      queryClient.invalidateQueries({ queryKey: ["chat-artifacts", threadId] });
    } catch (err: any) {
      toast({ title: "Couldn't open that document", description: err.message, variant: "destructive" });
    }
  };

  const chat = useSendChatMessage(
    (threadId) => {
      // The first message of a new chat gives it a row — reflect it in the URL
      // (dropping any ?mode/?doc seed) so a refresh lands back on it.
      setSearchParams(new URLSearchParams({ chat: threadId }), { replace: true });
    },
    (artifact) => setOpenArtifact(artifact),
  );

  // Artifacts by id — the persisted ones for this thread plus anything the
  // current turn has streamed so far.
  const artifactMap = useMemo(() => {
    const map = new Map<string, ChatArtifact>();
    for (const a of threadArtifacts ?? []) map.set(a.id, a);
    for (const a of chat.stream.artifacts) map.set(a.id, a);
    return map;
  }, [threadArtifacts, chat.stream.artifacts]);

  // Keep the open panel on the freshest copy of its artifact (after a save).
  useEffect(() => {
    if (openArtifact) {
      const fresh = artifactMap.get(openArtifact.id);
      if (fresh && fresh !== openArtifact) setOpenArtifact(fresh);
    }
  }, [artifactMap, openArtifact]);

  // ---- seeds from the URL: Draft / Verify buttons and Revise links ----
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
    if (mode === "verify" || lawUpdateId) return { key: "verify", label: "Verify" };
    return undefined;
  }, [mode, lawUpdateId]);

  const seedText = useMemo(() => {
    if (!lawUpdate) return undefined;
    return buildRevisePrompt(lawUpdate, seedDoc?.title);
  }, [lawUpdate, seedDoc?.title]);

  const activeThread = threads?.find((t) => t.id === activeThreadId);
  // A reopened edit thread (reload, or picked from the sidebar) keeps its
  // Edit skill in force — the thread row remembers which version it is on.
  const threadEditSkill = useMemo<ActiveSkill | null>(() => {
    const sk = activeThread?.skill as any;
    if (sk?.key !== "edit" || !sk.documentVersionId) return null;
    return {
      key: "edit",
      documentVersionId: sk.documentVersionId,
      matterDocumentId: sk.matterDocumentId,
      label: (activeThread?.title ?? "Edit").replace(/^Edit: /, "Edit · "),
    };
  }, [activeThread]);
  const lastArtifact = threadArtifacts?.length ? threadArtifacts[threadArtifacts.length - 1] : null;

  const handleSend = async (input: { message: string; attachments: ChatAttachment[]; skill: ActiveSkill | null }) => {
    await chat.send({ matterId, threadId: activeThreadId, ...input });
  };

  const sidebar = (
    <ChatSidebar
      matterId={matterId}
      matterName={matter?.name}
      threads={threads ?? []}
      activeThreadId={activeThreadId}
      onSelect={selectThread}
    />
  );

  const emptyState = (
    <div className="flex flex-col items-center gap-6 pt-16 text-center">
      <div>
        <h2 className="text-2xl font-semibold">How can I help with {matter?.name ?? "this project"}?</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Grounded in this project's documents, the firm's precedents and the law library. Drop a file in, or type <kbd className="rounded border px-1">/</kbd> for a skill.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <SuggestionChip Icon={Sparkles} label="Draft a document" onClick={() => setSearchParams(new URLSearchParams({ mode: "draft" }), { replace: true })} />
        <SuggestionChip Icon={ScanSearch} label="Verify a document" onClick={() => setSearchParams(new URLSearchParams({ mode: "verify" }), { replace: true })} />
        <SuggestionChip Icon={StickyNote} label="Summarise a document" onClick={() => setSearchParams(new URLSearchParams({ mode: "summarise" }), { replace: true })} />
        <SuggestionChip Icon={PencilLine} label="Edit a document" onClick={() => setEditPickerOpen(true)} />
      </div>
    </div>
  );

  const seedSkillWithSummarise = mode === "summarise" ? ({ key: "summarise", label: "Summarise" } as ActiveSkill) : seedSkill;
  const composerSkill = editSkill ?? threadEditSkill ?? seedSkillWithSummarise;

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] overflow-hidden md:-m-6" data-testid="ai-workspace">
      {isMobile ? (
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" className="w-80 p-0">{sidebar}</SheetContent>
        </Sheet>
      ) : (
        <div className="hidden w-64 shrink-0 md:block lg:w-72">{sidebar}</div>
      )}

      <ResizablePanelGroup direction="horizontal" className="min-w-0 flex-1">
        <ResizablePanel defaultSize={openArtifact ? 45 : 100} minSize={30}>
          <div className="flex h-full min-w-0 flex-col">
            <div className="flex h-11 items-center gap-2 border-b px-3">
              {isMobile && (
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
              stream={chat.stream}
              pending={chat.pending}
              activeArtifactId={openArtifact?.id ?? null}
              onOpenArtifact={setOpenArtifact}
              empty={emptyState}
              resumingMessageId={chat.resumingMessageId}
              onResume={(m) => activeThreadId && chat.resume({ matterId, threadId: activeThreadId, message: m })}
            />

            <Composer
              key={activeThreadId ?? "new"}
              matterId={matterId}
              sending={chat.sending}
              initialText={seedText}
              initialSkill={composerSkill}
              initialAttachments={seedAttachments}
              onSend={handleSend}
              onStop={chat.stop}
              onEditDocument={handleEditDocument}
              editPickerOpen={editPickerOpen}
              onEditPickerOpenChange={setEditPickerOpen}
            />
          </div>
        </ResizablePanel>

        {openArtifact && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={55} minSize={30}>
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
