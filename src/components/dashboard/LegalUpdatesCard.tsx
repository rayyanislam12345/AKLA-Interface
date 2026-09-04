import ReactMarkdown from "react-markdown";
import { ExternalLink, Scale } from "lucide-react";
import { useLatestLawDigest, useRecentLawUpdates, lawUpdateTypeLabel, type LawUpdate } from "@/hooks/useLawUpdates";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

// The digest is written by an AI on the VM each morning, so it renders
// through react-markdown rather than dangerouslySetInnerHTML — generated
// text should never be able to inject markup into the homepage.
function typeVariant(type: string): "default" | "secondary" | "outline" {
  if (type === "bill") return "outline";
  if (type === "consolidated_replacement" || type === "amending_instrument") return "default";
  return "secondary";
}

function UpdateRow({ update }: { update: LawUpdate }) {
  const link = update.document_url || update.source_url;
  const touchedLibrary =
    update.library_action === "replaced_act" || update.library_action === "ingested_amendment";

  return (
    <div className="border-b last:border-0 py-2.5 space-y-1">
      <div className="flex items-start gap-2 flex-wrap">
        <Badge variant={typeVariant(update.update_type)} className="shrink-0 font-normal">
          {lawUpdateTypeLabel(update.update_type)}
        </Badge>
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
        {touchedLibrary && (
          <span className="text-[11px] text-emerald-700 dark:text-emerald-400">
            Law library updated automatically
          </span>
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

export default function LegalUpdatesCard() {
  const { data: digest, isLoading: digestLoading } = useLatestLawDigest();
  const { data: updates } = useRecentLawUpdates(6);

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
            The morning sweep hasn't produced a briefing yet. It checks SECP, the PPP authorities and the
            firm's law library every day at 7am.
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
      </CardContent>
    </Card>
  );
}
