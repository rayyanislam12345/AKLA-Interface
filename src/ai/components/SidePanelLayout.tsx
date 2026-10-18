import type { ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSplitLayout } from "@/ai/useMediaQuery";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";

// A page with the document window beside it: from 1024px up the two split
// the screen (and can be dragged); between 768 and 1023px the window lies
// over the page; on a phone it fills the screen with a bar to come back.
export default function SidePanelLayout({
  panel,
  onClose,
  backLabel = "Back",
  children,
  testId,
}: {
  /** The window's content; nothing closes it. */
  panel: ReactNode | null;
  onClose: () => void;
  backLabel?: string;
  children: ReactNode;
  testId?: string;
}) {
  const isMobile = useIsMobile();
  const split = useSplitLayout();
  const open = !!panel;

  if (split) {
    return (
      <div className="relative flex min-h-0 flex-1" data-testid={testId}>
        <ResizablePanelGroup direction="horizontal" className="min-w-0 flex-1">
          <ResizablePanel id="page" order={1} defaultSize={open ? 48 : 100} minSize={30}>
            <div className="flex h-full min-w-0 flex-col">{children}</div>
          </ResizablePanel>
          {open && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel id="window" order={2} defaultSize={52} minSize={30}>
                <div className="h-full animate-in fade-in slide-in-from-right-8 duration-200">{panel}</div>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 flex-1" data-testid={testId}>
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      {!isMobile && open && (
        <div className="absolute inset-y-0 right-0 z-20 w-[min(100%,40rem)] border-l bg-background shadow-xl animate-in fade-in slide-in-from-right-8 duration-200" data-testid="panel-overlay">
          {panel}
        </div>
      )}
      {isMobile && (
        <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
          <SheetContent side="right" className="w-full max-w-none p-0 sm:max-w-none [&>button]:hidden">
            <SheetTitle className="sr-only">Document</SheetTitle>
            <div className="flex h-full flex-col">
              <div className="flex h-12 shrink-0 items-center border-b px-1">
                <Button variant="ghost" size="sm" onClick={onClose} aria-label={backLabel}>
                  <ArrowLeft className="mr-1 h-4 w-4" /> {backLabel}
                </Button>
              </div>
              <div className="min-h-0 flex-1">{panel}</div>
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
