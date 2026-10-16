// The index worker: reads project files for search, one at a time, on the
// Oracle VM (systemd unit index-worker.service, same .env as chat-service).
//
// Loop: claim_index_job -> processJob (indexing/pipeline.js) -> next job; when
// there is nothing to do, ask again every 5 seconds. One line in the journal
// per job. On SIGTERM it finishes the step it is on (an OCR page, an
// embedding batch), hands the job back with release_index_job, and exits.
import "dotenv/config";
import { hostname } from "node:os";
import { createClient } from "@supabase/supabase-js";
import { processJob, plainError } from "./indexing/pipeline.js";
import { StopRequested } from "./indexing/extract.js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const VOYAGE_KEY = process.env.VOYAGE_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const IDLE_POLL_MS = Number(process.env.INDEX_POLL_MS ?? 5_000);
const ERROR_POLL_MS = 30_000;
const MISSING_RPC_POLL_MS = 60_000;
// A scanned PDF is ~12 s a page here; 400 pages is 80 minutes.
const MAX_JOB_MS = Number(process.env.INDEX_MAX_MINUTES ?? 90) * 60_000;
const HEARTBEAT_MS = 2 * 60_000;
const WORKER = `${hostname()}:${process.pid}`;

for (const [name, value] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, VOYAGE_API_KEY: VOYAGE_KEY })) {
  if (!value) {
    console.error(`index-worker: ${name} is not set; exiting.`);
    process.exit(1);
  }
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

let stopping = false;
let wake = null; // resolves the idle sleep early on SIGTERM
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  console.log(`index-worker: ${signal} received; stopping after the current step.`);
  wake?.();
};
process.on("SIGTERM", () => stop("SIGTERM"));
process.on("SIGINT", () => stop("SIGINT"));

const sleep = (ms) => new Promise((resolve) => {
  const timer = setTimeout(resolve, ms);
  wake = () => { clearTimeout(timer); resolve(); };
});

const quote = (s) => JSON.stringify(String(s ?? "").slice(0, 300));

const isMissingFunction = (error) =>
  error && (error.code === "PGRST202" || error.code === "42883" || /could not find the function|does not exist/i.test(error.message ?? ""));

async function claim() {
  const { data, error } = await db.rpc("claim_index_job", { p_worker: WORKER });
  if (error) return { error };
  return { job: Array.isArray(data) ? data[0] ?? null : data ?? null };
}

async function runJob(job) {
  const started = Date.now();
  const deadline = started + MAX_JOB_MS;
  let lastBeat = started;
  let lost = false;
  const log = (message) => console.log(`index job=${job.id} ${message}`);
  const checkStop = () => {
    if (stopping) throw new StopRequested("worker stopping");
    if (lost) throw new StopRequested("job no longer ours");
    if (Date.now() > deadline) {
      const err = new Error(`This file took more than ${Math.round(MAX_JOB_MS / 60_000)} minutes to read and was stopped. Split it into smaller files, or upload a version with a text layer.`);
      err.permanent = true;
      throw err;
    }
  };
  const heartbeat = async () => {
    if (Date.now() - lastBeat < HEARTBEAT_MS) return;
    lastBeat = Date.now();
    const { data, error } = await db.rpc("touch_index_job", { p_job_id: job.id, p_run_id: job.run_id });
    if (!error && data !== true) lost = true;
  };

  try {
    const result = await processJob(job, { db, voyageKey: VOYAGE_KEY, anthropicKey: ANTHROPIC_KEY, log, checkStop, heartbeat });
    console.log(`index job=${job.id} version=${job.document_version_id} result=done attempt=${job.attempts} file=${quote(result.fileName)} format=${result.format} passages=${result.passages} pages=${result.pages ?? "-"} ocr_pages=${result.ocrPages} ms=${Date.now() - started}`);
  } catch (err) {
    if (err instanceof StopRequested) {
      if (stopping) {
        const { error } = await db.rpc("release_index_job", { p_job_id: job.id, p_run_id: job.run_id });
        console.log(`index job=${job.id} version=${job.document_version_id} result=released reason=${quote(err.message)}${error ? ` release_error=${quote(error.message)}` : ""} ms=${Date.now() - started}`);
      } else {
        console.log(`index job=${job.id} version=${job.document_version_id} result=abandoned reason=${quote(err.message)} ms=${Date.now() - started}`);
      }
      return;
    }
    const permanent = Boolean(err?.permanent);
    const message = plainError(err);
    const { data, error } = await db.rpc("fail_index_job", { p_job_id: job.id, p_error: message, p_retry: !permanent, p_run_id: job.run_id });
    console.log(`index job=${job.id} version=${job.document_version_id} result=${error ? "error" : data ?? "failed"} attempt=${job.attempts} permanent=${permanent} error=${quote(message)} detail=${quote(err?.message ?? err)}${error ? ` fail_error=${quote(error.message)}` : ""} ms=${Date.now() - started}`);
  }
}

async function main() {
  console.log(`index-worker: started as ${WORKER}; polling every ${IDLE_POLL_MS / 1000}s.`);
  let warnedMissing = false;
  while (!stopping) {
    const { job, error } = await claim().catch((err) => ({ error: err }));
    if (error) {
      if (isMissingFunction(error)) {
        if (!warnedMissing) console.log("index-worker: claim_index_job does not exist yet (migration 20261017090000 not applied); waiting.");
        warnedMissing = true;
        await sleep(MISSING_RPC_POLL_MS);
      } else {
        console.error(`index-worker: claim failed: ${error.message ?? error}`);
        await sleep(ERROR_POLL_MS);
      }
      continue;
    }
    warnedMissing = false;
    if (!job) {
      await sleep(IDLE_POLL_MS);
      continue;
    }
    await runJob(job);
  }
  console.log("index-worker: stopped.");
}

main().then(() => process.exit(0), (err) => {
  console.error("index-worker: crashed:", err);
  process.exit(1);
});
