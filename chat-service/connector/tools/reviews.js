// Slice 5 of the connector: the Hub's review, from claude.ai.
//
// "Review v3 of the SPA" runs the Hub's own three-pass review (review.js:
// legal clauses and citations, formatting and structure, content and
// conflicts, against the firm's precedents, the law library and the
// project's other documents) on a Word version; "what did the review find?"
// reads its findings; "put all but 4 and 9 into the file" writes the rest
// into the lawyer's file as tracked changes, filed as the next version.
// Three tools serve that:
//
// start_review (write: it records a review run, and changes no document):
// starts the review detached on the server (connector/reviewRuns.js) and
// answers within seconds with the run id. One review on the box at a time,
// the Hub chat's own included, because on the Voyage free tier (three calls
// a minute) a review's searches hold up every other search; one per
// process; a second review of a version already being reviewed is refused;
// three a day per person, counted from connector_actions. No online law
// lookup (it needs the person's own sign-in, which the connector does not
// keep). The start_review record carries the run id in its label.
//
// get_review (read): the run's status, passes, coverage and error, and its
// findings by clause, each numbered, with its original wording, suggested
// wording, reason and pass, paged under the result cap. The numbers are
// what apply_review_to_version's `exclude` takes.
//
// apply_review_to_version (write): the findings, less any the lawyer left
// out, as tracked changes by "AKLA AI" in the reviewed version's working
// file (docxAgent applyReviewSuggestions, as the Hub chat's review writes
// them, server.js writeReviewChanges), filed as the next version of the
// same document. Refused unless the run is complete, and when the document
// has a newer version than the one reviewed (the findings quote that
// version's text). The placed changes are recorded on the new version as
// its Changes list (versionChanges.js rows, review_type 'edit', the Word
// revision ids each minted), so they are accepted or rejected in the panel
// under the reply (the MCP Apps trial), in the Hub's document window or in
// Word, exactly as a mark-up's are; the review's own rows on the reviewed
// version say where each went: placed (carried to the new version, as
// carryForward marks a carried change), could not be placed (with the
// reason), or left out at the lawyer's word (rejected, by them).
//
// The write foundation's order holds (README.md): checkCaps first, the
// work, recordAction last, release() in a finally. Node 20.

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { WRITE } from "../app.js";
import { MAX_RESULT_CHARS, uuid, when } from "../tools.js";
import { applyReviewSuggestions, suggestionParagraphs } from "../../docxAgent.js";
import { checkFormat } from "../../formatFingerprint.js";
import { reconcile, placementNote, codeFor } from "../../changes.js";
import { workingFileOf, downloadFile, versionRows, highestRecordedVersionId, latestVersionOf, carryForward, isWordPath, VERSION_ROW_TYPE, DOCX_MIME } from "../../versionChanges.js";
import { CHANGES_UI } from "../apps.js";
import { panelForVersion } from "./changesPanel.js";
import {
  claimReviewSlot, isActiveRun, connectorRunIds, runLabel, START_REVIEW_TOOL, RESTART_SENTENCE, STALE_RUN_MS, START_TIMEOUT_MS,
} from "../reviewRuns.js";
import { runReview } from "../../review.js";

export const START_TOOL = START_REVIEW_TOOL;
export const GET_TOOL = "get_review";
export const APPLY_TOOL = "apply_review_to_version";
/** Reviews one person may start from claude.ai in a day (owner decision 3). */
export const DAILY_REVIEWS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_LABEL_CHARS = 200;
const MAX_FINDINGS = 500;
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

/** The passes, in the order they are listed, and what the lawyer reads for each. */
const PASSES = ["legal_clauses", "formatting", "content_conflicts", "chat"];
const PASS_LABEL = { legal_clauses: "legal clauses and citations", formatting: "formatting and structure", content_conflicts: "content and conflicts", chat: "follow-up" };
const passLabel = (t) => PASS_LABEL[t] ?? String(t ?? "review").replace(/_/g, " ");

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Karachi" });
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

