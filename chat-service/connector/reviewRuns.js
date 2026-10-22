// The reviews the connector runs for claude.ai (slice 5, start_review in
// connector/tools/reviews.js): the Hub's three-pass review (review.js
// runReview, exactly as the Hub's own review route calls it, the online law
// lookup included: start_review passes research.js reviewLawLookup with the
// server-side ingest, since the connector keeps no sign-in token for the
// ingest function), run detached from the tool call, because a review of a
// long agreement takes minutes and claude.ai waits at most 240 seconds for
// a tool. The tool call returns as soon as the run row exists (runReview's
// onStarted), with its run id; get_review reads the row afterwards.
//
// When the run completes, `onComplete` files it (reviewFiling.js: the
// findings as tracked changes in the next version, decided in its Changes
// list), still inside the slot, so the placement is one more step of the
// same review and two never run at once. A stop asked for meanwhile files
// nothing rather than half (the run stays complete, and
// apply_review_to_version can file it).
//
// One review at a time in this process: a review makes several Voyage
// calls per 30,000 characters, and on the free tier (three a minute) two at
// once would hold up every search the Hub makes. The slot is claimed before
// the tool's own checks and held until the run settles, so two calls in one
// claude.ai turn cannot both start one.
//
// The connector exits five seconds after systemd says stop (connector.js),
// and a deploy restarts it. A run cut off there must not be left "running"
// (it would block the next review and get_review would wait on it forever),
// so on SIGTERM stopReviewRuns aborts each run's signal, gives it a moment
// to stop, and marks it failed with RESTART_SENTENCE inside that window. A
// process killed outright (SIGKILL, a crash) gets no such chance: at the
// next start failOrphanedRuns marks failed every run this connector started
// that is still "running", since no process is running it any more.
//
// Which runs the connector started is read from connector_actions: the
// start_review row carries the run id in its label ("Review run <id>"), so
// nothing new is needed in the database. Runs the Hub chat started
// (chat-service, its own process) are never touched here. Node 20.

import { runReview } from "../review.js";

export const START_REVIEW_TOOL = "start_review";
export const RESTART_SENTENCE = "The connector restarted during this review; start it again.";
const RUN_LABEL_PREFIX = "Review run ";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** How long start_review waits for the run row (the file is downloaded first). */
export const START_TIMEOUT_MS = 90_000;
/** How long a stop waits for an aborted run to wind down before marking it failed itself. */
export const STOP_WAIT_MS = 2_500;
/**
 * A "running" row older than this is taken as abandoned, never as a review
 * in progress: a run whose process died without marking it (chat-service
 * killed mid-review, a crash) would otherwise block every review on the
 * box for ever. Two hours is several times the longest review measured,
 * even on the Voyage free tier; the 15 October migration used one hour for
 * the same sweep.
 */
export const STALE_RUN_MS = 2 * 60 * 60 * 1000;
/** How far back the startup sweep looks for runs this connector started. */
const ORPHAN_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** The label of the start_review record that carries a run's id. */
export const runLabel = (runId) => `${RUN_LABEL_PREFIX}${runId}`;
/** The run id a start_review record's label carries, or null. */
export function runIdOfLabel(label) {
  const s = String(label ?? "");
  if (!s.startsWith(RUN_LABEL_PREFIX)) return null;
  const id = s.slice(RUN_LABEL_PREFIX.length).trim();
  return UUID_RE.test(id) ? id.toLowerCase() : null;
}

// The runs this process is running: runId -> { runId, versionId, userId,
// startedAt, controller, done } (done settles, never rejects, when the run
// ends). `held` is the process's one slot; `generation` lets the tests'
// reset disown a slot handed out before it.
const active = new Map();
let held = false;
let generation = 0;

/** Whether this process is running the run. */
export const isActiveRun = (runId) => active.has(runId);
/** The runs this process is running, oldest first (for /health and the tests). */
export const activeReviewRuns = () => [...active.values()].map(({ runId, versionId, userId, startedAt }) => ({ runId, versionId, userId, startedAt }));
/** Whether the slot is taken (a review starting or running). */
export const reviewSlotHeld = () => held;

/**
 * Takes the process's one review slot, or null when it is taken. The
 * handle's release() gives it back (a refusal after the claim); start()
 * launches the review, and the slot is then held until the run settles.
 */
export function claimReviewSlot() {
  if (held) return null;
  held = true;
  const gen = generation;
  let mine = true;
  let launched = false;
  const free = () => { if (mine) { mine = false; if (gen === generation) held = false; } };
  return {
    release() { if (!launched) free(); },
    start(opts) { launched = true; return launch(free, opts); },
  };
}

/**
 * Runs the review detached and resolves { runId } as soon as its row
 * exists; rejects with the reason when it fails before that (no such
 * version, the file could not be downloaded, the row could not be written)
 * or takes longer than startTimeoutMs to begin. `run` is review.js
 * runReview (a test passes a stand-in with the same contract: it calls
 * onStarted(runId) once the row is in, honours the signal, and settles when
 * the review is complete or failed). `lookUpLaw(signal)` makes the run's
 * law lookup (null: none); `onComplete({ runId, signal })` runs after a
 * complete run, before the slot is given back, and never fails the run.
 */
