// Slice 5 of the connector: the Hub's review, from claude.ai.
//
// "Review v3 of the SPA" runs the Hub's own three-pass review (review.js:
// legal clauses and citations, formatting and structure, content and
// conflicts, against the firm's precedents, the law library, the project's
// other documents and the law looked up online) on a Word version. When it
// is complete it is filed into the Hub on its own, exactly as a review
// started in the Hub is (reviewFiling.js): its findings are placed as
// tracked changes by "AKLA AI" in the next version of the same document,
// one change row each on that version, and the lawyer only decides, in the
// panel under the reply where Claude shows one (the MCP Apps trial), in the
// Hub's Changes list, or in Word. Three tools serve that:
//
// start_review (write: it records a review run, and later files its
// findings as the next version): starts the review detached on the server
// (connector/reviewRuns.js) and answers within seconds with the run id. One
// review on the box at a time, the Hub chat's own included, because on the
// Voyage free tier (three calls a minute) a review's searches hold up every
// other search; one per process; a second review of a version already
// being reviewed is refused; three a day per person, counted from
// connector_actions. The law is looked up online as the Hub's review does
// (research.js reviewLawLookup); a law it downloads is added to the library
// from the server (indexing/statute.js), because the ingest function needs
// a sign-in token the connector does not keep. The start_review record
// carries the run id in its label; the filing has its own record
// (apply_review_to_version, "saved").
//
// get_review (read): the run's status, passes, coverage and error; once
// complete, where it was filed (the new version's id, its Hub page, its
// Changes counts, the findings that could not be placed, and the changes
// panel with the trial on) or why nothing was filed (a newer version came
// in meanwhile: nothing is placed over it), then every finding by clause,
// numbered, with its original and suggested wording, reason, pass and where
// it went, paged under the result cap.
//
// apply_review_to_version (write): only to place a filed review's findings
// again, less the ones the lawyer wants left out entirely, as a fresh next
// version (before any change in the filed version is decided), or to file
// a complete review the automatic filing could not (it failed, or the
// connector stopped first). To leave a finding out of a filed review the
// lawyer normally just rejects it in the Changes list.
//
// The write foundation's order holds (README.md): checkCaps first, the
// work, recordAction last, release() in a finally. Node 20.

import { z } from "zod";
import { WRITE } from "../app.js";
import { MAX_RESULT_CHARS, uuid, when } from "../tools.js";
import { applyReviewSuggestions, suggestionParagraphs } from "../../docxAgent.js";
import { checkFormat } from "../../formatFingerprint.js";
import { placementNote } from "../../changes.js";
import { isWordPath, latestVersionOf, listVersionChanges } from "../../versionChanges.js";
import {
  fileReviewRun, findingsOf, readRun, filingOf, orderFindings, reviewLabel, passLabel, PASSES, FILED, NEWER_VERSION,
} from "../../reviewFiling.js";
import { anthropicCaller, reviewLawLookup } from "../../research.js";
import { ingestStatute } from "../../indexing/statute.js";
import { CHANGES_UI } from "../apps.js";
import { panelData, countsLine } from "./changesPanel.js";
import {
  claimReviewSlot, isActiveRun, connectorRunIds, runLabel, START_REVIEW_TOOL, RESTART_SENTENCE, STALE_RUN_MS, START_TIMEOUT_MS,
} from "../reviewRuns.js";
import { runReview } from "../../review.js";

export { orderFindings, reviewLabel };
export const START_TOOL = START_REVIEW_TOOL;
export const GET_TOOL = "get_review";
export const APPLY_TOOL = "apply_review_to_version";
/** Reviews one person may start from claude.ai in a day (owner decision 3). */
export const DAILY_REVIEWS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LABEL_CHARS = 200;
const MAX_EXCLUDE = 500;
/** One original or suggested wording in get_review; the Hub has the whole of it. */
export const MAX_FINDING_TEXT = 1_500;
const MAX_LISTED = 60;
// Room left under the wrapper's cap for the tail line and the clip note.
const PAGE_MARGIN = 600;

export const NO_KEY_SENTENCE = "Reviews cannot be started from claude.ai on this server yet: the connector has no AI key (ANTHROPIC_API_KEY). Tell the Hub's owner, or run the review in the Hub.";
export const BOX_BUSY_SENTENCE = "Another review is already running on the Hub, and only one runs at a time; nothing was started. Try again in a few minutes.";
export const APPLY_BUSY_SENTENCE = "Another review's findings are being placed on the Hub; nothing was saved. Try again in a minute.";
export const UNRECORDED_LINE = "The step landed but could not be recorded in the Hub's log; tell the Hub's owner.";
export const NOT_EXHAUSTIVE = "The review is not an exhaustive legal clearance, and filing is not legal approval.";
/** What a finished review does on its own, said once in start_review's reply and description. */
export const FILES_ITSELF = "When it is complete it files itself: the findings are placed as tracked changes by AKLA AI in the next version of the same document, one change each, and the lawyer accepts or rejects each one in that version's Changes list in the Hub, in the changes panel under a reply where Claude shows one, or in Word";

const n = (v) => Number(v ?? 0).toLocaleString("en");
const plural = (k, one, many = `${one}s`) => (k === 1 ? one : many);
const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
/** A review's wording as the lawyer reads it: mammoth's HTML gone, paragraphs joined by " / ". */
const plainOf = (html) => suggestionParagraphs(html).join(" / ");

