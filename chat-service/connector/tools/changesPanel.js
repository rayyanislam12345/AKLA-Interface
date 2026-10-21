// The changes panel's tools (the MCP Apps trial, connector/apps.js): only
// registered when CONNECTOR_APPS=on, so with the switch off the connector's
// tool list is exactly what it was.
//
// list_changes (read): a Word version's Changes list (versionChanges.js
// listVersionChanges, the Hub's POST /changes/list with { versionId }) as
// text, one block per change with its changeId, and as structuredContent
// for the panel (ui://akla/changes) Claude draws under the reply.
//
// decide_changes (write): accept or reject changes in the version's working
// file (versionChanges.js decideVersionChanges, the Hub's POST
// /changes/decide with { versionId }: the same lock, the same all-or-nothing
// rule per change, the decided file kept beside the version and the version
// itself never rewritten). The panel's Accept and Reject buttons call it
// through the host (tools/call), and Claude can call it when the lawyer says
// "accept change 2" in the chat. The write order of every write tool
// (README.md): checkCaps, the work, recordAction, release in a finally. A
// 409 (another decision moved the file on, no changes yet, not a Word file)
// is refused in one sentence, recorded as refused, and nothing is written.
//
// apply_tracked_changes (markup.js) attaches the same panel to its reply
// with panelForVersion below. Every reply keeps its full text, so a host
// that draws no app loses nothing. Node 20.

import { z } from "zod";
import { WRITE } from "../app.js";
import { CHANGES_UI } from "../apps.js";
import { uuid } from "../tools.js";
import { cardsFor, countsWith, findRevisions } from "../../changes.js";
import { listVersionChanges, decideVersionChanges, versionRows, latestVersionOf, isWordPath, NOT_WORD_SENTENCE } from "../../versionChanges.js";

export const LIST_TOOL = "list_changes";
export const DECIDE_TOOL = "decide_changes";
/** The Hub's own cap on one decision request (server.js MAX_DECISIONS). */
export const MAX_DECISIONS = 200;
/** One before or after text in the panel's data; the Hub has the whole of it. */
export const MAX_CARD_TEXT = 4_000;
/**
 * The panel's data stays well under the ~150,000 characters past which
 * Claude stores a tool result as a file instead of handing it to the app
 * (claude.com/docs/connectors/building/mcp-apps/troubleshooting).
 */
export const PANEL_BUDGET = 90_000;
/** The structuredContent's kind, which the page checks before drawing. */
export const PANEL_KIND = "akla.changes";
const MAX_TEXT_CHANGES = 80;
const MAX_TEXT_SNIPPET = 600;

