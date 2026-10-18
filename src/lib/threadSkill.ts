// Which skill a chat is in, worked out from what is stored on it. Only
// erasable TypeScript and type-only imports, so tests/threadSkill.test.js can
// run it in Node as the browser runs it.
import type { ActiveSkill, MessageMetadata, SkillKey } from "../hooks/useChat";

export type StoredSkill = NonNullable<MessageMetadata["skill"]>;

export interface ThreadSkillContext {
  /** The chat's title: an Edit chat is titled "Edit: <document> (vN)". */
  threadTitle?: string | null;
  documentTypes?: Array<{ id: string; name: string }> | undefined;
  customSkills?: Array<{ id: string; name: string }> | undefined;
}

/**
 * The skill in force in a chat: the one its last message was sent with (or,
 * before any message, the one the chat was opened with: an Edit). It stays in
 * force on every later message until the chip is taken off, so the chip shows
 * it rather than disappearing after the first send.
 */
export function resolveThreadSkill(stored: StoredSkill | null | undefined, ctx: ThreadSkillContext): ActiveSkill | null {
  if (!stored) return null;
  const key: SkillKey = stored.key === "verify" ? "review" : stored.key;
  const base = {
    documentTypeId: stored.documentTypeId,
    customSkillId: stored.customSkillId,
    documentVersionId: stored.documentVersionId,
    matterDocumentId: stored.matterDocumentId,
  };
  switch (key) {
    case "edit":
      if (!stored.documentVersionId) return null;
      return { key, ...base, label: (ctx.threadTitle ?? "Edit").replace(/^Edit: /, "Edit · ") };
    case "draft": {
      const type = ctx.documentTypes?.find((t) => t.id === stored.documentTypeId)?.name;
      return { key, ...base, label: type ? `Draft · ${type}` : "Draft" };
    }
    case "custom": {
      const custom = ctx.customSkills?.find((c) => c.id === stored.customSkillId);
      // A firm skill deleted since: nothing is applied, so nothing is shown.
      return custom ? { key, ...base, label: custom.name } : null;
    }
    case "review":
      return { key, ...base, label: "Review" };
    case "summarise":
      return { key, ...base, label: "Summarise" };
    case "agreement":
      return { key, ...base, label: "Agreement" };
    default:
      return null;
  }
}

/** The skill a `?mode=` seed (a Draft or Review button, a Revise link) starts the composer with. */
export function seedSkillFor(mode: string | null | undefined, lawUpdateId?: string | null): ActiveSkill | undefined {
  if (mode === "draft") return { key: "draft", label: "Draft" };
  if (mode === "agreement") return { key: "agreement", label: "Agreement" };
  if (mode === "summarise") return { key: "summarise", label: "Summarise" };
  if (mode === "review" || mode === "verify" || lawUpdateId) return { key: "review", label: "Review" };
  return undefined;
}

/**
 * Whether sending without a chip must tell the server to clear the chat's
 * skill. Not while the firm skills are still loading: the chip for one is
 * only shown once they have, and its absence then means nothing.
 */
export function shouldClearSkill(input: {
  chipSkill: ActiveSkill | null;
  threadId: string | null;
  storedSkill: StoredSkill | null | undefined;
  threadHasSkill: boolean;
  customSkillsLoaded: boolean;
}): boolean {
  const skillsLoading = input.storedSkill?.key === "custom" && !input.customSkillsLoaded;
  return !input.chipSkill && !!input.threadId && !skillsLoading && (!!input.storedSkill || input.threadHasSkill);
}
