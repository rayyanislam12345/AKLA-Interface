import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoadState } from "@/components/LoadState";
import { ArrivedList } from "@/components/ArrivedList";
import { useIntakeActions } from "@/hooks/useIntake";
import { cn } from "@/lib/utils";
import { matchesArrivedFilter, type ArrivedFilter } from "@/lib/intake";

const FILTERS: { key: ArrivedFilter; label: string }[] = [
  { key: "all", label: "Everything" },
  { key: "documents", label: "Documents" },
  { key: "rows", label: "Row moves" },
  { key: "notes", label: "Notes" },
];

const SINCE_DAYS = 14;

/** Everything the Hub filed, moved or noted on its own, with an Undo on each line. */
export default function ArrivedPage() {
  const [params] = useSearchParams();
  // ?project=<id>: one project's arrivals, however old (the project page's "See all").
  const projectId = params.get("project") || undefined;
  const { data: actions, isLoading, error, refetch } = useIntakeActions(projectId ? { matterId: projectId } : { sinceDays: SINCE_DAYS });
  const [filter, setFilter] = useState<ArrivedFilter>("all");

  const shown = useMemo(() => (actions ?? []).filter((a) => matchesArrivedFilter(a, filter)), [actions, filter]);
  const projectName = projectId ? actions?.find((a) => a.projectName)?.projectName ?? "" : "";

  return (
    <div className="space-y-5">
      <div>
        <Link
          to={projectId ? `/matters/${projectId}` : "/transactions"}
          className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {projectId ? projectName || "Back to the project" : "Transactions Hub"}
        </Link>
        <h1 className="text-2xl font-semibold">Arrived</h1>
        <p className="text-muted-foreground">
          {projectId
            ? `What the Hub filed or noted on its own for ${projectName || "this project"}.`
            : `What the Hub filed or noted on its own in the last ${SINCE_DAYS} days.`}{" "}
          Undo takes any of it back.
          {projectId && (
            <>
              {" "}
              <Link to="/transactions/arrived" className="underline underline-offset-2 hover:text-foreground">
                Show every project
              </Link>
            </>
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {FILTERS.map((f) => (
          <Button
            key={f.key}
            size="sm"
            variant={filter === f.key ? "secondary" : "ghost"}
            className={cn("h-7 px-2.5 text-xs", filter !== f.key && "text-muted-foreground")}
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </Button>
        ))}
      </div>

      <LoadState
        isLoading={isLoading}
        error={error}
        onRetry={() => refetch()}
        what="what arrived"
        isEmpty={!shown.length}
        empty={filter === "all" ? "Nothing has arrived yet." : "Nothing of that kind has arrived."}
      >
        <ArrivedList actions={shown} showProject={!projectId} />
      </LoadState>
    </div>
  );
}
