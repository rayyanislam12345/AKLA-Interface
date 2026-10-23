import { friendlyError } from "@/lib/friendlyError";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ExternalLink, Star } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useMyProfile, useProfiles } from "@/hooks/useProfiles";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import { useMatter, normalizeMatterStatus } from "@/hooks/useMatters";
import { useMatterDocuments } from "@/hooks/useMatterDocuments";
import { useStarredMatters, useToggleStar } from "@/hooks/useMatterStars";
import { attachmentOf, useDocumentVersion } from "@/hooks/useDocumentVersion";
import { buildRevisePrompt, useDocumentsCitingAct, useLawUpdate } from "@/hooks/useLawUpdates";
import { useLatestDocumentVersion } from "@/hooks/useRedline";
import { type ActiveSkill, type ChatAttachment, chatScopeKey, useChatThreads } from "@/hooks/useChat";
import { seedSkillFor } from "@/lib/threadSkill";
import { chatStatus, relativeDay } from "@/lib/chatStatus";
import { openParam, parseOpenParam } from "@/lib/aiLinks";
import { readProjectSeeds } from "@/lib/projectSeeds";
import { useClaudeIsTheChat } from "@/lib/embedMode";
import { useAiPageTitle, useAiWorkspace } from "@/ai/AiWorkspaceContext";
import { useOpenEditChat } from "@/ai/useOpenEditChat";
import AiDocumentWindow from "@/ai/components/AiDocumentWindow";
import CompanionProjectView from "@/ai/components/CompanionProjectView";
import HomePrompt from "@/ai/components/HomePrompt";
import ProjectFilesPanel from "@/ai/components/ProjectFilesPanel";
import ProjectInstructions from "@/ai/components/ProjectInstructions";
import ProjectStandards from "@/ai/components/ProjectStandards";
import SidePanelLayout from "@/ai/components/SidePanelLayout";
import SiteLink from "@/ai/components/SiteLink";
import StatusDot from "@/ai/components/StatusDot";
import ThreadRowMenu from "@/components/ai/chat/ThreadRowMenu";
import { LoadState } from "@/components/LoadState";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

// A project in the AI workspace (/ai/p/:matterId): a prompt box already
// about this project, the chats in it, and beside them its instructions,
// files and the firm's standards. A file opens in the document window on
// the right (?open=v:<versionId>).
//
// The address honours the site's links to /matters/:id/ai as well:
//   ?chat=<id>                       open that chat
//   ?mode=draft|review|summarise     start with that skill in force
//   ?mode=edit                       choose a version to edit
//   ?mode=review&doc=<id>&version=   that document attached (the latest version otherwise)
//   ?update=<lawUpdateId>            a Revise link: Review, the affected document, the prompt filled in
//   ?attach=v:<versionId>            a stored version put in the prompt box ("Ask about this")
// Framed by the companion, or on the pane page (useClaudeIsTheChat), the page
// is CompanionProjectView instead: files, instructions and recent activity,
// and no Hub chat at all.
export default function AiProjectPage() {
  const { matterId } = useParams<{ matterId: string }>();
  // In the companion's drawer and on the pane page the chat is claude.ai's: a
  // read-only view of the project that starts no Hub chat (the address's
  // seeds are ignored).
  const companion = useClaudeIsTheChat();
  // Keyed so moving between projects resets every pane.
  if (companion) return <CompanionProjectView key={matterId} matterId={matterId!} />;
  return <ProjectView key={matterId} matterId={matterId!} />;
}

