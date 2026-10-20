import { useState } from "react";
import { Check, ClipboardCopy } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";

// In the companion's drawer the lawyer is already in a claude.ai chat, so a
// document offers no Hub chat of its own ("Ask about this", "Edit with AI").
// This button copies what Claude needs to work on the exact version through
// the connector instead: its name, its version id and its Hub address. The
// lawyer pastes it into the chat.

export interface CopyForClaudeProps {
  title: string;
  versionId: string;
  versionNumber: number;
  fileName?: string | null;
  projectName?: string | null;
}

function copyForClaudeText({ title, versionId, versionNumber, fileName, projectName }: CopyForClaudeProps): string {
  const what = [`v${versionNumber}`, fileName ? `(${fileName})` : null, projectName ? `in project ${projectName}` : null].filter(Boolean).join(" ");
  return [`Hub document: ${title}, ${what}`, `versionId: ${versionId}`, `Open in Hub: ${window.location.origin}/ai/d/${versionId}`].join("\n");
}

// The drawer's frame sits two frames deep under claude.ai, where the
// Clipboard API can be refused; the older copy command still works there.
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

export default function CopyForClaude(props: CopyForClaudeProps) {
  const { toast } = useToast();
  const [done, setDone] = useState(false);
  const onClick = async () => {
    const text = copyForClaudeText(props);
    if (await copyText(text)) {
      setDone(true);
      setTimeout(() => setDone(false), 2500);
      toast({ title: "Copied for Claude", description: "Paste it into the chat and ask what you need." });
    } else {
      toast({ title: "Copy it by hand", description: text });
    }
  };
  return (
    <Button size="sm" onClick={() => void onClick()} data-testid="copy-for-claude" title="Copies this version's name, id and Hub link, to paste into the claude.ai chat">
      {done ? <Check className="mr-1.5 h-4 w-4" /> : <ClipboardCopy className="mr-1.5 h-4 w-4" />}
      {done ? "Copied" : "Copy for Claude"}
    </Button>
  );
}
