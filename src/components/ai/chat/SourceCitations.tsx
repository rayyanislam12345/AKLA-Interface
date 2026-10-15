import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, BookOpen, ChevronDown, ChevronRight, ExternalLink, Landmark, Paperclip, Scale } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { ChatSource } from "@/hooks/useChat";
import {
  chipLabel,
  highlightRanges,
  isLegacySources,
  normaliseStatuteText,
  paragraphIndent,
  quotedPhrases,
  sectionLabel,
} from "@/lib/chatCitations";
import { cn } from "@/lib/utils";

export const UNVERIFIED_CITATION = "This citation does not match a passage retrieved in this chat.";

// What opening a source needs: the passage, the number the reply used for
// it, and the reply text (whose quoted words are highlighted in the passage).
export interface OpenedSource {
  source: ChatSource;
  n: number | null;
  replyText: string;
  unverified?: boolean;
}

function scopeMeta(s: ChatSource) {
  switch (s.scope) {
    case "statute":
      return { Icon: Scale, name: "Law", fallback: s.act_name ?? "Statute" };
    case "precedent":
      return { Icon: BookOpen, name: "Firm precedent", fallback: s.filename ?? "Precedent" };
    case "attachment":
      return { Icon: Paperclip, name: "Attached", fallback: s.filename ?? "Attached file" };
    default:
      return { Icon: Landmark, name: "This project's document", fallback: s.filename ?? "Project document" };
  }
}

function sourceTitle(s: ChatSource): string {
  if (s.label) return s.label;
  if (s.scope === "statute" && s.act_name) {
    const sec = sectionLabel(s.section);
    return sec ? `${s.act_name}, ${sec}` : s.act_name;
  }
  return scopeMeta(s).fallback;
}

function safeUrl(url: string | null | undefined): string | null {
  return url && /^https:\/\//i.test(url) ? url : null;
}

// ------------------------------------------------------------ inline chip

// One [Source n] in a reply. Small enough to sit in a sentence; the
// transparent ::before extends the tap target to 32px tall without changing
// the line height.
export function CitationChip({
  n,
  source,
  unverified,
  onOpen,
}: {
  n: number;
  source: ChatSource | null;
  unverified?: boolean;
  onOpen: (source: ChatSource, n: number, unverified: boolean) => void;
}) {
  const muted = unverified || !source;
  const label = chipLabel(source, n);
  const tip = muted ? UNVERIFIED_CITATION : `Source ${n} · ${sourceTitle(source!)}`;
  const base =
    "relative mx-0.5 inline-flex h-5 max-w-[15rem] items-center gap-1 rounded-md border px-1.5 align-baseline text-[11px] font-medium leading-none no-underline transition-colors before:absolute before:-inset-x-1 before:-inset-y-1.5 before:content-[''] focus:outline-none focus-visible:ring-2 focus-visible:ring-ring";
  const tone = muted
    ? "border-dashed border-muted-foreground/40 bg-transparent text-muted-foreground"
    : source!.scope === "statute"
      ? "border-amber-300/70 bg-amber-50 text-amber-900 hover:bg-amber-100 dark:border-amber-700/60 dark:bg-amber-950/40 dark:text-amber-200 dark:hover:bg-amber-900/40"
      : "border-border bg-muted text-foreground hover:bg-accent";
  const inner = (
    <>
      {muted && <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />}
      <span className="truncate">{label}</span>
    </>
  );
  const chip = source ? (
    <button
      type="button"
      className={cn(base, tone, "cursor-pointer")}
      onClick={() => onOpen(source, n, !!unverified)}
      aria-label={`${muted ? "Unverified citation: " : ""}open source ${n}, ${sourceTitle(source)}`}
      data-testid="citation-chip"
      data-source-n={n}
    >
      {inner}
    </button>
  ) : (
    <span className={cn(base, tone, "cursor-help")} tabIndex={0} aria-label={`Source ${n}: ${UNVERIFIED_CITATION}`} data-testid="citation-chip-unresolved">
      {inner}
    </span>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>{chip}</TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">{tip}</TooltipContent>
    </Tooltip>
  );
}

// ------------------------------------------------------------ footnote

function FootnoteItem({ source, n, bold, onOpen }: { source: ChatSource; n: number | null; bold?: boolean; onOpen: () => void }) {
  const { Icon } = scopeMeta(source);
  const preview = (source.excerpt || source.content || "").replace(/\s+/g, " ").trim();
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-8 w-full items-start gap-2 rounded-md px-1 py-1 text-left text-xs hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="source-footnote-item"
      >
        <span className="w-6 shrink-0 text-right tabular-nums text-muted-foreground">{n != null ? `${n}.` : ""}</span>
        <Icon className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className={cn(bold ? "font-semibold" : "font-medium", source.scope === "statute" && "text-amber-800 dark:text-amber-300")}>
            {sourceTitle(source)}
          </span>
          {source.applicability === "candidate" && <span className="block text-muted-foreground">Potentially relevant — applicability needs review</span>}
          {preview && <span className="block truncate text-muted-foreground">{preview}</span>}
        </span>
      </button>
    </li>
  );
}

