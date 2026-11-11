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