/** "Review suggestions placed — 22 October 2026", the lawyer's label in front when given. */
export function reviewLabel(label, at = new Date()) {
  const base = `Review suggestions placed — ${dateFmt.format(at)}`;
  const own = String(label ?? "").replace(/\s+/g, " ").trim();
  if (!own) return base;
  const room = MAX_LABEL_CHARS - base.length - 2;
  return `${own.length > room ? `${own.slice(0, room - 1)}…` : own}: ${base}`;
}

// ---------------------------------------------------------------- the order of the findings

// A clause reference's numbers ("Section 14.2" -> [14, 2]), or null.
function clauseKey(ref) {
  const m = /(\d+(?:\.\d+)*)/.exec(String(ref ?? ""));
  return m ? m[1].split(".").map(Number) : null;
}

/**
 * The findings in the order get_review numbers them and apply's `exclude`
 * reads the numbers: by clause number (references without one after), then
 * by reference, by pass, and by id, so the numbering is the same on every
 * call. complete_ai_review inserts a run's rows in one statement, so their
 * times do not order them.
 */
export function orderFindings(rows) {
  const passAt = (t) => { const i = PASSES.indexOf(t); return i === -1 ? PASSES.length : i; };
  return [...(rows ?? [])].sort((a, b) => {
    const ka = clauseKey(a.clause_reference);
    const kb = clauseKey(b.clause_reference);
    if (ka && !kb) return -1;
    if (!ka && kb) return 1;
    if (ka && kb) {
      for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
        const d = (ka[i] ?? -1) - (kb[i] ?? -1);
        if (d) return d;
      }
    }
    return String(a.clause_reference ?? "").localeCompare(String(b.clause_reference ?? ""), "en", { numeric: true })
      || passAt(a.review_type) - passAt(b.review_type)
      || String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""))
      || String(a.id).localeCompare(String(b.id));
  });
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

// ---------------------------------------------------------------- the tools

/**
 * The tools, with the pieces a test swaps: `run` in place of review.js
 * runReview (the same contract: onStarted(runId) once the row is in, the
 * signal honoured), `apply` in place of applyReviewSuggestions, `format` in
 * place of checkFormat, `startTimeoutMs`. `deps` is what tools.js hands
 * every module; `deps.anthropicKey` is the review's AI key (null when the
 * server has none: start_review then says so).
 */
