import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import PrecedentSearchTab from "@/components/precedents/PrecedentSearchTab";
import { BookMarked, ExternalLink, FileCheck, FileText, Gavel, Plus, RotateCcw, Search, Sparkles, Trash2, Upload, X } from "lucide-react";
import AddLawDialog from "@/components/law/AddLawDialog";
import { useDocumentTypes } from "@/hooks/useMatterDocuments";
import {
  usePrecedentSources,
  useUploadPrecedentDocument,
  useDeletePrecedentSource,
  fetchLibraryFileKeys,
  hashFile,
  libraryFileKey,
} from "@/hooks/usePrecedentLibrary";
import { useMyProfile } from "@/hooks/useProfiles";
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

type FileStatus = "queued" | "checking" | "uploading" | "done" | "error" | "duplicate";
interface QueuedFile {
  id: number;
  file: File;
  status: FileStatus;
  error?: string;
  hash?: string;
}

const STATUS_LABEL: Record<FileStatus, string> = {
  queued: "Waiting",
  checking: "Checking",
  uploading: "Uploading",
  done: "Added",
  error: "Failed",
  duplicate: "Already in the library",
};

const LEAVE_WARNING =
  "Files are still uploading to the Firm Library. If you leave this page now, the files still waiting will not be added. Leave anyway?";

let nextQueueId = 1;

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