/** "45 s" under two minutes, else "12 min" or "3 h 5 min". */
export function ago(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 120) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 120 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** The law lookup a review recorded (coverage.research), in one line, as the Hub's review panel says it. */
export function lawLookupLine(research) {
  if (!research || typeof research !== "object") return "not run for this review";
  if (research.status === "not_run") return (research.unresolved ?? [])[0] ?? "not run for this review";
  if (research.status === "failed") return `could not finish${research.unresolved?.length ? ` (${oneLine(research.unresolved[0])})` : ""}`;
  const k = Number(research.sourcesChecked ?? 0);
  return `${k} ${plural(k, "law")} read from the library or official sources (${research.status ?? "partial"})${research.unresolved?.length ? `; open: ${research.unresolved.slice(0, 3).map(oneLine).join("; ")}` : ""}`;
}

/** Where a finding stands, in a few words, or null when it is simply waiting to be placed. */
function standing(row) {
  if (row.status === "rejected") return "left out (rejected)";
  if (row.status === "accepted") return "accepted in the Hub";
  if (row.placement === "superseded") return row.placement_reason || "placed in a later version";
  if (row.placement === "unplaced") return `could not be placed: ${placementNote(row.placement_reason) ?? "the wording was not found"}`;
  if (row.placement === "blocked") return "to decide in Word";
  return null;
}

/** One finding as get_review prints it. */
function findingText(row, number) {
  const state = standing(row);
  const original = plainOf(row.original_text);
  const suggested = plainOf(row.suggested_text);
  const lines = [`Finding ${number} — ${row.clause_reference ? oneLine(row.clause_reference) : "no clause named"} (${passLabel(row.review_type)})${state ? ` — ${state}` : ""}`];
  lines.push(`  Original: ${original ? clip(original, MAX_FINDING_TEXT) : "(none quoted)"}`);
  lines.push(`  Suggested: ${suggested ? clip(suggested, MAX_FINDING_TEXT) : "(delete the original wording)"}`);
  if (row.rationale) lines.push(`  Why: ${clip(oneLine(row.rationale), MAX_FINDING_TEXT)}`);
  lines.push(`  suggestionId: ${row.id}`);
  return lines.join("\n");
}

/** "Finding 3 — Clause 5", for the could-not-place lists. */
const findingName = (row, numberOf) => `Finding ${numberOf.get(row.id) ?? "?"}${row?.clause_reference ? ` — ${oneLine(row.clause_reference)}` : ""}`;

// ---------------------------------------------------------------- the tools

/**
 * The tools, with the pieces a test swaps: `run` in place of review.js
 * runReview (the same contract: onStarted(runId) once the row is in, the
 * signal honoured), `apply` in place of applyReviewSuggestions, `format` in
 * place of checkFormat, `lawLookup({ ctx, signal, log })` in place of the
 * online law lookup (null: none), `startTimeoutMs`. `deps` is what tools.js
 * hands every module; `deps.anthropicKey` is the review's AI key (null when
 * the server has none: start_review then says so).
 */
