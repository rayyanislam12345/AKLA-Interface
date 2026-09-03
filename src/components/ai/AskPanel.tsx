import { useEffect, useRef, useState } from "react";
import { FilePlus2, Send } from "lucide-react";
import { useMatterChatThread, useMatterChatMessages, useAskMatterQuestion } from "@/hooks/useMatterChat";
import DocumentUploadCard from "@/components/ai/DocumentUploadCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface AskPanelProps {
  matterId: string;
  active: boolean;
}

// Matter Q&A grounded (via rag-query) in this matter's documents and the
// firm's precedent library. The upload card lets a lawyer add a document
// here and ask about it straight away — it lands on the matter like any
// other upload, so it's not scratch context, it's part of the record.
export default function AskPanel({ matterId, active }: AskPanelProps) {
  const { data: thread } = useMatterChatThread(matterId);
  const [localThreadId, setLocalThreadId] = useState<string | undefined>();
  const activeThreadId = localThreadId ?? thread?.id;

  const { data: messages } = useMatterChatMessages(activeThreadId);
  const ask = useAskMatterQuestion();

  const [input, setInput] = useState("");
  const [lastSources, setLastSources] = useState<any[]>([]);
  const [showUpload, setShowUpload] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // scrollIntoView is a no-op while the panel is hidden behind another tab,
  // so re-run it when this tab becomes active, not only when messages change.
  useEffect(() => {
    if (active) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, active]);

  const handleSend = async () => {
    if (!input.trim()) return;
    const query = input.trim();
    setInput("");
    try {
      const result = await ask.mutateAsync({ matterId, threadId: activeThreadId, query });
      setLocalThreadId(result.threadId);
      setLastSources(result.sources ?? []);
    } catch {
      // error surfaced via ask.isError below
    }
  };

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="text-sm text-muted-foreground">
          Grounded in this matter's documents and the firm's precedent library.
        </p>
        <Button size="sm" variant="outline" onClick={() => setShowUpload((v) => !v)}>
          <FilePlus2 className="h-4 w-4 mr-2" />
          {showUpload ? "Hide upload" : "Add a document"}
        </Button>
      </div>

      {showUpload && (
        <Card>
          <CardContent className="pt-6">
            <DocumentUploadCard
              matterId={matterId}
              hint="Upload a document to this matter and it becomes part of what Ask AI can answer from."
              onUploaded={() => setShowUpload(false)}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="space-y-3 min-h-[300px] max-h-[60vh] overflow-y-auto">
            {!messages?.length && (
              <p className="text-sm text-muted-foreground">
                Ask a question about this matter's documents, or about how the firm has handled similar terms before.
              </p>
            )}
            {messages?.map((m) => (
              <div
                key={m.id}
                className={cn(
                  "rounded-lg px-3 py-2 text-sm max-w-[85%] whitespace-pre-wrap",
                  m.role === "assistant" ? "bg-muted" : "bg-primary text-primary-foreground ml-auto"
                )}
              >
                {m.content}
              </div>
            ))}
            {ask.isPending && <p className="text-sm text-muted-foreground">Thinking…</p>}
            {ask.isError && <p className="text-sm text-destructive">Something went wrong — try again.</p>}
            <div ref={endRef} />
          </div>

          {lastSources.length > 0 && (
            <div className="border-t pt-3 space-y-1">
              <p className="text-xs font-medium text-muted-foreground">
                Sources for the last answer ({lastSources.length}):
              </p>
              {lastSources.map((s) => (
                <p key={s.id} className="text-xs text-muted-foreground truncate">
                  <span className="font-medium">
                    {s.scope === "matter" ? s.filename ?? "This matter" : "Precedent"}
                  </span>
                  {" · "}
                  {(s.similarity * 100).toFixed(0)}% match — {s.content.slice(0, 100)}…
                </p>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <Input
              placeholder="Ask a question…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSend()}
              disabled={ask.isPending}
            />
            <Button size="icon" onClick={handleSend} disabled={!input.trim() || ask.isPending}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
