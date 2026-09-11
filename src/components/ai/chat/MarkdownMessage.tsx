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
  // True only for the reply currently streaming. A stored partial with an
  // open artifact tag is "cut short", not "being written".
  inProgress?: boolean;
}

const ARTIFACT_MARKER = /\[\[artifact:([0-9a-f-]{36})\]\]/g;
// A reply saved mid-generation still holds the raw opening tag of the document
// being written — the artifact row is only created once the block closes. Show
// the placeholder rather than the markup if someone reloads at that moment.
const UNTERMINATED_ARTIFACT = /<artifact\b[\s\S]*$/;

export function artifactIcon(kind: string) {
  if (kind === "review") return ScanSearch;
  if (kind === "memo") return StickyNote;
  return FileText;
}

// Renders an assistant reply the way claude.ai does: GFM markdown, with any
// document the model produced shown as a clickable card (the chat function
// stores those as [[artifact:id]] markers where the block was) rather than
// inline in the bubble.
export default function MarkdownMessage({ content, artifacts, onOpenArtifact, activeArtifactId, className, inProgress = false }: MarkdownMessageProps) {
  const writingDocument = UNTERMINATED_ARTIFACT.test(content);
  // A stray closing tag (the model sometimes closes an artifact twice) is
  // markup, not prose — older stored replies still carry a few.
  const visible = (writingDocument ? content.replace(UNTERMINATED_ARTIFACT, "") : content).replace(/<\/artifact>/g, "");

  const parts: Array<{ type: "md"; text: string } | { type: "artifact"; id: string }> = [];
  let last = 0;
  for (const m of visible.matchAll(ARTIFACT_MARKER)) {
    if (m.index! > last) parts.push({ type: "md", text: visible.slice(last, m.index) });
    parts.push({ type: "artifact", id: m[1] });
    last = m.index! + m[0].length;
  }
  if (last < visible.length) parts.push({ type: "md", text: visible.slice(last) });

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
      {writingDocument && (
        <div className="flex max-w-md items-center gap-2 rounded-xl border bg-background px-3 py-2.5 text-sm text-muted-foreground">
          <FileText className={inProgress ? "h-4 w-4 animate-pulse" : "h-4 w-4"} />
          {inProgress ? "Writing document…" : "Document cut short — not finished yet"}
        </div>
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
  const edit = (artifact.data as any)?.editSource;
  const docxData = artifact.kind === "docx" ? (artifact.data as any) : null;
  const subtitle = docxData
    ? docxData.original
      ? `Word file · ${edit?.title ?? docxData.fileName} v${edit?.versionNumber ?? ""}`.trim()
      : `Word file · ${docxData.applied ?? 0} tracked change${docxData.applied === 1 ? "" : "s"}${edit?.versionNumber ? ` · from v${edit.versionNumber}` : docxData.standard ? " · from the firm's standard" : ""}`
    : edit
    ? `${(artifact.data as any)?.original ? "Original" : "Edited"} · ${edit.title} v${edit.versionNumber}`
    : artifact.kind === "review"
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
