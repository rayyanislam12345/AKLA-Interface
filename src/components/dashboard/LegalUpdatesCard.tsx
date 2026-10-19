import ReactMarkdown from "react-markdown";
import { ExternalLink, Scale } from "lucide-react";
import {
  useLatestLawDigest,
  useRecentLawUpdates,
  usePendingLawCandidates,
  useWatchedPages,
  lawUpdateTypeLabel,
  incorporationLabel,
  type LawUpdate,
  type LawMonitorCandidate,
} from "@/hooks/useLawUpdates";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// The digest is written by an AI on the VM each morning, so it renders
// through react-markdown rather than dangerouslySetInnerHTML — generated
// text should never be able to inject markup into the homepage.
function typeVariant(type: string): "default" | "secondary" | "outline" {
  if (type === "bill" || type === "draft") return "outline";
  if (type === "consolidated_replacement" || type === "amending_instrument") return "default";
  return "secondary";
}

function incorporationClass(incorporation: LawUpdate["incorporation"]) {
  if (incorporation === "incorporated") return "text-emerald-700 dark:text-emerald-400";
  if (incorporation === "not_incorporated") return "text-amber-700 dark:text-amber-400";
  return "text-muted-foreground";
}

function UpdateRow({ update }: { update: LawUpdate }) {
  const link = update.document_url || update.source_url;
  const touchedLibrary =
    update.library_action === "replaced_act" || update.library_action === "ingested_amendment";
  const reported = update.tier === "reported";
  const incorporation = incorporationLabel(update);

  return (
    <div className="border-b last:border-0 py-2.5 space-y-1">
      <div className="flex items-start gap-2 flex-wrap">
        <Badge variant={typeVariant(update.update_type)} className="shrink-0 font-normal">
          {lawUpdateTypeLabel(update.update_type)}
        </Badge>
        {reported && (
          <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground border-dashed">
            Reported in press
          </Badge>
        )}
        <p className="text-sm font-medium min-w-0 flex-1">{update.title}</p>
      </div>
      <p className="text-xs text-muted-foreground">
        {update.source_name}
        {update.authority_ref ? ` · ${update.authority_ref}` : ""}
        {update.published_date ? ` · ${update.published_date}` : ""}
        {update.act_name ? ` · affects ${update.act_name}` : " · not an Act in the library"}
      </p>
      {update.summary && <p className="text-xs text-muted-foreground">{update.summary}</p>}
      <div className="flex items-center gap-3 flex-wrap">
        {incorporation && (
          <span className={`text-[11px] ${incorporationClass(update.incorporation)}`}>{incorporation}</span>
        )}
        {touchedLibrary && (
          <span className="text-[11px] text-emerald-700 dark:text-emerald-400">
            Law library updated automatically
          </span>
        )}
        {reported && (
          <span className="text-[11px] text-muted-foreground">Official text not yet located</span>
        )}
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[11px] text-primary inline-flex items-center gap-1 hover:underline"
          >
            Source <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  );
}

function PendingRow({ candidate }: { candidate: LawMonitorCandidate }) {
  return (
    <div className="border-b last:border-0 py-2 space-y-0.5">
      <div className="flex items-start gap-2 flex-wrap">
        {candidate.update_type && (
          <Badge variant="outline" className="shrink-0 font-normal text-muted-foreground">
            {lawUpdateTypeLabel(candidate.update_type)}
          </Badge>
        )}
        <p className="text-sm min-w-0 flex-1">{candidate.title}</p>
      </div>
      <p className="text-xs text-muted-foreground">
        {candidate.source_name}
        {candidate.act_name ? ` · affects ${candidate.act_name}` : ""}
        {" · the official site has not answered yet; retried each morning"}
        {candidate.url && (
          <>
            {" · "}
            <a href={candidate.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
              address
            </a>
          </>
        )}
      </p>
    </div>
  );
}

// One line on what is being watched, so a source that has gone quiet or
// dead is visible rather than silently missing from the briefing.
function WatchFooter() {
  const { data: pages } = useWatchedPages();
  if (!pages || pages.length === 0) return null;
  const listings = pages.filter((p) => p.kind === "listing" && p.enabled);
  const sources = pages.filter((p) => p.kind === "library_source" && p.enabled);
  const failing = pages.filter((p) => p.enabled && p.consecutive_failures >= 3);
  const lastChange = pages
    .map((p) => p.last_changed_at)
    .filter((d): d is string => !!d)
    .sort()
    .at(-1);
  return (
    <p className="text-[11px] text-muted-foreground border-t pt-2">
      Watching {listings.length} official notice-board page{listings.length === 1 ? "" : "s"}
      {sources.length > 0 ? ` and the source pages of ${sources.length} library Act${sources.length === 1 ? "" : "s"}` : ""}
      {lastChange ? ` · last change seen ${new Date(lastChange).toLocaleDateString("en-GB")}` : ""}
      {failing.length > 0 ? ` · ${failing.length} page${failing.length === 1 ? " has" : "s have"} not answered for days: ${failing.map((p) => p.name).join(", ")}` : ""}
    </p>
  );
}

export default function LegalUpdatesCard() {
  const { data: digest, isLoading: digestLoading } = useLatestLawDigest();
  const { data: updates } = useRecentLawUpdates(8);
  const { data: pending } = usePendingLawCandidates(5);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Scale className="h-4 w-4 text-primary" />
          Legal Updates
          {digest && (
            <span className="text-xs font-normal text-muted-foreground">
              {new Date(digest.digest_date).toLocaleDateString("en-GB", {
                day: "numeric",
                month: "long",
                year: "numeric",
              })}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {digestLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : !digest ? (
          <p className="text-sm text-muted-foreground">
            The morning sweep hasn't produced a briefing yet. It checks Parliament, the regulators, the
            PPP authorities, the press and the firm's law library every day at 7am.
          </p>
        ) : (
          <div className="text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:my-2 [&_p]:my-1.5">
            <ReactMarkdown>{digest.summary_markdown}</ReactMarkdown>
          </div>
        )}

        {updates && updates.length > 0 && (
          <div className="border-t pt-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide pt-2 pb-1">
              Recent findings
            </p>
            {updates.map((update) => (
              <UpdateRow key={update.id} update={update} />
            ))}
          </div>
        )}

        {pending && pending.length > 0 && (
          <div className="border-t pt-1">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide pt-2 pb-1">
              Seen, awaiting the official document
            </p>
            {pending.map((candidate) => (
              <PendingRow key={candidate.dedupe_key} candidate={candidate} />
            ))}
          </div>
        )}

        <WatchFooter />
      </CardContent>
    </Card>
  );
}
