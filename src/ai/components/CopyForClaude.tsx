import { useState } from "react";
import { Check, ClipboardCopy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { versionForClaudeText, type VersionForClaude } from "@/lib/copyForClaude";
import { copyText } from "@/lib/copyText";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// In the companion's drawer, and on the pane page beside a Claude chat, the
// lawyer is already in a claude.ai chat, so a document offers no Hub chat of
// its own ("Ask about this", "Edit with AI"). This button copies what Claude
// needs to work on the exact version through the connector instead: its
// name, its version id and its Hub address. The lawyer pastes it into the
// chat.

export interface CopyForClaudeProps extends VersionForClaude {
  /** An icon alone, for a row in a narrow list. */
  compact?: boolean;
}

export default function CopyForClaude({ compact, ...source }: CopyForClaudeProps) {
  return (
    <CopyTextForClaude
      text={() => versionForClaudeText(source, window.location.origin)}
      compact={compact}
      label={compact ? `Copy "${source.title}" for Claude` : undefined}
      title="Copies this version's name, id and Hub link, to paste into the claude.ai chat"
    />
  );
}

interface CopyTextForClaudeProps {
  /** What goes on the clipboard, worked out when pressed. */
  text: () => string;
  title: string;
  /** The accessible name; the button's words otherwise. */
  label?: string;
  compact?: boolean;
  className?: string;
  disabled?: boolean;
  /** The words only from 480px wide, the icon alone below (the bar of a narrow drawer, where the page's name needs the room). */
  iconWhenNarrow?: boolean;
}

/** Copies any text for the claude.ai chat: the full button, or an icon alone (compact). */
export function CopyTextForClaude({ text, title, label, compact, className, disabled, iconWhenNarrow }: CopyTextForClaudeProps) {
  const { toast } = useToast();
  const [done, setDone] = useState(false);
  const onClick = async () => {
    const value = text();
    if (await copyText(value)) {
      setDone(true);
      setTimeout(() => setDone(false), 2500);
      toast({ title: "Copied for Claude", description: "Paste it into the chat and ask what you need." });
    } else {
      toast({ title: "Copy it by hand", description: value });
    }
  };
  const Icon = done ? Check : ClipboardCopy;
  if (compact) {
    return (
      <Button
        size="icon"
        variant="ghost"
        className={cn("h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground", className)}
        onClick={() => void onClick()}
        disabled={disabled}
        data-testid="copy-for-claude"
        title={title}
        aria-label={done ? "Copied" : label ?? "Copy for Claude"}
      >
        <Icon className="h-3.5 w-3.5" />
      </Button>
    );
  }
  return (
    <Button size="sm" className={className} onClick={() => void onClick()} disabled={disabled} data-testid="copy-for-claude" title={title} aria-label={label ?? (iconWhenNarrow ? "Copy for Claude" : undefined)}>
      <Icon className={cn("h-4 w-4", iconWhenNarrow ? "min-[480px]:mr-1.5" : "mr-1.5")} />
      <span className={cn(iconWhenNarrow && "hidden min-[480px]:inline")}>{done ? "Copied" : "Copy for Claude"}</span>
    </Button>
  );
}
