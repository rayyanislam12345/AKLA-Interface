import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { MessageSquare, Send } from "lucide-react";
import { useMatter } from "@/hooks/useMatters";
import { useMatterChatThread, useMatterChatMessages, useAskMatterQuestion } from "@/hooks/useMatterChat";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

export default function MatterChatPage() {
  const { matterId } = useParams<{ matterId: string }>();
  const { data: matter } = useMatter(matterId);
  const { data: thread } = useMatterChatThread(matterId);
  const [localThreadId, setLocalThreadId] = useState<string | undefined>();
  const activeThreadId = localThreadId ?? thread?.id;

  const { data: messages } = useMatterChatMessages(activeThreadId);
  const ask = useAskMatterQuestion();

  const [input, setInput] = useState("");
  const [lastSources, setLastSources] = useState<any[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || !matterId) return;
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

  if (!matterId) return null;

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-primary" />
          Ask AI
        </h1>
        <p className="text-muted-foreground">
          {matter?.name} — grounded in this matter's documents and the firm's precedent library.
        </p>
      </div>

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