function LawLibraryTab() {
  const { data: statutes, isLoading } = useStatuteSources();
  const deleteStatute = useDeleteStatuteSource();
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);

  const handleDelete = async (actName: string) => {
    if (!window.confirm(`Remove "${actName}" from the law library?`)) return;
    try {
      await deleteStatute.mutateAsync(actName);
      toast({ title: "Removed from law library" });
    } catch (err) {
      toast({ title: "Failed to remove", description: errorMessage(err), variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Pakistani statute text — Draft, Review and Standardise ground their answers in what the law
          actually says, kept separate from the firm's own precedent above. Add an Act by name and it is
          found on{" "}
          <a href="https://pakistancode.gov.pk" target="_blank" rel="noreferrer" className="underline underline-offset-2">
            pakistancode.gov.pk
          </a>{" "}
          or another official source, downloaded and checked before it is indexed; or upload the Act as a file.
        </p>
        <Button onClick={() => setAddOpen(true)} data-testid="add-law">
          <Plus className="mr-2 h-4 w-4" />
          Add a law
        </Button>
      </div>
      <AddLawDialog open={addOpen} onOpenChange={setAddOpen} />

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !statutes?.length ? (
        <p className="text-muted-foreground">Nothing in the law library yet.</p>
      ) : (
        <>
          <div className="hidden sm:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Act</TableHead>
                  <TableHead>Indexed passages</TableHead>
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
          </div>

          <div className="sm:hidden space-y-2">
            {statutes.map((s) => (
              <div key={s.act_name} className="flex items-center justify-between gap-2 border rounded-md px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm truncate">{s.act_name}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.chunk_count} chunks · {s.scraped_at ? new Date(s.scraped_at).toLocaleDateString() : "—"}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
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
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function StandardizeTab({ confirmLeave }: { confirmLeave: () => boolean }) {
  const routerNavigate = useNavigate();
  const navigate = (to: string) => {
    if (confirmLeave()) routerNavigate(to);
  };
  const { data: rows, isLoading } = useDocumentTypeTemplates();
  const { data: me } = useMyProfile();
  const isAdmin = me?.role === "admin" || me?.role === "founder";
  const openLabel = (hasStandard: boolean) => (isAdmin ? (hasStandard ? "Replace" : "Upload") : "Open");

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        One canonical "standard version" per document type — "Draft with AI" uses it as the primary
        structural and formatting jump-off point for that type, ahead of the firm's other precedent.
        {isAdmin
          ? " As an administrator you set and replace them."
          : " An administrator sets each standard; anyone can build or revise one with AI and ask an administrator to set it."}
      </p>

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !rows?.length ? (
        <p className="text-muted-foreground">No document types yet.</p>
      ) : (
        <>
          <div className="hidden sm:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Document Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last Updated</TableHead>
                  <TableHead className="w-64"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.document_type_id}>
                    <TableCell className="max-w-md">{row.document_type_name}</TableCell>
                    <TableCell>
                      <Badge variant={row.filename ? "default" : "secondary"}>
                        {row.filename ? "Standardised" : "Not yet standardised"}
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
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => navigate(`/precedent-library/standardize/${row.document_type_id}`)}
                        >
                          {openLabel(!!row.filename)}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          title="Build the standard with the AI from the firm's documents and the relevant law"
                          onClick={() => navigate(`/precedent-library/standardize/${row.document_type_id}/build`)}
                        >
                          <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                          {row.filename ? "Revise with AI" : "Build with AI"}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="sm:hidden space-y-2">
            {rows.map((row) => (
              <div key={row.document_type_id} className="border rounded-md px-3 py-2.5 space-y-2">
                <p className="text-sm font-medium">{row.document_type_name}</p>
                <div className="flex items-center justify-between gap-2">
                  <Badge variant={row.filename ? "default" : "secondary"}>
                    {row.filename ? "Standardised" : "Not yet standardised"}
                  </Badge>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => navigate(`/precedent-library/standardize/${row.document_type_id}`)}
                    >
                      {openLabel(!!row.filename)}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => navigate(`/precedent-library/standardize/${row.document_type_id}/build`)}
                    >
                      <Sparkles className="mr-1.5 h-3.5 w-3.5" />
                      AI
                    </Button>
                  </div>
                </div>
                {row.updated_at && (
                  <p className="text-xs text-muted-foreground">
                    {new Date(row.updated_at).toLocaleDateString()}
                    {row.updated_by_name ? ` by ${row.updated_by_name}` : ""}
                  </p>
                )}
              </div>
            ))}
          </div>
        </>
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
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "precedents";

  const [documentTypeId, setDocumentTypeId] = useState<string>("");
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Set when the page goes away mid-batch, so the batch stops after the file
  // in flight rather than carrying on unseen.
  const leftPage = useRef(false);
  useEffect(() => {
    leftPage.current = false;
    return () => {
      leftPage.current = true;
    };
  }, []);

  const grouped = useMemo(() => {
    const map = new Map<string, typeof sources>();
    for (const s of sources ?? []) {
      const key = s.document_type_name ?? "Unassigned";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return map;
  }, [sources]);

  // Leaving mid-batch: the browser asks before a reload, a closed tab or an
  // address typed in; a click on any link inside the app asks first too.
  useEffect(() => {
    if (!uploading) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const link = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || link.target === "_blank" || link.hasAttribute("download")) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      if (!window.confirm(LEAVE_WARNING)) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [uploading]);
  const confirmLeave = () => !uploading || window.confirm(LEAVE_WARNING);

  const patch = (id: number, change: Partial<QueuedFile>) =>
    setQueue((prev) => prev.map((q) => (q.id === id ? { ...q, ...change } : q)));

  const handleFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;
    setQueue((prev) => [...prev, ...files.map((file) => ({ id: nextQueueId++, file, status: "queued" as FileStatus }))]);
  };

  // One file at a time. Before each upload the file is checked against the
  // library (same name and exact size) and against this batch (same content),
  // so the same agreement is never indexed twice.
  const runBatch = async (items: QueuedFile[]) => {
    if (!documentTypeId || items.length === 0) return;
    setUploading(true);
    let libraryKeys = new Set<string>();
    try {
      libraryKeys = await fetchLibraryFileKeys();
    } catch (err) {
      console.warn("Could not read the library to check for duplicates:", err);
    }
    const seen = new Map<string, string>();
    for (const q of queue) if (q.status === "done" && q.hash) seen.set(q.hash, q.file.name);

    let added = 0;
    let skipped = 0;
    const failed: string[] = [];
    for (const item of items) {
      if (leftPage.current) break;
      patch(item.id, { status: "checking", error: undefined });
      let hash: string | undefined;
      try {
        hash = await hashFile(item.file);
      } catch {
        hash = undefined;
      }
      const sameInBatch = hash ? seen.get(hash) : undefined;
      if (sameInBatch || libraryKeys.has(libraryFileKey(item.file.name, item.file.size))) {
        patch(item.id, {
          status: "duplicate",
          hash,
          error: sameInBatch ? `Same file as "${sameInBatch}" in this upload` : "A file with this name and size is already in the library",
        });
        skipped++;
        continue;
      }
      patch(item.id, { status: "uploading", hash });
      try {
        await uploadDoc.mutateAsync({ file: item.file, documentTypeId });
        if (hash) seen.set(hash, item.file.name);
        libraryKeys.add(libraryFileKey(item.file.name, item.file.size));
        patch(item.id, { status: "done" });
        added++;
      } catch (err) {
        const message = errorMessage(err) || "Upload failed";
        patch(item.id, { status: "error", error: message });
        failed.push(`${item.file.name}: ${message}`);
      }
    }
    if (leftPage.current) return;
    setUploading(false);
    // Report the real outcome, each failure with its reason.
    const summary = [`${added} added`, skipped ? `${skipped} already in the library` : null, failed.length ? `${failed.length} failed` : null]
      .filter(Boolean)
      .join(", ");
    if (failed.length === 0) {
      toast({ title: summary });
    } else {
      toast({ title: summary, description: failed.join("\n"), variant: "destructive" });
    }
  };

  const queuedItems = queue.filter((q) => q.status === "queued");
  const failedItems = queue.filter((q) => q.status === "error");
  const finishedCount = queue.filter((q) => q.status === "done" || q.status === "duplicate").length;

  const handleUploadAll = () => runBatch(queuedItems);
  const handleRetryFailed = () => {
    const retry = failedItems.map((q) => ({ ...q, status: "queued" as FileStatus, error: undefined }));
    setQueue((prev) => prev.map((q) => (q.status === "error" ? { ...q, status: "queued", error: undefined } : q)));
    void runBatch(retry);
  };
  const handleClearFinished = () => setQueue((prev) => prev.filter((q) => q.status !== "done" && q.status !== "duplicate"));
  const handleRemoveQueued = (id: number) => setQueue((prev) => prev.filter((q) => q.id !== id));

  const handleDelete = async (storagePath: string, filename: string) => {
    if (!window.confirm(`Remove "${filename}" from the precedent library?`)) return;
    try {
      await deleteSource.mutateAsync(storagePath);
      toast({ title: "Removed from precedent library" });
    } catch (err) {
      toast({ title: "Failed to remove", description: errorMessage(err), variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <BookMarked className="h-5 w-5 text-primary" />
          Firm Library
        </h1>
        <p className="text-muted-foreground">
          The firm's own agreements and the laws they rely on — what the AI draws on when it drafts,
          reviews and answers.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setParams(v === "precedents" ? {} : { tab: v }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="precedents">Agreements</TabsTrigger>
          <TabsTrigger value="search">
            <Search className="h-3.5 w-3.5 mr-1.5" />
            Find a clause
          </TabsTrigger>
          <TabsTrigger value="law-library">
            <Gavel className="h-3.5 w-3.5 mr-1.5" />
            Laws
          </TabsTrigger>
          <TabsTrigger value="standardize">
            <FileCheck className="h-3.5 w-3.5 mr-1.5" />
            Standards
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
                  accept=".pdf,.docx,.xlsx,.xls,.pptx"
                  className="hidden"
                  onChange={handleFilesSelected}
                />
                <Button variant="outline" onClick={() => fileInputRef.current?.click()} disabled={!documentTypeId}>
                  <Upload className="h-4 w-4 mr-2" />
                  Add Files
                </Button>
                <Button
                  onClick={handleUploadAll}
                  disabled={!documentTypeId || queuedItems.length === 0 || uploading}
                >
                  {uploading ? "Uploading…" : `Upload${queuedItems.length > 0 ? ` (${queuedItems.length})` : ""}`}
                </Button>
              </div>
              {!documentTypeId && (
                <p className="text-xs text-muted-foreground">
                  Pick a document type first — every file in a batch is tagged with the same type. Run the
                  upload again for a different type.
                </p>
              )}

              {uploading && (
                <p className="text-xs text-muted-foreground" data-testid="upload-stay-on-page">
                  Stay on this page until the upload finishes — files still waiting are only added while it is open.
                </p>
              )}

              {queue.length > 0 && (
                <div className="space-y-2">
                  <div className="space-y-1 max-h-64 overflow-y-auto">
                    {queue.map((q) => (
                      <div key={q.id} className="flex items-start gap-3 text-sm border-b py-1.5 last:border-0">
                        <FileText className="h-4 w-4 mt-0.5 text-muted-foreground shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate">{q.file.name}</p>
                          {q.error && (
                            <p className={cn("text-xs", q.status === "error" ? "text-destructive" : "text-muted-foreground")}>
                              {q.error}
                            </p>
                          )}
                        </div>
                        <Badge
                          className="shrink-0"
                          variant={
                            q.status === "done" ? "default" : q.status === "error" ? "destructive" : q.status === "duplicate" ? "outline" : "secondary"
                          }
                        >
                          {STATUS_LABEL[q.status]}
                        </Badge>
                        {q.status === "queued" && !uploading && (
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-6 w-6 shrink-0"
                            aria-label={`Remove ${q.file.name} from the upload`}
                            title="Remove from the upload"
                            onClick={() => handleRemoveQueued(q.id)}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                  {(failedItems.length > 0 || finishedCount > 0) && !uploading && (
                    <div className="flex flex-wrap gap-2">
                      {failedItems.length > 0 && (
                        <Button size="sm" variant="outline" onClick={handleRetryFailed} disabled={!documentTypeId} data-testid="retry-failed-uploads">
                          <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                          Retry failed ({failedItems.length})
                        </Button>
                      )}
                      {finishedCount > 0 && (
                        <Button size="sm" variant="ghost" onClick={handleClearFinished} data-testid="clear-finished-uploads">
                          Clear finished ({finishedCount})
                        </Button>
                      )}
                    </div>
                  )}
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

                  <div className="hidden sm:block">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>File</TableHead>
                          <TableHead>Indexed passages</TableHead>
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

                  <div className="sm:hidden space-y-2">
                    {items!.map((s) => (
                      <div key={s.storage_path} className="flex items-center justify-between gap-2 border rounded-md px-3 py-2">
                        <div className="min-w-0">
                          <p className="text-sm truncate">{s.filename}</p>
                          <p className="text-xs text-muted-foreground">
                            {s.chunk_count} chunks · {new Date(s.created_at).toLocaleDateString()}
                          </p>
                        </div>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="shrink-0"
                          onClick={() => handleDelete(s.storage_path, s.filename)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </TabsContent>

        <TabsContent value="search" className="mt-6">
          <PrecedentSearchTab />
        </TabsContent>

        <TabsContent value="law-library" className="mt-6">
          <LawLibraryTab />
        </TabsContent>

        <TabsContent value="standardize" className="mt-6">
          <StandardizeTab confirmLeave={confirmLeave} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