export function createReviewTools(deps, { run = runReview, apply = applyReviewSuggestions, format = checkFormat, startTimeoutMs = START_TIMEOUT_MS } = {}) {
  const { supabase, helpers, writes, log = () => {} } = deps;
  const { needVersion, versionById, versionName, open, link } = helpers;
  const now = () => { const t = typeof deps.now === "function" ? deps.now() : Date.now(); return t instanceof Date ? t.getTime() : Number(t); };
  const at = () => new Date(now());
  const COLUMNS = "id, version_number, storage_path, file_name, label, created_at, matter_document_id";
  // One placement at a time in this process (a long agreement read whole and
  // rewritten is a few hundred MB resident, as markup.js's lock says).
  let applying = false;

  /** The run row, or a sentence saying there is none. */
  async function needRun(input) {
    const id = uuid(input.runId);
    if (!id) throw new Error(`runId must be a review's run id (a UUID), as ${START_TOOL} gave it.`);
    const { data, error } = await supabase.from("ai_review_runs").select("id, document_version_id, artifact_id, status, passes, coverage, error, created_at, created_by").eq("id", id).maybeSingle();
    if (error) throw new Error(`Could not read the review: ${error.message}`);
    if (!data) throw new Error(`There is no review with that run id. ${START_TOOL} starts one and gives its runId.`);
    if (!data.document_version_id) throw new Error("That review ran inside a Hub chat on its working document; its findings are in that chat's Changes list in the Hub, not here.");
    return data;
  }

  /** The review's findings, in get_review's order. */
  async function findingsOf(run) {
    const { data, error } = await supabase
      .from("redline_suggestions")
      .select("id, clause_reference, original_text, suggested_text, rationale, review_type, status, placement, placement_reason, superseded_by, created_at")
      .eq("review_run_id", run.id)
      .eq("document_version_id", run.document_version_id)
      .limit(MAX_FINDINGS);
    if (error) throw new Error(`Could not read the review's findings: ${error.message}`);
    return orderFindings(data ?? []);
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

  return [
    // ------------------------------------------------------------ start
    {
      name: START_TOOL,
      title: "Start the Hub's review of a Word document",
      description: `Start the Hub's own three-pass review of one Word version of a project document: legal clauses and citations, formatting and structure, and content and conflicts, checked against the firm's precedents, its law library and the project's other documents (no online law lookup). Use it when the lawyer asks to review a Hub document ("review v3 of the SPA"). It answers within seconds with a runId while the review runs on the Hub's server; a short agreement takes a few minutes, a long one much longer. Then call ${GET_TOOL} with the runId for progress and, once it is complete, the findings by clause. Nothing in the document changes: ${APPLY_TOOL} later places the findings as tracked changes in a new version, when the lawyer asks. Word (.docx) versions only. One review runs on the Hub at a time (the Hub chat's included), a second review of the same version is refused while one runs, and each person may start ${DAILY_REVIEWS} a day; a refusal is one sentence, and nothing is started. claude.ai asks the lawyer first, and the start is recorded against them. The review's findings are suggestions, not legal approval.`,
      inputSchema: {
        versionId: z.string().describe("The Word version's id, from list_project_documents (or the \"versionId:\" line the lawyer pasted)."),
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
            await refuse(`${versionName(version)} is a ${kind} file. The review is started from claude.ai on Word (.docx) versions only, because its findings are placed back as tracked changes; read_document reads this one, and you can review its text here in the chat, or run the Hub's review in the Hub.`);
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
            ({ runId } = await slot.start({ supabase, anthropicKey: deps.anthropicKey, voyageKey: deps.voyageKey, versionId: version.id, userId: ctx.userId, run, startTimeoutMs, log, now }));
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
            `The three passes (legal clauses and citations, formatting and structure, content and conflicts) run on the Hub's server against the firm's precedents, its law library and the project's other documents; no online law lookup is run from claude.ai. A short agreement takes a few minutes, a long one much longer. Call ${GET_TOOL} with this runId in a minute or two for progress and, when it is complete, the findings by clause. Nothing in the document changes until ${APPLY_TOOL} places the findings as tracked changes in a new version.`,
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
      title: "Read a review's progress and findings",
      description: `A review started with ${START_TOOL}: while it runs, how far it has got; once complete, each pass's status and findings count, what it covered, and every finding by clause, numbered, with the original wording, the suggested wording, the reason and the pass (paged: from is the finding number to start at); if it failed, why. Use it when the lawyer asks what the review found. The finding numbers and suggestionIds are what ${APPLY_TOOL}'s exclude takes ("put all but 4 and 9 into the file"). Nothing is changed by this tool, and the findings are suggestions, not legal approval.`,
      inputSchema: {
        runId: z.string().describe(`The runId ${START_TOOL} gave.`),
        from: z.number().int().min(1).optional().describe("The finding number to start at, for a long list. Default 1."),
      },
      async run(input) {
        const r = await needRun(input);
        const version = await versionById(r.document_version_id, COLUMNS);
        const name = version ? versionName(version) : "the reviewed version";
        const project = version?.matter_document?.matter?.name;
        const age = now() - new Date(r.created_at).getTime();
        const head = [
          `Review of ${name}${project ? ` on ${project}` : ""}, started ${when(r.created_at)}.`,
          `runId: ${r.id}`,
          `versionId: ${r.document_version_id}`,
          open("version", r.document_version_id),
        ];
        if (r.status === "running") {
          const stopped = await stoppedSentence(r);
          if (stopped) return [...head, "", `Status: stopped without finishing. ${stopped}`].join("\n");
          const c = r.coverage ?? {};
          const sections = Number.isInteger(c.sectionsTotal) && c.sectionsTotal > 0 ? `; ${c.sectionsCompleted ?? 0} of ${c.sectionsTotal} ${plural(c.sectionsTotal, "section")} of the document checked` : "";
          return [...head, "", `Status: still running (started ${ago(age)} ago${sections}). Call ${GET_TOOL} again with the same runId in a minute or two; the findings are listed once it is complete.`].join("\n");
        }
        if (r.status === "failed") {
          return [...head, "", `Status: failed. ${r.error ? oneLine(r.error) : "No reason was recorded."}${r.error === RESTART_SENTENCE ? "" : ` Nothing from it can be placed; start it again with ${START_TOOL}.`}`].join("\n");
        }

        // Complete: the passes, the coverage, then the findings by clause.
        const rows = await findingsOf(r);
        const out = [...head, "", `Status: complete. ${rows.length} ${plural(rows.length, "finding")}.`, "", "PASSES"];
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
        out.push("", `COVERAGE: ${covered.length ? `${covered.join("; ")}.` : "not recorded."} No online law lookup was run: the law it compared against is the firm's law library. ${NOT_EXHAUSTIVE}`);
        if (!rows.length) {
          out.push("", "The review found nothing to change. That is not a clearance: see each pass's status above.");
          return out.join("\n");
        }

        const placedIn = rows.some((x) => x.placement === "superseded" && x.superseded_by);
        const from = Number.isInteger(input.from) && input.from > 0 ? input.from : 1;
        if (from > rows.length) return [...out, "", `There is no finding ${from}: the review has ${rows.length}.`].join("\n");
        out.push("", `FINDINGS BY CLAUSE (${rows.length}; the numbers and suggestionIds are what ${APPLY_TOOL}'s exclude takes):`);
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
          : placedIn
            ? "[End of the findings. They have been placed in a later version: see each finding's note, and decide them there.]"
            : `[End of the findings. To place them in the file as tracked changes in a new version, call ${APPLY_TOOL} with this runId, and exclude the numbers the lawyer wants left out; only when the lawyer asks.]`;
        return `${headText}\n\n${shown.join("\n\n")}\n\n${tail}`;
      },
    },

    // ------------------------------------------------------------ apply
    {
      name: APPLY_TOOL,
      title: "Place a review's findings in the file as tracked changes",
      description: `Write a complete review's findings into the reviewed Word version as real tracked changes by "AKLA AI", in the lawyer's own file, and file the result as the NEXT version of the same document; nothing is accepted, and the lawyer accepts or rejects each change in the panel under the reply where Claude shows one, in the Hub's Changes list, or in Word. Use it when the lawyer asks to put the review's suggestions into the document ("put all but 4 and 9 into the file"): exclude takes the finding numbers or suggestionIds ${GET_TOOL} printed, for the ones to leave out (recorded as rejected by the lawyer). Refused, with nothing saved, unless the review is complete, and when the document has a newer version than the one reviewed (the findings quote that version's words; start a fresh review of the newest). A finding whose quoted wording is not found once in the file is not placed, and is named with the reason. It always saves a NEW version, never over one, and claude.ai asks the lawyer before it runs; every save is recorded against the lawyer. Returns how many were placed, left out and could not be placed, the new version's id and its Hub page. Filing is not legal approval.`,
      inputSchema: {
        runId: z.string().describe(`The runId ${START_TOOL} gave (the review must be complete).`),
        exclude: z.array(z.union([z.number().int(), z.string()])).max(MAX_EXCLUDE).optional().describe(`Optional: the findings to leave out, as the numbers ${GET_TOOL} printed (e.g. [4, 9]) or their suggestionIds.`),
        label: z.string().optional().describe("Optional: a short label for the new version, e.g. \"Review comments for the client\". \"Review suggestions placed\" and the date are added."),
      },
      write: true,
      annotations: WRITE,
      // The MCP Apps trial (CONNECTOR_APPS=on): the changes panel under the
      // reply, drawn from the new version's Changes list.
      ui: CHANGES_UI,
      async run(input, ctx) {
        const caps = await writes.checkCaps(ctx);
        let locked = false;
        try {
          const r = await needRun(input);
          const version = await needVersion({ versionId: r.document_version_id }, COLUMNS);
          const doc = version.matter_document;
          const matter = doc.matter;
          const record = (fields) => writes.recordAction(ctx, { tool: APPLY_TOOL, projectId: matter.id, documentId: doc.id, ...fields }).catch((err) => { log(`${APPLY_TOOL}: the record could not be written: ${err?.message ?? err}`); return null; });
          const refuse = async (sentence) => { await record({ versionId: version.id, outcome: "refused" }); throw new Error(sentence); };

          if (r.status === "running") {
            const stopped = await stoppedSentence(r);
            await refuse(stopped ? `That review stopped without finishing, so it has nothing to place. ${stopped}` : `That review is still running (started ${ago(now() - new Date(r.created_at).getTime())} ago), so nothing was placed; call ${GET_TOOL} until it is complete.`);
          }
          if (r.status !== "complete") await refuse(`That review ${r.status === "failed" ? `failed${r.error ? ` (${oneLine(r.error)})` : ""}` : `is ${r.status}`}, so it has nothing to place; start it again with ${START_TOOL}.`);
          if (!isWordPath(version.storage_path)) await refuse(`${versionName(version)} is not a Word file, so the findings cannot be placed as tracked changes.`);
          const latest = await latestVersionOf(supabase, version.matter_document_id);
          if (latest && latest.id !== version.id) {
            await refuse(`A newer version of ${doc.title} exists (v${latest.version_number}, versionId ${latest.id}), so nothing was placed: the review's findings quote v${version.version_number}'s words. Start a fresh review of v${latest.version_number} with ${START_TOOL}, or ask for the findings to be made as a mark-up of v${latest.version_number} (show_document_paragraphs, then apply_tracked_changes).\n${open("version", latest.id)}`);
          }

          // The findings, numbered as get_review printed them, and the ones
          // the lawyer left out.
          const rows = await findingsOf(r);
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
          const numberOf = new Map(rows.map((x, i) => [x.id, i + 1]));
          const waiting = (x) => x.status === "pending" && (x.placement == null || x.placement === "placed");
          const chosen = rows.filter((x) => !excluded.has(x.id) && waiting(x));
          const decidedBefore = rows.filter((x) => !excluded.has(x.id) && !waiting(x));
          if (!chosen.length) await refuse(`None of the review's findings is left to place (${excluded.size} left out, ${decidedBefore.length} already decided or placed), so nothing was saved.`);

          if (applying) await refuse(APPLY_BUSY_SENTENCE);
          applying = true; locked = true;

          // The version's working file (its own, or the copy its decisions
          // in the Hub were kept in), the findings written in with ids above
          // every id this document has used, then the format gate against
          // that file, as the Hub chat's review does.
          const file = await workingFileOf(supabase, version);
          const bytes = await downloadFile(supabase, file);
          let out;
          try {
            const idFloor = Math.max(9000, await highestRecordedVersionId(supabase, doc.id));
            out = apply(bytes, chosen.map((x, i) => ({ id: i, original: x.original_text, suggested: x.suggested_text, accepted: false, clause: x.clause_reference ?? null })), { idFloor });
          } catch (err) {
            await record({ versionId: version.id, outcome: "failed" });
            throw new Error(`The findings could not be written into ${versionName(version)}: ${err?.message ?? err}. Nothing was saved.`);
          } finally {
            applying = false; locked = false;
          }
          const results = out.results;
          const placed = results.filter((x) => x.status === "applied");
          const notPlaced = results.filter((x) => x.status !== "applied");
          const why = (x) => placementNote(codeFor(x.reason)) ?? x.reason ?? "no reason given";
          const findingLine = (x) => { const s = chosen[x.id]; return `Finding ${numberOf.get(s.id)}${s.clause_reference ? ` — ${oneLine(s.clause_reference)}` : ""}`; };
          if (!placed.length) {
            await refuse(`None of the ${chosen.length} ${plural(chosen.length, "finding")} could be placed, so nothing was saved: ${notPlaced.slice(0, 8).map((x) => `${findingLine(x)}: ${why(x)}`).join("; ")}.`);
          }
          const gate = format(out.bytes, bytes, { base: file.fileName, subject: "the version it was made from" });
          log(`${APPLY_TOOL}: format ${gate.result.status}${gate.refused ? " (refused)" : ""}`);
          if (gate.refused) await refuse(`${gate.text} v${version.version_number} is unchanged.`);
          // The file must still be the one written into: a decision in the
          // Hub meanwhile moves the working file on.
          const now2 = await workingFileOf(supabase, version);
          if (now2.storagePath !== file.storagePath) await refuse(`A change in v${version.version_number} was decided in the Hub while the findings were being placed, so nothing was saved; call ${APPLY_TOOL} again.`);

          let saved;
          try {
            saved = await writes.saveVersion({
              ctx, projectId: matter.id, title: doc.title, matterDocumentId: doc.id, expectedVersion: version.id,
              bytes: out.bytes, fileName: `${doc.title}.docx`, mime: DOCX_MIME,
              labelVerbatim: reviewLabel(typeof input.label === "string" ? input.label.slice(0, MAX_LABEL_CHARS) : null, at()),
            });
          } catch (err) {
            await record({ versionId: version.id, outcome: "failed" });
            throw err;
          }

          const rowsLine = await recordRows({ supabase, version, saved, bytes: out.bytes, chosen, results, userId: ctx.userId, log });
          const leftOutLine = await markExcluded({ supabase, ids: [...excluded], userId: ctx.userId, at: at(), log });
          const recorded = await record({ versionId: saved.versionId, label: saved.label, outcome: "saved" });
          log(`${APPLY_TOOL}: run ${r.id}, v${version.version_number} → v${saved.versionNumber} of ${doc.id}: ${placed.length} placed, ${notPlaced.length} not, ${excluded.size} left out`);

          const excludedNumbers = [...excluded].map((id) => numberOf.get(id)).sort((a, b) => a - b);
          const lines = [
            `Placed the review's findings in "${doc.title}" v${version.version_number} and filed the result as v${saved.versionNumber} (${saved.fileName}), the next version of the document on ${matter.name}, labelled "${saved.label}".`,
            `Findings: ${placed.length} of ${rows.length} placed as tracked changes by AKLA AI; ${excluded.size} left out at the lawyer's word${excludedNumbers.length ? ` (${excludedNumbers.slice(0, 40).join(", ")}${excludedNumbers.length > 40 ? ", …" : ""})` : ""}; ${notPlaced.length} could not be placed${decidedBefore.length ? `; ${decidedBefore.length} already decided or placed before, left as they were` : ""}.`,
            "Placed:",
            ...placed.slice(0, MAX_LISTED).map((x) => `- ${findingLine(x)}: ${clip(oneLine(x.original ?? ""), 90)}`),
            ...(placed.length > MAX_LISTED ? [`- and ${placed.length - MAX_LISTED} more`] : []),
          ];
          if (notPlaced.length) {
            lines.push("Could not be placed (nothing changed there):");
            for (const x of notPlaced.slice(0, MAX_LISTED)) lines.push(`- ${findingLine(x)}: ${why(x)}`);
            if (notPlaced.length > MAX_LISTED) lines.push(`- and ${notPlaced.length - MAX_LISTED} more`);
          }
          lines.push(
            gate.text,
            rowsLine,
            ...(leftOutLine ? [leftOutLine] : []),
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
          const structuredContent = await panelForVersion(supabase, {
            versionId: saved.versionId, versionNumber: saved.versionNumber, title: doc.title, projectName: matter.name,
            hubUrl: link("version", saved.versionId), bytes: out.bytes, canDecide: true,
          }).catch((err) => { log(`${APPLY_TOOL}: the changes panel for ${saved.versionId} could not be built: ${err?.message ?? err}`); return null; });
          return structuredContent ? { text, structuredContent } : text;
        } finally {
          if (locked) applying = false;
          caps.release();
        }
      },
    },
  ];
}

/**
 * The new version's Changes list, written after the save (the rows need its
 * id): the reviewed version's own waiting AKLA AI changes carried forward
 * (their revisions are in this file too), then one row per finding placed,
 * as versionChanges.js rows (review_type 'edit', anchored to the new
 * version, the Word revision ids it minted; the pass and reason in its
 * "why"), then what this placement did to the carried ones. The review's
 * own rows on the reviewed version then say where each went: placed (moved
 * to the new version's row, as a carried change is) or could not be placed
 * (with the reason). Returns the reply's line; a failure is said, never
 * thrown: the version is filed and its changes are in the file, decidable
 * in Word.
 */
async function recordRows({ supabase, version, saved, bytes, chosen, results, userId, log }) {
  try {
    const earlier = await versionRows(supabase, version.id);
    const { clones, carried } = carryForward(earlier, { toVersionId: saved.versionId, toVersionNumber: saved.versionNumber });
    const rows = [];
    const moved = [];
    const unplaced = [];
    for (const res of results) {
      const finding = chosen[res.id];
      if (!finding) continue;
      if (res.status !== "applied") { unplaced.push({ id: finding.id, patch: { placement: "unplaced", placement_reason: codeFor(res.reason) ?? "not_found" } }); continue; }
      const id = randomUUID();
      rows.push({
        id, document_version_id: saved.versionId, artifact_id: null, thread_id: null, message_id: null, review_run_id: null,
        review_type: VERSION_ROW_TYPE, op: "replace", part: res.part ?? "word/document.xml", paragraph_index: res.paragraphIndex ?? null,
        clause_reference: finding.clause_reference ?? res.clause ?? null,
        original_text: res.original ?? "", suggested_text: res.suggested ?? "",
        rationale: `Review (${passLabel(finding.review_type)}): ${oneLine(finding.rationale ?? "")}`.slice(0, 4000),
        status: "pending", revision_ids: res.revisionIds ?? [], placement: "placed", placement_reason: null, created_by: userId,
      });
      res.rowId = id;
      moved.push({ id: finding.id, patch: { placement: "superseded", placement_reason: `Placed in v${saved.versionNumber} as a tracked change; decide it there.`, superseded_by: id } });
    }
    const all = [...clones, ...rows];
    if (all.length) {
      const { error } = await supabase.from("redline_suggestions").insert(all).select("id");
      if (error) throw new Error(error.message);
    }
    for (const { id, patch } of carried) await supabase.from("redline_suggestions").update(patch).eq("id", id);
    // A carried change a finding rewrote is "Replaced by change N" in the
    // new version's list (applyReviewSuggestions' takesOver).
    const overtaken = clones.length ? reconcile(bytes, clones, results) : [];
    for (const { id, patch } of overtaken) await supabase.from("redline_suggestions").update(patch).eq("id", id);
    for (const { id, patch } of [...moved, ...unplaced]) await supabase.from("redline_suggestions").update(patch).eq("id", id);
    const gone = new Set(overtaken.filter((p) => p.patch.placement).map((p) => p.id));
    const waiting = rows.length + clones.filter((c) => !gone.has(c.id)).length;
    const parts = [`${waiting} ${plural(waiting, "change is", "changes are")} waiting in v${saved.versionNumber}'s Changes list in the Hub: accept or reject each there (the document window beside the chat), in the panel under this reply where Claude shows one, or in Word.`];
    if (clones.length) parts.push(`${clones.length} AKLA AI ${plural(clones.length, "change")} still waiting on v${version.version_number} ${clones.length === 1 ? "was" : "were"} carried forward to this version${gone.size ? `, ${gone.size} of them overtaken by a finding` : ""}.`);
    return parts.join(" ");
  } catch (err) {
    log(`${APPLY_TOOL}: the change rows for ${saved.versionId} could not be written: ${err?.message ?? err}`);
    return `The findings are in the file as tracked changes, but the Hub could not list them in v${saved.versionNumber}'s Changes list (${err?.message ?? err}); accept or reject them in Word, and tell the Hub's owner.`;
  }
}

/** The findings the lawyer left out, recorded as rejected by them. Returns a line only when that failed. */
async function markExcluded({ supabase, ids, userId, at, log }) {
  if (!ids.length) return null;
  const { error } = await supabase.from("redline_suggestions").update({ status: "rejected", decided_by: userId, decided_at: at.toISOString() }).in("id", ids);
  if (!error) return null;
  log(`${APPLY_TOOL}: the left-out findings could not be marked rejected: ${error.message}`);
  return `The ${ids.length} ${plural(ids.length, "finding")} left out could not be marked as rejected in the review (${error.message}); they are not in the file either way.`;
}

export default (deps) => createReviewTools(deps);
