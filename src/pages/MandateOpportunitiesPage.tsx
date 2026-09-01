import { Fragment, useMemo, useState } from "react";
import { format, isPast } from "date-fns";
import { ChevronDown, ChevronRight, ExternalLink, FileText, Megaphone } from "lucide-react";
import {
  useMandateOpportunities,
  useMandateDocuments,
  openMandateDocument,
  type MandateOpportunity,
} from "@/hooks/useMandateOpportunities";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const SOURCE_LABELS: Record<string, string> = {
  bppt: "Balochistan (BPPT)",
  epms: "PPRA (EPMS)",
  kppra: "KP (KPPRA)",
  sindh: "Sindh",
  pndkp: "P&D KP",
  worldbank: "World Bank",
  wbgeprocure: "World Bank (eConsultant2)",
  adb: "Asian Development Bank",
};

function formatDate(value: string | null) {
  if (!value) return "—";
  return format(new Date(value), "d MMM yyyy");
}

function StatusBadge({ closeDate }: { closeDate: string | null }) {
  if (!closeDate) return <Badge variant="secondary">Unknown</Badge>;
  const closed = isPast(new Date(closeDate));
  return (
    <Badge variant={closed ? "secondary" : "default"} className={cn(!closed && "bg-emerald-600 hover:bg-emerald-600")}>
      {closed ? "Closed" : "Open"}
    </Badge>
  );
}