const plural = (k, one, many = `${one}s`) => (k === 1 ? one : many);
const clip = (s, max) => { const t = String(s ?? ""); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Who decided each change, by name, in one lookup (versionChanges.js's own reader is private). */
async function namesOf(db, rows) {
  const ids = [...new Set(rows.map((r) => r.decided_by).filter(Boolean))];
  if (!ids.length) return new Map();
  const { data } = await db.from("profiles").select("id, full_name").in("id", ids);
  return new Map((data ?? []).map((p) => [p.id, p.full_name ?? null]));
}

/** A version's cards, numbered as the Hub numbers them. */
export async function versionCards(db, versionId) {
  const rows = await versionRows(db, versionId);
  return { rows, cards: cardsFor(rows, await namesOf(db, rows)) };
}

/** "3 waiting, 1 accepted, 0 rejected" and the rarer states when there are any. */
export function countsLine(counts) {
  const c = counts ?? {};
  const parts = [`${c.waiting ?? 0} waiting`, `${c.accepted ?? 0} accepted`, `${c.rejected ?? 0} rejected`];
  if (c.couldNotPlace) parts.push(`${c.couldNotPlace} could not be placed`);
  if (c.needsWord) parts.push(`${c.needsWord} to decide in Word`);
  if (c.replaced) parts.push(`${c.replaced} replaced or carried forward`);
  return parts.join(", ");
}

/**
 * The panel's data (the tool result's structuredContent): the version, the
 * counts and every card the budget holds, each text clipped for the page.
 * `canDecide` is whether this sign-in may save (the buttons are hidden
 * otherwise); `message` and `notDone` are a decision's outcome.
 */
export function panelData({ versionId, versionNumber, title, projectName, hubUrl, cards, counts, canDecide, message = null, notDone = [], newer = null }) {
  const out = [];
  let used = 0;
  for (const c of cards) {
    const card = {
      id: c.id,
      number: c.number,
      kind: c.kind,
      clause: c.where?.clause ?? null,
      paragraph: c.where?.paragraph ?? null,
      part: c.where?.part ?? "body",
      before: clip(c.before, MAX_CARD_TEXT),
      after: clip(c.after, MAX_CARD_TEXT),
      why: c.why ? clip(c.why, 600) : null,
      state: c.state,
      stateLabel: c.stateLabel,
      note: c.stateNote ?? null,
      decidedBy: c.decided?.by?.name ?? null,
      decidedAt: c.decided?.at ?? null,
      canDecide: c.canAccept === true && c.canReject === true,
    };
    const size = card.before.length + card.after.length + (card.why?.length ?? 0) + 200;
    if (out.length && used + size > PANEL_BUDGET) break;
    used += size;
    out.push(card);
  }
  return {
    kind: PANEL_KIND,
    versionId,
    versionNumber: versionNumber ?? null,
    title: title ?? null,
    projectName: projectName ?? null,
    hubUrl,
    counts: counts ?? null,
    changes: out,
    more: cards.length - out.length,
    canDecide: canDecide === true,
    message: message ?? null,
    notDone: (notDone ?? []).map((n) => ({ id: n.changeId, note: n.note ?? null })),
    newer: newer ? { versionId: newer.id, versionNumber: newer.version_number } : null,
  };
}

/** The cards as text, for a host that draws no app and for the model. */
export function changesText({ title, versionNumber, projectName, versionId, openLine, cards, counts, newer = null }) {
  const lines = [
    `Changes in "${title ?? "the document"}" v${versionNumber ?? "?"}${projectName ? ` on ${projectName}` : ""}: ${countsLine(counts)}.`,
    `versionId: ${versionId}`,
    openLine,
  ];
  if (newer) lines.push(`Note: a newer version exists (v${newer.version_number}, versionId ${newer.id}); changes still waiting here were carried forward to it, so decide them there.`);
  if (!cards.length) lines.push("", "No AKLA AI changes are recorded on this version.");
  for (const c of cards.slice(0, MAX_TEXT_CHANGES)) {
    const where = [c.where?.paragraph != null ? `¶${c.where.paragraph}` : null, c.where?.clause ? `clause ${c.where.clause}` : null, c.where?.part && c.where.part !== "body" ? c.where.part : null].filter(Boolean).join(", ");
    lines.push("", `Change ${c.number} (${c.kind})${where ? ` — ${where}` : ""} — ${c.stateLabel}${c.decided?.by?.name ? ` by ${c.decided.by.name}` : ""}`);
    if (c.before) lines.push(`  Before: ${clip(oneLine(c.before), MAX_TEXT_SNIPPET)}`);
    if (c.after) lines.push(`  After: ${clip(oneLine(c.after), MAX_TEXT_SNIPPET)}`);
    if (c.why) lines.push(`  Why: ${clip(oneLine(c.why), 300)}`);
    if (c.stateNote) lines.push(`  Note: ${c.stateNote}`);
    lines.push(`  changeId: ${c.id}`);
  }
  if (cards.length > MAX_TEXT_CHANGES) lines.push("", `… and ${cards.length - MAX_TEXT_CHANGES} more in the Hub's Changes list.`);
  if (cards.some((c) => c.canAccept)) lines.push("", `To decide: ${DECIDE_TOOL} with this versionId and decisions [{ id: changeId, decision: "accept" or "reject" }], only on the lawyer's word. The lawyer can also decide in the panel under this reply where Claude shows one, in the Hub's Changes list, or in Word.`);
  return lines.join("\n");
}

/**
 * The panel for a version just filed or decided (markup.js after a mark-up):
 * its cards read afresh, the counts from `bytes` (the file) when given.
 */
export async function panelForVersion(db, { versionId, versionNumber, title, projectName, hubUrl, bytes = null, counts = null, canDecide, message = null, notDone = [] }) {
  const { rows, cards } = await versionCards(db, versionId);
  const c = counts ?? countsWith(rows, bytes ? findRevisions(bytes) : { ours: new Set(), others: 0 });
  return panelData({ versionId, versionNumber, title, projectName, hubUrl, cards, counts: c, canDecide, message, notDone });
}

class Refusal extends Error {}

export function createChangesPanelTools(deps) {
  const { supabase, helpers, writes, log = () => {} } = deps;
  const { needVersion, versionName, open, link } = helpers;
  const COLUMNS = "id, version_number, storage_path, file_name, label, created_at, matter_document_id";

  async function wordVersion(input) {
    const v = await needVersion(input, COLUMNS);
    if (!isWordPath(v.storage_path)) throw new Refusal(`${versionName(v)} is not a Word file. ${NOT_WORD_SENTENCE}`);
    return v;
  }
  const newerThan = async (v) => { const latest = await latestVersionOf(supabase, v.matter_document_id ?? v.matter_document?.id); return latest && latest.id !== v.id ? latest : null; };
  const describe = (v) => ({ versionId: v.id, versionNumber: v.version_number, title: v.matter_document?.title ?? null, projectName: v.matter_document?.matter?.name ?? null, hubUrl: link("version", v.id) });

  return [
    {
      name: LIST_TOOL,
      title: "List a version's tracked changes",
      description: `The tracked changes AKLA AI made in a Word version of a project document (by apply_tracked_changes or the Hub's own Edit), each with its clause, the text before and after, the reason, whether it is still waiting, accepted or rejected, and its changeId. Where Claude can show it, an interactive panel under the reply lets the lawyer accept or reject each change, or all of them, and open the document in the Hub. Use it when the lawyer asks what changed, what is still waiting, or wants to go through the changes. Nothing is changed by this tool; ${DECIDE_TOOL} decides.`,
      inputSchema: {
        versionId: z.string().describe("The Word version's id: the versionId apply_tracked_changes filed, or from list_project_documents."),
      },
      ui: CHANGES_UI,
      async run(input, ctx) {
        const v = await wordVersion(input);
        const listed = await listVersionChanges(supabase, v.id);
        if (listed.status !== 200) throw new Error("There is no project document version with that id. list_project_documents gives them.");
        const newer = await newerThan(v);
        const d = describe(v);
        const text = changesText({ ...d, openLine: open("version", v.id), cards: listed.body.changes, counts: listed.body.counts, newer });
        return { text, structuredContent: panelData({ ...d, cards: listed.body.changes, counts: listed.body.counts, canDecide: ctx?.canWrite === true, newer }) };
      },
    },
    {
      name: DECIDE_TOOL,
      title: "Accept or reject tracked changes",
      description: `Accept or reject AKLA AI's tracked changes in a Word version of a project document, in the version's working file in the Hub (the same as the Hub's Changes list: the version's own file is never rewritten; the decided copy is kept beside it, and a clean copy or a further mark-up starts from it). Each decision is { id: the changeId from ${LIST_TOOL}, decision: "accept" or "reject" }, at most ${MAX_DECISIONS} at a time. Only on the lawyer's word: the panel's Accept and Reject buttons call it, or the lawyer says which to accept or reject. A change already decided, or one Word must decide, is reported and left alone. Refused with nothing written if the document changed meanwhile (decide again on the fresh list). claude.ai asks the lawyer before it runs; every call is recorded against the lawyer. Nothing is deleted.`,
      inputSchema: {
        versionId: z.string().describe(`The Word version whose changes these are (${LIST_TOOL}'s versionId).`),
        decisions: z.array(z.object({
          id: z.string().describe(`The change's changeId from ${LIST_TOOL}.`),
          decision: z.enum(["accept", "reject"]),
        })).min(1).max(MAX_DECISIONS).describe(`The decisions, at most ${MAX_DECISIONS}.`),
      },
      write: true,
      annotations: WRITE,
      ui: CHANGES_UI,
      async run(input, ctx) {
        const caps = await writes.checkCaps(ctx);
        let ids = {};
        const record = (outcome) => writes.recordAction(ctx, { tool: DECIDE_TOOL, ...ids, outcome });
        try {
          let v;
          let decisions;
          try {
            const list = Array.isArray(input.decisions) ? input.decisions : [];
            if (!list.length) throw new Refusal(`decisions must name at least one change ({ id, decision: "accept" or "reject" }).`);
            if (list.length > MAX_DECISIONS) throw new Refusal(`At most ${MAX_DECISIONS} decisions at a time; ${list.length} were sent.`);
            const seen = new Set();
            decisions = list.map((d) => {
              const id = uuid(d?.id);
              if (!id) throw new Refusal(`Each decision needs the change's id (changeId from ${LIST_TOOL}).`);
              if (d.decision !== "accept" && d.decision !== "reject") throw new Refusal(`Each decision must be "accept" or "reject".`);
              if (seen.has(id)) throw new Refusal("Each change can be decided only once in one call.");
              seen.add(id);
              return { changeId: id, decision: d.decision === "accept" ? "accepted" : "rejected" };
            });
            v = await wordVersion(input);
          } catch (err) {
            await record("refused").catch(() => {});
            throw err;
          }
          ids = { projectId: v.matter_document?.matter?.id ?? v.matter_document?.matter_id ?? null, documentId: v.matter_document?.id ?? v.matter_document_id ?? null, versionId: v.id };

          let reply;
          try {
            reply = await decideVersionChanges(supabase, { versionId: v.id, decisions, userId: ctx.userId });
          } catch (err) {
            await record("failed").catch(() => {});
            throw err;
          }
          if (reply.status !== 200) {
            await record(reply.status === 422 ? "failed" : "refused").catch(() => {});
            const why = String(reply.body?.error ?? "The Hub refused the decision.").replace(/\s+$/, "");
            throw new Error(reply.status === 404 ? "There is no project document version with that id. list_project_documents gives them." : `${why}${/[.!?]$/.test(why) ? "" : "."} Nothing was decided.`);
          }

          let unrecorded = false;
          try { await record("done"); } catch (err) {
            unrecorded = true;
            log(`${DECIDE_TOOL}: decided, but the record could not be written: ${err?.message ?? err}`);
          }

          const decided = reply.body.changes ?? [];
          const notDone = reply.body.notDone ?? [];
          const skipped = new Set(notDone.map((n) => n.changeId));
          const accepted = decided.filter((c) => !skipped.has(c.id) && c.state === "accepted").length;
          const rejected = decided.filter((c) => !skipped.has(c.id) && c.state === "rejected").length;
          const message = [
            accepted || rejected ? `${accepted} ${plural(accepted, "change")} accepted, ${rejected} rejected.` : "Nothing was decided.",
            ...(notDone.length ? [`${notDone.length} left as ${notDone.length === 1 ? "it was" : "they were"}.`] : []),
          ].join(" ");

          // The whole list again, so the panel redraws from this reply.
          const { cards } = await versionCards(supabase, v.id);
          const d = describe(v);
          const byId = new Map(cards.map((c) => [c.id, c]));
          const lines = [
            `${versionName(v)}${d.projectName ? ` on ${d.projectName}` : ""}: ${message} Decided in the Hub's working copy of this version (the version's own file is unchanged); ${countsLine(reply.body.counts)} now.`,
            ...notDone.map((n) => `- Change ${byId.get(n.changeId)?.number ?? "?"} not decided: ${n.note ?? "it cannot be decided here."}`),
            `versionId: ${v.id}`,
            open("version", v.id),
            ...(unrecorded ? ["The decision was made but could not be recorded in the Hub's log; tell the Hub's owner."] : []),
            ...(reply.body.counts?.waiting ? [] : ["Every change is decided: make_clean_copy files a clean copy when the lawyer asks for one."]),
          ];
          return {
            text: lines.join("\n"),
            structuredContent: panelData({ ...d, cards, counts: reply.body.counts, canDecide: true, message, notDone }),
          };
        } finally {
          caps.release();
        }
      },
    },
  ];
}

/** Registered only when the trial is on (deps.apps, from CONNECTOR_APPS). */
export default (deps) => (deps.apps === true ? createChangesPanelTools(deps) : []);
