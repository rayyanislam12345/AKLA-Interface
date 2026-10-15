import type { ReactNode } from "react";
import { AlertTriangle, Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface LoadStateProps {
  isLoading: boolean;
  /** The query's error, if any. A failed load must never read as "nothing here yet". */
  error?: unknown;
  /** Usually the query's refetch. */
  onRetry?: () => void;
  /** Plural noun for what is being loaded: "projects", "clients", "tasks". */
  what: string;
  /** True when the load worked and there is nothing to show. */
  isEmpty?: boolean;
  /** What to show when isEmpty: "No projects yet." */
  empty?: ReactNode;
  /** Smaller text, for lists inside cards. */
  compact?: boolean;
  className?: string;
  children?: ReactNode;
}

// One place that tells loading, failed and empty apart. Before this, a list
// that failed to load (weak connection, expired sign-in) showed "No projects
// yet", which told a lawyer the firm had none.
export function LoadState({ isLoading, error, onRetry, what, isEmpty, empty, compact, className, children }: LoadStateProps) {
  const text = compact ? "text-sm" : "";
  if (isLoading) {
    return (
      <p className={cn("flex items-center gap-2 text-muted-foreground", text, className)}>
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading {what}…
      </p>
    );
  }
  if (error) {
    return (
      <div role="alert" className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 text-muted-foreground", text, className)}>
        <span className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
          Couldn't load {what}. Check your connection.
        </span>
        {onRetry && (
          <Button size="sm" variant="outline" className="h-7" onClick={onRetry}>
            <RotateCw className="mr-1.5 h-3.5 w-3.5" />
            Try again
          </Button>
        )}
      </div>
    );
  }
  if (isEmpty) {
    return typeof empty === "string" || empty === undefined ? (
      <p className={cn("text-muted-foreground", text, className)}>{empty ?? `No ${what} yet.`}</p>
    ) : (
      <>{empty}</>
    );
  }
  return <>{children}</>;
}

export default LoadState;
