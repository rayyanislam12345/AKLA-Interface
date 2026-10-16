import { Fragment, useMemo, useState } from "react";
import { format } from "date-fns";
import { marked } from "marked";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronDown, ChevronRight, Download, FileText, FolderPlus, Loader2, MessageCircle, MessageSquareText, Send } from "lucide-react";
import {
  useWhatsAppMatters,
  useWhatsAppDocuments,
  useLinkWhatsAppMatter,
  openWhatsAppDocument,
  downloadWhatsAppDocument,
  useWhatsAppDocumentsInProject,
  addWhatsAppDocumentToProject,
  addAllWhatsAppDocumentsToProject,
  isVoiceNote,
  type WhatsAppDocument,
  type WhatsAppMatter,
} from "@/hooks/useWhatsAppMatters";
import ProjectPickerDialog from "@/components/ai/chat/ProjectPickerDialog";
import { describeIndexing, describeSave } from "@/lib/saveFileToProject";
import {
  useWhatsAppStatus,
  useLinkMyWhatsApp,
  useBackfillStatus,
  useTriggerBackfill,
  useAskWhatsApp,
  useWhatsAppLastSynced,
  whatsappDocumentDownloadUrl,
} from "@/hooks/useWhatsAppConnection";
import { useMatters, isOpenMatter } from "@/hooks/useMatters";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

function formatDate(value: string | null) {
  if (!value) return "—";
  return format(new Date(value), "d MMM yyyy, h:mm a");
}

