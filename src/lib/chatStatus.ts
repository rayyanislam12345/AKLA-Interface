// What a chat row in the new workspace's sidebar shows beside its title,
// worked out in the browser (the server does not yet record a turn's
// status). Pure, so tests/chatStatus.test.js runs it in Node.

export type ChatStatus = "running" | "needs_you" | "failed" | null;

export interface ChatStatusInput {
  /** The chat's questionnaire column: guided drafting waiting on an answer. */
  questionnaire?: unknown;
  /** A reply is being written in this browser right now. */
  busy: boolean;
  /** The last turn in this browser ended in an error that is still showing. */
  failed: boolean;
}

export function chatStatus(input: ChatStatusInput): ChatStatus {
  if (input.busy) return "running";
  if (input.failed) return "failed";
  const q = input.questionnaire as { pending?: unknown } | null | undefined;
  if (q && typeof q === "object" && q.pending) return "needs_you";
  return null;
}

export function chatStatusLabel(status: ChatStatus): string | null {
  switch (status) {
    case "running":
      return "Writing a reply";
    case "needs_you":
      return "Waiting for your answer";
    case "failed":
      return "The last reply failed";
    default:
      return null;
  }
}

/** "14:05", "Yesterday", "Tue", "3 Mar": the same short form the site's chat list uses. */
export function relativeDay(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const d = new Date(iso);
  const days = Math.floor((now - d.getTime()) / 86_400_000);
  if (days <= 0) return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString("en-GB", { weekday: "short" });
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** The greeting at the top of Home. */
export function greeting(name: string | null | undefined, hour = new Date().getHours()): string {
  const part = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? `${part}, ${first}` : part;
}
