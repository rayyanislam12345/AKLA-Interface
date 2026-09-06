import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileText, ScanSearch, StickyNote } from "lucide-react";
import type { ChatArtifact } from "@/hooks/useChat";
import { cn } from "@/lib/utils";

interface MarkdownMessageProps {
  content: string;
  artifacts: Map<string, ChatArtifact>;
  onOpenArtifact: (artifact: ChatArtifact) => void;
  activeArtifactId?: string | null;
  className?: string;
}

const ARTIFACT_MARKER = /\[\[artifact:([0-9a-f-]{36})\]\]/g;

export function artifactIcon(kind: string) {
  if (kind === "review") return ScanSearch;
  if (kind === "memo") return StickyNote;
  return FileText;
}

// Renders an assistant reply the way claude.ai does: GFM markdown, with any
// document the model produced shown as a clickable card (the chat function
// stores those as [[artifact:id]] markers where the block was) rather than
// inline in the bubble.
export default function MarkdownMessage({ content, artifacts, onOpenArtifact, activeArtifactId, className }: MarkdownMessageProps) {
  const parts: Array<{ type: "md"; text: string } | { type: "artifact"; id: string }> = [];
  let last = 0;
  for (const m of content.matchAll(ARTIFACT_MARKER)) {
    if (m.index! > last) parts.push({ type: "md", text: content.slice(last, m.index) });
    parts.push({ type: "artifact", id: m[1] });
    last = m.index! + m[0].length;
  }
  if (last < content.length) parts.push({ type: "md", text: content.slice(last) });

  return (
    <div className={cn("space-y-3", className)}>
      {parts.map((part, i) =>
        part.type === "md" ? (
          <div key={i} className="prose prose-sm dark:prose-invert max-w-none break-words prose-p:my-2 prose-headings:mt-4 prose-headings:mb-2 prose-pre:bg-muted prose-pre:text-foreground prose-table:text-xs">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
          </div>
        ) : (
          <ArtifactCard
            key={i}
            artifact={artifacts.get(part.id)}
            active={activeArtifactId === part.id}
            onOpen={onOpenArtifact}
          />
        ),
      )}
    </div>
  );
}

export function ArtifactCard({
  artifact,
  active,
  onOpen,
}: {
  artifact: ChatArtifact | undefined;
  active?: boolean;
  onOpen: (artifact: ChatArtifact) => void;
}) {
  if (!artifact) {
    return <div className="text-xs text-muted-foreground italic">(document no longer available)</div>;
  }
  const Icon = artifactIcon(artifact.kind);
  const subtitle =
    artifact.kind === "review"
      ? `Review · ${(artifact.data as any)?.suggestionCount ?? 0} suggestion(s)`
      : artifact.kind === "memo"
        ? "Memo"
        : `Draft${(artifact.data as any)?.documentTypeName ? ` · ${(artifact.data as any).documentTypeName}` : ""}`;
  return (
    <button
      type="button"
      onClick={() => onOpen(artifact)}
      data-testid="artifact-card"
      className={cn(
        "flex w-full max-w-md items-center gap-3 rounded-xl border bg-background px-3 py-2.5 text-left transition-colors hover:bg-accent",
        active && "border-primary ring-1 ring-primary/40",
      )}
    >
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-muted">
        <Icon className="h-4 w-4" />
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{artifact.title}</div>
        <div className="text-xs text-muted-foreground">{subtitle} · Click to open</div>
      </div>
    </button>
  );
}
