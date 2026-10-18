import { useState } from "react";
import { MessageSquare, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DocumentViewer } from "./DocumentViewer";
import { sortVersions, type PreviewVersion } from "./previewVersions";

// The project page's preview: the document viewer in a sheet that opens
// from the right and fills the screen on a phone. The viewer itself (the
// drawn Word file, Checks, What changed, the version picker) is
// DocumentViewer, shared with the AI workspace's document window.

export type { PreviewVersion } from "./previewVersions";

export interface PreviewTarget {
  /** Different every time a preview is opened. */
  openId: string;
  document: { id: string; title: string };
  versions: PreviewVersion[];
  versionId: string;
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

  const versions = sortVersions(target?.versions);
  const versionId = picked && picked.openId === target?.openId ? picked.id : target?.versionId;
  const version = versions.find((v) => v.id === versionId) ?? versions[0] ?? null;
  const latest = versions[0] ?? null;

  return (
    <Sheet open={!!target} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full max-w-none sm:max-w-none md:w-[min(60rem,90vw)] p-0 gap-0 flex flex-col">
        {target && version && (
          <DocumentViewer
            // A new preview opens on the Document tab.
            key={target.openId}
            document={target.document}
            versions={versions}
            versionId={version.id}
            onVersionChange={(id) => setPicked({ openId: target.openId, id })}
            onDownload={onDownload}
            headerClassName="p-4 pr-12"
            heading={
              <SheetHeader className="space-y-1 text-left">
                <SheetTitle className="text-base break-words">{target.document.title}</SheetTitle>
                <SheetDescription className="text-xs truncate" title={version.file_name ?? undefined}>
                  {version.file_name ?? `Version ${version.version_number}`} · added {new Date(version.created_at).toLocaleDateString()}
                </SheetDescription>
              </SheetHeader>
            }
            actions={
              <>
                <Button size="sm" variant="outline" onClick={() => onOpenInAi(target.document.id, version.id)}>
                  <MessageSquare className="h-4 w-4 mr-1.5" />Open in AI
                </Button>
                <Button size="sm" variant="outline" onClick={() => onReview(target.document.id, version.id)}>
                  <ScanSearch className="h-4 w-4 mr-1.5" />Review
                </Button>
              </>
            }
            note={
              latest && version.id !== latest.id ? (
                <p className="text-xs text-muted-foreground">
                  Open in AI and Review will use this older version (v{version.version_number}), not the latest (v{latest.version_number}).
                </p>
              ) : null
            }
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