// Pure content, shared by the desktop table's expanded row and the mobile
// card's expanded section.
function OpportunityDetail({ opportunity }: { opportunity: MandateOpportunity }) {
  const { data: files, isLoading } = useMandateDocuments(opportunity.storage_folder);
  const { toast } = useToast();

  const externalLinks = [
    opportunity.notice_url && { label: "Notice", url: opportunity.notice_url },
    opportunity.document_url && { label: "Bidding Document", url: opportunity.document_url },
    ...opportunity.extra_urls.map((url, i) => ({ label: `Attachment ${i + 1}`, url })),
  ].filter(Boolean) as { label: string; url: string }[];

  const handleOpen = async (path: string) => {
    try {
      await openMandateDocument(path);
    } catch (err: any) {
      toast({ title: "Failed to open document", description: err.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-3">
      {externalLinks.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {externalLinks.map((link) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              {link.label}
            </a>
          ))}
        </div>
      )}

      {opportunity.storage_folder ? (
        isLoading ? (
          <p className="text-sm text-muted-foreground">Loading saved documents…</p>
        ) : !files?.length ? (
          <p className="text-sm text-muted-foreground">No documents saved for this opportunity.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {files.map((file) => (
              <Button
                key={file.path}
                variant="outline"
                size="sm"
                onClick={() => handleOpen(file.path)}
                className="gap-1.5"
              >
                <FileText className="h-3.5 w-3.5" />
                {file.name}
              </Button>
            ))}
          </div>
        )
      ) : (
        <p className="text-sm text-muted-foreground">No saved documents for this opportunity.</p>
      )}
    </div>
  );
}

function DocumentsRow({ opportunity }: { opportunity: MandateOpportunity }) {
  return (
    <TableRow className="bg-muted/30 hover:bg-muted/30">
      <TableCell colSpan={7} className="py-4">
        <OpportunityDetail opportunity={opportunity} />
      </TableCell>
    </TableRow>
  );
}

function OpportunityCard({ opportunity, expanded, onToggle }: { opportunity: MandateOpportunity; expanded: boolean; onToggle: () => void }) {
  return (
    <div className="border rounded-md">
      <button className="w-full text-left px-3 py-2.5 flex items-start gap-2" onClick={onToggle}>
        {expanded ? (
          <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        ) : (
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
        )}
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium">{opportunity.title}</p>
            <div className="shrink-0">
              <StatusBadge closeDate={opportunity.close_date} />
            </div>
          </div>
          {opportunity.department && <p className="text-xs text-muted-foreground">{opportunity.department}</p>}
          <p className="text-xs text-muted-foreground">
            {SOURCE_LABELS[opportunity.source] ?? opportunity.source}
            {opportunity.category ? ` · ${opportunity.category}` : ""} · Published{" "}
            {formatDate(opportunity.publish_date)} · Closes {formatDate(opportunity.close_date)}
          </p>
          {opportunity.matched_keywords.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {opportunity.matched_keywords.slice(0, 4).map((kw) => (
                <Badge key={kw} variant="outline" className="text-[10px] font-normal">
                  {kw}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </button>
      {expanded && (
        <div className="border-t px-3 py-3">
          <OpportunityDetail opportunity={opportunity} />
        </div>
      )}
    </div>
  );
}

export default function MandateOpportunitiesPage() {
  const { data: opportunities, isLoading } = useMandateOpportunities();
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [statusFilter, setStatusFilter] = useState<string>("open");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const sources = useMemo(() => {
    const set = new Set((opportunities ?? []).map((o) => o.source));
    return Array.from(set).sort();
  }, [opportunities]);

  const filtered = useMemo(() => {
    return (opportunities ?? []).filter((o) => {
      if (sourceFilter !== "all" && o.source !== sourceFilter) return false;
      if (statusFilter === "open" && o.close_date && isPast(new Date(o.close_date))) return false;
      if (statusFilter === "closed" && (!o.close_date || !isPast(new Date(o.close_date)))) return false;
      return true;
    });
  }, [opportunities, sourceFilter, statusFilter]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Megaphone className="h-5 w-5 text-primary" />
          Mandate Opportunities
        </h1>
        <p className="text-muted-foreground">
          Tenders and consulting opportunities matching the firm's keywords, scraped daily from public
          procurement portals — Balochistan, Punjab (PPRA), Khyber Pakhtunkhwa, the World Bank, and the
          Asian Development Bank.
        </p>
      </div>

      <div className="flex gap-3 flex-wrap items-center">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="open">Open only</SelectItem>
            <SelectItem value="closed">Closed only</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>

        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sources</SelectItem>
            {sources.map((s) => (
              <SelectItem key={s} value={s}>
                {SOURCE_LABELS[s] ?? s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="text-sm text-muted-foreground">
          {filtered.length} of {opportunities?.length ?? 0} opportunities
        </span>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !filtered.length ? (
        <p className="text-muted-foreground">No opportunities match these filters.</p>
      ) : (
        <>
          <div className="hidden sm:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8"></TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead>Published</TableHead>
                  <TableHead>Closes</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((o) => {
                  const expanded = expandedId === o.id;
                  return (
                    <Fragment key={o.id}>
                      <TableRow
                        className="cursor-pointer"
                        onClick={() => setExpandedId(expanded ? null : o.id)}
                      >
                        <TableCell>
                          {expanded ? (
                            <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          )}
                        </TableCell>
                        <TableCell className="max-w-md">
                          <p className="font-medium truncate">{o.title}</p>
                          {o.department && (
                            <p className="text-xs text-muted-foreground truncate">{o.department}</p>
                          )}
                          {o.matched_keywords.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1">
                              {o.matched_keywords.slice(0, 4).map((kw) => (
                                <Badge key={kw} variant="outline" className="text-[10px] font-normal">
                                  {kw}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-sm">{SOURCE_LABELS[o.source] ?? o.source}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{o.category ?? "—"}</TableCell>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {formatDate(o.publish_date)}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                          {formatDate(o.close_date)}
                        </TableCell>
                        <TableCell>
                          <StatusBadge closeDate={o.close_date} />
                        </TableCell>
                      </TableRow>
                      {expanded && <DocumentsRow opportunity={o} />}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </div>

          <div className="sm:hidden space-y-2">
            {filtered.map((o) => (
              <OpportunityCard
                key={o.id}
                opportunity={o}
                expanded={expandedId === o.id}
                onToggle={() => setExpandedId(expandedId === o.id ? null : o.id)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
