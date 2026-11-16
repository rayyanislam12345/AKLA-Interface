import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// The sheet's eight words, coloured by who is waiting: the firm (blue), the
// client or the other side (amber), parked (grey), done (outline).
const TONE: Record<string, string> = {
  "Not Started": "bg-muted text-muted-foreground border-transparent",
  "In Progress": "bg-sky-100 text-sky-900 border-transparent dark:bg-sky-900/40 dark:text-sky-100",
  "With Boss": "bg-indigo-100 text-indigo-900 border-transparent dark:bg-indigo-900/40 dark:text-indigo-100",
  "With Client": "bg-amber-100 text-amber-900 border-transparent dark:bg-amber-900/40 dark:text-amber-100",
  "With Counterparty": "bg-amber-100 text-amber-900 border-transparent dark:bg-amber-900/40 dark:text-amber-100",
  "With Client And AKLA": "bg-emerald-100 text-emerald-900 border-transparent dark:bg-emerald-900/40 dark:text-emerald-100",
  "On Hold": "bg-muted text-muted-foreground border-transparent",
  Closed: "",
};

export function TransactionStatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <Badge variant="outline" className={cn("whitespace-nowrap font-normal", TONE[status] ?? "", className)}>
      {status}
    </Badge>
  );
}

// The quiet form for a long list: one small dot and the word, no filled pill.
const DOT: Record<string, string> = {
  "Not Started": "bg-zinc-300 dark:bg-zinc-600",
  "In Progress": "bg-sky-500",
  "With Boss": "bg-indigo-500",
  "With Client": "bg-amber-500",
  "With Counterparty": "bg-orange-500",
  "With Client And AKLA": "bg-emerald-500",
  "On Hold": "border border-zinc-400 bg-transparent",
  Closed: "border border-zinc-300 bg-transparent dark:border-zinc-600",
};

export function TransactionStatusDot({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground", className)}>
      <span className={cn("h-2 w-2 shrink-0 rounded-full", DOT[status] ?? "bg-zinc-300")} aria-hidden />
      <span className="truncate">{status}</span>
    </span>
  );
}
