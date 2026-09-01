import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface DocumentChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface DocumentChatPanelProps {
  messages: DocumentChatMessage[];
  onSend: (text: string) => Promise<void>;
  sending: boolean;
  placeholder?: string;
  emptyHint?: string;
}

// Shared chat log + bottom input bar for iterating on a document with the
// AI after an initial draft/review — same bubble styling as MatterChatPage,
// used both there in spirit and directly by DraftDocumentPage/RedlineReviewPage.
export default function DocumentChatPanel({
  messages,
  onSend,
  sending,
  placeholder = "Type a message…",
  emptyHint,
}: DocumentChatPanelProps) {
  const [input, setInput] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    if (!input.trim() || sending) return;
    const text = input.trim();
    setInput("");
    await onSend(text);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-3 min-h-[120px] max-h-[50vh] overflow-y-auto">
        {!messages.length && emptyHint && <p className="text-sm text-muted-foreground">{emptyHint}</p>}
        {messages.map((m, i) => (
          <div
            key={i}
            className={cn(
              "rounded-lg px-3 py-2 text-sm max-w-[85%] whitespace-pre-wrap",
              m.role === "assistant" ? "bg-muted" : "bg-primary text-primary-foreground ml-auto"
            )}
          >
            {m.content}
          </div>
        ))}
        {sending && <p className="text-sm text-muted-foreground">Thinking…</p>}
        <div ref={endRef} />
      </div>
      <div className="flex gap-2">
        <Input
          placeholder={placeholder}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          disabled={sending}
        />
        <Button size="icon" onClick={handleSend} disabled={!input.trim() || sending}>
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
