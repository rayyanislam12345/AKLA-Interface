import { useEffect, useRef, useState } from "react";
import { BookOpen, ChevronDown, ChevronRight, FileText, Landmark, Paperclip, Play, Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import MarkdownMessage from "@/components/ai/chat/MarkdownMessage";
import { messageMetadata, type ChatArtifact, type ChatAttachment, type ChatMessage, type ChatSource, type StreamingState } from "@/hooks/useChat";
import { cn } from "@/lib/utils";

interface MessageListProps {
  messages: ChatMessage[];
  artifacts: Map<string, ChatArtifact>;
  stream: StreamingState;
  pending: { content: string; attachments: ChatAttachment[] } | null;
  activeArtifactId: string | null;
  onOpenArtifact: (artifact: ChatArtifact) => void;
  empty?: React.ReactNode;
  // A reply left half-written can be picked up again from where it stopped.
  onResume?: (message: ChatMessage) => void;
  resumingMessageId?: string | null;
}

// The scrolling transcript — persisted messages, then (while a turn is in
// flight) the lawyer's just-sent message and the assistant's reply as it
// streams. Layout mirrors claude.ai: user turns as a bubble on the right,
// assistant turns full-width with no bubble.
export default function MessageList({ messages, artifacts, stream, pending, activeArtifactId, onOpenArtifact, empty, onResume, resumingMessageId }: MessageListProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  // Follow the stream unless the reader has scrolled up to re-read something.
  useEffect(() => {
    if (stickToBottom) endRef.current?.scrollIntoView({ behavior: "auto" });
  }, [messages, stream.text, pending, stickToBottom]);

  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    setStickToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };

  const showEmpty = !messages.length && !pending && !stream.text;
  // The chat function stores the lawyer's message before it streams, and a
  // brand-new thread's URL change refetches messages mid-turn — so the
  // persisted copy can arrive while the optimistic bubble is still showing.
  const last = messages[messages.length - 1];
  const showPendingBubble = !!pending && !(last?.role === "user" && last.content === pending.content);

  return (
    <div ref={containerRef} onScroll={onScroll} className="flex-1 overflow-y-auto px-4 md:px-8" data-testid="message-list">
      <div className="mx-auto flex max-w-3xl flex-col gap-6 py-6">
        {showEmpty && empty}
        {messages
          // While it is being resumed the partial is shown as the streaming
          // reply instead, so it grows in place rather than appearing twice.
          .filter((m) => m.id !== resumingMessageId)
          .map((m) => (
            <MessageRow
              key={m.id}
              message={m}
              artifacts={artifacts}
              activeArtifactId={activeArtifactId}
              onOpenArtifact={onOpenArtifact}
              onResume={!pending && onResume ? onResume : undefined}
            />
          ))}
        {showPendingBubble && (
          <UserBubble content={pending!.content} attachments={pending!.attachments} />
        )}
        {pending && (
          <div className="min-w-0" data-testid="streaming-reply">
            {stream.notices.map((n, i) => (
              <p key={i} className="mb-2 text-xs text-amber-700 dark:text-amber-400">{n}</p>
            ))}
            {stream.text ? (
              <MarkdownMessage
                content={stream.text.replace(/<artifact[\s\S]*$/, "")}
                artifacts={artifacts}
                onOpenArtifact={onOpenArtifact}
                inProgress
              />
            ) : (
              <ThinkingDots />
            )}
            {stream.text.includes("<artifact") && !stream.text.includes("</artifact>") && (
              <div className="mt-3 flex items-center gap-2 rounded-xl border bg-background px-3 py-2.5 text-sm text-muted-foreground max-w-md">
                <FileText className="h-4 w-4 animate-pulse" /> Writing document…
              </div>
            )}
            {stream.artifacts.map((a) => (
              <div key={a.id} className="mt-3">
                <MarkdownMessage content={`[[artifact:${a.id}]]`} artifacts={new Map([[a.id, a]])} onOpenArtifact={onOpenArtifact} activeArtifactId={activeArtifactId} />
              </div>
            ))}
          </div>
        )}
        {stream.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
            {stream.error}
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function MessageRow({
  message,
  artifacts,
  activeArtifactId,
  onOpenArtifact,
  onResume,
}: {
  message: ChatMessage;
  artifacts: Map<string, ChatArtifact>;
  activeArtifactId: string | null;
  onOpenArtifact: (artifact: ChatArtifact) => void;
  onResume?: (message: ChatMessage) => void;
}) {
  const meta = messageMetadata(message);
  if (message.role === "user") {
    return <UserBubble content={message.content} attachments={meta.attachments ?? []} />;
  }
  return (
    <div className="min-w-0" data-testid="assistant-message">
      <MarkdownMessage content={message.content} artifacts={artifacts} onOpenArtifact={onOpenArtifact} activeArtifactId={activeArtifactId} />
      {!!meta.sources?.length && <SourcesFootnote sources={meta.sources} />}
      {meta.incomplete && onResume && (
        <div className="mt-3 flex items-center gap-3">
          <Button size="sm" variant="secondary" onClick={() => onResume(message)} data-testid="resume-reply">
            <Play className="mr-2 h-3.5 w-3.5" />
            Continue writing
          </Button>
          <span className="text-xs text-muted-foreground">This reply stopped before it was finished.</span>
        </div>
      )}
    </div>
  );
}

function UserBubble({ content, attachments }: { content: string; attachments: ChatAttachment[] }) {
  return (
    <div className="flex flex-col items-end gap-1.5" data-testid="user-message">
      {attachments.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
          {attachments.map((a) => (
            <span key={`${a.bucket}/${a.path}`} className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-1 text-xs">
              <Paperclip className="h-3 w-3" />
              <span className="max-w-[220px] truncate">{a.name}</span>
            </span>
          ))}
        </div>
      )}
      {content && (
        <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-sm text-primary-foreground">
          {content}
        </div>
      )}
    </div>
  );
}

function ThinkingDots() {
  return (
    <div className="flex items-center gap-1 py-2" aria-label="Thinking">
      <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.3s]" />
      <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.15s]" />
      <span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/60" />
    </div>
  );
}

function scopeMeta(s: ChatSource) {
  switch (s.scope) {
    case "statute":
      return { Icon: Scale, label: s.act_name ?? "Statute" };
    case "precedent":
      return { Icon: BookOpen, label: s.filename ?? "Precedent" };
    default:
      return { Icon: Landmark, label: s.filename ?? "Project document" };
  }
}

// What the reply was grounded in, collapsed by default — the same numbered
// [Source n] labels the model cites.
export function SourcesFootnote({ sources }: { sources: ChatSource[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {sources.length} source{sources.length === 1 ? "" : "s"} from the library
      </button>
      {open && (
        <ol className="mt-2 space-y-1.5">
          {sources.map((s, i) => {
            const { Icon, label } = scopeMeta(s);
            return (
              <li key={s.id} className="flex items-start gap-2 text-xs">
                <span className="w-5 shrink-0 text-muted-foreground">{i + 1}.</span>
                <Icon className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className={cn("font-medium", s.scope === "statute" && "text-amber-800 dark:text-amber-300")}>{label}</span>
                  <span className="ml-1 text-muted-foreground">({Math.round(s.similarity * 100)}%)</span>
                  <span className="block truncate text-muted-foreground">{s.content}</span>
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