function LinkToMatterSelect({ whatsappMatter }: { whatsappMatter: WhatsAppMatter }) {
  const { data: matters } = useMatters();
  const linkMatter = useLinkWhatsAppMatter();
  const { toast } = useToast();

  const handleChange = async (value: string) => {
    try {
      await linkMatter.mutateAsync({ id: whatsappMatter.id, matterId: value === "unlinked" ? null : value });
    } catch (err) {
      toast({ title: "Failed to update link", description: (err as Error).message, variant: "destructive" });
    }
  };

  return (
    <Select value={whatsappMatter.matter_id ?? "unlinked"} onValueChange={handleChange}>
      <SelectTrigger className="w-full sm:w-56" onClick={(e) => e.stopPropagation()}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent onClick={(e) => e.stopPropagation()}>
        <SelectItem value="unlinked">Unlinked</SelectItem>
        {/* Closed projects are not offered, but the one already linked stays listed. */}
        {matters?.filter((m) => isOpenMatter(m) || m.id === whatsappMatter.matter_id).map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// Pure content, shared by the desktop table's expanded row and the mobile
// card's expanded section — only the wrapper differs (TableRow/TableCell
// vs a plain div), so this stays presentation-independent.
function WhatsAppMatterDetail({ whatsappMatter }: { whatsappMatter: WhatsAppMatter }) {
  const { data: files, isLoading } = useWhatsAppDocuments(whatsappMatter.id);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: matters } = useMatters();
  const linkedId = whatsappMatter.matter_id;
  const linkedName = whatsappMatter.matter_name ?? "the project";
  // Linked: which files are already among the project's documents, from the
  // database. Unlinked: each file asks which project, and where it went is
  // remembered here for the visit.
  const { data: inProject } = useWhatsAppDocumentsInProject(linkedId, files);
  const [addedElsewhere, setAddedElsewhere] = useState<Record<string, { matterId: string; name: string }>>({});
  const [adding, setAdding] = useState<Set<string>>(new Set());
  const [addingAll, setAddingAll] = useState(false);
  const [pickFor, setPickFor] = useState<WhatsAppDocument | null>(null);

  const refreshProject = (matterId: string) => {
    queryClient.invalidateQueries({ queryKey: ["whatsapp-documents-in-project", matterId] });
    queryClient.invalidateQueries({ queryKey: ["matter-documents", matterId] });
  };

  const addOne = async (file: WhatsAppDocument, matterId: string) => {
    if (adding.has(file.id)) return;
    const name = matterId === linkedId ? linkedName : (matters?.find((m) => m.id === matterId)?.name ?? "the project");
    setAdding((prev) => new Set(prev).add(file.id));
    try {
      const result = await addWhatsAppDocumentToProject(file, matterId);
      if (matterId !== linkedId) setAddedElsewhere((prev) => ({ ...prev, [file.id]: { matterId, name } }));
      refreshProject(matterId);
      toast(describeSave(result, name));
      result.indexing?.then((outcome) => {
        refreshProject(matterId);
        const note = describeIndexing(outcome, result.title);
        if (note) toast({ title: "Added, with a note", description: note });
      });
    } catch (err) {
      toast({ title: `Could not add "${file.filename}"`, description: (err as Error).message, variant: "destructive" });
    } finally {
      setAdding((prev) => {
        const next = new Set(prev);
        next.delete(file.id);
        return next;
      });
    }
  };

  const addAll = async () => {
    if (!linkedId || !files?.length || addingAll) return;
    setAddingAll(true);
    try {
      const outcome = await addAllWhatsAppDocumentsToProject(files, linkedId);
      refreshProject(linkedId);
      const parts = [
        outcome.saved.length ? `${outcome.saved.length} added` : "Nothing new to add",
        outcome.already ? `${outcome.already} already there` : "",
        outcome.voiceNotes ? `${outcome.voiceNotes} voice note${outcome.voiceNotes === 1 ? "" : "s"} left out (add one by one if needed)` : "",
      ].filter(Boolean);
      toast({ title: `${linkedName}: project documents`, description: `${parts.join("; ")}.` });
      if (outcome.failed.length) {
        toast({ title: `${outcome.failed.length} file${outcome.failed.length === 1 ? " was" : "s were"} not added`, description: outcome.failed.join(" "), variant: "destructive" });
      }
      const unread = outcome.saved.map((r) => r.indexing?.then((o) => (o === false ? r.title : null)) ?? Promise.resolve(null));
      Promise.all(unread).then((titles) => {
        refreshProject(linkedId);
        const failedReads = titles.filter(Boolean);
        if (failedReads.length) {
          toast({ title: "Added, with a note", description: `The assistant could not read ${failedReads.map((t) => `"${t}"`).join(", ")} yet. The project's documents page tries again on its own, and has a Try again button.` });
        }
      });
    } catch (err) {
      toast({ title: "Could not add the documents", description: (err as Error).message, variant: "destructive" });
    } finally {
      setAddingAll(false);
    }
  };

  const remaining = linkedId && files ? files.filter((f) => !isVoiceNote(f) && !inProject?.has(f.id)).length : 0;

  const timeline = Object.entries(whatsappMatter.chat_history)
    .flatMap(([chat, entries]) => entries.map((e) => ({ chat, ...e })))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 10);

  const handleOpen = async (path: string) => {
    try {
      await openWhatsAppDocument(path);
    } catch (err) {
      toast({ title: "Failed to open document", description: (err as Error).message, variant: "destructive" });
    }
  };

  const handleDownload = async (path: string, fileName: string) => {
    try {
      await downloadWhatsAppDocument(path, fileName);
    } catch (err) {
      toast({ title: "Failed to download document", description: (err as Error).message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-4">
      {whatsappMatter.detailed_summary && (
        <p className="text-sm text-muted-foreground max-w-3xl">{whatsappMatter.detailed_summary}</p>
      )}

      {timeline.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Recent activity</p>
          {timeline.map((entry, i) => (
            <div key={i} className="text-sm flex gap-2 flex-wrap">
              <span className="text-muted-foreground whitespace-nowrap">
                {format(new Date(entry.timestamp), "d MMM, h:mm a")}
              </span>
              <span className="text-muted-foreground">·</span>
              <span className="text-muted-foreground shrink-0">{entry.chat}</span>
              <span>{entry.summary}</span>
            </div>
          ))}
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading documents…</p>
      ) : !files?.length ? (
        <p className="text-sm text-muted-foreground">No documents captured for this project.</p>
      ) : (
        <div className="space-y-2">
        {linkedId && (
          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" variant="outline" className="gap-1.5" onClick={addAll} disabled={addingAll || remaining === 0} data-testid="whatsapp-add-all">
              {addingAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderPlus className="h-3.5 w-3.5" />}
              {addingAll ? "Adding…" : "Add all to project documents"}
            </Button>
            <span className="text-xs text-muted-foreground">
              {remaining === 0 ? `Every file here is already in ${linkedName}'s documents.` : `Copies files not yet in ${linkedName}'s documents; voice notes are left out.`}
            </span>
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          {files.map((file) => {
            const there = linkedId ? inProject?.get(file.id) : undefined;
            const elsewhere = addedElsewhere[file.id];
            const busy = adding.has(file.id) || (addingAll && !there);
            return (
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
              {there || elsewhere ? (
                <span
                  className="flex h-8 items-center gap-1 border-l px-2 text-xs text-emerald-700 dark:text-emerald-400"
                  title={there ? `In ${linkedName}'s documents as "${there.title}"` : `Added to ${elsewhere!.name}'s documents`}
                >
                  <Check className="h-3.5 w-3.5" />
                  {there ? "In project" : `Added to ${elsewhere!.name}`}
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  title={linkedId ? `Add to ${linkedName}'s documents` : "Add to a project's documents"}
                  disabled={busy}
                  onClick={() => (linkedId ? addOne(file, linkedId) : setPickFor(file))}
                  className="h-8 gap-1 rounded-l-none border-l px-2 text-xs"
                  data-testid="whatsapp-add-to-project"
                >
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderPlus className="h-3.5 w-3.5" />}
                  {busy ? "Adding…" : "Add to project documents"}
                </Button>
              )}
            </div>
            );
          })}
        </div>
        </div>
      )}
      <ProjectPickerDialog
        open={!!pickFor}
        onOpenChange={(open) => !open && setPickFor(null)}
        title="Add to which project?"
        description={pickFor ? `"${pickFor.filename}" will be copied into that project's documents. This WhatsApp project stays unlinked.` : undefined}
        onPick={(id) => {
          const file = pickFor;
          setPickFor(null);
          if (file) void addOne(file, id);
        }}
      />
    </div>
  );
}

function DetailRow({ whatsappMatter }: { whatsappMatter: WhatsAppMatter }) {
  return (
    <TableRow className="bg-muted/30 hover:bg-muted/30">
      <TableCell colSpan={7} className="py-4">
        <WhatsAppMatterDetail whatsappMatter={whatsappMatter} />
      </TableCell>
    </TableRow>
  );
}

// Mobile equivalent of a table row — everything a TableRow's columns show,
// stacked instead of laid out side by side, so nothing needs its own
// horizontal scroll on a narrow screen.
function WhatsAppMatterCard({ whatsappMatter, expanded, onToggle }: { whatsappMatter: WhatsAppMatter; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="border rounded-md">
      <button className="w-full text-left px-3 py-2.5 flex items-start gap-2" onClick={onToggle}>
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        )}
        <div className="min-w-0 flex-1 space-y-1.5">
          <div>
            <p className="font-medium">{whatsappMatter.name}</p>
            {whatsappMatter.summary && <p className="text-xs text-muted-foreground">{whatsappMatter.summary}</p>}
          </div>
          <p className="text-xs text-muted-foreground">
            {whatsappMatter.owner_name ?? "Unknown"} · {whatsappMatter.message_count} messages · Last active{" "}
            {formatDate(whatsappMatter.last_active_at)}
          </p>
          {whatsappMatter.chats.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {whatsappMatter.chats.slice(0, 3).map((chat) => (
                <Badge key={chat} variant="outline" className="text-[10px] font-normal">
                  {chat}
                </Badge>
              ))}
              {whatsappMatter.chats.length > 3 && (
                <Badge variant="outline" className="text-[10px] font-normal">
                  +{whatsappMatter.chats.length - 3}
                </Badge>
              )}
            </div>
          )}
        </div>
      </button>
      <div className="px-3 pb-2.5" onClick={(e) => e.stopPropagation()}>
        <LinkToMatterSelect whatsappMatter={whatsappMatter} />
      </div>
      {expanded && (
        <div className="border-t px-3 py-3">
          <WhatsAppMatterDetail whatsappMatter={whatsappMatter} />
        </div>
      )}
    </div>
  );
}

function AskDialog() {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const { messages, ask, isPending } = useAskWhatsApp();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const question = input.trim();
    if (!question || isPending) return;
    setInput("");
    ask(question);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <MessageSquareText className="h-4 w-4" />
          Ask
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Ask about your WhatsApp chats</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 max-h-96 overflow-y-auto">
          {messages.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Ask about anything tracked in your linked WhatsApp chats — projects, documents, or specific
              conversations.
            </p>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              className={cn(
                "text-sm rounded-md px-3 py-2",
                m.role === "user" ? "bg-muted ml-8" : "bg-primary/5 mr-8",
                m.error && "text-destructive"
              )}
            >
              {m.role === "assistant" ? (
                <div
                  className="[&_p]:mb-2 last:[&_p]:mb-0 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:list-decimal [&_ol]:pl-4"
                  dangerouslySetInnerHTML={{ __html: marked.parse(m.content, { async: false }) as string }}
                />
              ) : (
                m.content
              )}
              {m.documents && m.documents.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {m.documents.map((doc) => (
                    <a
                      key={doc.id}
                      href={whatsappDocumentDownloadUrl(doc.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      <FileText className="h-3 w-3" />
                      {doc.filename}
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
          {isPending && <p className="text-sm text-muted-foreground px-3">Thinking…</p>}
        </div>
        <form onSubmit={handleSubmit} className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask a question…"
            disabled={isPending}
          />
          <Button type="submit" size="icon" disabled={!input.trim() || isPending}>
            <Send className="h-4 w-4" />
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BackfillControl() {
  const { data: backfillStatus } = useBackfillStatus(true);
  const triggerBackfill = useTriggerBackfill();
  const [days, setDays] = useState("20");
  const { toast } = useToast();

  const handleTrigger = async () => {
    try {
      await triggerBackfill.mutateAsync(parseInt(days, 10) || 20);
    } catch (err) {
      toast({ title: "Failed to start backfill", description: (err as Error).message, variant: "destructive" });
    }
  };

  const statusText = (() => {
    if (!backfillStatus) return "";
    if (backfillStatus.running) return `Running… processed ${backfillStatus.chats.length} chat(s) so far.`;
    if (backfillStatus.finishedAt) {
      const total = backfillStatus.chats.reduce((sum, c) => sum + (c.processed || 0), 0);
      const failed = backfillStatus.chats.filter((c) => c.error).length;
      return `Last run finished ${new Date(backfillStatus.finishedAt).toLocaleString()} — ${total} message(s) across ${backfillStatus.chats.length} chat(s)${failed ? `, ${failed} failed` : ""}.`;
    }
    return "";
  })();

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Input
        type="number"
        min={1}
        value={days}
        onChange={(e) => setDays(e.target.value)}
        className="w-20 h-8"
      />
      <span className="text-sm text-muted-foreground">days</span>
      <Button
        size="sm"
        variant="outline"
        onClick={handleTrigger}
        disabled={backfillStatus?.running || triggerBackfill.isPending}
      >
        Run Backfill
      </Button>
      {statusText && <span className="text-xs text-muted-foreground">{statusText}</span>}
    </div>
  );
}

function LinkWhatsAppButton() {
  const linkMyWhatsApp = useLinkMyWhatsApp();
  const { toast } = useToast();

  const handleLink = async () => {
    try {
      await linkMyWhatsApp.mutateAsync();
    } catch (err) {
      toast({ title: "Failed to link WhatsApp", description: (err as Error).message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">
        Link your WhatsApp to start tracking your work chats automatically.
      </p>
      <Button onClick={handleLink} disabled={linkMyWhatsApp.isPending}>
        {linkMyWhatsApp.isPending ? "Linking…" : "Link WhatsApp"}
      </Button>
    </div>
  );
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// "Last synced <date>" from the newest synced_at the tracker wrote, amber
// once it's more than a day old so a stopped sync is visible instead of the
// page quietly showing old activity as if it were current.
function LastSynced() {
  const { data: syncedAt, isLoading } = useWhatsAppLastSynced();
  if (isLoading) return null;
  if (!syncedAt) {
    return <p className="text-sm text-muted-foreground">Nothing has been synced from WhatsApp yet.</p>;
  }
  const stale = Date.now() - new Date(syncedAt).getTime() > ONE_DAY_MS;
  return (
    <p
      className={cn(
        "text-sm",
        stale
          ? "rounded-md border border-amber-300/60 bg-amber-50 px-3 py-2 text-amber-900 dark:bg-amber-950/30 dark:text-amber-200"
          : "text-muted-foreground"
      )}
    >
      Last synced {formatDate(syncedAt)}
      {stale && ". Nothing new has arrived for over a day, so what is shown below may be out of date."}
    </p>
  );
}

function WhatsAppConnectionCard() {
  const { data: status, isLoading, error } = useWhatsAppStatus();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between">
          Your WhatsApp Connection
          {status?.state === "ready" && (
            <Badge className="bg-emerald-600 hover:bg-emerald-600">Connected</Badge>
          )}
          {status?.state === "qr" && <Badge variant="secondary">Waiting for scan</Badge>}
          {status?.state === "disconnected" && <Badge variant="destructive">Disconnected</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : status?.state === "not_linked" ? (
          <LinkWhatsAppButton />
        ) : status?.state === "qr" && status.qr ? (
          <div className="flex items-center gap-4">
            <img src={status.qr} alt="Scan with WhatsApp" className="w-40 h-40 border rounded-md" />
            <p className="text-sm text-muted-foreground max-w-xs">
              Open WhatsApp on your phone → Linked Devices → Link a Device, and scan this code. It refreshes
              automatically if it expires.
            </p>
          </div>
        ) : status?.state === "ready" ? (
          <div className="space-y-3">
            <div className="flex items-center gap-3 flex-wrap">
              <BackfillControl />
              <AskDialog />
            </div>
          </div>
        ) : status?.state === "unreachable" ? (
          <p className="text-sm text-amber-700 dark:text-amber-300">
            The WhatsApp connection service isn't running. Ask Rayyan to start it.
          </p>
        ) : error ? (
          <p className="text-sm text-destructive">
            Could not check your WhatsApp connection: {(error as Error).message}
          </p>
        ) : status?.state === "disconnected" ? (
          <p className="text-sm text-muted-foreground">
            WhatsApp is disconnected from this account. Ask Rayyan to reconnect it.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Starting…</p>
        )}
        <div className="mt-4">
          <LastSynced />
        </div>
      </CardContent>
    </Card>
  );
}

export default function WhatsAppActivityPage() {
  const { data: matters, isLoading } = useWhatsAppMatters();
  const [linkFilter, setLinkFilter] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    return (matters ?? []).filter((m) => {
      if (linkFilter === "linked" && !m.matter_id) return false;
      if (linkFilter === "unlinked" && m.matter_id) return false;
      return true;
    });
  }, [matters, linkFilter]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <MessageCircle className="h-5 w-5 text-primary" />
          WhatsApp Activity
        </h1>
        <p className="text-muted-foreground">
          Projects tracked automatically from linked lawyers' WhatsApp accounts. Unlinked projects are only
          visible to the lawyer who captured them — link one to a firm Project to share it.
        </p>
      </div>

      <WhatsAppConnectionCard />

      <div className="flex gap-3 flex-wrap items-center">
        <Select value={linkFilter} onValueChange={setLinkFilter}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="linked">Linked</SelectItem>
            <SelectItem value="unlinked">Unlinked</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">
          {filtered.length} of {matters?.length ?? 0} matters
        </span>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !filtered.length ? (
        <p className="text-muted-foreground">No WhatsApp activity to show.</p>
      ) : (
        <>
          {/* Below sm, a table forces horizontal scroll no matter how narrow
              the columns get — a stacked card per matter instead needs no
              scrolling at all, at the cost of showing one matter at a time
              instead of a dense grid. */}
          <div className="hidden sm:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Project</TableHead>
                  <TableHead>Captured by</TableHead>
                  <TableHead>Chats</TableHead>
                  <TableHead>Messages</TableHead>
                  <TableHead>Last active</TableHead>
                  <TableHead>Link to Project</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((m) => {
                  const expanded = expandedId === m.id;
                  return (
                    <Fragment key={m.id}>
                      <TableRow className="cursor-pointer" onClick={() => setExpandedId(expanded ? null : m.id)}>
                        <TableCell>
                          {expanded ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell className="max-w-sm">
                          <p className="font-medium truncate">{m.name}</p>
                          {m.summary && <p className="text-xs text-muted-foreground truncate">{m.summary}</p>}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{m.owner_name ?? "—"}</TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-1 max-w-48">
                            {m.chats.slice(0, 3).map((chat) => (
                              <Badge key={chat} variant="outline" className="text-[10px] font-normal">
                                {chat}
                              </Badge>
                            ))}
                            {m.chats.length > 3 && (
                              <Badge variant="outline" className="text-[10px] font-normal">
                                +{m.chats.length - 3}
                              </Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">{m.message_count}</TableCell>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {formatDate(m.last_active_at)}
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <LinkToMatterSelect whatsappMatter={m} />
                        </TableCell>
                      </TableRow>
                      {expanded && <DetailRow whatsappMatter={m} />}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <div className="sm:hidden space-y-2">
            {filtered.map((m) => (
              <WhatsAppMatterCard
                key={m.id}
                whatsappMatter={m}
                expanded={expandedId === m.id}
                onToggle={() => setExpandedId(expandedId === m.id ? null : m.id)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
