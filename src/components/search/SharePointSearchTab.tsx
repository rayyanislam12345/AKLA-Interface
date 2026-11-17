import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ExternalLink, FileText, FolderOpen, Loader2, Search, Square } from "lucide-react";
import { useSharePointSearch, type SharePointFile } from "@/hooks/useSharePointSearch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

// Search SharePoint: describe a file in plain words and the assistant looks
// through the firm's Data Room for it — several searches in different
// wordings, opening the likely files — and lists the ones that fit, each
// with a line on why and a link that opens it on SharePoint.
//
// The description is kept in the address (?sp=…) so a search can be linked
// to and the browser's Back returns to it.
const EXAMPLES = [
  "The signed lenders' direct agreement for a port project",
  "Our comments on the KPT direct agreement",
  "A legal opinion on stamp duty on a share transfer",
];

const FIT: Record<SharePointFile["fit"], { label: string; variant: "default" | "secondary" | "outline" }> = {
  strong: { label: "Strong match", variant: "default" },
  possible: { label: "Possible", variant: "secondary" },
  unchecked: { label: "Not checked", variant: "outline" },
};

function changedOn(iso: string | null) {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;

export default function SharePointSearchTab() {
  const [params, setParams] = useSearchParams();
  const query = params.get("sp") ?? "";
  const [input, setInput] = useState(query);
  const search = useSharePointSearch();
  const { run } = search;

  useEffect(() => {
    setInput(query);
    void run(query);
  }, [query, run]);

  const submit = () => {
    const next = input.trim();
    if (next.length < 3) return;
    // The same description again is a request to look again.
    if (next === query) return void run(next, { again: true });
    const p = new URLSearchParams(params);
    p.set("sp", next);
    setParams(p);
  };

  const result = search.result;
  const latestStep = search.steps[search.steps.length - 1];

  return (
    <div className="space-y-5" data-testid="sharepoint-search">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className="relative min-w-[16rem] flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Describe the file you are looking for"
            className="pl-8"
            maxLength={600}
            data-testid="sharepoint-search-input"
          />
        </div>
        {search.running ? (
          <Button type="button" variant="outline" onClick={search.stop}>
            <Square className="mr-1.5 h-3.5 w-3.5" /> Stop
          </Button>
        ) : (
          <Button type="submit" disabled={input.trim().length < 3}>Search</Button>
        )}
      </form>

      {!query && !search.running && (
        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            Describe the file the way you would to a colleague. The assistant searches the firm's SharePoint Data Room,
            opens the likely files and lists the ones that fit, with a line on why. It reads as it goes, so this takes
            longer than an ordinary search. Scanned PDFs can only be found by their file name.
          </p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((example) => (
              <button
                key={example}
                type="button"
                onClick={() => setInput(example)}
                className="rounded-full border px-3 py-1 text-xs hover:bg-accent/50"
              >
                {example}
              </button>
            ))}
          </div>
        </div>
      )}

      {search.running && (
        <div className="space-y-1.5 text-sm text-muted-foreground" data-testid="sharepoint-search-progress">
          <p className="flex items-center gap-2 text-foreground">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
            <span className="min-w-0 truncate">{latestStep ? `${latestStep}…` : "Starting the search…"}</span>
          </p>
          {search.steps.length > 1 && (
            <ul className="space-y-0.5 pl-6 text-xs">
              {search.steps.slice(-5, -1).map((step, i) => (
                <li key={`${i}-${step}`} className="truncate">{step}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {search.error && !search.running && <p className="text-sm text-destructive" data-testid="sharepoint-search-error">{search.error}</p>}

      {result && !search.running && (
        <>
          <p className="text-sm text-muted-foreground">
            {result.results.length ? `${plural(result.results.length, "file")} found` : "No file fits that description."}
            {" · "}
            {plural(result.searches.length, "search", "searches")} run, {plural(result.seen, "file")} looked at, {result.opened.toLocaleString("en-GB")} opened
          </p>
          {result.note && <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm">{result.note}</p>}
          <div className="space-y-3">
            {result.results.map((file) => {
              const changed = changedOn(file.modified);
              return (
                <div key={file.webUrl} className="rounded-lg border px-4 py-3" data-testid="sharepoint-hit">
                  <div className="flex flex-wrap items-start gap-2">
                    <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <a
                      href={file.webUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="min-w-0 flex-1 break-words font-medium hover:underline"
                      title="Open on SharePoint"
                    >
                      {file.name}
                    </a>
                    <Badge variant={FIT[file.fit].variant}>{FIT[file.fit].label}</Badge>
                  </div>
                  {file.why && <p className="mt-1.5 pl-6 text-sm leading-relaxed">{file.why}</p>}
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-6 text-xs text-muted-foreground">
                    <a href={file.folderUrl} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 hover:underline" title="Open the folder on SharePoint">
                      <FolderOpen className="h-3.5 w-3.5 shrink-0" />
                      <span className="break-words">{file.folder || "Data Room"}</span>
                    </a>
                    {changed && <span>Changed {changed}</span>}
                    <span>{file.opened ? "Opened and read" : "Judged by its name and the matching text"}</span>
                    <a href={file.webUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                      <ExternalLink className="h-3.5 w-3.5" /> Open
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
          {!result.results.length && result.searches.length > 0 && (
            <p className="text-xs text-muted-foreground">Searched for: {result.searches.join(" · ")}</p>
          )}
        </>
      )}
    </div>
  );
}
