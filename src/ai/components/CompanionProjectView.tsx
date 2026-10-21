import { useEffect, useMemo } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { FileText } from "lucide-react";
import { useMatter, normalizeMatterStatus } from "@/hooks/useMatters";
import { useMatterDocuments } from "@/hooks/useMatterDocuments";
import { useMatterContext } from "@/hooks/useMatterContext";
import { useProfiles } from "@/hooks/useProfiles";
import { relativeDay } from "@/lib/chatStatus";
import { parseOpenParam } from "@/lib/aiLinks";
import { instructionsForClaudeText, recentVersions } from "@/lib/copyForClaude";
import { useAiPageTitle } from "@/ai/AiWorkspaceContext";
import { CopyTextForClaude } from "@/ai/components/CopyForClaude";
import ProjectFilesPanel from "@/ai/components/ProjectFilesPanel";
import { LoadState } from "@/components/LoadState";
import { Button } from "@/components/ui/button";

const RECENT = 5;

// A project in the companion's drawer, beside a claude.ai chat. The chat is
// claude.ai's, so nothing here starts a Hub chat: no prompt box, no chats,
// and the address's seeds (?attach=, ?mode=, ?update=, ?chat=) are left
// alone. What is here: the project's files, each opening its own page in the
// drawer and each with a "Copy for Claude"; its standing instructions, to
// copy into the chat; and what arrived lately. Files can still be added.
export default function CompanionProjectView({ matterId }: { matterId: string }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { data: matter, isLoading, error: matterError, refetch: refetchMatter } = useMatter(matterId);
  useAiPageTitle(matter?.name ?? "Project");
  const documents = useMatterDocuments(matterId);

  // A link to one of the project's files (?open=v:<id>, from search or a
  // pasted address) opens that file's own page: the drawer has no room for a
  // window beside the list.
  const open = parseOpenParam(searchParams.get("open"));
  const openVersionId = open?.kind === "version" ? open.id : null;
  useEffect(() => {
    if (openVersionId) navigate(`/ai/d/${openVersionId}`, { replace: true });
  }, [openVersionId, navigate]);

  if (isLoading) {
    return (
      <div className="w-full px-3 pt-4" aria-label="Loading the project" data-testid="ai-project-loading">
        <div className="h-6 w-2/3 animate-pulse rounded bg-muted" />
        <div className="mt-2 h-4 w-1/3 animate-pulse rounded bg-muted" />
        <div className="mt-4 h-24 animate-pulse rounded-2xl border bg-muted/50" />
      </div>
    );
  }
  if (matterError && !matter) {
    return (
      <div className="px-3 pt-6">
        <LoadState isLoading={false} error={matterError} onRetry={() => refetchMatter()} what="this project" />
      </div>
    );
  }
  if (!matter) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center" data-testid="ai-project-missing">
        <h2 className="text-lg font-semibold">This project isn't available</h2>
        <p className="max-w-sm text-sm text-muted-foreground">It may have been deleted, or the link may be out of date.</p>
        <Button asChild variant="ghost" size="sm"><Link to="/ai">Home</Link></Button>
      </div>
    );
  }

  const client = (matter as { client?: { name: string } | null }).client?.name;
  const closed = normalizeMatterStatus(matter.status) === "closed";

  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="ai-project-companion">
      <div className="w-full space-y-4 px-3 pb-10 pt-4">
        <header>
          <h1 className="break-words text-xl font-semibold tracking-tight" style={{ fontFamily: "var(--ai-serif)" }}>{matter.name}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {client || "No client"}
            {matter.sector ? ` · ${matter.sector}` : ""}
            {closed ? " · Closed" : ""}
          </p>
        </header>

        <ProjectFilesPanel
          matterId={matterId}
          matterName={matter.name}
          documents={documents.data}
          isLoading={documents.isLoading}
          error={documents.error}
          onRetry={() => documents.refetch()}
          companion={{ projectName: matter.name }}
        />
        <StandingInstructions matterId={matterId} projectName={matter.name} />
        <RecentActivity documents={documents.data} isLoading={documents.isLoading} error={documents.error} onRetry={() => documents.refetch()} />
      </div>
    </div>
  );
}