function launch(free, { supabase, anthropicKey, voyageKey, versionId, userId, run = runReview, lookUpLaw = null, onComplete = null, startTimeoutMs = START_TIMEOUT_MS, log = () => {}, now = () => Date.now() }) {
  const controller = new AbortController();
  return new Promise((resolve, reject) => {
    let runId = null;
    let answered = false;
    let done = null;
    const answer = (fn, value) => { if (!answered) { answered = true; fn(value); } };
    const timer = setTimeout(() => {
      // The run is told to stop and the slot is given back: a run that
      // still reaches its row after this fails there (onStarted throws),
      // before any search or pass, so two never run at once.
      controller.abort(new Error("The review did not start in time."));
      free();
      answer(reject, new Error(`The review did not start within ${Math.round(startTimeoutMs / 1000)} seconds; nothing was reviewed. Try again in a few minutes.`));
    }, startTimeoutMs);
    timer.unref?.();
    const onStarted = (id) => {
      if (controller.signal.aborted) throw new Error("The review did not start in time; start it again.");
      runId = id;
      active.set(id, { runId: id, versionId, userId, startedAt: now(), controller, done });
      clearTimeout(timer);
      log(`review ${id} started on version ${versionId} for ${userId}`);
      answer(resolve, { runId: id });
    };
    // Detached: the tool call is answered from onStarted, not from here.
    setImmediate(() => {
      const running = Promise.resolve().then(() => run({
        supabase, anthropicKey, voyageKey, documentVersionId: versionId, userId,
        lookUpLaw: typeof lookUpLaw === "function" ? lookUpLaw(controller.signal) : null,
        notice: (text) => log(`review ${runId ?? "(starting)"}: ${text}`),
        signal: controller.signal,
        onStarted,
      }));
      done = running.then(
        async (result) => {
          log(`review ${runId} complete: ${result?.suggestions?.length ?? 0} findings`);
          if (!onComplete || !runId) return;
          try {
            await onComplete({ runId, signal: controller.signal });
          } catch (err) {
            log(`review ${runId}: filing failed: ${err?.message ?? err}`);
          }
        },
        (err) => {
          log(`review ${runId ?? "(not started)"} on version ${versionId} failed: ${err?.message ?? err}`);
          answer(reject, err instanceof Error ? err : new Error(String(err)));
        },
      ).finally(() => {
        clearTimeout(timer);
        if (runId) active.delete(runId);
        free();
      });
      // run() starts in a microtask, after this line: onStarted finds `done` set.
    });
  });
}

/**
 * On SIGTERM (connector.js): every run in this process is aborted, given up
 * to waitMs to wind down (its own catch marks it failed with the abort's
 * words), then marked failed with RESTART_SENTENCE, which is what
 * get_review tells the lawyer. A run that completed meanwhile is left
 * complete. Returns how many runs were stopped. Never throws.
 */
export async function stopReviewRuns({ supabase, waitMs = STOP_WAIT_MS, log = () => {} }) {
  const entries = [...active.values()];
  if (!entries.length) return 0;
  for (const e of entries) e.controller.abort(new Error(RESTART_SENTENCE));
  let timer = null;
  await Promise.race([
    Promise.all(entries.map((e) => e.done ?? Promise.resolve())),
    new Promise((r) => { timer = setTimeout(r, waitMs); }),
  ]);
  clearTimeout(timer);
  await Promise.all(entries.map(async (e) => {
    try {
      const { error } = await supabase.from("ai_review_runs").update({ status: "failed", error: RESTART_SENTENCE }).eq("id", e.runId).neq("status", "complete");
      if (error) throw new Error(error.message);
      log(`review ${e.runId} marked failed: the connector is stopping`);
    } catch (err) {
      log(`review ${e.runId} could not be marked failed while stopping: ${err?.message ?? err}`);
    }
  }));
  return entries.length;
}

/** Of these run ids, the ones the connector started (a start_review record names them). */
export async function connectorRunIds(supabase, runIds) {
  const ids = [...new Set((runIds ?? []).filter(Boolean))];
  if (!ids.length) return new Set();
  const { data, error } = await supabase.from("connector_actions").select("label").eq("tool", START_REVIEW_TOOL).in("label", ids.map(runLabel));
  if (error) throw new Error(`Which reviews came from claude.ai could not be read: ${error.message}`);
  return new Set((data ?? []).map((r) => runIdOfLabel(r.label)).filter(Boolean));
}

/**
 * At startup (connector.js): every run this connector started in the last
 * week that is still "running" is an orphan (no process is running it), so
 * it is marked failed with RESTART_SENTENCE. Returns how many. Never throws:
 * a sweep that cannot run must not stop the connector starting.
 */
export async function failOrphanedRuns({ supabase, now = () => Date.now(), log = () => {} }) {
  try {
    const since = new Date(now() - ORPHAN_LOOKBACK_MS).toISOString();
    const { data, error } = await supabase.from("connector_actions").select("label").eq("tool", START_REVIEW_TOOL).eq("outcome", "done").gte("created_at", since);
    if (error) throw new Error(error.message);
    const ids = [...new Set((data ?? []).map((r) => runIdOfLabel(r.label)).filter((id) => id && !active.has(id)))];
    if (!ids.length) return 0;
    const { data: marked, error: markError } = await supabase.from("ai_review_runs").update({ status: "failed", error: RESTART_SENTENCE }).in("id", ids).eq("status", "running").select("id");
    if (markError) throw new Error(markError.message);
    if (marked?.length) log(`${marked.length} review${marked.length === 1 ? "" : "s"} left running by an earlier connector process marked failed`);
    return marked?.length ?? 0;
  } catch (err) {
    log(`the sweep for reviews left running could not run: ${err?.message ?? err}`);
    return 0;
  }
}

/** Forgets every run and frees the slot (tests only). */
export function resetReviewRuns() {
  active.clear();
  held = false;
  generation += 1;
}
