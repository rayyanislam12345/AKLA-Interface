import { ScanSearch, Sparkles, StickyNote, Table2 } from "lucide-react";

export type ActionTileKey = "draft" | "review" | "summarise" | "table";

const TILES: Array<{ key: ActionTileKey; title: string; hint: string; Icon: typeof Sparkles }> = [
  { key: "draft", title: "Draft", hint: "A document of a chosen type, from a few questions", Icon: Sparkles },
  { key: "review", title: "Review", hint: "A project document, clause by clause, against the law", Icon: ScanSearch },
  { key: "summarise", title: "Summarise", hint: "A short \"Notes On…\" memo about a document", Icon: StickyNote },
  { key: "table", title: "Table", hint: "One row per document, the columns you ask for", Icon: Table2 },
];

// The four things people come to the AI for, under the composer on Home.
// Each one sets the composer up; the lawyer still says what they want.
export default function ActionTiles({ onPick }: { onPick: (key: ActionTileKey) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="action-tiles">
      {TILES.map(({ key, title, hint, Icon }) => (
        <button
          key={key}
          type="button"
          onClick={() => onPick(key)}
          className="flex flex-col items-start gap-2 rounded-2xl border bg-card px-4 py-3.5 text-left transition-colors hover:border-primary/40 hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid={`tile-${key}`}
        >
          <Icon className="h-5 w-5 text-primary" />
          <div>
            <div className="text-sm font-medium">{title}</div>
            <div className="mt-0.5 text-xs leading-snug text-muted-foreground">{hint}</div>
          </div>
        </button>
      ))}
    </div>
  );
}
