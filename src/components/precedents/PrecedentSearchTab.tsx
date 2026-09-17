import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { renderAsync } from "docx-preview";
import { ExternalLink, FileText, Loader2, Search, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useDocumentTypes } from "@/hooks/useMatterDocuments";
import { fetchPrecedentText, usePrecedentSearch, type PrecedentExcerpt, type PrecedentHit } from "@/hooks/usePrecedentLibrary";
import { fitDocxPreview } from "@/lib/fitDocxPreview";
import { outlineSuggestion } from "@/lib/locateInPreview";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";

// Search the firm's precedents for clauses — "liquidated damages",
// "step-in rights", "change in law" — and read the passages that answer,
// grouped by the agreement they sit in. Opening one shows the whole
// agreement scrolled to that passage and outlined.
//
//   /precedent-library?tab=search&q=<query>&type=<documentTypeId>
export default function PrecedentSearchTab() {
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const typeId = params.get("type");
  const [input, setInput] = useState(query);
  useEffect(() => setInput(query), [query]);
  const { data: documentTypes } = useDocumentTypes();
  const search = usePrecedentSearch(query, typeId);
  const [open, setOpen] = useState<{ hit: PrecedentHit; excerpt: PrecedentExcerpt } | null>(null);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    next.set("tab", "search");
    for (const [k, v] of Object.entries(patch)) (v ? next.set(k, v) : next.delete(k));
    setParams(next, { replace: true });
  };

  const terms = search.data?.terms ?? [];

  return (
    <div className="space-y-5" data-testid="precedent-search">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          update({ q: input.trim() || null });
        }}
      >
        <div className="relative min-w-[16rem] flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Find clauses — e.g. liquidated damages, step-in rights, change in law"
            className="pl-8"
            data-testid="precedent-search-input"
          />
        </div>
        <Select value={typeId ?? "all"} onValueChange={(v) => update({ type: v === "all" ? null : v })}>
          <SelectTrigger className="w-60"><SelectValue placeholder="All document types" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All document types</SelectItem>
            {(documentTypes ?? []).map((t) => (
              <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="submit" disabled={input.trim().length < 2}>Search</Button>
      </form>

      {!query && (
        <p className="text-sm text-muted-foreground">
          Searches every precedent in the library by meaning as well as by words, so "LD" finds liquidated damages and
          delay damages clauses however they are worded. Each result shows the passages that answer; open one to see
          it in the full agreement.
        </p>
      )}

      {search.isFetching && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Searching the precedent library…</p>
      )}
      {search.error && <p className="text-sm text-destructive">{(search.error as Error).message}</p>}

      {search.data && !search.isFetching && (
        <>
          <p className="text-sm text-muted-foreground">
            {search.data.results.length
              ? `${search.data.results.length} agreement${search.data.results.length === 1 ? "" : "s"} with matching clauses`
              : "No precedent clause matches. Try other words, or all document types."}
            {terms.length > 1 && <> · also searched for: {terms.slice(0, 8).join(", ")}</>}
          </p>
          <div className="space-y-4">
            {search.data.results.map((hit) => (
              <div key={hit.storagePath ?? hit.filename} className="rounded-lg border" data-testid="precedent-hit">
                <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate font-medium" title={hit.filename}>{hit.filename}</span>
                  {hit.documentTypeName && <Badge variant="secondary">{hit.documentTypeName}</Badge>}
                  {hit.storagePath && (
                    <Button size="sm" variant="outline" onClick={() => setOpen({ hit, excerpt: hit.excerpts[0] })}>
                      <ExternalLink className="mr-1.5 h-3.5 w-3.5" /> Open agreement
                    </Button>
                  )}
                </div>
                <div className="divide-y">
                  {hit.excerpts.map((ex, i) => (
                    <button
                      key={i}
                      type="button"
                      disabled={!hit.storagePath}
                      onClick={() => setOpen({ hit, excerpt: ex })}
                      className="block w-full px-4 py-3 text-left text-sm leading-relaxed hover:bg-accent/50 disabled:cursor-default"
                      title={hit.storagePath ? "Open the agreement at this clause" : undefined}
                      data-testid="precedent-excerpt"
                    >
                      <Highlighted text={ex.text} terms={terms} />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      <PrecedentViewer target={open} terms={terms} onClose={() => setOpen(null)} />
    </div>
  );
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  const usable = terms.filter((t) => t.length > 2).sort((a, b) => b.length - a.length);
  if (!usable.length) return <>{text}</>;
  const re = new RegExp(`(${usable.map(escapeRe).join("|")})`, "gi");
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 ? <mark key={i} className="rounded bg-amber-100 px-0.5 text-inherit dark:bg-amber-900/40">{part}</mark> : <span key={i}>{part}</span>,
      )}
    </>
  );
}

// The whole agreement, opened at the passage. A Word file is shown as the
// document itself with the passage outlined; anything else as its text,
// with the passage marked.
function PrecedentViewer({ target, terms, onClose }: { target: { hit: PrecedentHit; excerpt: PrecedentExcerpt } | null; terms: string[]; onClose: () => void }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");
  const [text, setText] = useState<string | null>(null);
  const [found, setFound] = useState(true);
  const path = target?.hit.storagePath ?? null;
  const isDocx = !!path && /\.docx$/i.test(path);

  useEffect(() => {
    if (!target || !path) return;
    let cancelled = false;
    let stopFitting = () => {};
    setState("loading");
    setText(null);
    setFound(true);
    (async () => {
      if (isDocx) {
        const { data, error: dl } = await supabase.storage.from("precedent-library").download(path);
        if (dl || !data) throw new Error(dl?.message ?? "The file could not be downloaded");
        // The dialog's frame mounts on the next paint.
        await new Promise((r) => requestAnimationFrame(r));
        const frame = frameRef.current;
        if (cancelled || !frame) return;
        frame.innerHTML = "";
        await renderAsync(data, frame, frame, { inWrapper: true });
        if (cancelled) return;
        stopFitting = fitDocxPreview(frame);
        setState("ready");
        // Fitting rescales the page; outline once it has settled.
        setTimeout(() => {
          if (!cancelled && frameRef.current) setFound(outlineSuggestion(frameRef.current, target.excerpt.text, null));
        }, 300);
      } else {
        const full = await fetchPrecedentText(path);
        if (cancelled) return;
        setText(full);
        setState("ready");
      }
    })().catch((err) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      }
    });
    return () => {
      cancelled = true;
      stopFitting();
    };
  }, [target, path, isDocx]);

  // Text view: scroll the marked passage into view once drawn.
  useEffect(() => {
    if (state !== "ready" || isDocx) return;
    const el = frameRef.current?.querySelector("[data-hit]");
    if (el) el.scrollIntoView({ block: "center" });
    else setFound(false);
  }, [state, isDocx, text]);

  const download = async () => {
    if (!path) return;
    const { data } = await supabase.storage.from("precedent-library").download(path);
    if (!data) return;
    const url = URL.createObjectURL(data);
    const a = document.createElement("a");
    a.href = url;
    a.download = target?.hit.filename ?? "precedent";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={!!target} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex h-[90vh] max-w-5xl flex-col gap-3 p-4" data-testid="precedent-viewer">
        <DialogHeader className="space-y-1 pr-8">
          <DialogTitle className="truncate text-base">{target?.hit.filename}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2 text-xs">
            {target?.hit.documentTypeName && <Badge variant="secondary">{target.hit.documentTypeName}</Badge>}
            <span>{found ? "The matching passage is outlined." : "The passage could not be pinpointed in this view; it is shown below the title."}</span>
            <Button size="sm" variant="link" className="h-auto p-0 text-xs" onClick={download}>Download</Button>
          </DialogDescription>
        </DialogHeader>
        {!found && target && (
          <div className="rounded-md border bg-amber-50 px-3 py-2 text-xs dark:bg-amber-950/20">
            <Highlighted text={target.excerpt.text} terms={terms} />
          </div>
        )}
        <div ref={frameRef} className="relative min-h-0 flex-1 overflow-auto rounded-md border bg-muted/30">
          {!isDocx && state === "ready" && text !== null && <TextWithPassage text={text} passage={target!.excerpt.text} terms={terms} />}
        </div>
        {state === "loading" && (
          <p className="absolute inset-x-0 top-1/2 flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Opening the agreement…
          </p>
        )}
        {state === "error" && <p className="text-sm text-destructive"><X className="mr-1 inline h-4 w-4" />{error}</p>}
      </DialogContent>
    </Dialog>
  );
}

function TextWithPassage({ text, passage, terms }: { text: string; passage: string; terms: string[] }) {
  const plain = useMemo(() => text.replace(/<\/(?:p|li|h[1-6]|tr)>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/[ \t]+/g, " "), [text]);
  const at = plain.indexOf(passage.slice(0, 120));
  if (at < 0) return <pre className="whitespace-pre-wrap p-6 font-sans text-sm leading-relaxed">{plain}</pre>;
  const end = at + passage.length;
  return (
    <pre className="whitespace-pre-wrap p-6 font-sans text-sm leading-relaxed">
      {plain.slice(0, at)}
      <span data-hit className="rounded outline outline-2 outline-red-600 outline-offset-2 bg-amber-50 dark:bg-amber-950/30">
        <Highlighted text={plain.slice(at, end)} terms={terms} />
      </span>
      {plain.slice(end)}
    </pre>
  );
}
