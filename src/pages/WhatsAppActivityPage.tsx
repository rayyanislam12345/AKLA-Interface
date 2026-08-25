import { Fragment, useMemo, useState } from "react";
import { format } from "date-fns";
import { marked } from "marked";
import { ChevronDown, ChevronRight, FileText, MessageCircle, MessageSquareText, Send } from "lucide-react";
import {
  useWhatsAppMatters,
  useWhatsAppDocuments,
  useLinkWhatsAppMatter,
  openWhatsAppDocument,
  type WhatsAppMatter,
} from "@/hooks/useWhatsAppMatters";
import {
  useWhatsAppStatus,
  useLinkMyWhatsApp,
  useBackfillStatus,
  useTriggerBackfill,
  useAskWhatsApp,
  whatsappDocumentDownloadUrl,
} from "@/hooks/useWhatsAppConnection";
import { useMatters } from "@/hooks/useMatters";
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
    } catch (err: any) {
      toast({ title: "Failed to update link", description: err.message, variant: "destructive" });
    }
  };

  return (
    <Select value={whatsappMatter.matter_id ?? "unlinked"} onValueChange={handleChange}>
      <SelectTrigger className="w-56" onClick={(e) => e.stopPropagation()}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent onClick={(e) => e.stopPropagation()}>
        <SelectItem value="unlinked">Unlinked</SelectItem>
        {matters?.map((m) => (
          <SelectItem key={m.id} value={m.id}>
            {m.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function DetailRow({ whatsappMatter }: { whatsappMatter: WhatsAppMatter }) {
  const { data: files, isLoading } = useWhatsAppDocuments(whatsappMatter.id);
  const { toast } = useToast();

  const timeline = Object.entries(whatsappMatter.chat_history)
    .flatMap(([chat, entries]) => entries.map((e) => ({ chat, ...e })))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 10);

  const handleOpen = async (path: string) => {
    try {
      await openWhatsAppDocument(path);
    } catch (err: any) {
      toast({ title: "Failed to open document", description: err.message, variant: "destructive" });
    }
  };

  return (
    <TableRow className="bg-muted/30 hover:bg-muted/30">
      <TableCell colSpan={7} className="py-4">
        <div className="space-y-4">
          {whatsappMatter.detailed_summary && (
            <p className="text-sm text-muted-foreground max-w-3xl">{whatsappMatter.detailed_summary}</p>
          )}

          {timeline.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Recent activity</p>
              {timeline.map((entry, i) => (
                <div key={i} className="text-sm flex gap-2">
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
            <p className="text-sm text-muted-foreground">No documents captured for this matter.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {files.map((file) => (
                <Button
                  key={file.id}
                  variant="outline"
                  size="sm"
                  onClick={() => handleOpen(file.storage_path)}
                  className="gap-1.5"
                >
                  <FileText className="h-3.5 w-3.5" />
                  {file.filename}
                </Button>
              ))}
            </div>
          )}
        </div>
      </TableCell>
    </TableRow>
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
              Ask about anything tracked in your linked WhatsApp chats — matters, documents, or specific
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
    } catch (err: any) {
      toast({ title: "Failed to start backfill", description: err.message, variant: "destructive" });
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
    } catch (err: any) {
      toast({ title: "Failed to link WhatsApp", description: err.message, variant: "destructive" });
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

function WhatsAppConnectionCard() {
  const { data: status, isLoading } = useWhatsAppStatus();

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
        ) : (
          <p className="text-sm text-muted-foreground">Starting…</p>
        )}
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
          Matters tracked automatically from linked lawyers' WhatsApp accounts. Unlinked matters are only
          visible to the lawyer who captured them — link one to a firm Matter to share it.
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
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8"></TableHead>
              <TableHead>Matter</TableHead>
              <TableHead>Captured by</TableHead>
              <TableHead>Chats</TableHead>
              <TableHead>Messages</TableHead>
              <TableHead>Last active</TableHead>
              <TableHead>Link to Matter</TableHead>
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
      )}
    </div>
  );
}
