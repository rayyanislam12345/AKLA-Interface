import { useEffect, useRef, useState } from "react";
import { Download, FileQuestion, Loader2, MessageSquare, ScanSearch } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { extensionFor } from "./zipDownload";

// Look at a project document without downloading it: Word files are drawn
// in the page, PDFs and images shown as they are, anything else offered as a
// download. Opens from the right; fills the screen on a phone.

export interface PreviewVersion {
  id: string;
  version_number: number;
  storage_path: string;
  file_name: string | null;
  label: string | null;
  created_at: string;
}

export interface PreviewTarget {
  /** Different every time a preview is opened. */
  openId: string;
  document: { id: string; title: string };
  versions: PreviewVersion[];
  versionId: string;
}

type Kind = "docx" | "pdf" | "image" | "none";

const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"];

function kindOf(v: PreviewVersion): Kind {
  const ext = extensionFor(v);
  if (ext === "docx") return "docx";
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTENSIONS.includes(ext)) return "image";
  return "none";
}

function versionOptionLabel(v: PreviewVersion) {
  return `v${v.version_number}${v.label ? ` · ${v.label}` : ""}`;
}

export function DocumentPreviewSheet({
  target,
  onClose,
  onDownload,
  onOpenInAi,
  onReview,
}: {
  target: PreviewTarget | null;
  onClose: () => void;
  onDownload: (version: PreviewVersion) => void;
  onOpenInAi: (documentId: string, versionId: string) => void;
  onReview: (documentId: string, versionId: string) => void;
}) {
  // The version picked inside this preview; a new target starts on its own.
  const [picked, setPicked] = useState<{ openId: string; id: string } | null>(null);
  const [state, setState] = useState<{ loading: boolean; error: string | null; url: string | null }>({ loading: false, error: null, url: null });
  const docxRef = useRef<HTMLDivElement>(null);

  const versions = [...(target?.versions ?? [])].sort((a, b) => b.version_number - a.version_number);
  const versionId = picked && picked.openId === target?.openId ? picked.id : target?.versionId;
  const version = versions.find((v) => v.id === versionId) ?? versions[0] ?? null;
  const latest = versions[0] ?? null;
  const kind = version ? kindOf(version) : "none";

  useEffect(() => {
    if (!version) return;
    let cancelled = false;
    const container = docxRef.current;
    if (container) container.innerHTML = "";
    setState({ loading: kind !== "none", error: null, url: null });
    (async () => {
      try {
        if (kind === "docx") {
          const { data, error } = await supabase.storage.from("matter-documents").download(version.storage_path);
          if (error || !data) throw error ?? new Error("The file couldn't be fetched.");
          const { renderAsync } = await import("docx-preview");
          if (cancelled || !docxRef.current) return;
          await renderAsync(data, docxRef.current, docxRef.current, {
            inWrapper: true,
            ignoreWidth: window.innerWidth < 640,
            renderChanges: true,
            renderComments: false,
          });
          if (!cancelled) setState({ loading: false, error: null, url: null });
        } else if (kind === "pdf" || kind === "image") {
          const { data, error } = await supabase.storage.from("matter-documents").createSignedUrl(version.storage_path, 60 * 60);
          if (error || !data?.signedUrl) throw error ?? new Error("The file couldn't be fetched.");
          if (!cancelled) setState({ loading: false, error: null, url: data.signedUrl });
        }
      } catch {
        if (!cancelled) setState({ loading: false, error: "This file couldn't be shown here. You can still download it.", url: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [version?.id, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Sheet open={!!target} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full max-w-none sm:max-w-none md:w-[min(60rem,90vw)] p-0 gap-0 flex flex-col">
        {target && version && (
          <>
            <div className="border-b p-4 pr-12 space-y-3">
              <SheetHeader className="space-y-1 text-left">
                <SheetTitle className="text-base break-words">{target.document.title}</SheetTitle>
                <SheetDescription className="text-xs truncate" title={version.file_name ?? undefined}>
                  {version.file_name ?? `Version ${version.version_number}`} · added {new Date(version.created_at).toLocaleDateString()}
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={version.id} onValueChange={(id) => setPicked({ openId: target.openId, id })}>
                  <SelectTrigger className="h-8 w-full sm:w-auto sm:min-w-[12rem] sm:max-w-[20rem] text-xs" aria-label="Version">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {versions.map((v) => (
                      <SelectItem key={v.id} value={v.id} className="text-xs">
                        {versionOptionLabel(v)}{v.id === latest?.id ? " (latest)" : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" variant="outline" onClick={() => onDownload(version)}>
                  <Download className="h-4 w-4 mr-1.5" />Download
                </Button>
                <Button size="sm" variant="outline" onClick={() => onOpenInAi(target.document.id, version.id)}>
                  <MessageSquare className="h-4 w-4 mr-1.5" />Open in AI
                </Button>
                <Button size="sm" variant="outline" onClick={() => onReview(target.document.id, version.id)}>
                  <ScanSearch className="h-4 w-4 mr-1.5" />Review
                </Button>
              </div>
              {latest && version.id !== latest.id && (
                <p className="text-xs text-muted-foreground">
                  Open in AI and Review will use this older version (v{version.version_number}), not the latest (v{latest.version_number}).
                </p>
              )}
            </div>

            <div className="relative flex-1 min-h-0 overflow-auto bg-muted/40">
              {state.loading && (
                <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />Opening…
                </div>
              )}
              {state.error && (
                <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
                  <p className="text-sm text-muted-foreground">{state.error}</p>
                  <Button size="sm" onClick={() => onDownload(version)}><Download className="h-4 w-4 mr-1.5" />Download</Button>
                </div>
              )}
              {kind === "docx" && <div ref={docxRef} className="min-h-full [&_.docx-wrapper]:bg-transparent [&_.docx-wrapper]:p-2 sm:[&_.docx-wrapper]:p-6" />}
              {kind === "pdf" && state.url && (
                <iframe src={state.url} title={target.document.title} className="h-full w-full border-0 bg-background" />
              )}
              {kind === "image" && state.url && (
                <div className="flex justify-center p-4">
                  <img src={state.url} alt={target.document.title} className="max-w-full h-auto shadow" />
                </div>
              )}
              {kind === "none" && (
                <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
                  <FileQuestion className="h-8 w-8 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">No preview for this file type.</p>
                  <Button size="sm" onClick={() => onDownload(version)}><Download className="h-4 w-4 mr-1.5" />Download</Button>
                </div>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
