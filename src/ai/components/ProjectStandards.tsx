import { useMemo } from "react";
import { BookMarked, Check, Minus } from "lucide-react";
import { useDocumentTypeTemplates } from "@/hooks/useDocumentTypeTemplates";
import SiteLink from "@/ai/components/SiteLink";

// The firm's standards for the kinds of document in this project: which
// have a standard master set (a draft of that kind follows it) and which do
// not yet. Each links to the standard in the Firm Library.
export default function ProjectStandards({ documents }: { documents: Array<{ document_type_id: string | null }> | undefined }) {
  const { data: templates } = useDocumentTypeTemplates();
  const rows = useMemo(() => {
    const inUse = new Set((documents ?? []).map((d) => d.document_type_id).filter((id): id is string => !!id));
    return (templates ?? []).filter((t) => inUse.has(t.document_type_id));
  }, [documents, templates]);

  return (
    <section className="rounded-2xl border bg-card px-4 py-3" data-testid="project-standards">
      <h2 className="text-sm font-medium">Standards</h2>
      {rows.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {documents?.length ? "None of this project's files has a document type yet. Give them one on Project Hub and the firm's standard for that kind shows here." : "The firm's standard for each kind of document shows here once the project has files."}
        </p>
      ) : (
        <ul className="mt-2 space-y-1">
          {rows.map((t) => (
            <li key={t.document_type_id}>
              <SiteLink to={`/precedent-library/standardize/${t.document_type_id}`} className="flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-accent" title={t.filename ? `Standard: ${t.filename}` : "No standard set yet"}>
                {t.filename ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" /> : <Minus className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                <span className="min-w-0 flex-1 truncate">{t.document_type_name}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{t.filename ? "Standard set" : "No standard yet"}</span>
              </SiteLink>
            </li>
          ))}
        </ul>
      )}
      <SiteLink to="/precedent-library" className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <BookMarked className="h-3.5 w-3.5" /> Firm Library
      </SiteLink>
    </section>
  );
}
