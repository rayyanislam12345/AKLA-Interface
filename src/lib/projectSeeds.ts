// What the address of the AI workspace's project page asks for. The site's
// links were built for /matters/:id/ai (?mode=, ?doc=, ?version=, ?update=,
// ?chat=); the project page honours the same ones, plus the workspace's own
// ?open=v:<versionId> (the document window) and ?attach=v:<versionId> (a
// stored version put in the prompt box, from "Ask about this").
// Pure, so tests/projectSeeds.test.js runs it in Node.

export interface ProjectSeeds {
  /** Open this chat instead of the project page. */
  chat: string | null;
  /** A skill to start with: draft, review, verify, summarise, agreement, edit. */
  mode: string | null;
  /** Open the "which version to edit" dialog. */
  edit: boolean;
  /** A project document to attach, and which of its versions (the latest otherwise). */
  doc: string | null;
  version: string | null;
  /** A law update: a Revise link. */
  update: string | null;
  /** A stored version to attach to the prompt. */
  attach: string | null;
  /** Whether anything in the address seeds the prompt box. */
  seeded: boolean;
}

const VERSION_PARAM = /^v:([0-9a-f-]{36})$/i;

export function readProjectSeeds(params: { get(name: string): string | null }): ProjectSeeds {
  const mode = params.get("mode");
  const doc = params.get("doc");
  const version = params.get("version");
  const update = params.get("update");
  const attachRaw = params.get("attach");
  const attach = attachRaw && VERSION_PARAM.test(attachRaw) ? VERSION_PARAM.exec(attachRaw)![1] : null;
  return {
    chat: params.get("chat"),
    mode,
    edit: mode === "edit",
    doc,
    version,
    update,
    attach,
    seeded: !!(mode || doc || update || attach),
  };
}

/** The `?attach=` value for a stored version. */
export function attachParam(versionId: string): string {
  return `v:${versionId}`;
}