export function createReviewTools(deps, { run = runReview, apply = applyReviewSuggestions, format = checkFormat, startTimeoutMs = START_TIMEOUT_MS, lawLookup = undefined } = {}) {
  const { supabase, helpers, writes, log = () => {} } = deps;
  const { needVersion, versionById, versionName, open, link } = helpers;
  const now = () => { const t = typeof deps.now === "function" ? deps.now() : Date.now(); return t instanceof Date ? t.getTime() : Number(t); };
  const at = () => new Date(now());
  const COLUMNS = "id, version_number, storage_path, file_name, label, created_at, matter_document_id";

  // The Hub review's online law lookup, for the lawyer who started the
  // review: the same research, with a downloaded law added to the library
  // from the server under the lawyer's name.
  const realLawLookup = ({ ctx, signal }) => reviewLawLookup({
    supabase,
    anthropicJson: anthropicCaller(deps.anthropicKey),
    ingest: ({ content, metadata }) => ingestStatute({ supabase, voyageKey: deps.voyageKey, userId: ctx.userId, content, metadata, log }),
    userId: ctx.userId,
    signal,
    notice: (text) => log(`review law lookup: ${text}`),
  });
  const makeLawLookup = lawLookup === undefined ? realLawLookup : lawLookup;

  /** A filing as the lawyer: the next version saved through the write foundation. */
  const saverFor = (ctx) => (args) => writes.saveVersion({ ctx, ...args });

  /** The run row, or a sentence saying there is none. */
  async function needRun(input) {
    const id = uuid(input.runId);
    if (!id) throw new Error(`runId must be a review's run id (a UUID), as ${START_TOOL} gave it.`);
    const data = await readRun(supabase, id);
    if (!data) throw new Error(`There is no review with that run id. ${START_TOOL} starts one and gives its runId.`);
    if (!data.document_version_id) throw new Error("That review ran inside a Hub chat on its working document; its findings are in that chat's Changes list in the Hub, not here.");
    return data;
  }

  /**
   * The runs "running" on the box now, the Hub chat's included: none older
   * than STALE_RUN_MS (abandoned, never a review in progress), and none this
   * connector started that this process is not running (an earlier
   * process's, cut off by a restart: failOrphanedRuns marks those failed at
   * startup, and this keeps them from blocking meanwhile).
   */
  async function runningOnBox() {
    const since = new Date(now() - STALE_RUN_MS).toISOString();
    const { data, error } = await supabase.from("ai_review_runs").select("id, document_version_id, created_at").eq("status", "running").gte("created_at", since).order("created_at", { ascending: false }).limit(20);
    if (error) throw new Error(`Whether a review is already running could not be checked: ${error.message}`);
    const rows = data ?? [];
    const ours = await connectorRunIds(supabase, rows.map((r) => r.id));
    return rows.filter((r) => !ours.has(r.id) || isActiveRun(r.id));
  }

  /** Whether a "running" run has in fact stopped, and the sentence that says so; null while it runs. */
  async function stoppedSentence(r) {
    if (isActiveRun(r.id)) return null;
    const age = now() - new Date(r.created_at).getTime();
    if (age > STALE_RUN_MS) return `It has been marked as running for ${ago(age)}, so it most likely stopped without finishing; start it again with ${START_TOOL}.`;
    const ours = await connectorRunIds(supabase, [r.id]).catch(() => new Set());
    return ours.has(r.id) ? RESTART_SENTENCE : null;
  }

  /**
   * The automatic filing once a run started here completes (reviewRuns.js
   * onComplete): the findings into the next version as the lawyer, then the
   * record. A stop asked for meanwhile files nothing.
   */
  async function autoFile({ runId, ctx, signal }) {
    const out = await fileReviewRun({
      supabase, runId, userId: ctx.userId, save: saverFor(ctx), apply, format, log, now: at,
      shouldStop: () => signal?.aborted === true,
    });
    const ids = { tool: APPLY_TOOL, projectId: out.doc?.matter_id ?? null, documentId: out.doc?.id ?? null };
    const record = (fields) => writes.recordAction(ctx, { ...ids, ...fields }).catch((err) => log(`${APPLY_TOOL} (automatic): the record could not be written: ${err?.message ?? err}`));
    if (out.status === FILED) await record({ versionId: out.saved.versionId, label: out.saved.label, outcome: "saved" });
    else if (["failed", "format_refused", "none_placed", NEWER_VERSION].includes(out.status)) await record({ versionId: out.version?.id ?? null, outcome: out.status === "failed" ? "failed" : "refused" });
    log(`review ${runId}: filing ${out.status}${out.saved ? ` as v${out.saved.versionNumber} (${out.placed.length} placed, ${out.notPlaced.length} not)` : ""}`);
    return out;
  }

  /** The could-not-place lines of a filing record, finding numbers from the run's findings. */
  function notPlacedLines(filing, rows) {
    const byId = new Map(rows.map((r, i) => [r.id, { row: r, number: i + 1 }]));
    const items = (filing?.notPlaced ?? []).map((x) => ({ hit: byId.get(x.suggestionId), reason: x.reason }));
    const lines = items.slice(0, MAX_LISTED).map(({ hit, reason }) => `- ${hit ? `Finding ${hit.number}${hit.row.clause_reference ? ` — ${oneLine(hit.row.clause_reference)}` : ""}` : "A finding"}: ${placementNote(reason) ?? reason}`);
    if (items.length > MAX_LISTED) lines.push(`- and ${items.length - MAX_LISTED} more`);
    return lines;
  }

  return [
    // ------------------------------------------------------------ start
    {
      name: START_TOOL,
      title: "Start the Hub's review of a Word document",
      description: `Start the Hub's own three-pass review of one Word version of a project document: legal clauses and citations, formatting and structure, and content and conflicts, checked against the firm's precedents, its law library (with the law that applies looked up online on official sources and added to the library, as the Hub's review does) and the project's other documents. Use it whenever the lawyer asks for a review of a document ("review v3 of the SPA"): on the Hub version (list_project_documents gives its versionId); for a file attached in this chat, upload it first with upload_file_to_project and review the version that makes. It answers within seconds with a runId while the review runs on the Hub's server; a short agreement takes a few minutes, a long one much longer. ${FILES_ITSELF}. Call ${GET_TOOL} with the runId for progress and, once it is complete, where it was filed and the findings by clause. Word (.docx) versions only. One review runs on the Hub at a time (the Hub chat's included), a second review of the same version is refused while one runs, and each person may start ${DAILY_REVIEWS} a day; a refusal is one sentence, and nothing is started. claude.ai asks the lawyer first, and the start and the filing are recorded against them. The review's findings are suggestions, not legal approval.`,
      inputSchema: {
        versionId: z.string().describe("The Word version's id, from list_project_documents (or the \"versionId:\" line the lawyer pasted, or the version upload_file_to_project made)."),
      },
      write: true,
      annotations: WRITE,
      async run(input, ctx) {
        if (!deps.anthropicKey) throw new Error(NO_KEY_SENTENCE);
        const caps = await writes.checkCaps(ctx);
        let slot = null;
        try {
          const version = await needVersion(input, COLUMNS);
          const doc = version.matter_document;
          const matter = doc.matter;
          const record = (fields) => writes.recordAction(ctx, { tool: START_TOOL, projectId: matter.id, documentId: doc.id, versionId: version.id, ...fields }).catch((err) => { log(`${START_TOOL}: the record could not be written: ${err?.message ?? err}`); return null; });
          const refuse = async (sentence) => { await record({ outcome: "refused" }); throw new Error(sentence); };
          if (!isWordPath(version.storage_path)) {
            const kind = (/\.([a-z0-9]{1,10})$/i.exec(version.file_name ?? version.storage_path)?.[1] ?? "other").toUpperCase();
            await refuse(`${versionName(version)} is a ${kind} file. The review is started from claude.ai on Word (.docx) versions only, because its findings are filed back as tracked changes; read_document reads this one, and you can review its text here in the chat, or run the Hub's review in the Hub.`);
          }

          // The process's one slot first (taken before anything is awaited
          // again, so two calls side by side cannot both pass), then the
          // version, the box and the day.
          slot = claimReviewSlot();
          if (!slot) await refuse(BOX_BUSY_SENTENCE);
          const running = await runningOnBox();
          const same = running.find((r) => r.document_version_id === version.id);
          if (same) await refuse(`A review of ${versionName(version)} is already running (started ${ago(now() - new Date(same.created_at).getTime())} ago); nothing new was started. Call ${GET_TOOL} with runId ${same.id} for its progress and findings.`);
          if (running.length) await refuse(BOX_BUSY_SENTENCE);
          const { data: today, error: todayError } = await supabase
            .from("connector_actions").select("created_at")
            .eq("user_id", ctx.userId).eq("tool", START_TOOL).eq("outcome", "done")
            .gte("created_at", new Date(now() - DAY_MS).toISOString())
            .limit(DAILY_REVIEWS + 1);
          if (todayError) throw new Error(`Your reviews today could not be counted: ${todayError.message}`);
          if ((today ?? []).length >= DAILY_REVIEWS) await refuse(`You have started ${DAILY_REVIEWS} reviews from claude.ai in the last day, which is the limit; try again tomorrow, or run the review in the Hub.`);

          let runId;
          try {
            ({ runId } = await slot.start({
              supabase, anthropicKey: deps.anthropicKey, voyageKey: deps.voyageKey, versionId: version.id, userId: ctx.userId, run, startTimeoutMs, log, now,
              lookUpLaw: makeLawLookup ? (signal) => makeLawLookup({ ctx, signal, log }) : null,
              onComplete: ({ runId: id, signal }) => autoFile({ runId: id, ctx, signal }),
            }));
          } catch (err) {
            await record({ outcome: "failed" });
            throw new Error(`The review could not be started: ${err?.message ?? err}`);
          } finally {
            slot = null; // the run holds the slot now, or has given it back
          }
          const recorded = await record({ label: runLabel(runId), outcome: "done" });
          return [
            `Started the Hub's review of ${versionName(version)} on ${matter.name}.`,
            `runId: ${runId}`,
            `versionId: ${version.id}`,
            open("version", version.id),
            ...(recorded ? [] : [UNRECORDED_LINE]),
            `The three passes (legal clauses and citations, formatting and structure, content and conflicts) run on the Hub's server against the firm's precedents, its law library (the law that applies is looked up online first, as in the Hub) and the project's other documents. A short agreement takes a few minutes, a long one much longer. ${FILES_ITSELF}. Call ${GET_TOOL} with this runId in a minute or two for progress and, when it is complete, the new version and the findings by clause.`,
          ].join("\n");
        } finally {
          slot?.release();
          caps.release();
        }
      },
    },

    // ------------------------------------------------------------ read
    {
      name: GET_TOOL,
      title: "Read a review's progress, filing and findings",
      description: `A review started with ${START_TOOL}: while it runs, how far it has got; once complete, where it was filed (the next version of the document, with the review's findings in it as tracked changes: its versionId, its Hub page, how many changes are waiting or decided, and the findings that could not be placed), or why nothing was filed (a newer version was saved while the review ran, so nothing was placed over it), each pass's status and the law looked up, and every finding by clause, numbered, with the original wording, the suggested wording, the reason, the pass and where it went (paged: from is the finding number to start at); if it failed, why. Where Claude can show it, the filed version's changes panel comes with it. Use it when the lawyer asks what the review found or how it is going. The lawyer decides the filed changes in that panel, in the Hub's Changes list or with decide_changes on their word. Nothing is changed by this tool, and the findings are suggestions, not legal approval.`,
      inputSchema: {
        runId: z.string().describe(`The runId ${START_TOOL} gave.`),
        from: z.number().int().min(1).optional().describe("The finding number to start at, for a long list. Default 1."),
      },
      ui: CHANGES_UI,
      async run(input, ctx) {
        const r = await needRun(input);
        const version = await versionById(r.document_version_id, COLUMNS);
        const name = version ? versionName(version) : "the reviewed version";
        const title = version?.matter_document?.title ?? "the document";
        const project = version?.matter_document?.matter?.name;
        const age = now() - new Date(r.created_at).getTime();
        const head = [
          `Review of ${name}${project ? ` on ${project}` : ""}, started ${when(r.created_at)}.`,
          `runId: ${r.id}`,
          `versionId: ${r.document_version_id} (the version reviewed)`,
          open("version", r.document_version_id),
        ];
        if (r.status === "running") {
          const stopped = await stoppedSentence(r);
          if (stopped) return [...head, "", `Status: stopped without finishing. ${stopped}`].join("\n");
          const c = r.coverage ?? {};
          const sections = Number.isInteger(c.sectionsTotal) && c.sectionsTotal > 0 ? `; ${c.sectionsCompleted ?? 0} of ${c.sectionsTotal} ${plural(c.sectionsTotal, "section")} of the document checked` : "";
          return [...head, "", `Status: still running (started ${ago(age)} ago${sections}). Call ${GET_TOOL} again with the same runId in a minute or two; it is filed in the next version once it is complete.`].join("\n");
        }
        if (r.status === "failed") {
          return [...head, "", `Status: failed. ${r.error ? oneLine(r.error) : "No reason was recorded."}${r.error === RESTART_SENTENCE ? "" : ` Nothing from it was filed; start it again with ${START_TOOL}.`}`].join("\n");
        }

        // Complete: where it was filed, the passes, the coverage, then the
        // findings by clause.
        const rows = await findingsOf(supabase, r);
        const filing = filingOf(r);
        const out = [...head, "", `Status: complete. ${rows.length} ${plural(rows.length, "finding")}.`, ""];
        let panel = null;
        let filedNumber = null;
        if (filing?.status === FILED) {
          filedNumber = filing.versionNumber;
          out.push(`FILED: the findings were placed as tracked changes by AKLA AI in v${filing.versionNumber} of "${title}"${filing.fileName ? ` (${filing.fileName})` : ""}${filing.label ? `, labelled "${filing.label}"` : ""}.`);
          out.push(`versionId: ${filing.versionId}`, open("version", filing.versionId));
          const listed = await listVersionChanges(supabase, filing.versionId).catch((err) => { log(`${GET_TOOL}: the Changes list of ${filing.versionId} could not be read: ${err?.message ?? err}`); return null; });
          if (listed?.status === 200) {
            out.push(`Changes in v${filing.versionNumber}: ${countsLine(listed.body.counts)}.`);
            if (ctx?.apps) panel = panelData({ versionId: filing.versionId, versionNumber: filing.versionNumber, title, projectName: project ?? null, hubUrl: link("version", filing.versionId), cards: listed.body.changes, counts: listed.body.counts, canDecide: ctx?.canWrite === true });
          }
          const notPlaced = notPlacedLines(filing, rows);
          if (notPlaced.length) out.push("Could not be placed (nothing changed there; these are for reading):", ...notPlaced);
          if (filing.rowsError) out.push(`The changes are in the file, but the Hub could not list them in v${filing.versionNumber}'s Changes list (${oneLine(filing.rowsError)}); decide them in Word, and tell the Hub's owner.`);
          if (filing.formatNote) out.push(oneLine(filing.formatNote));
          const latest = version ? await latestVersionOf(supabase, version.matter_document_id).catch(() => null) : null;
          if (latest && latest.id !== filing.versionId && latest.version_number > filing.versionNumber) out.push(`A newer version exists (v${latest.version_number}, versionId ${latest.id}): changes still waiting in v${filing.versionNumber} were carried forward if it was made from it, so decide them in the newest version.`);
          out.push(`Nothing needs placing: the lawyer accepts or rejects each change in v${filing.versionNumber}'s Changes list in the Hub, in the panel under this reply where Claude shows one (decide_changes on the lawyer's word), or in Word. To leave a finding out, reject its change.`);
        } else if (filing?.status === NEWER_VERSION) {
          out.push(`NOT FILED: v${filing.latestVersionNumber ?? "?"} of "${title}" was saved while the review ran${filing.latestVersionId ? ` (versionId ${filing.latestVersionId})` : ""}, and the findings quote v${filing.reviewedVersionNumber}'s words, so nothing was placed over it. The findings below are for reading; start a fresh review of the newest version with ${START_TOOL} if the lawyer wants it filed.`);
          if (filing.latestVersionId) out.push(open("version", filing.latestVersionId));
        } else if (filing?.status === "none_placed") {
          out.push("NOT FILED: none of the findings' quoted wording could be found once in the file, so no version was made; each finding below says why.");
        } else if (filing?.status === "format_refused") {
          out.push(`NOT FILED: ${oneLine(filing.note ?? "the format check refused the marked-up file.")}`);
        } else if (filing?.status === "failed") {
          out.push(`NOT FILED: the findings could not be filed (${oneLine(filing.note ?? "no reason was recorded")}). ${APPLY_TOOL} with this runId tries again, when the lawyer asks.`);
        } else if (filing?.status === "nothing_found") {
          out.push("Nothing to file: the review found nothing to change.");
        } else if (!filing && isActiveRun(r.id)) {
          out.push("FILING: the findings are being placed as tracked changes in the next version now; call get_review again in a moment for the new version.");
        } else if (!filing && rows.length) {
          out.push(`NOT FILED YET: this review finished before it could be filed. ${APPLY_TOOL} with this runId files it now (the findings as tracked changes in the next version).`);
        }

        out.push("", "PASSES");
        const passes = r.passes && typeof r.passes === "object" ? r.passes : {};
        for (const key of PASSES.filter((k) => passes[k])) {
          const p = passes[key];
          out.push(`- ${passLabel(key)}: ${String(p.status ?? "unknown").replace(/_/g, " ")}, ${n(p.findings)} ${plural(Number(p.findings ?? 0), "finding")}${p.note ? `. ${oneLine(p.note)}` : ""}`);
        }
        const c = r.coverage && typeof r.coverage === "object" ? r.coverage : {};
        const covered = [];
        if (c.documentCharacters) covered.push(`${n(c.documentCharacters)} characters in ${n(c.sectionsTotal ?? 1)} ${plural(Number(c.sectionsTotal ?? 1), "section")}`);
        if (c.statuteExcerpts != null || c.precedentExcerpts != null || c.projectExcerpts != null) covered.push(`evidence: ${n(c.statuteExcerpts)} law, ${n(c.precedentExcerpts)} precedent and ${n(c.projectExcerpts)} project ${plural(Number(c.projectExcerpts ?? 0), "excerpt")} for the first section`);
        if (c.droppedUnlocated) covered.push(`${n(c.droppedUnlocated)} ${plural(c.droppedUnlocated, "suggestion")} left out because the quoted wording was not in the document`);
        if (c.failedPassSections) covered.push(`${n(c.failedPassSections)} pass ${plural(c.failedPassSections, "section")} could not be completed`);
        if (Array.isArray(c.placeholders) && c.placeholders.length) covered.push(`${n(c.placeholders.length)} ${plural(c.placeholders.length, "blank")} or placeholder${c.placeholders.length === 1 ? "" : "s"} in the file`);
        out.push("", `COVERAGE: ${covered.length ? `${covered.join("; ")}.` : "not recorded."} LAW LOOKUP: ${lawLookupLine(c.research)}. ${NOT_EXHAUSTIVE}`);
        const answer = (text) => (panel ? { text, structuredContent: panel } : text);
        if (!rows.length) {
          out.push("", "The review found nothing to change. That is not a clearance: see each pass's status above.");
          return answer(out.join("\n"));
        }

        const from = Number.isInteger(input.from) && input.from > 0 ? input.from : 1;
        if (from > rows.length) return answer([...out, "", `There is no finding ${from}: the review has ${rows.length}.`].join("\n"));
        out.push("", `FINDINGS BY CLAUSE (${rows.length}; each says where it went):`);
        const headText = out.join("\n");
        const budget = Math.max(2_000, MAX_RESULT_CHARS - headText.length - PAGE_MARGIN);
        const shown = [];
        let used = 0;
        let last = from - 1;
        for (let i = from - 1; i < rows.length; i++) {
          const block = findingText(rows[i], i + 1);
          if (shown.length && used + block.length + 2 > budget) break;
          shown.push(block);
          used += block.length + 2;
          last = i + 1;
        }
        const tail = last < rows.length
          ? `[Findings ${from}–${last} of ${rows.length} shown: call ${GET_TOOL} again with from: ${last + 1}.]`
          : filedNumber
            ? `[End of the findings. They are filed in v${filedNumber}: decide them there.]`
            : "[End of the findings.]";
        return answer(`${headText}\n\n${shown.join("\n\n")}\n\n${tail}`);
      },
    },

    // ------------------------------------------------------------ apply
    {
      name: APPLY_TOOL,
      title: "Place a review's findings again, leaving some out",
      description: `Rarely needed: a complete review files itself (${START_TOOL}), with every finding as a tracked change in the next version, and the lawyer leaves a finding out by rejecting its change there. Use this only (a) when the lawyer wants a fresh copy of the reviewed document with some findings left out entirely ("put all but 4 and 9 into the file"): exclude takes the finding numbers or suggestionIds ${GET_TOOL} printed, and the rest are placed again, as tracked changes by AKLA AI, in a NEW next version after the filed one; refused once any change in the filed version has been decided (reject there instead), or when a newer version exists; or (b) when ${GET_TOOL} says the review was not filed because filing failed or never ran: it files it now, as the automatic filing would. Refused, with nothing saved, unless the review is complete, and when the document has a newer version than the one the findings were written for (the findings quote that version's words; start a fresh review of the newest). A finding whose quoted wording is not found once in the file is not placed, and is named with the reason. It always saves a NEW version, never over one, and claude.ai asks the lawyer before it runs; every save is recorded against the lawyer. Returns how many were placed, left out and could not be placed, the new version's id and its Hub page. Filing is not legal approval.`,
      inputSchema: {
        runId: z.string().describe(`The runId ${START_TOOL} gave (the review must be complete).`),
        exclude: z.array(z.union([z.number().int(), z.string()])).max(MAX_EXCLUDE).optional().describe(`The findings to leave out entirely, as the numbers ${GET_TOOL} printed (e.g. [4, 9]) or their suggestionIds. Needed when the review is already filed.`),
        label: z.string().optional().describe("Optional: a short label for the new version, e.g. \"Review comments for the client\". \"Review suggestions placed\" and the date are added."),
      },
      write: true,
      annotations: WRITE,
      // The MCP Apps trial (CONNECTOR_APPS=on): the changes panel under the
      // reply, drawn from the new version's Changes list.
      ui: CHANGES_UI,
      async run(input, ctx) {
        const caps = await writes.checkCaps(ctx);
        try {
          const r = await needRun(input);
          const version = await needVersion({ versionId: r.document_version_id }, COLUMNS);
          const doc = version.matter_document;
          const matter = doc.matter;
          const record = (fields) => writes.recordAction(ctx, { tool: APPLY_TOOL, projectId: matter.id, documentId: doc.id, ...fields }).catch((err) => { log(`${APPLY_TOOL}: the record could not be written: ${err?.message ?? err}`); return null; });
          const refuse = async (sentence) => { await record({ versionId: version.id, outcome: "refused" }); throw new Error(sentence); };

          if (r.status === "running") {
            const stopped = await stoppedSentence(r);
            await refuse(stopped ? `That review stopped without finishing, so it has nothing to place. ${stopped}` : `That review is still running (started ${ago(now() - new Date(r.created_at).getTime())} ago), so nothing was placed; it files itself once it is complete (call ${GET_TOOL} until it is).`);
          }
          if (r.status !== "complete") await refuse(`That review ${r.status === "failed" ? `failed${r.error ? ` (${oneLine(r.error)})` : ""}` : `is ${r.status}`}, so it has nothing to place; start it again with ${START_TOOL}.`);
          if (!isWordPath(version.storage_path)) await refuse(`${versionName(version)} is not a Word file, so the findings cannot be placed as tracked changes.`);
          if (isActiveRun(r.id)) await refuse(`That review is being filed right now; nothing more was placed. Call ${GET_TOOL} in a moment for the new version.`);

          // The findings, numbered as get_review printed them, and the ones
          // the lawyer left out.
          const rows = await findingsOf(supabase, r);
          if (!rows.length) await refuse(`That review found nothing to place, so nothing was saved.\n${open("version", version.id)}`);
          const byId = new Map(rows.map((x) => [x.id, x]));
          const excluded = new Set();
          const unknown = [];
          for (const item of Array.isArray(input.exclude) ? input.exclude : []) {
            const s = String(item ?? "").trim().replace(/^#/, "");
            const id = uuid(s);
            if (id && byId.has(id)) excluded.add(id);
            else if (/^\d+$/.test(s) && Number(s) >= 1 && Number(s) <= rows.length) excluded.add(rows[Number(s) - 1].id);
            else unknown.push(String(item));
          }
          if (unknown.length) await refuse(`${unknown.slice(0, 10).join(", ")} ${unknown.length === 1 ? "is not a finding" : "are not findings"} of this review (it has ${rows.length}, numbered 1–${rows.length}); nothing was placed. Use the finding numbers or suggestionIds ${GET_TOOL} printed.`);
          const filed = filingOf(r)?.status === FILED ? filingOf(r) : null;
          if (filed && !excluded.size) await refuse(`This review is already filed as v${filed.versionNumber}, with its findings waiting there as tracked changes; nothing more was placed. To leave findings out, reject them in v${filed.versionNumber}'s Changes list, or name them in exclude to place the rest again as a fresh version.\n${open("version", filed.versionId)}`);

          const label = reviewLabel(typeof input.label === "string" ? input.label.slice(0, MAX_LABEL_CHARS) : null, at());
          let res;
          try {
            res = await fileReviewRun({ supabase, runId: r.id, userId: ctx.userId, save: saverFor(ctx), exclude: [...excluded], label, isAiGenerated: false, wait: false, apply, format, log, now: at });
          } catch (err) {
            await record({ versionId: version.id, outcome: "failed" });
            throw err;
          }
          const name = (row) => findingName(row, res.numberOf ?? new Map());
          const why = (x) => placementNote(x.reason) ?? x.reason ?? "no reason given";
          switch (res.status) {
            case FILED: break;
            case "busy": await refuse(APPLY_BUSY_SENTENCE); break;
            case NEWER_VERSION: {
              const latest = res.latest;
              if (filed) await refuse(`A newer version of ${doc.title} exists (v${latest?.version_number ?? "?"}${latest?.id ? `, versionId ${latest.id}` : ""}) than v${filed.versionNumber}, where the review was filed, so nothing was placed again. Decide the review's changes where they now wait, or start a fresh review of the newest version with ${START_TOOL}.${latest?.id ? `\n${open("version", latest.id)}` : ""}`);
              await refuse(`A newer version of ${doc.title} exists (v${latest?.version_number ?? "?"}${latest?.id ? `, versionId ${latest.id}` : ""}), so nothing was placed: the review's findings quote v${version.version_number}'s words. Start a fresh review of v${latest?.version_number ?? "the newest version"} with ${START_TOOL}, or ask for the findings to be made as a mark-up of it (show_document_paragraphs, then apply_tracked_changes).${latest?.id ? `\n${open("version", latest.id)}` : ""}`);
              break;
            }
            case "decided_in_filed": await refuse(`Changes in v${filed?.versionNumber ?? "?"}, where the review was filed, have already been decided (or a follow-up placed more there), so the findings were not placed again: to leave findings out now, reject them in v${filed?.versionNumber ?? "?"}'s Changes list (the panel, decide_changes on the lawyer's word, or the Hub).${filed ? `\n${open("version", filed.versionId)}` : ""}`); break;
            case "nothing_left": await refuse(`None of the review's findings is left to place (${excluded.size} left out, ${res.decidedBefore ?? 0} already decided), so nothing was saved.`); break;
            case "none_placed": await refuse(`None of the ${rows.length - excluded.size} ${plural(rows.length - excluded.size, "finding")} could be placed, so nothing was saved: ${res.notPlaced.slice(0, 8).map((x) => `${name(x.finding)}: ${why(x)}`).join("; ")}.`); break;
            case "format_refused": await refuse(`${res.format.text} v${version.version_number} is unchanged.`); break;
            case "moved": await refuse(`A change was decided in the Hub while the findings were being placed, so nothing was saved; call ${APPLY_TOOL} again.`); break;
            case "nothing_found": await refuse(`That review found nothing to place, so nothing was saved.`); break;
            default: {
              await record({ versionId: version.id, outcome: "failed" });
              throw new Error(`The findings could not be placed: ${res.error ?? res.status}. Nothing was saved.`);
            }
          }

          const saved = res.saved;
          const recorded = await record({ versionId: saved.versionId, label: saved.label, outcome: "saved" });
          log(`${APPLY_TOOL}: run ${r.id}, v${version.version_number} → v${saved.versionNumber} of ${doc.id}: ${res.placed.length} placed, ${res.notPlaced.length} not, ${excluded.size} left out`);
          const excludedNumbers = [...excluded].map((id) => res.numberOf.get(id)).sort((a, b) => a - b);
          const lines = [
            filed
              ? `Placed the review's findings again from "${doc.title}" v${version.version_number}, less the ones left out, and filed the result as v${saved.versionNumber} (${saved.fileName}), the next version after v${filed.versionNumber} on ${matter.name}, labelled "${saved.label}". The review's changes in v${filed.versionNumber} no longer wait there.`
              : `Placed the review's findings in "${doc.title}" v${version.version_number} and filed the result as v${saved.versionNumber} (${saved.fileName}), the next version of the document on ${matter.name}, labelled "${saved.label}".`,
            `Findings: ${res.placed.length} of ${rows.length} placed as tracked changes by AKLA AI; ${excluded.size} left out at the lawyer's word${excludedNumbers.length ? ` (${excludedNumbers.slice(0, 40).join(", ")}${excludedNumbers.length > 40 ? ", …" : ""})` : ""}; ${res.notPlaced.length} could not be placed${res.decidedBefore ? `; ${res.decidedBefore} already decided before, left as they were` : ""}.`,
            "Placed:",
            ...res.placed.slice(0, MAX_LISTED).map((p) => `- ${name(p.finding)}: ${clip(oneLine(p.original ?? ""), 90)}`),
            ...(res.placed.length > MAX_LISTED ? [`- and ${res.placed.length - MAX_LISTED} more`] : []),
          ];
          if (res.notPlaced.length) {
            lines.push("Could not be placed (nothing changed there):");
            for (const x of res.notPlaced.slice(0, MAX_LISTED)) lines.push(`- ${name(x.finding)}: ${why(x)}`);
            if (res.notPlaced.length > MAX_LISTED) lines.push(`- and ${res.notPlaced.length - MAX_LISTED} more`);
          }
          lines.push(
            res.format.text,
            res.rowsError
              ? `The findings are in the file as tracked changes, but the Hub could not list them in v${saved.versionNumber}'s Changes list (${res.rowsError}); accept or reject them in Word, and tell the Hub's owner.`
              : `${res.waiting} ${plural(res.waiting, "change is", "changes are")} waiting in v${saved.versionNumber}'s Changes list in the Hub: accept or reject each there (the document window beside the chat), in the panel under this reply where Claude shows one, or in Word.${res.carriedCount ? ` ${res.carriedCount} AKLA AI ${plural(res.carriedCount, "change")} still waiting before ${res.carriedCount === 1 ? "was" : "were"} carried forward to this version${res.overtakenCount ? `, ${res.overtakenCount} of them overtaken by a finding` : ""}.` : ""}`,
            `documentId: ${doc.id}`,
            `versionId: ${saved.versionId}`,
            open("version", saved.versionId),
            `Project ${matter.name} — Open in Hub: ${link("project", matter.id)}`,
            ...(recorded ? [] : [UNRECORDED_LINE]),
            `Nothing was accepted: v${saved.versionNumber} carries the findings as tracked changes, and v${version.version_number} is unchanged. Filed as the lawyer's own version (not marked AI-generated), with the label saying it came from the review. ${NOT_EXHAUSTIVE} When the changes are decided, make_clean_copy files a clean copy.`,
          );
          const text = lines.join("\n");
          // With the trial on, the panel's data too; a panel that cannot be
          // built never costs the lawyer the filing's reply.
          if (!ctx?.apps) return text;
          const listed = await listVersionChanges(supabase, saved.versionId).catch((err) => { log(`${APPLY_TOOL}: the changes panel for ${saved.versionId} could not be built: ${err?.message ?? err}`); return null; });
          if (listed?.status !== 200) return text;
          return { text, structuredContent: panelData({ versionId: saved.versionId, versionNumber: saved.versionNumber, title: doc.title, projectName: matter.name, hubUrl: link("version", saved.versionId), cards: listed.body.changes, counts: listed.body.counts, canDecide: true }) };
        } finally {
          caps.release();
        }
      },
    },
  ];
}

export default (deps) => createReviewTools(deps);
