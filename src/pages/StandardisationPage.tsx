import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Check, FileText, Globe, Menu, PanelRightOpen, Plus, Scale, X } from "lucide-react";
import AddLawDialog from "@/components/law/AddLawDialog";
import { useIsMobile } from "@/hooks/use-mobile";
import { useDocumentTypes } from "@/hooks/useMatterDocuments";
import { useDocumentTypeTemplate } from "@/hooks/useDocumentTypeTemplates";
import { useStatuteSources } from "@/hooks/useLawLibrary";
import {
  type ChatArtifact,
  type ChatAttachment,
  chatScopeKey,
  messageMetadata,
  useChatMessages,
  useChatThreads,
  useSendChatMessage,
  useThreadArtifacts,
  useUpdateChatThread,
  EMPTY_STREAM,
} from "@/hooks/useChat";
import ChatSidebar from "@/components/ai/chat/ChatSidebar";
import MessageList from "@/components/ai/chat/MessageList";
import Composer from "@/components/ai/chat/Composer";
import ArtifactPanel from "@/components/ai/chat/ArtifactPanel";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import type { ImperativePanelGroupHandle } from "react-resizable-panels";

// The standardisation window: an associate builds the firm's standard master
// for one document type with the AI, from the firm's own earlier documents
// (uploaded, from the Precedent Library, or from any project) and the laws
// they identify from the law library. The same chat as the AI Workspace,
// scoped to a document type instead of a project; the master and its
// Standardisation Note open beside the chat, and "Set as standard" on the
// master publishes it for every future draft of the type.
//
//   /precedent-library/standardize/:documentTypeId/build?chat=<threadId>
export default function StandardisationPage() {
  const { documentTypeId } = useParams<{ documentTypeId: string }>();
  if (!documentTypeId) return null;
  return <Standardisation key={documentTypeId} documentTypeId={documentTypeId} />;
}

