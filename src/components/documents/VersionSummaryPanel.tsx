import type { VersionCard } from "./versionInsights";

// What the Hub read in this version: the summary card the index worker
// writes for every version it reads (chat-service/indexing/card.js). Only
// what the text shows; the worker invents nothing.
export function VersionSummaryPanel({ card, loading }: { card: VersionCard | null; loading: boolean }) {
  if (loading) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (!card?.summary && !card?.parties?.length && !card?.key_dates?.length) {
    return (
      <p className="p-4 text-sm text-muted-foreground">
        No summary yet. The Hub writes one a few minutes after a file is uploaded, once it has read it; a scanned
        file it can't read gets none.
      </p>
    );
  }
  return (
    <div className="space-y-5 p-4 text-sm" data-testid="version-summary">
      {card.document_kind && <p className="text-xs uppercase tracking-wide text-muted-foreground">{card.document_kind}</p>}
      {card.summary && <p className="leading-relaxed">{card.summary}</p>}
      {!!card.parties?.length && (
        <section>
          <h3 className="mb-1.5 font-medium">Parties</h3>
          <ul className="space-y-1">
            {card.parties.map((p, i) => (
              <li key={`${p.name}-${i}`}>
                {p.name}
                {p.role && <span className="text-muted-foreground"> — {p.role}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {!!card.key_dates?.length && (
        <section>
          <h3 className="mb-1.5 font-medium">Key dates</h3>
          <ul className="space-y-1">
            {card.key_dates.map((d, i) => (
              <li key={`${d.date}-${i}`}>
                <span className="font-medium">{d.date}</span>
                {d.what && <span className="text-muted-foreground"> — {d.what}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {!!card.statutes_mentioned?.length && (
        <section>
          <h3 className="mb-1.5 font-medium">Laws it mentions</h3>
          <p className="text-muted-foreground">{card.statutes_mentioned.join("; ")}</p>
        </section>
      )}
      <p className="text-xs text-muted-foreground">Written by the Hub from the text of this version. Check it against the document.</p>
    </div>
  );
}
