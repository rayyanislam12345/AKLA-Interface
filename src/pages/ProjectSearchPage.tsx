import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Search, FileText, StickyNote, CheckSquare, Download, Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useMatters } from "@/hooks/useMatters";
import { useToast } from "@/hooks/use-toast";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";

export interface ProjectSearchResult {
  kind: "document" | "note" | "task"; item_id: string; matter_id: string; matter_name: string; title: string; snippet: string;
  document_id: string | null; version_id: string | null; version_number: number | null; storage_path: string | null; file_name: string | null;
  created_at: string; rank: number; total_count: number; matched_in: string;
}
const PAGE_SIZE = 25;
function Snippet({ text }: { text: string }) {
  return <>{text.split(/(⟦[^⟧]*⟧)/g).map((part,i) => part.startsWith("⟦") ? <mark key={i} className="rounded bg-amber-100 px-0.5 text-inherit dark:bg-amber-900/40">{part.slice(1,-1)}</mark> : <span key={i}>{part}</span>)}</>;
}
export default function ProjectSearchPage() {
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const matterId = params.get("matter") ?? "all";
  const kind = params.get("kind") ?? "all";
  const allVersions = params.get("versions") === "all";
  const page = Math.floor(Math.max(0, Math.min(400, Number(params.get("page")) || 0)));
  const [input, setInput] = useState(query);
  const [downloading, setDownloading] = useState<string | null>(null);
  const { data: matters } = useMatters();
  const { toast } = useToast();
  useEffect(() => setInput(query), [query]);
  const update = (patch: Record<string,string>) => {
    const next = new URLSearchParams(params); next.delete("page");
    for (const [key,value] of Object.entries(patch)) value ? next.set(key,value) : next.delete(key);
    setParams(next);
  };
  const search = useQuery({
    queryKey: ["project-search", query, matterId, kind, allVersions, page],
    enabled: query.trim().length >= 2,
    queryFn: async ({ signal }): Promise<ProjectSearchResult[]> => {
      const { data, error } = await supabase.rpc("search_project_content", { p_query: query.trim(), p_matter_id: matterId === "all" ? null : matterId,
        p_kind: kind, p_all_versions: allVersions, p_limit: PAGE_SIZE, p_offset: page*PAGE_SIZE }).abortSignal(signal);
      if (error) throw error;
      return data as ProjectSearchResult[];
    },
  });
  const total = Number(search.data?.[0]?.total_count ?? 0);
  const download = async (row: ProjectSearchResult) => {
    if (!row.storage_path) return;
    setDownloading(row.item_id);
    try {
      const { data, error } = await supabase.storage.from("matter-documents").download(row.storage_path);
      if (error || !data) throw error ?? new Error("File unavailable");
      const url = URL.createObjectURL(data); const a = document.createElement("a"); a.href=url; a.download=row.file_name ?? `document-v${row.version_number}.docx`; a.click(); URL.revokeObjectURL(url);
    } catch (err) { toast({ title: "Download failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" }); }
    finally { setDownloading(null); }
  };
  return <div className="mx-auto max-w-5xl space-y-6">
    <div><h1 className="text-2xl font-semibold">Project search</h1><p className="text-muted-foreground">Find documents, clauses, notes, and tasks across your projects.</p></div>
    <form className="flex gap-2" onSubmit={e => { e.preventDefault(); update({q:input.trim()}); }}>
      <Input aria-label="Search projects" placeholder='Search words or an exact phrase in quotes' value={input} maxLength={200} onChange={e => setInput(e.target.value)} autoFocus />
      <Button type="submit" disabled={input.trim().length<2}><Search className="mr-2 h-4 w-4"/>Search</Button>
    </form>
    <div className="flex flex-wrap items-center gap-3">
      <Select value={matterId} onValueChange={v => update({matter:v})}><SelectTrigger className="w-64" aria-label="Project filter"><SelectValue placeholder="All projects"/></SelectTrigger><SelectContent><SelectItem value="all">All projects</SelectItem>{matters?.map(m => <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>)}</SelectContent></Select>
      <Select value={kind} onValueChange={v => update({kind:v})}><SelectTrigger className="w-44" aria-label="Result type"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">All types</SelectItem><SelectItem value="document">Documents</SelectItem><SelectItem value="note">Notes</SelectItem><SelectItem value="task">Tasks</SelectItem></SelectContent></Select>
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={allVersions} onCheckedChange={v => update({versions:v === true ? "all" : ""})}/>Include older versions</label>
    </div>
    <p className="text-xs text-muted-foreground">Document text is searchable after indexing finishes. By default, results include only the latest version of each document.</p>
    <div aria-live="polite">
      {query.trim().length<2 ? <p className="py-12 text-center text-muted-foreground">Enter at least two characters to search.</p> : search.isFetching ? <p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin"/>Searching…</p> : search.isError ? <div className="rounded border border-destructive p-4"><p>Search could not load. {search.error.message}</p><Button className="mt-2" variant="outline" onClick={() => search.refetch()}>Try again</Button></div> : <>
        <p className="mb-3 text-sm text-muted-foreground">{total.toLocaleString()} result{total===1?"":"s"}{matterId!=="all"?" in this project":""}</p>
        {!search.data?.length && <p className="rounded border p-6 text-muted-foreground">No matches. Try fewer words, another project, or include older versions.</p>}
        <div className="space-y-3">{search.data?.map(row => {
          const Icon = row.kind === "document" ? FileText : row.kind === "note" ? StickyNote : CheckSquare;
          const target = row.kind === "document" ? `?document=${row.document_id}#version-${row.version_id}` : `#${row.kind}-${row.item_id}`;
          return <article key={`${row.kind}-${row.item_id}`} className="rounded-lg border p-4 space-y-2">
            <div className="flex items-start gap-3"><Icon className="mt-1 h-4 w-4 shrink-0 text-muted-foreground"/><div className="min-w-0 flex-1"><Link className="font-medium hover:underline" to={`/matters/${row.matter_id}${target}`}>{row.title}</Link><p className="text-xs text-muted-foreground">{row.matter_name} · {new Date(row.created_at).toLocaleDateString()}</p></div><Badge variant="outline">{row.kind}{row.version_number ? ` · v${row.version_number}` : ""}</Badge></div>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed"><Snippet text={row.snippet}/></p>
            {row.storage_path && <Button variant="ghost" size="sm" disabled={!!downloading} onClick={() => download(row)}><Download className="mr-2 h-3.5 w-3.5"/>{downloading===row.item_id?"Downloading…":`Download v${row.version_number}`}</Button>}
          </article>;
        })}</div>
        {(page>0 || total>PAGE_SIZE) && <div className="mt-4 flex items-center gap-3"><Button variant="outline" disabled={page===0} onClick={() => update({page:String(page-1)})}>Previous</Button><span className="text-sm">Page {page+1}</span><Button variant="outline" disabled={(page+1)*PAGE_SIZE>=total} onClick={() => update({page:String(page+1)})}>Next</Button></div>}
      </>}
    </div>
  </div>;
}
