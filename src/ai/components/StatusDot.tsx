import { Loader2 } from "lucide-react";
import { type ChatStatus, chatStatusLabel } from "@/lib/chatStatus";

// Beside a chat's title in Recents: spinning navy while a reply is being
// written, gold when the chat is waiting on the lawyer, red when its last
// reply failed. Nothing when there is nothing to say.
export default function StatusDot({ status }: { status: ChatStatus }) {
  if (!status) return null;
  const label = chatStatusLabel(status) ?? undefined;
  if (status === "running") {
    return <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" aria-label={label} data-testid="status-running" />;
  }
  return (
    <span
      className={status === "needs_you" ? "h-2 w-2 shrink-0 rounded-full bg-[hsl(var(--gold))]" : "h-2 w-2 shrink-0 rounded-full bg-destructive"}
      role="img"
      aria-label={label}
      title={label}
      data-testid={status === "needs_you" ? "status-needs-you" : "status-failed"}
    />
  );
}
