import { useRef, useState } from "react";
import type { NameLabelRegion } from "@/lib/speakerVision";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

interface NameLabelCalibratorProps {
  frameDataUrl: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (region: NameLabelRegion) => void;
}

interface DragBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function toRegion(box: DragBox): NameLabelRegion {
  return {
    x: Math.min(box.x1, box.x2),
    y: Math.min(box.y1, box.y2),
    width: Math.abs(box.x2 - box.x1),
    height: Math.abs(box.y2 - box.y1),
  };
}

// Where Zoom puts the active speaker's name is a moving target — it differs
// by Zoom version, theme, window size, and whether the whole screen or just
// the Zoom window was shared. Rather than guess coordinates that would break
// on the next Zoom update, the region is established once by dragging over
// it. Stored as fractions, so resizing the window doesn't invalidate it.
export default function NameLabelCalibrator({ frameDataUrl, open, onOpenChange, onConfirm }: NameLabelCalibratorProps) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [box, setBox] = useState<DragBox | null>(null);
  const [dragging, setDragging] = useState(false);

  const pointFromEvent = (e: React.MouseEvent) => {
    const rect = imageRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return {
      x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    const p = pointFromEvent(e);
    if (!p) return;
    setDragging(true);
    setBox({ x1: p.x, y1: p.y, x2: p.x, y2: p.y });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!dragging) return;
    const p = pointFromEvent(e);
    if (!p) return;
    setBox((prev) => (prev ? { ...prev, x2: p.x, y2: p.y } : prev));
  };

  const region = box ? toRegion(box) : null;
  // Sub-1% drags are almost always a stray click rather than a real selection.
  const regionUsable = region !== null && region.width > 0.01 && region.height > 0.01;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Mark the speaker's name label</DialogTitle>
          <DialogDescription>
            Put Zoom in <strong>Speaker View</strong>, then drag a box around the name shown on the main tile — just the
            name, as tightly as you can. This is remembered, so it's a one-time step per setup.
          </DialogDescription>
        </DialogHeader>

        {frameDataUrl ? (
          <div
            className="relative select-none border rounded-md overflow-hidden cursor-crosshair"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={() => setDragging(false)}
            onMouseLeave={() => setDragging(false)}
          >
            <img ref={imageRef} src={frameDataUrl} alt="Captured screen" className="w-full block" draggable={false} />
            {region && (
              <div
                className="absolute border-2 border-primary bg-primary/20 pointer-events-none"
                style={{
                  left: `${region.x * 100}%`,
                  top: `${region.y * 100}%`,
                  width: `${region.width * 100}%`,
                  height: `${region.height * 100}%`,
                }}
              />
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No screen frame available. Start the meeting with “Microphone + meeting audio” selected, share the Zoom
            window, then calibrate.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => setBox(null)} disabled={!box}>
            Clear
          </Button>
          <Button onClick={() => region && onConfirm(region)} disabled={!regionUsable}>
            Use this region
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