function Standardisation({ documentTypeId }: { documentTypeId: string }) {
  const isMobile = useIsMobile();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeThreadId = searchParams.get("chat");
  const scope = useMemo(() => ({ documentTypeId }), [documentTypeId]);
  const scopeKey = chatScopeKey(scope);

  const { data: documentTypes } = useDocumentTypes();
  const documentType = documentTypes?.find((t) => t.id === documentTypeId);
  const documentTypeName = documentType?.name ?? "Document type";
  const { data: currentStandard } = useDocumentTypeTemplate(documentTypeId);
  const { data: threads } = useChatThreads(scope);
  const { data: messages } = useChatMessages(activeThreadId ?? undefined);
  const { data: threadArtifacts } = useThreadArtifacts(activeThreadId ?? undefined);
  const updateThread = useUpdateChatThread(scopeKey);

  const [openArtifactState, setOpenArtifact] = useState<ChatArtifact | null>(null);
  const openArtifact = openArtifactState && openArtifactState.thread_id === activeThreadId ? openArtifactState : null;
  const panelGroupRef = useRef<ImperativePanelGroupHandle>(null);
  useEffect(() => {
    if (openArtifact) panelGroupRef.current?.setLayout([45, 55]);
  }, [openArtifact?.id]);
  const activeThreadIdRef = useRef(activeThreadId);
  activeThreadIdRef.current = activeThreadId;
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // The laws identified for the standard live on the thread; before the
  // first message creates one they live here and go with that message.
  const activeThread = threads?.find((t) => t.id === activeThreadId);
  const [draftLaws, setDraftLaws] = useState<string[]>([]);
  const laws = activeThread ? ((activeThread.laws as string[] | null) ?? []) : draftLaws;
  const setLaws = (next: string[]) => {
    if (activeThread) updateThread.mutate({ id: activeThread.id, laws: next });
    else setDraftLaws(next);
  };

  const selectThread = useCallback(
    (threadId: string | null) => {
      const params = new URLSearchParams();
      if (threadId) params.set("chat", threadId);
      setSearchParams(params);
      setOpenArtifact(null);
      setSidebarOpen(false);
    },
    [setSearchParams],
  );

  const chat = useSendChatMessage(
    (threadId) => {
      if (activeThreadIdRef.current === null) setSearchParams(new URLSearchParams({ chat: threadId }), { replace: true });
    },
    (artifact) => {
      if (artifact.thread_id === activeThreadIdRef.current) setOpenArtifact(artifact);
    },
  );
  const turn = chat.turnFor(activeThreadId);
  const stream = turn?.stream ?? EMPTY_STREAM;

  const artifactMap = useMemo(() => {
    const map = new Map<string, ChatArtifact>();
    for (const a of threadArtifacts ?? []) map.set(a.id, a);
    for (const a of stream.artifacts) map.set(a.id, a);
    return map;
  }, [threadArtifacts, stream.artifacts]);
  useEffect(() => {
    if (openArtifact) {
      const fresh = artifactMap.get(openArtifact.id);
      if (fresh && fresh !== openArtifact) setOpenArtifact(fresh);
    }
  }, [artifactMap, openArtifact]);

  // Every source supplied so far in this session, for the strip under the
  // header — they stay in the AI's context for the whole conversation.
  const sources = useMemo(() => {
    const seen = new Map<string, ChatAttachment>();
    for (const m of messages ?? []) {
      if (m.role !== "user") continue;
      for (const a of messageMetadata(m).attachments ?? []) if (!seen.has(a.path)) seen.set(a.path, a);
    }
    return [...seen.values()];
  }, [messages]);

  const lastArtifact = threadArtifacts?.length ? threadArtifacts[threadArtifacts.length - 1] : null;

  const handleSend = async (input: { message: string; attachments: ChatAttachment[] }) => {
    const working = openArtifact && ["docx", "draft", "memo"].includes(openArtifact.kind) ? openArtifact.id : null;
    await chat.send({ documentTypeId, threadId: activeThreadId, laws, message: input.message, attachments: input.attachments, skill: null, workingArtifactId: working });
  };

  const sidebar = (
    <ChatSidebar
      scopeKey={scopeKey}
      subtitle={`Standardising · ${documentTypeName}`}
      threads={threads ?? []}
      activeThreadId={activeThreadId}
      busyThreadIds={chat.busyThreadIds}
      onSelect={selectThread}
    />
  );

  const emptyState = (
    <div className="mx-auto flex max-w-xl flex-col gap-5 pt-12 text-center">
      <div>
        <h2 className="text-2xl font-semibold">Build the standard {documentTypeName}</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          {currentStandard?.filename
            ? `The firm's current standard is ${currentStandard.filename}. The AI revises it from the sources you supply, as tracked changes.`
            : "There is no standard for this type yet. The AI builds one from the sources you supply and the laws you identify."}
        </p>
      </div>
      <ol className="space-y-2 text-left text-sm text-muted-foreground">
        <li><span className="font-medium text-foreground">1. Supply sources.</span> Use <kbd className="rounded border px-1">+</kbd> to upload the firm's earlier documents of this type, take them from the Precedent Library, or pick them from any project. Two or more is best.</li>
        <li><span className="font-medium text-foreground">2. Identify the law.</span> Add the Acts this document turns on with <span className="font-medium">Add law</span> above; the AI checks every clause against them and cites the sections.</li>
        <li><span className="font-medium text-foreground">3. Ask for the master.</span> The AI produces the master with [●] placeholders and AKLA comments, and a Standardisation Note showing where each clause came from, the laws checked and what is left for a partner to decide.</li>
        <li><span className="font-medium text-foreground">4. Refine, then publish.</span> Ask for changes — they come as tracked changes — and press <span className="font-medium">Set as standard</span> on the master when it is ready.</li>
      </ol>
    </div>
  );

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] overflow-hidden md:-m-6" data-testid="standardisation-workspace">
      {isMobile ? (
        <Sheet open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <SheetContent side="left" className="w-80 p-0">{sidebar}</SheetContent>
        </Sheet>
      ) : (
        <div className="hidden w-64 shrink-0 md:block lg:w-72">{sidebar}</div>
      )}

      <ResizablePanelGroup ref={panelGroupRef} direction="horizontal" className="min-w-0 flex-1">
        <ResizablePanel id="chat" order={1} defaultSize={openArtifact ? 45 : 100} minSize={30}>
          <div className="flex h-full min-w-0 flex-col">
            <div className="flex h-11 items-center gap-2 border-b px-3">
              {isMobile && (
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setSidebarOpen(true)} aria-label="Open sessions">
                  <Menu className="h-4 w-4" />
                </Button>
              )}
              <Button asChild variant="ghost" size="sm" className="h-8 px-2">
                <Link to={`/precedent-library/standardize/${documentTypeId}`} aria-label="Back to the standard">
                  <ArrowLeft className="h-4 w-4" />
                </Link>
              </Button>
              <div className="min-w-0 flex-1 truncate text-sm">
                <span className="font-medium">{activeThread?.title ?? "New session"}</span>
                <span className="text-muted-foreground"> · Standard {documentTypeName}</span>
              </div>
              {!openArtifact && lastArtifact && (
                <Button variant="ghost" size="sm" className="h-8" onClick={() => setOpenArtifact(lastArtifact)}>
                  <PanelRightOpen className="mr-2 h-4 w-4" />
                  <span className="hidden sm:inline">{lastArtifact.title}</span>
                  <FileText className="h-4 w-4 sm:hidden" />
                </Button>
              )}
            </div>

            <ContextStrip laws={laws} onLawsChange={setLaws} sources={sources} />

            <MessageList
              messages={messages ?? []}
              artifacts={artifactMap}
              stream={stream}
              pending={turn?.pending ?? null}
              activeArtifactId={openArtifact?.id ?? null}
              onOpenArtifact={setOpenArtifact}
              empty={emptyState}
              resumingMessageId={turn?.resumingMessageId ?? null}
              onResume={(m) => activeThreadId && chat.resume({ documentTypeId, threadId: activeThreadId, message: m })}
            />

            <Composer
              key={activeThreadId ?? "new"}
              standard={{ documentTypeId, documentTypeName }}
              sending={!!turn?.inFlight}
              onSend={handleSend}
              onStop={() => chat.stop(activeThreadId)}
            />
          </div>
        </ResizablePanel>

        {openArtifact && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel id="artifact" order={2} defaultSize={55} minSize={30}>
              <ArtifactPanel
                standard={{ documentTypeId, documentTypeName }}
                artifact={openArtifact}
                onClose={() => setOpenArtifact(null)}
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  );
}

