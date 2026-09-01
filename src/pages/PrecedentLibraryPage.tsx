import { useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { BookMarked, ExternalLink, FileCheck, FileText, Gavel, Trash2, Upload } from "lucide-react";
import { useDocumentTypes } from "@/hooks/useMatterDocuments";
import {
  usePrecedentSources,
  useUploadPrecedentDocument,
  useDeletePrecedentSource,
} from "@/hooks/usePrecedentLibrary";
import { useStatuteSources, useDeleteStatuteSource } from "@/hooks/useLawLibrary";
import { useDocumentTypeTemplates } from "@/hooks/useDocumentTypeTemplates";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

type FileStatus = "queued" | "uploading" | "done" | "error";
interface QueuedFile {
  file: File;
  status: FileStatus;
  error?: string;
}

function LawLibraryTab() {
  const { data: statutes, isLoading } = useStatuteSources();
  const deleteStatute = useDeleteStatuteSource();
  const { toast } = useToast();

  const handleDelete = async (actName: string) => {
    if (!window.confirm(`Remove "${actName}" from the law library?`)) return;
    try {
      await deleteStatute.mutateAsync(actName);
      toast({ title: "Removed from law library" });
    } catch (err: any) {
      toast({ title: "Failed to remove", description: err.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Pakistani statute text — Draft with AI and Review with AI can ground answers in what the law
        actually says, kept separate from the firm's own precedent above. Sourced from{" "}
        <a
          href="https://pakistancode.gov.pk"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          pakistancode.gov.pk
        </a>{" "}
        via <code className="text-xs">scripts/law_library</code> — there's no upload button here since
        this corpus is scraper-managed, not lawyer-uploaded.
      </p>

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !statutes?.length ? (
        <p className="text-muted-foreground">Nothing in the law library yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Act</TableHead>
              <TableHead>Chunks</TableHead>
              <TableHead>Added</TableHead>
              <TableHead className="w-20"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {statutes.map((s) => (
              <TableRow key={s.act_name}>
                <TableCell className="max-w-md">{s.act_name}</TableCell>
                <TableCell className="text-muted-foreground">{s.chunk_count}</TableCell>
                <TableCell className="text-muted-foreground">
                  {s.scraped_at ? new Date(s.scraped_at).toLocaleDateString() : "—"}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    {s.source_url && (
                      <Button size="icon" variant="ghost" asChild>
                        <a href={s.source_url} target="_blank" rel="noreferrer" title="View source">
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </Button>
                    )}
                    <Button size="icon" variant="ghost" onClick={() => handleDelete(s.act_name)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

function StandardizeTab() {
  const navigate = useNavigate();
  const { data: rows, isLoading } = useDocumentTypeTemplates();

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        One canonical "standard version" per document type, curated by the team — "Draft with AI" uses
        it as the primary structural and formatting jump-off point for that type, ahead of the firm's
        other precedent.
      </p>

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !rows?.length ? (
        <p className="text-muted-foreground">No document types yet.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Document Type</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Last Updated</TableHead>
              <TableHead className="w-32"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.document_type_id}>
                <TableCell className="max-w-md">{row.document_type_name}</TableCell>
                <TableCell>
                  <Badge variant={row.filename ? "default" : "secondary"}>
                    {row.filename ? "Standardized" : "Not yet standardized"}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {row.updated_at
                    ? `${new Date(row.updated_at).toLocaleDateString()}${
                        row.updated_by_name ? ` by ${row.updated_by_name}` : ""
                      }`
                    : "—"}
                </TableCell>
                <TableCell>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => navigate(`/precedent-library/standardize/${row.document_type_id}`)}
                  >
                    {row.filename ? "Replace" : "Upload"}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export default function PrecedentLibraryPage() {
  const { data: documentTypes } = useDocumentTypes();
  const { data: sources, isLoading } = usePrecedentSources();
  const uploadDoc = useUploadPrecedentDocument();
  const deleteSource = useDeletePrecedentSource();
  const { toast } = useToast();

  const [documentTypeId, setDocumentTypeId] = useState<string>("");
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof sources>();
    for (const s of sources ?? []) {
      const key = s.document_type_name ?? "Unassigned";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return map;
  }, [sources]);

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setQueue((prev) => [...prev, ...files.map((file) => ({ file, status: "queued" as FileStatus }))]);
  };

  const handleUploadAll = async () => {
    if (!documentTypeId || queue.length === 0) return;
    setUploading(true);
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].status === "done") continue;
      setQueue((prev) => prev.map((q, idx) => (idx === i ? { ...q, status: "uploading" } : q)));
      try {
        await uploadDoc.mutateAsync({ file: queue[i].file, documentTypeId });
        setQueue((prev) => prev.map((q, idx) => (idx === i ? { ...q, status: "done" } : q)));
      } catch (err: any) {
        setQueue((prev) =>
          prev.map((q, idx) => (idx === i ? { ...q, status: "error", error: err.message } : q))
        );
      }
    }
    setUploading(false);
    toast({ title: "Batch upload complete" });
  };

  const handleDelete = async (storagePath: string, filename: string) => {
    if (!window.confirm(`Remove "${filename}" from the precedent library?`)) return;
    try {
      await deleteSource.mutateAsync(storagePath);
      toast({ title: "Removed from precedent library" });
    } catch (err: any) {
      toast({ title: "Failed to remove", description: err.message, variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <BookMarked className="h-5 w-5 text-primary" />
          Precedent Library
        </h1>
        <p className="text-muted-foreground">
          What "Draft with AI" and "Review with AI" ground their answers in — the firm's own past
          agreements, and Pakistani statute text, kept as two distinct corpora.
        </p>
      </div>

      <Tabs defaultValue="precedents">
        <TabsList>
          <TabsTrigger value="precedents">Precedents</TabsTrigger>
          <TabsTrigger value="law-library">
            <Gavel className="h-3.5 w-3.5 mr-1.5" />
            Law Library
          </TabsTrigger>
          <TabsTrigger value="standardize">
            <FileCheck className="h-3.5 w-3.5 mr-1.5" />
            Standardize
          </TabsTrigger>
        </TabsList>

        <TabsContent value="precedents" className="space-y-6 mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Bulk Upload</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-3 items-end flex-wrap">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Document type</label>
                  <Select value={documentTypeId} onValueChange={setDocumentTypeId}>
                    <SelectTrigger className="w-64">
                      <SelectValue placeholder="All files below will be tagged as this type" />
                    </SelectTrigger>
                    <SelectContent>
                      {documentTypes?.map((type) => (
                        <SelectItem key={type.id} value={type.id}>
                          {type.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".pdf,.docx,.xlsx,.xls"
                  className="hidden"
                  onChange={handleFilesSelected}
                />
                <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={!documentTypeId}>
                  <Upload className="h-4 w-4 mr-2" />
                  Add Files
                </Button>
                <Button
                  onClick={handleUploadAll}
                  disabled={!documentTypeId || queue.length === 0 || uploading}
                >
                  Upload {queue.length > 0 ? `(${queue.length})` : ""}
                </Button>
              </div>
              {!documentTypeId && (
                <p className="text-xs text-muted-foreground">
                  Pick a document type first — every file in a batch is tagged with the same type. Run the
                  upload again for a different type.
                </p>
              )}

              {queue.length > 0 && (
                <div className="space-y-1 max-h-64 overflow-y-auto">
                  {queue.map((q, i) => (
                    <div key={i} className="flex items-center gap-3 text-sm border-b py-1.5 last:border-0">
                      <FileText className="h-4 w-4 text-muted-foreground shrink-0" />
                      <span className="truncate flex-1">{q.file.name}</span>
                      <Badge
                        variant={
                          q.status === "done" ? "default" : q.status === "error" ? "destructive" : "secondary"
                        }
                      >
                        {q.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="space-y-6">
            {isLoading ? (
              <p className="text-muted-foreground">Loading…</p>
            ) : !sources?.length ? (
              <p className="text-muted-foreground">Nothing in the precedent library yet.</p>
            ) : (
              Array.from(grouped.entries()).map(([category, items]) => (
                <div key={category} className="space-y-2">
                  <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                    {category}
                  </h2>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>File</TableHead>
                        <TableHead>Chunks</TableHead>
                        <TableHead>Added</TableHead>
                        <TableHead className="w-12"></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items!.map((s) => (
                        <TableRow key={s.storage_path}>
                          <TableCell className="truncate max-w-xs">{s.filename}</TableCell>
                          <TableCell className={cn("text-muted-foreground")}>{s.chunk_count}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {new Date(s.created_at).toLocaleDateString()}
                          </TableCell>
                          <TableCell>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => handleDelete(s.storage_path, s.filename)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="law-library" className="mt-6">
          <LawLibraryTab />
        </TabsContent>

        <TabsContent value="standardize" className="mt-6">
          <StandardizeTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