// The project's instructions, read only: they are edited on the Hub itself.
function StandingInstructions({ matterId, projectName }: { matterId: string; projectName: string }) {
  const { data: matterContext, isLoading, error, refetch } = useMatterContext(matterId);
  const text = instructionsForClaudeText(projectName, matterContext?.content);
  const updatedBy = (matterContext as { updated_by?: { full_name?: string | null } | null } | null | undefined)?.updated_by?.full_name;
  return (
    <section className="rounded-2xl border bg-card px-4 py-3" data-testid="project-instructions">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-medium">Instructions</h2>
        {text && (
          <CopyTextForClaude
            compact
            text={() => text}
            label="Copy the instructions for Claude"
            title="Copies this project's standing instructions, to paste into the claude.ai chat"
          />
        )}
      </div>
      <LoadState
        isLoading={isLoading}
        error={error}
        onRetry={() => refetch()}
        what="the instructions"
        compact
        className="mt-1"
        isEmpty={!text}
        empty={<p className="mt-1 text-xs text-muted-foreground">No standing instructions for this project yet. They are written on the project's page in the Hub.</p>}
      >
        <p className="mt-1 max-h-60 overflow-y-auto whitespace-pre-wrap break-words text-sm" data-testid="instructions-text">{matterContext?.content?.trim()}</p>
        {updatedBy && matterContext?.updated_at && (
          <p className="mt-1 text-[11px] text-muted-foreground">Last saved by {updatedBy} · {new Date(matterContext.updated_at).toLocaleDateString()}</p>
        )}
      </LoadState>
    </section>
  );
}

type Documents = ReturnType<typeof useMatterDocuments>["data"];

// The latest versions added across the project: what arrived, when, by whom.
function RecentActivity({ documents, isLoading, error, onRetry }: { documents: Documents; isLoading: boolean; error: unknown; onRetry: () => void }) {
  const { data: profiles } = useProfiles();
  const rows = useMemo(() => recentVersions(documents ?? [], RECENT), [documents]);
  const nameOf = (id: string | null | undefined) => {
    if (!id) return null;
    const p = profiles?.find((x) => x.id === id);
    return p?.full_name || p?.email || null;
  };
  return (
    <section className="rounded-2xl border bg-card px-4 py-3" data-testid="project-activity">
      <h2 className="text-sm font-medium">Recent activity</h2>
      <LoadState
        isLoading={isLoading}
        error={error}
        onRetry={onRetry}
        what="activity"
        compact
        className="mt-1"
        isEmpty={rows.length === 0}
        empty={<p className="mt-1 text-xs text-muted-foreground">Nothing added to this project yet.</p>}
      >
        <ul className="mt-1 space-y-0.5">
          {rows.map(({ doc, version }) => {
            const by = version.is_ai_generated ? "written with AI" : nameOf(version.uploaded_by);
            return (
              <li key={version.id}>
                <Link to={`/ai/d/${version.id}`} className="group flex items-start gap-2 rounded-md px-1 py-1.5 hover:bg-accent" data-testid="activity-row">
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm group-hover:underline">
                      {doc.title} <span className="text-muted-foreground">v{version.version_number}</span>
                    </span>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {version.version_number === 1 ? "Added" : "New version"}
                      {version.label ? ` · ${version.label}` : ""}
                      {by ? ` · ${by}` : ""}
                    </span>
                  </span>
                  <span className="shrink-0 pt-0.5 text-[11px] text-muted-foreground" title={new Date(version.created_at).toLocaleString()}>{relativeDay(version.created_at)}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </LoadState>
    </section>
  );
}