// The laws identified for the standard, and the sources supplied so far —
// what the AI is working from, kept in view above the conversation.
function ContextStrip({ laws, onLawsChange, sources }: { laws: string[]; onLawsChange: (laws: string[]) => void; sources: ChatAttachment[] }) {
  const { data: statutes } = useStatuteSources();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const toggle = (act: string) => onLawsChange(laws.includes(act) ? laws.filter((l) => l !== act) : [...laws, act]);
  // A law the library does not hold is found or uploaded from here, and
  // identified for the standard as soon as it is in.
  const openAdd = () => {
    setOpen(false);
    setAddOpen(true);
  };
  return (
    <div className="space-y-1.5 border-b bg-muted/20 px-3 py-2 text-xs" data-testid="standardisation-context">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center gap-1 font-medium text-muted-foreground"><Scale className="h-3.5 w-3.5" /> Laws</span>
        {laws.length === 0 && <span className="text-muted-foreground">none identified yet</span>}
        {laws.map((act) => (
          <span key={act} className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-0.5" data-testid="law-chip">
            <span className="max-w-[260px] truncate" title={act}>{act}</span>
            <button type="button" aria-label={`Remove ${act}`} className="rounded hover:bg-muted" onClick={() => toggle(act)}>
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="outline" size="sm" className="h-6 px-2 text-xs" data-testid="add-law">
              <Plus className="mr-1 h-3 w-3" /> Add law
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-96 p-0">
            <Command>
              <CommandInput placeholder="Search the law library…" value={query} onValueChange={setQuery} />
              <CommandList>
                <CommandEmpty>Not in the law library.</CommandEmpty>
                <CommandGroup heading="Law library">
                  {(statutes ?? []).map((s) => (
                    <CommandItem key={s.act_name} value={s.act_name} onSelect={() => toggle(s.act_name)}>
                      <Check className={`mr-2 h-4 w-4 ${laws.includes(s.act_name) ? "opacity-100" : "opacity-0"}`} />
                      <span className="truncate">{s.act_name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
              <button
                type="button"
                onClick={openAdd}
                className="flex w-full items-center gap-2 border-t px-3 py-2 text-left text-xs hover:bg-accent"
                data-testid="find-or-upload-law"
              >
                <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span>
                  Not here? <span className="font-medium">Find it on official sources or upload it</span>
                  {query.trim() ? <> — “{query.trim()}”</> : null}
                </span>
              </button>
            </Command>
          </PopoverContent>
        </Popover>
        <AddLawDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          initialName={query.trim()}
          onAdded={(act) => {
            if (!laws.includes(act)) onLawsChange([...laws, act]);
            setQuery("");
          }}
        />
      </div>
      {sources.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="inline-flex items-center gap-1 font-medium text-muted-foreground"><FileText className="h-3.5 w-3.5" /> Sources</span>
          {sources.map((a) => (
            <span key={a.path} className="max-w-[280px] truncate rounded-md border bg-background px-2 py-0.5" title={a.name} data-testid="source-chip">
              {a.name}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
