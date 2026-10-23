// "Open in Claude": a new claude.ai chat with the request already typed.
// claude.ai fills its message box from ?q= (widely used, not documented by
// Anthropic), so the same words also go to the clipboard: if the box comes
// up empty, the lawyer pastes. Nothing is sent until they press Enter.

export const CLAUDE_NEW_CHAT = "https://claude.ai/new";

/** The address of a new claude.ai chat with `prompt` in its message box. */
export function claudeNewChatUrl(prompt: string): string {
  return `${CLAUDE_NEW_CHAT}?q=${encodeURIComponent(prompt)}`;
}

/**
 * Opens a new claude.ai chat in another tab with `prompt` typed in, and
 * copies `prompt`. Resolves to whether the copy worked.
 */
export async function openInClaude(prompt: string): Promise<boolean> {
  // Opened before the clipboard write: a browser allows a new tab only in
  // the click itself, and awaiting the clipboard first loses that.
  window.open(claudeNewChatUrl(prompt), "_blank", "noopener");
  try {
    await navigator.clipboard.writeText(prompt);
    return true;
  } catch {
    return false;
  }
}

/** A request about one project, naming it as the connector's tools find it. */
export function projectPrompt(projectName: string, ask: string): string {
  return `In the AKLA Hub project "${projectName}": ${ask}`;
}

/** A request about one document of a project. */
export function documentPrompt(projectName: string, documentTitle: string, ask: string): string {
  return `In the AKLA Hub project "${projectName}", the document "${documentTitle}" (latest version): ${ask}`;
}
