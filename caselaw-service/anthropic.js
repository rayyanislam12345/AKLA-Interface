// Thin Anthropic helpers for the case-law service. Kept local rather than
// imported from chat-service so the two services can be deployed and evolve
// independently (same reason chat-service is a copy of the edge function, not
// a shared import). Raw fetch to the Messages API, matching the house pattern.

const API = "https://api.anthropic.com/v1/messages";
const VERSION = "2023-06-01";

export async function anthropicJson(body, signal, { timeoutMs = 120_000 } = {}) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  const resp = await fetch(API, {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": VERSION, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`AI provider error ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  return resp.json();
}

// Join an Anthropic response's text blocks into one string.
export function textOf(result) {
  return (result.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n");
}

// Pull the last complete, top-level JSON object out of a model reply, tolerant
// of prose or code fences around it. Ported from chat-service's readPlan so a
// model that chats before the JSON doesn't hand a parse error to the attorney.
// `validate` lets the caller insist on the shape it needs.
export function readJson(text, validate = () => true) {
  const objects = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{") { if (depth === 0) start = i; depth++; }
    else if (c === "}" && depth > 0) { depth--; if (depth === 0) objects.push(text.slice(start, i + 1)); }
  }
  for (const candidate of objects.reverse()) {
    let parsed;
    try { parsed = JSON.parse(candidate); } catch { continue; }
    if (validate(parsed)) return parsed;
  }
  throw new Error("The model replied in prose instead of the JSON the step needed.");
}
