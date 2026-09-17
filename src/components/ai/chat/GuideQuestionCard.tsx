import { useEffect, useState } from "react";
import { Check, ListChecks, Loader2, SkipForward } from "lucide-react";
import type { GuideAnswer, GuideQuestion, GuideState } from "@/hooks/useChat";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface GuideQuestionCardProps {
  state: GuideState;
  // A reply is being written: the choice just made is being applied.
  busy: boolean;
  onAnswer: (question: GuideQuestion, answer: GuideAnswer, labels: string[]) => void;
}

// The drafting decision being asked, above the composer. A single-choice
// question is answered by clicking an option; a multi-choice one by ticking
// options and pressing Apply. Each answer is written into the document
// before the next question appears.
export default function GuideQuestionCard({ state, busy, onAnswer }: GuideQuestionCardProps) {
  const q = state.pending;
  const [picked, setPicked] = useState<string[]>([]);
  const [sent, setSent] = useState<string[] | null>(null);
  useEffect(() => {
    setPicked([]);
    setSent(null);
  }, [q?.id]);
  if (!q) return null;
  const answeredCount = Object.values(state.answers).filter((a) => !a.skipped).length;

  const choose = (optionIds: string[]) => {
    const labels = optionIds.map((id) => q.options.find((o) => o.id === id)?.label ?? id);
    setSent(optionIds);
    onAnswer(q, { questionId: q.id, optionIds }, labels);
  };
  const toggle = (id: string) => {
    setPicked((current) => {
      if (current.includes(id)) return current.filter((x) => x !== id);
      // An exclusive option ("No Government support") stands alone.
      if (q.exclusive.includes(id)) return [id];
      return [...current.filter((x) => !q.exclusive.includes(x)), id];
    });
  };
  const disabled = busy || sent !== null;

  return (
    <div className="px-4 md:px-8" data-testid="guide-question">
      <div className="mx-auto max-w-3xl rounded-2xl border border-primary/30 bg-primary/5 p-3 shadow-sm">
        <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <ListChecks className="h-3.5 w-3.5" />
          <span className="font-medium uppercase tracking-wide">{q.section}</span>
          <span>· Question {q.index} of {q.total}</span>
          <span>· {answeredCount} answered</span>
        </div>
        <p className="text-sm font-medium">{q.question}</p>
        <div className={cn("mt-2 grid gap-1.5", q.options.length > 3 && "sm:grid-cols-2")}>
          {q.options.map((o) => {
            const active = q.multi ? picked.includes(o.id) : sent?.includes(o.id);
            return (
              <button
                key={o.id}
                type="button"
                disabled={disabled}
                onClick={() => (q.multi ? toggle(o.id) : choose([o.id]))}
                className={cn(
                  "flex items-start gap-2 rounded-lg border bg-background px-3 py-2 text-left text-sm transition-colors hover:border-primary/60 hover:bg-accent disabled:cursor-default disabled:hover:bg-background",
                  active && "border-primary bg-primary/10",
                )}
                data-testid="guide-option"
              >
                {q.multi && (
                  <span className={cn("mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border", active && "border-primary bg-primary text-primary-foreground")}>
                    {active && <Check className="h-3 w-3" />}
                  </span>
                )}
                {!q.multi && sent?.includes(o.id) && <Loader2 className="mt-0.5 h-4 w-4 shrink-0 animate-spin text-primary" />}
                <span className="min-w-0">
                  <span className="block">{o.label}</span>
                  {o.hint && <span className="block text-xs text-muted-foreground">{o.hint}</span>}
                </span>
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {q.multi && (
            <Button size="sm" className="h-8" disabled={disabled || !picked.length} onClick={() => choose(picked)} data-testid="guide-apply">
              {sent ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-2 h-3.5 w-3.5" />}
              Apply {picked.length ? `(${picked.length})` : ""}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-muted-foreground"
            disabled={disabled}
            onClick={() => {
              setSent([]);
              onAnswer(q, { questionId: q.id, optionIds: [], skip: true }, []);
            }}
            data-testid="guide-skip"
          >
            <SkipForward className="mr-2 h-3.5 w-3.5" /> Skip for now
          </Button>
          <span className="text-[11px] text-muted-foreground">
            {sent !== null || busy ? "Applying your choice to the document…" : "Your choice is written into the document as tracked changes."}
          </span>
        </div>
      </div>
    </div>
  );
}
