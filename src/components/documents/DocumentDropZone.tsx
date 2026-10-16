import { useRef, useState, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";

// Lets files, folders and .zip files be dropped anywhere over what it wraps.
// Only reacts to files being dragged, not to text or links.
export function DocumentDropZone({
  onDrop,
  disabled,
  className,
  children,
}: {
  onDrop: (dataTransfer: DataTransfer) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const carriesFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types ?? []).includes("Files");

  return (
    <div
      className={cn("relative", className)}
      onDragEnter={(e) => {
        if (disabled || !carriesFiles(e)) return;
        e.preventDefault();
        depth.current++;
        setOver(true);
      }}
      onDragOver={(e) => {
        if (disabled || !carriesFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (disabled || !carriesFiles(e)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(e) => {
        if (disabled || !carriesFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        onDrop(e.dataTransfer);
      }}
    >
      {children}
      {over && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-background/85">
          <div className="text-center px-4">
            <Upload className="mx-auto h-6 w-6 text-primary" />
            <p className="mt-2 text-sm font-medium">Drop to add to this project</p>
            <p className="text-xs text-muted-foreground">Files, folders and .zip files. You'll see the list before anything is uploaded.</p>
          </div>
        </div>
      )}
    </div>
  );
}