// What the reply was grounded in. Newer replies say which passages they
// cited (shown first, in bold) and keep the rest under "Also retrieved";
// older ones keep the single collapsed list. Every item opens the passage.
export function SourcesFootnote({
  sources,
  cited,
  resolve,
  onOpen,
}: {
  sources: ChatSource[];
  cited?: number[];
  resolve: (n: number) => ChatSource | null;
  onOpen: (source: ChatSource, n: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const legacy = isLegacySources(sources);
  const numberOf = (s: ChatSource, i: number) => (legacy ? i + 1 : (s.n ?? null));

  if (!cited || legacy) {
    if (!sources.length) return null;
    return (
      <div className="mt-3" data-testid="sources-footnote">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="inline-flex min-h-8 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          {sources.length} source{sources.length === 1 ? "" : "s"} used for this answer
        </button>
        {open && (
          <ol className="mt-1 space-y-0.5">
            {sources.map((s, i) => (
              <FootnoteItem key={`${s.id}-${i}`} source={s} n={numberOf(s, i)} onOpen={() => onOpen(s, numberOf(s, i))} />
            ))}
          </ol>
        )}
      </div>
    );
  }

  const citedSet = new Set(cited);
  const citedItems = cited.flatMap((n) => {
    const s = resolve(n);
    return s ? [{ n, s }] : [];
  });
  const alsoItems = sources.filter((s) => !(typeof s.n === "number" && citedSet.has(s.n)));
  const total = citedItems.length + alsoItems.length;
  if (!total) return null;

  return (
    <div className="mt-3" data-testid="sources-footnote">
      <p className="text-xs text-muted-foreground">
        Cited {citedItems.length} of {total} passage{total === 1 ? "" : "s"}
      </p>
      {citedItems.length > 0 && (
        <ol className="mt-1 space-y-0.5">
          {citedItems.map(({ n, s }) => (
            <FootnoteItem key={`cited-${n}`} source={s} n={n} bold onOpen={() => onOpen(s, n)} />
          ))}
        </ol>
      )}
      {alsoItems.length > 0 && (
        <div className="mt-1">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex min-h-8 items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Also retrieved ({alsoItems.length})
          </button>
          {open && (
            <ol className="mt-1 space-y-0.5">
              {alsoItems.map((s, i) => (
                <FootnoteItem key={`also-${s.n ?? i}-${s.id}`} source={s} n={s.n ?? null} onOpen={() => onOpen(s, s.n ?? null)} />
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------ viewer

// The passage, laid out to read: statute text broken at its sub-sections and
// clauses, and the words the reply quoted marked where they appear verbatim.
function Excerpt({ text, statute, phrases }: { text: string; statute: boolean; phrases: string[] }) {
  const { paragraphs, marks } = useMemo(() => {
    const body = statute ? normaliseStatuteText(text) : text.replace(/\r\n?/g, "\n").trim();
    const ranges = highlightRanges(body, phrases);
    const paras: Array<{ start: number; text: string }> = [];
    const re = statute ? /[^\n]+/g : /[^\n]+(?:\n(?!\s*\n)[^\n]*)*/g;
    for (const m of body.matchAll(re)) {
      if (m[0].trim()) paras.push({ start: m.index!, text: m[0] });
    }
    return { paragraphs: paras, marks: ranges };
  }, [text, statute, phrases]);

  return (
    <div className="space-y-2.5 text-sm leading-relaxed" data-testid="source-excerpt">
      {paragraphs.map((p, i) => {
        const end = p.start + p.text.length;
        const segs: Array<{ text: string; mark: boolean }> = [];
        let cursor = p.start;
        for (const [a, b] of marks) {
          if (b <= p.start || a >= end) continue;
          const s = Math.max(a, p.start);
          const e = Math.min(b, end);
          if (s > cursor) segs.push({ text: body(p, cursor, s), mark: false });
          segs.push({ text: body(p, s, e), mark: true });
          cursor = e;
        }
        if (cursor < end) segs.push({ text: body(p, cursor, end), mark: false });
        const indent = statute ? paragraphIndent(p.text.trim()) : 0;
        return (
          <p key={i} className={cn("whitespace-pre-line", indent === 1 && "pl-5", indent === 2 && "pl-10")}>
            {segs.map((s, j) =>
              s.mark ? (
                <mark key={j} data-quote-mark className="rounded-sm bg-yellow-200 px-0.5 text-foreground underline decoration-yellow-600 decoration-2 underline-offset-2 dark:bg-yellow-500/30">
                  {s.text}
                </mark>
              ) : (
                <Fragment key={j}>{s.text}</Fragment>
              ),
            )}
          </p>
        );
      })}
    </div>
  );
}

function body(p: { start: number; text: string }, from: number, to: number) {
  return p.text.slice(from - p.start, to - p.start);
}

// The right-hand sheet (full screen on a phone) that shows one passage. `opened`
// is kept by the caller after closing so the sheet can animate out with its
// content still in place.
export function SourceViewer({ opened, open, onOpenChange }: { opened: OpenedSource | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const s = opened?.source ?? null;
  const fullText = s?.excerpt?.trim() ? s.excerpt : null;
  const text = fullText ?? s?.content ?? "";
  const phrases = useMemo(() => (opened ? quotedPhrases(opened.replyText) : []), [opened]);
  const markCount = useMemo(
    () => (s && text ? highlightRanges(s.scope === "statute" ? normaliseStatuteText(text) : text, phrases).length : 0),
    [s, text, phrases],
  );

  // Bring the first highlighted words into view once the sheet has rendered.
  useEffect(() => {
    if (!open || !opened || !markCount) return;
    const t = window.setTimeout(() => {
      scrollRef.current?.querySelector("[data-quote-mark]")?.scrollIntoView({ block: "center" });
    }, 350);
    return () => window.clearTimeout(t);
  }, [open, opened, markCount]);

  const meta = s ? scopeMeta(s) : null;
  const url = safeUrl(s?.url);
  const section = sectionLabel(s?.section);

  return (
    <Sheet open={open && !!opened} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex h-full w-full flex-col gap-0 p-0 sm:max-w-xl" data-testid="source-viewer">
        {s && meta && (
          <>
            <SheetHeader className="space-y-1.5 border-b px-4 py-3 pr-12 text-left">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <meta.Icon className="h-3.5 w-3.5" />
                <Badge variant="secondary" className="font-medium">{meta.name}</Badge>
                {opened!.n != null && <span>Source {opened!.n}</span>}
              </div>
              <SheetTitle className="text-base leading-snug">{sourceTitle(s)}</SheetTitle>
              <SheetDescription asChild>
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  {s.act_name && (<><dt className="text-muted-foreground">Act</dt><dd className="text-foreground">{s.act_name}</dd></>)}
                  {section && (<><dt className="text-muted-foreground">Section</dt><dd className="text-foreground">{section.slice(1)}</dd></>)}
                  {s.filename && (<><dt className="text-muted-foreground">File</dt><dd className="break-all text-foreground">{s.filename}</dd></>)}
                  {s.fetchedAt && (<><dt className="text-muted-foreground">Retrieved</dt><dd className="text-foreground">{new Date(s.fetchedAt).toLocaleDateString()}</dd></>)}
                </dl>
              </SheetDescription>
              {url && (
                <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-8 items-center gap-1 text-xs font-medium text-primary underline underline-offset-2">
                  <ExternalLink className="h-3 w-3" /> Open the source
                </a>
              )}
            </SheetHeader>

            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              {opened!.unverified && (
                <div role="note" className="mb-3 flex items-start gap-2 rounded-md border border-amber-400/60 bg-amber-50 px-3 py-2 text-xs dark:border-amber-700/50 dark:bg-amber-950/20">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
                  <span>{UNVERIFIED_CITATION} Check the reply against this passage before relying on it.</span>
                </div>
              )}
              {s.applicability === "candidate" && (
                <p className="mb-3 text-xs text-muted-foreground">Potentially relevant — applicability needs review.</p>
              )}
              {markCount > 0 && (
                <p className="mb-3 text-xs text-muted-foreground">
                  <mark className="rounded-sm bg-yellow-200 px-1 text-foreground dark:bg-yellow-500/30">Highlighted</mark> words are quoted in the reply.
                </p>
              )}
              {text ? (
                <Excerpt text={text} statute={s.scope === "statute"} phrases={phrases} />
              ) : (
                <p className="text-sm text-muted-foreground">No text was kept for this passage.</p>
              )}
              {!fullText && text && (
                <p className="mt-4 text-xs text-muted-foreground">Only a short preview of this passage was kept with this reply.</p>
              )}
            </div>

            <div className="border-t px-4 py-2 sm:hidden">
              <SheetClose asChild>
                <Button variant="secondary" className="h-10 w-full">Close</Button>
              </SheetClose>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