function ProjectView({ matterId }: { matterId: string }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { user: me } = useAuth();
  // As on the site's chat sidebar: a chat may be deleted by the person who
  // started it or by an administrator, and the prompt names a colleague's.
  const { data: myProfile } = useMyProfile();
  const { data: profiles } = useProfiles();
  const isAdmin = myProfile?.role === "admin" || myProfile?.role === "founder";
  const authorName = (t: { created_by: string | null }) => {
    if (!t.created_by || t.created_by === me?.id) return null;
    const p = profiles?.find((x) => x.id === t.created_by);
    return p?.full_name || p?.email || "A colleague";
  };
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const { chat, panel, setPanel, openVersion, closePanel } = useAiWorkspace();
  const openEdit = useOpenEditChat();

  const { data: matter, isLoading, error: matterError, refetch: refetchMatter } = useMatter(matterId);
  useAiPageTitle(matter?.name ?? "Project");
  const seeds = readProjectSeeds(searchParams);

  // A link to one of this project's chats lands on the chat.
  useEffect(() => {
    if (seeds.chat) navigate(`/ai/c/${seeds.chat}`, { replace: true });
  }, [seeds.chat, navigate]);

  const { data: starred } = useStarredMatters();
  const toggleStar = useToggleStar();
  const isStarred = starred?.has(matterId) ?? false;

  const documents = useMatterDocuments(matterId);
  const threads = useChatThreads({ matterId });
  const projectChats = useMemo(() => (threads.data ?? []).filter((t) => !t.archived && !t.document_type_id), [threads.data]);

  // ---- the document window ----
  const openVersionId = panel?.kind === "version" ? panel.versionId : null;
  // ?open=v:<id> in the address opens that version: on arrival, and again
  // whenever the address brings a different one while the page is on screen
  // (a search result or a pasted link for one of this project's files, or
  // Back). Otherwise the address follows the window, so a refresh or a
  // shared link lands on the same view.
  const openSeed = searchParams.get("open");
  // The last ?open= value acted on, by either effect; undefined before the first.
  const lastSeed = useRef<string | null | undefined>(undefined);
  // The version just adopted, until the panel state has caught up with it.
  const adopting = useRef<string | null>(null);
  useEffect(() => {
    if (lastSeed.current !== undefined && openSeed === lastSeed.current) return;
    const first = lastSeed.current === undefined;
    lastSeed.current = openSeed;
    const parsed = parseOpenParam(openSeed);
    if (parsed?.kind === "version") {
      if (parsed.id === openVersionId) return;
      adopting.current = parsed.id;
      setPanel({ kind: "version", versionId: parsed.id });
    } else if (!first && openVersionId) {
      // The address lost its ?open= (Back, say): the window goes with it.
      closePanel();
    }
  }, [openSeed, openVersionId, setPanel, closePanel]);
  useEffect(() => {
    if (lastSeed.current === undefined) return;
    if (adopting.current && openVersionId !== adopting.current) return;
    adopting.current = null;
    const want = openParam(openVersionId ? { kind: "version", id: openVersionId } : null) ?? null;
    if (want === (searchParams.get("open") ?? null)) return;
    // Our own write is not a new seed to adopt.
    lastSeed.current = want;
    const next = new URLSearchParams(searchParams);
    if (want) next.set("open", want);
    else next.delete("open");
    setSearchParams(next, { replace: true });
  }, [openVersionId, searchParams, setSearchParams]);

  // ---- seeds from the address: Draft / Review buttons, Revise links, Ask about this ----
  const { data: lawUpdate } = useLawUpdate(seeds.update ?? undefined);
  const { data: citingDocs } = useDocumentsCitingAct(matterId, lawUpdate?.act_name);
  const reviewableIds = useMemo(() => new Set((documents.data ?? []).filter((d) => (d.versions?.length ?? 0) > 0).map((d) => d.id)), [documents.data]);
  // The document to pre-attach: ?doc= if given, else the single document that
  // cites the amended Act; if several do, the lawyer picks with "+".
  const affected = (citingDocs ?? []).filter((d) => reviewableIds.has(d.matter_document_id));
  const seedDocId = seeds.doc ?? (seeds.update && affected.length === 1 ? affected[0].matter_document_id : undefined);
  const { data: seedVersion } = useLatestDocumentVersion(seedDocId, seedDocId === seeds.doc ? seeds.version ?? undefined : undefined);
  const seedDoc = documents.data?.find((d) => d.id === seedDocId);
  const legacyAttachments = useMemo<ChatAttachment[] | undefined>(() => {
    if (!seedVersion || !seedDoc) return undefined;
    return [{ bucket: "matter-documents", path: seedVersion.storage_path, name: seedVersion.file_name ?? `${seedDoc.title} v${seedVersion.version_number}`, matterDocumentId: seedDoc.id, versionId: seedVersion.id }];
  }, [seedVersion, seedDoc]);

  const [skill, setSkill] = useState<ActiveSkill | null>(() => seedSkillFor(seeds.mode, seeds.update) ?? null);
  const [editPickerOpen, setEditPickerOpen] = useState(seeds.edit);
  useEffect(() => {
    const seeded = seedSkillFor(seeds.mode, seeds.update);
    if (seeded) setSkill(seeded);
    if (seeds.edit) setEditPickerOpen(true);
  }, [seeds.mode, seeds.update, seeds.edit]);
  const seedText = useMemo(() => (lawUpdate ? buildRevisePrompt(lawUpdate, seedDoc?.title) : undefined), [lawUpdate, seedDoc?.title]);

  // Files put in the prompt box after it is on screen ("Ask about this",
  // "Use in chat", ?attach=): added to whatever is attached already.
  const attachedRef = useRef<ChatAttachment[]>([]);
  const [handed, setHanded] = useState<ChatAttachment[] | undefined>(undefined);
  const addToPrompt = (incoming: ChatAttachment[]) => {
    // Everything attached stays, a file still uploading included: its
    // placeholder must survive so the finished upload can take its place.
    const merged = [...attachedRef.current];
    let added = 0;
    for (const a of incoming) {
      if (merged.some((m) => m.path === a.path)) continue;
      merged.push(a);
      added++;
    }
    setHanded(merged);
    if (added) toast({ title: added === 1 ? `${incoming[0].name} is in the prompt box` : `${added} files are in the prompt box`, description: "Say what you want done with it and send." });
  };
  const { data: attachDetail } = useDocumentVersion(seeds.attach ?? undefined);
  const attachedFromAddress = useRef<string | null>(null);
  useEffect(() => {
    if (!attachDetail || attachedFromAddress.current === attachDetail.version.id) return;
    attachedFromAddress.current = attachDetail.version.id;
    addToPrompt([attachmentOf(attachDetail)]);
    const next = new URLSearchParams(searchParams);
    next.delete("attach");
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attachDetail]);

  const star = () =>
    toggleStar.mutate(
      { matterId, starred: !isStarred },
      { onError: (err) => toast({ title: "Couldn't change the star", description: friendlyError(err), variant: "destructive" }) },
    );

  // ---- states that replace the page ----
  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-6xl px-4 pt-8 md:px-8" aria-label="Loading the project" data-testid="ai-project-loading">
        <div className="h-8 w-2/3 animate-pulse rounded bg-muted" />
        <div className="mt-2 h-4 w-1/3 animate-pulse rounded bg-muted" />
        <div className="mt-6 h-[7.5rem] animate-pulse rounded-[1.25rem] border bg-muted/50" />
      </div>
    );
  }
  if (matterError && !matter) {
    return (
      <div className="px-6 pt-10">
        <LoadState isLoading={false} error={matterError} onRetry={() => refetchMatter()} what="this project" />
      </div>
    );
  }
  if (!matter) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center" data-testid="ai-project-missing">
        <h2 className="text-lg font-semibold">This project isn't available</h2>
        <p className="max-w-sm text-sm text-muted-foreground">It may have been deleted, or the link may be out of date.</p>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm"><SiteLink to="/matters">All projects</SiteLink></Button>
          <Button asChild variant="ghost" size="sm"><Link to="/ai">Home</Link></Button>
        </div>
      </div>
    );
  }

  const client = (matter as { client?: { name: string } | null }).client?.name;
  const closed = normalizeMatterStatus(matter.status) === "closed";
  const scopeKey = chatScopeKey({ matterId });

  const chats = (
    <section data-testid="project-chats">
      <h2 className="mb-2 px-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Chats in this project</h2>
      <LoadState
        isLoading={threads.isLoading}
        error={threads.error}
        onRetry={() => threads.refetch()}
        what="chats"
        compact
        isEmpty={projectChats.length === 0}
        empty={<p className="px-1 text-sm text-muted-foreground">No chats about this project yet. Ask something above.</p>}
      >
        <ul className="divide-y rounded-2xl border bg-card">
          {projectChats.map((t) => (
            <li key={t.id} className="group flex items-center gap-1 pr-1 hover:bg-accent">
              <Link to={`/ai/c/${t.id}`} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5" data-testid="project-chat-row">
                <div className="min-w-0 flex-1 truncate text-sm">{t.title || "New chat"}</div>
                <StatusDot status={chatStatus({ questionnaire: t.questionnaire, busy: chat.busyThreadIds.has(t.id), failed: !!chat.turnFor(t.id)?.stream.error })} />
                <span className="shrink-0 text-xs text-muted-foreground">{relativeDay(t.last_message_at ?? t.created_at)}</span>
              </Link>
              <ThreadRowMenu thread={t} scopeKey={scopeKey} author={authorName(t)} canDelete={isAdmin || (!!me?.id && t.created_by === me.id)} />
            </li>
          ))}
        </ul>
      </LoadState>
    </section>
  );

  const files = (
    <ProjectFilesPanel
      matterId={matterId}
      matterName={matter.name}
      documents={documents.data}
      isLoading={documents.isLoading}
      error={documents.error}
      onRetry={() => documents.refetch()}
      activeVersionId={openVersionId}
      onOpenVersion={openVersion}
      onUseInChat={addToPrompt}
    />
  );
  const instructions = (
    <>
      <ProjectInstructions matterId={matterId} />
      <ProjectStandards documents={documents.data} />
    </>
  );

  const documentWindow = openVersionId ? (
    <AiDocumentWindow
      key={openVersionId}
      kind="version"
      versionId={openVersionId}
      onClose={closePanel}
      onVersionChange={openVersion}
      onAsk={(attachment) => {
        addToPrompt([attachment]);
        if (isMobile) closePanel();
      }}
      onEdit={(target, docMatterId) => void openEdit(docMatterId, target)}
    />
  ) : null;

  return (
    <SidePanelLayout panel={documentWindow} onClose={closePanel} backLabel="Project" testId="ai-project">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-6xl px-4 pb-16 pt-6 md:px-8 md:pt-8">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <h1 className="break-words text-2xl font-semibold tracking-tight md:text-3xl" style={{ fontFamily: "var(--ai-serif)" }}>{matter.name}</h1>
              <p className="mt-0.5 text-sm text-muted-foreground">
                {client || "No client"}
                {matter.sector ? ` · ${matter.sector}` : ""}
                {closed ? " · Closed" : ""}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-9 w-9 shrink-0"
              onClick={star}
              aria-pressed={isStarred}
              aria-label={isStarred ? "Remove the star" : "Star this project"}
              title={isStarred ? "Starred: at the top of your projects" : "Star this project to keep it at the top"}
              data-testid="project-star"
            >
              <Star className={cn("h-5 w-5", isStarred ? "fill-[hsl(var(--gold))] text-[hsl(var(--gold))]" : "text-muted-foreground")} />
            </Button>
            <Button asChild variant="ghost" size="sm" className="h-9 shrink-0">
              <SiteLink to={`/matters/${matterId}`} className="inline-flex items-center gap-1.5">
                <ExternalLink className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Open on Project Hub</span>
                <span className="sm:hidden">Project Hub</span>
              </SiteLink>
            </Button>
          </div>

          <div className="-mx-4 mt-5 md:-mx-8">
            <HomePrompt
              scope={{ matterId }}
              scopeLabel={matter.name}
              locked
              skill={skill}
              seedText={seedText}
              seedAttachments={handed ?? legacyAttachments}
              editPickerOpen={editPickerOpen}
              onEditPickerOpenChange={setEditPickerOpen}
              onNeedsProject={() => undefined}
              onAttachmentsChange={(a) => {
                attachedRef.current = a;
              }}
              autoFocus={!isMobile}
            />
          </div>

          {isMobile ? (
            <Tabs defaultValue="chats" className="mt-4" data-testid="project-tabs">
              <TabsList className="w-full">
                <TabsTrigger value="chats" className="flex-1">Chats</TabsTrigger>
                <TabsTrigger value="files" className="flex-1">Files</TabsTrigger>
                <TabsTrigger value="instructions" className="flex-1">Instructions</TabsTrigger>
              </TabsList>
              {/* All three stay mounted, so files waiting to be uploaded, a ticked selection or unsaved instructions survive a tab switch. */}
              <TabsContent value="chats" forceMount className="mt-4 data-[state=inactive]:hidden">{chats}</TabsContent>
              <TabsContent value="files" forceMount className="mt-4 data-[state=inactive]:hidden">{files}</TabsContent>
              <TabsContent value="instructions" forceMount className="mt-4 space-y-4 data-[state=inactive]:hidden">{instructions}</TabsContent>
            </Tabs>
          ) : (
            <div className={cn("mt-8 grid gap-6", !openVersionId && "lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]")}>
              <div className="min-w-0">{chats}</div>
              <div className="min-w-0 space-y-4">
                {instructions}
                {files}
              </div>
            </div>
          )}
        </div>
      </div>
    </SidePanelLayout>
  );
}
