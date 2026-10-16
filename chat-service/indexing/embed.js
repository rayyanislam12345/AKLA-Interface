// voyage-law-2 embeddings for the index, with batching inside the request
// limits and retries that honour Retry-After.
//
// truncation is false: an input over the model's 16,000-token context is an
// error, not a silently clipped vector. The chunker keeps passages near 800
// tokens, so this only ever fires on a bug, and the job fails loudly.

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
export const VOYAGE_MODEL = "voyage-law-2";
export const EMBEDDING_DIMENSIONS = 1024;
// Voyage allows 120k tokens and 1,000 inputs per request for voyage-law-2.
// Estimated at 3 characters a token (dense numeric text tokenizes worse than
// prose: a batch estimated at 100k at 4 chars/token came back as 123k).
const BATCH_TOKENS = Number(process.env.VOYAGE_BATCH_TOKENS ?? 90_000);
const BATCH_ITEMS = Number(process.env.VOYAGE_BATCH_ITEMS ?? 128);
const CHARS_PER_TOKEN = 3;
// On Voyage's free tier (3 requests a minute) set this to ~21000.
const MIN_INTERVAL_MS = Number(process.env.VOYAGE_MIN_INTERVAL_MS ?? 0);

export const isRetryableStatus = (status) => status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;

/** Retry-After as milliseconds: delta-seconds or an HTTP date. null when absent or unreadable. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/**
 * How long to wait before retry number `attempt` (1 = first retry):
 * the server's Retry-After when it gave one (capped), else exponential
 * backoff from baseMs with full jitter, capped at maxMs.
 */
export function retryDelayMs(attempt, retryAfter, { baseMs = 1000, maxMs = 60_000, random = Math.random } = {}) {
  const told = parseRetryAfter(retryAfter);
  if (told !== null) return Math.min(told, 5 * 60_000);
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** An error from an HTTP call; `retryable` says whether trying again may help. */
export class HttpError extends Error {
  constructor(message, { status = null, retryable = false, retryAfter = null } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
}

/**
 * Runs `call` (which throws HttpError, or any error for a network failure)
 * until it succeeds, a non-retryable error comes back, or attempts run out.
 */
export async function withRetry(call, { attempts = 6, wait = sleep, onRetry, baseMs, maxMs, random } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await call(attempt);
    } catch (err) {
      lastError = err;
      const retryable = err instanceof HttpError ? err.retryable : !(err?.permanent);
      if (!retryable || attempt === attempts) throw err;
      const delay = retryDelayMs(attempt, err?.retryAfter ?? null, { baseMs, maxMs, random });
      onRetry?.({ attempt, delay, error: err });
      await wait(delay);
    }
  }
  throw lastError;
}

/** Splits inputs into request-sized batches (by item count and estimated tokens). */
export function batchInputs(inputs, { maxItems = BATCH_ITEMS, maxTokens = BATCH_TOKENS, charsPerToken = CHARS_PER_TOKEN } = {}) {
  const batches = [];
  let current = [];
  let tokens = 0;
  inputs.forEach((input, index) => {
    const t = Math.ceil(input.length / charsPerToken);
    if (current.length && (current.length >= maxItems || tokens + t > maxTokens)) {
      batches.push(current);
      current = [];
      tokens = 0;
    }
    current.push(index);
    tokens += t;
  });
  if (current.length) batches.push(current);
  return batches;
}

let lastRequestAt = 0;

/**
 * Embeds documents with voyage-law-2. Returns one 1024-number vector per input, in order.
 * @param {string[]} inputs
 * @param {{ apiKey: string, fetchImpl?: typeof fetch, log?: (msg: string) => void, checkStop?: () => void }} options
 */
export async function embedDocuments(inputs, { apiKey, fetchImpl = fetch, log = () => {}, checkStop } = {}) {
  if (!apiKey) throw new Error("VOYAGE_API_KEY is not set");
  const vectors = new Array(inputs.length);
  for (const batch of batchInputs(inputs)) {
    checkStop?.();
    const data = await withRetry(async () => {
      const gap = MIN_INTERVAL_MS - (Date.now() - lastRequestAt);
      if (gap > 0) await sleep(gap);
      lastRequestAt = Date.now();
      let resp;
      try {
        resp = await fetchImpl(VOYAGE_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: VOYAGE_MODEL, input: batch.map((i) => inputs[i]), input_type: "document", truncation: false }),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (err) {
        throw new HttpError(`Voyage request failed: ${err?.message ?? err}`, { retryable: true });
      }
      if (!resp.ok) {
        const body = (await resp.text().catch(() => "")).slice(0, 300);
        throw new HttpError(`Voyage ${resp.status}: ${body}`, {
          status: resp.status,
          retryable: isRetryableStatus(resp.status),
          retryAfter: resp.headers.get("retry-after"),
        });
      }
      return resp.json();
    }, { onRetry: ({ attempt, delay, error }) => log(`voyage retry ${attempt} in ${delay}ms: ${error.message}`) });
    for (const item of data?.data ?? []) {
      // item.index is relative to this batch.
      vectors[batch[item.index]] = item.embedding;
    }
  }
  const missing = vectors.findIndex((v) => !Array.isArray(v) || v.length !== EMBEDDING_DIMENSIONS);
  if (missing !== -1) throw new Error(`Voyage returned no ${EMBEDDING_DIMENSIONS}-dimension vector for passage ${missing}`);
  return vectors;
}
