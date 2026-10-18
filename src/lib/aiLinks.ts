// Where links into the AI go. Today the AI lives on the site's own pages
// (/assistant and /matters/:id/ai); the new workspace lives at /ai. Every
// deep link is built here, so the cut-over is one flag: VITE_AI_APP=true
// sends every link to the new workspace, and unsetting it is the rollback.
//
// Pure: no React, no window. Tested in tests/aiLinks.test.js.

export type AiMode = "draft" | "review" | "verify" | "summarise" | "agreement" | "edit";

export interface AiProjectLinkOptions {
  mode?: AiMode;
  /** A matter document to attach (Review, Revise). */
  doc?: string;
  /** A particular version of that document; the latest otherwise. */
  version?: string;
  /** A law update: a Revise link. */
  update?: string;
  /** Open this chat. */
  chat?: string;
}

function query(params: Record<string, string | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Whether links go to the new workspace. Read once per call so tests can flip it. */
export function aiAppEnabled(env: Record<string, unknown> | undefined = readEnv()): boolean {
  const v = env?.VITE_AI_APP;
  return v === true || v === "true" || v === "1";
}

function readEnv(): Record<string, unknown> | undefined {
  try {
    return (import.meta as unknown as { env?: Record<string, unknown> }).env;
  } catch {
    return undefined;
  }
}

export function makeAiLinks(enabled: boolean) {
  return {
    /** The front door: the AI with no project chosen. */
    home(options: { mode?: AiMode; skill?: string } = {}): string {
      return enabled ? `/ai${query({ mode: options.mode, skill: options.skill })}` : `/assistant${query({ mode: options.mode })}`;
    },
    /** One conversation. */
    chat(threadId: string, options: { matterId?: string } = {}): string {
      if (enabled) return `/ai/c/${threadId}`;
      return options.matterId ? `/matters/${options.matterId}/ai?chat=${threadId}` : `/assistant?chat=${threadId}`;
    },
    /** A project's AI page: its chats, files and instructions. */
    project(matterId: string, options: AiProjectLinkOptions = {}): string {
      const q = query({ chat: options.chat, mode: options.mode, doc: options.doc, version: options.version, update: options.update });
      return enabled ? `/ai/p/${matterId}${q}` : `/matters/${matterId}/ai${q}`;
    },
    /** A stored document version, full page. Only the new workspace has one; the site opens the project. */
    document(versionId: string, options: { matterId?: string } = {}): string {
      if (enabled) return `/ai/d/${versionId}`;
      return options.matterId ? `/matters/${options.matterId}` : "/matters";
    },
  };
}

export const aiLink = makeAiLinks(aiAppEnabled());

/** Decodes the `?open=` parameter of the new workspace: a:<artifactId> or v:<versionId>. */
export function parseOpenParam(value: string | null | undefined): { kind: "artifact"; id: string } | { kind: "version"; id: string } | null {
  if (!value) return null;
  const m = /^([av]):([0-9a-f-]{36})$/i.exec(value);
  if (!m) return null;
  return m[1].toLowerCase() === "a" ? { kind: "artifact", id: m[2] } : { kind: "version", id: m[2] };
}

export function openParam(panel: { kind: "artifact" | "version"; id: string } | null): string | undefined {
  if (!panel) return undefined;
  return `${panel.kind === "artifact" ? "a" : "v"}:${panel.id}`;
}
