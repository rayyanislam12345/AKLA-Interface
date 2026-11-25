require("dotenv").config();
const { WebSocketServer, WebSocket } = require("ws");
const Anthropic = require("@anthropic-ai/sdk");
const { createServer } = require("http");
const { URL } = require("url");

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const PORT = process.env.PORT || 8091;
const SERVER_STARTED_AT = new Date().toISOString(); // see /version below

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// English legal/business terms that commonly get code-switched into Urdu
// speech — ported verbatim from transcription-bot/src/main.js.
const URDU_CODE_SWITCH_TERMS = [
  "retainer",
  "engagement letter",
  "scope of work",
  "NDA",
  "non-disclosure agreement",
  "contract",
  "litigation",
  "hourly rate",
  "flat fee",
  "invoice",
  "deposit",
  "lawsuit",
  "settlement",
  "arbitration",
  "mediation",
  "power of attorney",
  "affidavit",
  "notarize",
  "attorney",
  "counsel",
  "deadline",
  "damages",
  "breach of contract",
  "termination clause",
];

const SHORT_CALL_OPTS = { timeout: 15_000, maxRetries: 2 };

// Verifies a Supabase access token belongs to a real, currently signed-in
// user — same trust model as every edge function in the main app (RLS-gated
// as that user), no separate shared secret needed since there's a real user
// context here (unlike the OCR service, which is only ever called
// server-to-server from an edge function).
async function verifySupabaseToken(token) {
  if (!token) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: SUPABASE_PUBLISHABLE_KEY },
    });
    if (!res.ok) return null;
    const user = await res.json();
    return user?.id ? user : null;
  } catch {
    return null;
  }
}

// ---- Ported verbatim from transcription-bot/src/main.js ----

async function translateBatch(groups) {
  const allSegments = groups.flat();
  if (allSegments.length === 0) return [];

  const prompt = groups.map((group) => group.map((s) => `[${s.id}] ${s.text}`).join("\n")).join("\n\n");

  const res = await anthropic.messages.create(
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      system:
        "You are translating a batch of Urdu legal-meeting transcript lines into English. Most lines were transcribed live using a Hindi speech-to-text model, so they're written in Devanagari (Hindi) script even though they represent spoken Urdu — read them as spoken Urdu, not Hindi. Some lines may instead already be in Perso-Arabic Urdu script (from an uploaded transcript) — treat those the same way. Speakers frequently code-switch into English words and phrases mid-sentence — infer the correct English term for any that got mangled in transcription (especially legal/business terms like retainer, contract, NDA, invoice, deadline, etc.). Each input line is tagged with an id in brackets, e.g. '[3] <text>'. Lines are grouped into blocks separated by a blank line; each block is one continuous turn from a single speaker, so use the other lines in the same block as context when translating each line — to resolve pronouns, references, or ellipsis that span sentences — but still translate and output each line individually. Respond with exactly one output line per input line, in the same overall order as the input, in the exact format '[3] <english translation>' — same id, translation only, no commentary, no blank lines, no extra lines.",
      messages: [{ role: "user", content: prompt }],
    },
    { timeout: 45_000, maxRetries: 2 },
  );
  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const translations = new Map();
  for (const line of text.split("\n")) {
    const m = line.match(/^\[(\d+)\]\s*(.*)$/);
    if (m) translations.set(Number(m[1]), m[2].trim());
  }
  return allSegments.map((s) => ({ id: s.id, translation: translations.get(s.id) || null }));
}

// Romanizes instead of converting to Perso-Arabic Urdu script — updated to
// match transcription-bot/src/main.js's current transliterateToRoman.
// Deterministic Devanagari->Roman libraries were tried and ruled out in the
// standalone app (no schwa deletion, so they render every written-but-silent
// vowel and mangle code-switched English words phonetically); this stays an
// LLM call for the same reason.
async function transliterateToRoman(text) {
  const res = await anthropic.messages.create(
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system:
        "You are converting spoken Urdu into casual Roman Urdu — the way Urdu speakers commonly text informally in Latin script (e.g. \"aap kaise hain\", \"hum retainer discuss karna chahtay hain\"). The given text is spoken Urdu that was transcribed by a Hindi speech-to-text model, so it's written in Devanagari (Hindi) script even though it represents Urdu speech. Romanize it naturally and colloquially — this is a script conversion, not a translation, so do not change vocabulary, rephrase, or translate anything. Drop the written-but-unspoken short vowels the way casual Roman Urdu/Hinglish texting does (\"karna\" not \"karanaa\", \"hum\" not \"hama\", \"hain\" not \"haiM\") — do not use formal academic transliteration with diacritics or capitalized nasalization markers. The speaker may have code-switched into English words or phrases that got rendered phonetically in Devanagari; where you recognize this, write those in their normal English spelling (e.g. \"retainer\", \"contract\", \"meeting\"), not a phonetic respelling. If the given text is already entirely in Latin/English script (the speaker was speaking English for that whole segment, so there's nothing to convert), return it back exactly as given, character for character — do not alter, respell, correct, or reformat it in any way. Respond with only the resulting text and nothing else.",
      messages: [{ role: "user", content: text }],
    },
    SHORT_CALL_OPTS,
  );
  return res.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

function buildWavBuffer(pcmBuffer, { sampleRate = 16000, channels = 1, bitsPerSample = 16 } = {}) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmBuffer.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmBuffer.length, 40);
  return Buffer.concat([header, pcmBuffer]);
}

// Shared low-level call to Deepgram's batch (prerecorded) REST endpoint —
// used for reprocessing a live meeting's recorded PCM with the
// higher-accuracy diarizer, transcribing an uploaded recording from scratch,
// and reprocessing an uploaded recording's diarization the same way a live
// meeting's can be. Matches transcription-bot/src/main.js's
// deepgramBatchTranscribe.
async function deepgramBatchTranscribe(bodyBuffer, contentType, language) {
  const params = new URLSearchParams({
    model: "nova-3",
    diarize_model: "latest",
    punctuate: "true",
    utterances: "true",
    language,
  });
  if (language === "hi") {
    for (const term of URDU_CODE_SWITCH_TERMS) params.append("keyterm", term);
  }

  const res = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
    method: "POST",
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, "Content-Type": contentType },
    body: bodyBuffer,
  });

  if (!res.ok) {
    throw new Error(`Deepgram batch request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  const data = await res.json();
  return data.results?.utterances || [];
}

// Diarization-only reprocessing: deliberately ignores the batch pass's own
// transcript text — the client aligns this timeline against the existing
// (possibly hand-corrected) segments by time overlap and only touches
// speaker assignment, never the words themselves.
async function diarizeOnly(bodyBuffer, contentType, language) {
  const utterances = await deepgramBatchTranscribe(bodyBuffer, contentType, language);
  return utterances.map((u) => ({ speaker: u.speaker, start: u.start, end: u.end }));
}

async function reprocessDiarization(pcmBuffer, language) {
  return diarizeOnly(buildWavBuffer(pcmBuffer), "audio/wav", language);
}

// Transcribes an already-recorded meeting file (as opposed to live audio),
// using the same higher-accuracy diarizer as reprocessDiarization above —
// since this is the first and only pass for an uploaded recording, there's
// no reason to settle for the streaming-tier diarizer a live meeting has to.
async function transcribeAudioFile(fileBuffer, contentType, language) {
  const utterances = await deepgramBatchTranscribe(fileBuffer, contentType, language);
  return utterances
    .map((u) => ({ speaker: u.speaker, start: u.start, end: u.end, transcript: u.transcript }))
    .filter((u) => u.transcript && u.transcript.trim());
}

// Runs async `fn` over `items` with at most `limit` in flight at once — used
// to romanize a whole uploaded recording's Urdu utterances without firing
// off hundreds of concurrent Haiku calls at once.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// ---- AI look-over (Sonnet) ----
//
// The second pass a careful reader would make over a machine transcript,
// done with the whole meeting in view rather than a line at a time: it fixes
// what the speech model misheard (a place or company name, a legal term
// respelt phonetically), marks what cannot be made out instead of guessing,
// and writes every line twice — "original" (what was said, in the language it
// was said in: Urdu in Roman script, English left as English) and
// "translation" (all of it in English). Two steps: one read of the whole
// transcript for the likely mishearings, then the lines in chunks, each chunk
// carrying those readings so a name is spelt the same way throughout.
const LOOK_OVER_MODEL = "claude-sonnet-5-5";
const LOOK_OVER_CHUNK_WORDS = 1100;
const LOOK_OVER_CHUNK_LINES = 60;
const LOOK_OVER_CONCURRENCY = 4;
// Sonnet here does not accept a forced tool choice, so each prompt says to
// answer through the tool; an answer that comes back as prose is treated as a
// failed call rather than parsed.
const LOOK_OVER_VIA_TOOL = (name) => `Answer only by calling the ${name} tool, once. Do not write anything outside the tool call.`;

const LOOK_OVER_BACKGROUND =
  "The transcript is of a meeting or dictation at a Pakistani law firm (project finance, PPP concessions, procurement, corporate and regulatory work). It was produced by a speech-to-text model. Spoken Urdu was recognised with a Hindi model, so Urdu appears in Devanagari script even though it is Urdu, not Hindi; some lines may already be in Roman Urdu or Perso-Arabic script. Speakers switch between Urdu and English mid-sentence. The speech model often mishears: proper names (people, companies, banks, places), abbreviations (CTA, RFP, KPI, CDA, SECP, EPC, PAC), and legal or financial terms come out as similar-sounding wrong words. The firm is AKLA (often written \"Acla\" by the speech model); its lawyers also mention AI tools such as Claude (often written \"clot\" or \"cloud\") and Gemini.";

function lookOverContextText(context) {
  const lines = [];
  if (context?.projectName) lines.push(`Project: ${String(context.projectName).slice(0, 200)}`);
  if (context?.title) lines.push(`Meeting title: ${String(context.title).slice(0, 200)}`);
  if (context?.attendees) lines.push(`Attendees: ${String(context.attendees).slice(0, 500)}`);
  if (Array.isArray(context?.speakerNames) && context.speakerNames.length) {
    lines.push(`Named speakers: ${context.speakerNames.map((n) => String(n).slice(0, 80)).join(", ")}`);
  }
  return lines.length ? lines.join("\n") : "(none given)";
}

function lookOverLine(seg) {
  return `[${seg.id}] S${seg.speakerId ?? "?"}: ${seg.text}`;
}

function toolInput(res, name) {
  const block = res.content.find((b) => b.type === "tool_use" && b.name === name);
  return block ? block.input : null;
}

// Step one: read everything once and list what the speech model most likely
// misheard. Small output, so the whole meeting fits in one call; a very long
// transcript is sampled from the start, middle and end.
async function lookOverReadings(segments, context) {
  let lines = segments.map(lookOverLine);
  const MAX_CHARS = 280_000;
  let joined = lines.join("\n");
  if (joined.length > MAX_CHARS) {
    const third = Math.floor(MAX_CHARS / 3);
    const mid = Math.floor(joined.length / 2);
    joined = `${joined.slice(0, third)}\n[...]\n${joined.slice(mid - third / 2, mid + third / 2)}\n[...]\n${joined.slice(-third)}`;
  }
  const res = await anthropic.messages.create(
    {
      model: LOOK_OVER_MODEL,
      max_tokens: 3000,
      system: `${LOOK_OVER_BACKGROUND}\n\nRead the whole transcript and work out what it is about and which words the speech model most likely misheard. List only readings the surrounding conversation supports; mark the ones you are less sure of. Do not invent names: where a word is plainly wrong but you cannot tell what was said, leave it out of the list.\n\n${LOOK_OVER_VIA_TOOL("record_readings")}`,
      tools: [
        {
          name: "record_readings",
          description: "Record what the meeting is about and the likely mishearings.",
          input_schema: {
            type: "object",
            properties: {
              subject: { type: "string", description: "One or two sentences: what the meeting is about and who appears to be speaking." },
              readings: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    heard: { type: "string", description: "The word or phrase as it appears in the transcript (all variants, separated by ' / ')." },
                    reading: { type: "string", description: "What was most likely said." },
                    certain: { type: "boolean", description: "False when this is a best guess." },
                  },
                  required: ["heard", "reading", "certain"],
                },
              },
            },
            required: ["subject", "readings"],
          },
        },
      ],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: `What is known about the meeting:\n${lookOverContextText(context)}\n\nTranscript:\n${joined}` }],
    },
    { timeout: 180_000, maxRetries: 2 },
  );
  const input = toolInput(res, "record_readings") || {};
  return {
    subject: typeof input.subject === "string" ? input.subject : "",
    readings: Array.isArray(input.readings) ? input.readings.filter((r) => r && r.heard && r.reading).slice(0, 80) : [],
  };
}

function lookOverChunks(segments) {
  const chunks = [];
  let current = [];
  let words = 0;
  for (const seg of segments) {
    const n = String(seg.text).split(/\s+/).length;
    // A new chunk starts only at a change of speaker, so a turn is not cut in two.
    const speakerChanges = current.length > 0 && current[current.length - 1].speakerId !== seg.speakerId;
    const full = words + n > LOOK_OVER_CHUNK_WORDS || current.length >= LOOK_OVER_CHUNK_LINES;
    const overfull = words + n > LOOK_OVER_CHUNK_WORDS * 1.5 || current.length >= LOOK_OVER_CHUNK_LINES * 1.5;
    if (current.length > 0 && ((full && speakerChanges) || overfull)) {
      chunks.push(current);
      current = [];
      words = 0;
    }
    current.push(seg);
    words += n;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

const LOOK_OVER_LINE_RULES = `For every line write two versions.

"original": what was said, in the language it was said in. Urdu goes into casual Roman Urdu, the way Urdu speakers text in Latin script ("aap kaise hain", "hum retainer discuss karna chahte hain"): drop the unspoken short vowels, no diacritics, no academic transliteration. English words and phrases stay in English, in their normal spelling. Do not translate the Urdu and do not rephrase anything.

"translation": the same line entirely in English. Translate the Urdu faithfully and plainly, as a careful translator would, keeping the speaker's meaning, hedges and tone (do not tidy up rough or blunt speech, and do not add anything that was not said). English passages are carried over with only the mishearings corrected.

In both versions:
- Correct what the speech model misheard, using the readings given and the surrounding conversation. Write the corrected word in the text itself; do not keep the mishearing. Where a correction is a best guess, put it in square brackets with a question mark, e.g. [Humak?].
- Where words cannot be made out, write [unclear] rather than guessing. Never fill a gap with invented content.
- Words added only so the English reads as a sentence go in [square brackets] in the translation.
- Keep one output line for each input line, with the same id. Do not merge, split, drop or reorder lines. A line that is only a filler ("ji", "hmm") is still returned.
- Punctuate properly. Do not add speaker names or labels.`;

async function lookOverChunk(chunk, before, notes, context) {
  const readings = notes.readings.length
    ? notes.readings.map((r) => `- "${r.heard}" is ${r.certain ? "" : "probably "}${r.reading}`).join("\n")
    : "(none found)";
  const user = [
    `What is known about the meeting:\n${lookOverContextText(context)}`,
    notes.subject ? `What it is about: ${notes.subject}` : null,
    `Likely mishearings found across the whole transcript:\n${readings}`,
    before.length ? `The lines just before these, for context only (do not return them):\n${before.map(lookOverLine).join("\n")}` : null,
    `Lines to look over (${chunk.length}). Each is "[id] S<speaker number>: text":\n${chunk.map(lookOverLine).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const res = await anthropic.messages.create(
    {
      model: LOOK_OVER_MODEL,
      max_tokens: 16000,
      system: `${LOOK_OVER_BACKGROUND}\n\n${LOOK_OVER_LINE_RULES}\n\n${LOOK_OVER_VIA_TOOL("return_lines")}`,
      tools: [
        {
          name: "return_lines",
          description: "Return the looked-over lines.",
          input_schema: {
            type: "object",
            properties: {
              lines: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "integer" },
                    original: { type: "string" },
                    translation: { type: "string" },
                  },
                  required: ["id", "original", "translation"],
                },
              },
            },
            required: ["lines"],
          },
        },
      ],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: user }],
    },
    { timeout: 300_000, maxRetries: 2 },
  );
  const input = toolInput(res, "return_lines");
  if (!input) throw new Error(res.stop_reason === "max_tokens" ? "The answer was cut short." : "No lines were returned.");
  const wanted = new Set(chunk.map((s) => s.id));
  const byId = new Map();
  for (const line of Array.isArray(input.lines) ? input.lines : []) {
    if (!line || !wanted.has(line.id)) continue;
    const original = typeof line.original === "string" ? line.original.trim() : "";
    const translation = typeof line.translation === "string" ? line.translation.trim() : "";
    if (original && translation) byId.set(line.id, { id: line.id, original, translation });
  }
  // A line the model left out is reported as such, never silently dropped.
  return chunk.map((s) => byId.get(s.id) || { id: s.id, error: "not returned" });
}

// Runs the whole look-over, reporting each chunk as it finishes.
async function lookOverTranscript(segments, context, onChunk) {
  const clean = (segments || [])
    .filter((s) => s && Number.isInteger(s.id) && typeof s.text === "string" && s.text.trim())
    .map((s) => ({ id: s.id, speakerId: Number.isInteger(s.speakerId) ? s.speakerId + 1 : undefined, text: s.text.trim().slice(0, 4000) }));
  if (clean.length === 0) return { subject: "", readings: [], failed: 0 };

  let notes = { subject: "", readings: [] };
  try {
    notes = await lookOverReadings(clean, context);
  } catch {
    // The lines can still be looked over without the meeting-wide readings.
  }

  const chunks = lookOverChunks(clean);
  const starts = [];
  let offset = 0;
  for (const c of chunks) {
    starts.push(offset);
    offset += c.length;
  }
  let done = 0;
  let failed = 0;
  await mapWithConcurrency(chunks, LOOK_OVER_CONCURRENCY, async (chunk, i) => {
    const before = clean.slice(Math.max(0, starts[i] - 6), starts[i]);
    let results;
    try {
      results = await lookOverChunk(chunk, before, notes, context);
    } catch (err) {
      const message = err.message || String(err);
      results = chunk.map((s) => ({ id: s.id, error: message }));
    }
    failed += results.filter((r) => r.error).length;
    done += 1;
    onChunk({ results, done, total: chunks.length });
  });
  return { subject: notes.subject, readings: notes.readings, failed };
}

function deepgramLanguageFor(uiLanguage) {
  return uiLanguage === "ur" ? "hi" : "en-US";
}

// { buffer, contentType, language } for each user's most recently uploaded
// recording, so its diarization can be improved on-demand the same way a
// live meeting's can — an upload is a one-shot HTTP call with no persistent
// session, so this can't live in per-connection session state the way
// recordingBuffers does. Single slot per user (overwritten on each new
// upload); bounded by how many distinct users have ever uploaded a
// recording, which is fine for a small internal tool.
const uploadedRecordingsByUser = new Map();

// ---- Per-connection session state (one per browser WebSocket) ----

function createSession(ws, userId) {
  const state = {
    userId,
    currentLanguage: "en-US",
    segmentSeq: 0,
    pendingText: "",
    pendingSpeaker: undefined,
    pendingStartSec: undefined,
    pendingEndSec: undefined,
    recordingBuffers: [],
    deepgramSocket: null,
    lookingOver: false,
  };

  const send = (payload) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };

  function commitPending() {
    const text = state.pendingText.trim();
    const speaker = state.pendingSpeaker;
    const startSec = state.pendingStartSec;
    const endSec = state.pendingEndSec;
    state.pendingText = "";
    state.pendingSpeaker = undefined;
    state.pendingStartSec = undefined;
    state.pendingEndSec = undefined;
    if (!text) return;

    const id = ++state.segmentSeq;

    if (state.currentLanguage === "ur") {
      transliterateToRoman(text)
        .then((romanText) => {
          send({ type: "transcript", id, text: romanText, rawText: text, isFinal: true, speaker, startSec, endSec });
        })
        .catch(() => {
          send({
            type: "transcript",
            id,
            text: "[could not romanize]",
            rawText: text,
            isFinal: true,
            speaker,
            startSec,
            endSec,
          });
        });
    } else {
      send({ type: "transcript", id, text, isFinal: true, speaker, startSec, endSec });
    }
  }

  function connectDeepgram(language) {
    state.pendingText = "";
    state.pendingSpeaker = undefined;
    state.pendingStartSec = undefined;
    state.pendingEndSec = undefined;

    const params = new URLSearchParams({
      model: "nova-3",
      language,
      punctuate: "true",
      smart_format: "true",
      diarize: "true",
      interim_results: "true",
      endpointing: "500",
      utterance_end_ms: "1000",
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
    });
    if (language === "hi") {
      for (const term of URDU_CODE_SWITCH_TERMS) params.append("keyterm", term);
    }

    const dg = new WebSocket(`wss://api.deepgram.com/v1/listen?${params.toString()}`, {
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` },
    });
    state.deepgramSocket = dg;

    dg.on("open", () => send({ type: "status", status: "connected" }));

    dg.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      if (msg.type === "UtteranceEnd") {
        commitPending();
        return;
      }

      const alt = msg.channel?.alternatives?.[0];
      if (!alt) return;
      const isFinal = Boolean(msg.is_final);

      if (!isFinal) {
        if (!alt.transcript) return;
        const preview = state.pendingText ? `${state.pendingText} ${alt.transcript}` : alt.transcript;
        send({
          type: "transcript",
          text: state.currentLanguage === "ur" ? "…" : preview,
          isFinal: false,
          speaker: state.pendingSpeaker ?? alt.words?.[0]?.speaker,
        });
        return;
      }

      if (alt.transcript) {
        if (state.pendingText === "" && typeof msg.start === "number") state.pendingStartSec = msg.start;
        state.pendingText = state.pendingText ? `${state.pendingText} ${alt.transcript}` : alt.transcript;
        if (state.pendingSpeaker === undefined) state.pendingSpeaker = alt.words?.[0]?.speaker;
        if (typeof msg.start === "number" && typeof msg.duration === "number") {
          state.pendingEndSec = msg.start + msg.duration;
        }
      }

      if (msg.speech_final) {
        commitPending();
      } else if (state.pendingText) {
        send({
          type: "transcript",
          text: state.currentLanguage === "ur" ? "…" : state.pendingText,
          isFinal: false,
          speaker: state.pendingSpeaker,
        });
      }
    });

    dg.on("error", (err) => send({ type: "error", message: err.message }));
    dg.on("close", () => {
      state.deepgramSocket = null;
      send({ type: "status", status: "closed" });
    });
  }

  function handleControl(msg) {
    switch (msg.type) {
      case "start": {
        state.currentLanguage = msg.language === "ur" ? "ur" : "en-US";
        if (!DEEPGRAM_API_KEY) {
          send({ type: "start-ack", ok: false, error: "DEEPGRAM_API_KEY is not set" });
          return;
        }
        if (state.deepgramSocket) {
          send({ type: "start-ack", ok: false, error: "A meeting is already in progress" });
          return;
        }
        state.recordingBuffers = [];
        uploadedRecordingsByUser.delete(state.userId);
        connectDeepgram(deepgramLanguageFor(state.currentLanguage));
        send({ type: "start-ack", ok: true });
        return;
      }
      case "switch-language": {
        const newLanguage = msg.language === "ur" ? "ur" : "en-US";
        if (newLanguage === state.currentLanguage) return;
        if (!state.deepgramSocket) return;
        const old = state.deepgramSocket;
        state.deepgramSocket = null;
        old.removeAllListeners();
        try {
          old.send(JSON.stringify({ type: "CloseStream" }));
        } catch {
          // ignore
        }
        old.close();
        state.currentLanguage = newLanguage;
        connectDeepgram(deepgramLanguageFor(state.currentLanguage));
        return;
      }
      case "stop": {
        if (state.deepgramSocket) {
          try {
            state.deepgramSocket.send(JSON.stringify({ type: "CloseStream" }));
          } catch {
            // ignore
          }
          state.deepgramSocket.close();
          state.deepgramSocket = null;
        }
        return;
      }
      case "improve-diarization": {
        if (state.recordingBuffers.length > 0) {
          const pcm = Buffer.concat(state.recordingBuffers);
          reprocessDiarization(pcm, deepgramLanguageFor(state.currentLanguage))
            .then((utterances) => send({ type: "diarization-result", ok: true, utterances }))
            .catch((err) => send({ type: "diarization-result", ok: false, error: err.message || String(err) }));
          return;
        }
        const uploaded = uploadedRecordingsByUser.get(state.userId);
        if (!uploaded) {
          send({ type: "diarization-result", ok: false, error: "No recorded audio available for this transcript." });
          return;
        }
        diarizeOnly(uploaded.buffer, uploaded.contentType, uploaded.language)
          .then((utterances) => send({ type: "diarization-result", ok: true, utterances }))
          .catch((err) => send({ type: "diarization-result", ok: false, error: err.message || String(err) }));
        return;
      }
      case "translate-batch": {
        translateBatch(msg.groups || [])
          .then((results) => send({ type: "translate-result", ok: true, results }))
          .catch((err) => {
            const message = err.message || String(err);
            send({
              type: "translate-result",
              ok: false,
              results: (msg.groups || []).flat().map((s) => ({ id: s.id, error: message })),
            });
          });
        return;
      }
      case "look-over": {
        // One at a time per connection: a second request while the first is
        // still running would pay for the same transcript twice.
        if (state.lookingOver) {
          send({ type: "look-over-done", ok: false, error: "A look-over is already running." });
          return;
        }
        state.lookingOver = true;
        lookOverTranscript(msg.segments, msg.context, (progress) => send({ type: "look-over-progress", ...progress }))
          .then((summary) => send({ type: "look-over-done", ok: true, ...summary }))
          .catch((err) => send({ type: "look-over-done", ok: false, error: err.message || String(err) }))
          .finally(() => {
            state.lookingOver = false;
          });
        return;
      }
      default:
        return;
    }
  }

  return {
    handleControl,
    handleAudioChunk(buf) {
      state.recordingBuffers.push(buf);
      if (state.deepgramSocket && state.deepgramSocket.readyState === WebSocket.OPEN) {
        state.deepgramSocket.send(buf);
      }
    },
    cleanup() {
      if (state.deepgramSocket) state.deepgramSocket.close();
    },
  };
}

// ---- HTTP + WebSocket server ----

// Transcribes an already-recorded meeting file, uploaded from the browser as
// a plain POST body (the browser's File object already carries the correct
// MIME type via Content-Type, so — unlike the Electron app's file-dialog
// path, which only gets a filesystem path and has to guess from the
// extension — there's no need for an extension->Content-Type table here).
// A one-shot HTTP call, not a WebSocket control message, since it doesn't
// need a persistent session the way live audio streaming does.
async function handleTranscribeFileUpload(req, res, url) {
  const token = url.searchParams.get("token");
  const user = await verifySupabaseToken(token);
  if (!user) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    return;
  }

  const uiLanguage = url.searchParams.get("language") === "ur" ? "ur" : "en-US";
  const contentType = req.headers["content-type"] || "";
  if (!contentType.startsWith("audio/")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: `Unsupported content type "${contentType || "(none)"}".` }));
    return;
  }
  if (!DEEPGRAM_API_KEY) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "DEEPGRAM_API_KEY is not set" }));
    return;
  }

  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", async () => {
    try {
      const fileBuffer = Buffer.concat(chunks);
      const dgLanguage = deepgramLanguageFor(uiLanguage);
      const utterances = await transcribeAudioFile(fileBuffer, contentType, dgLanguage);

      uploadedRecordingsByUser.set(user.id, { buffer: fileBuffer, contentType, language: dgLanguage });

      // Deepgram's speaker indices are already small ints in practice, but
      // map them to sequential ids in order of first appearance to
      // guarantee it, matching how live-diarized speakers are numbered.
      const speakerIndex = new Map();
      for (const u of utterances) {
        if (!speakerIndex.has(u.speaker)) speakerIndex.set(u.speaker, speakerIndex.size);
      }

      let segmentSeq = 0;
      const segments = await mapWithConcurrency(utterances, 8, async (u) => {
        const id = ++segmentSeq;
        const speakerId = speakerIndex.get(u.speaker);
        const startSec = u.start;
        const endSec = u.end;

        if (uiLanguage !== "ur") {
          return { id, speakerId, text: u.transcript, startSec, endSec };
        }
        try {
          const text = await transliterateToRoman(u.transcript);
          return { id, speakerId, text, rawText: u.transcript, startSec, endSec };
        } catch {
          return { id, speakerId, text: "[could not romanize]", rawText: u.transcript, startSec, endSec };
        }
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, segments }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message || String(err) }));
    }
  });
}

// Reports the commit this running process was actually started from, so a
// stale deploy (code pushed to GitHub but this process never restarted) can
// be checked over the network without SSH access to the box.
//
// Two sources, because this relay is deployed by scp, not `git pull`: the box
// has no checkout and no git binary at all, so asking git would always answer
// "unknown" and the endpoint would be useless exactly where it is needed.
// deploy.sh writes DEPLOYED_VERSION alongside server.js; git is still tried
// first for the case where someone does run this from a checkout.
function getDeployedVersion() {
  try {
    const commit = require("child_process")
      .execSync("git rev-parse HEAD", { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    const committedAt = require("child_process")
      .execSync("git log -1 --format=%cI", { cwd: __dirname, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
    return { commit, committedAt, source: "git" };
  } catch {
    // fall through to the deploy stamp
  }
  try {
    const stamp = JSON.parse(
      require("fs").readFileSync(require("path").join(__dirname, "DEPLOYED_VERSION"), "utf8")
    );
    return { commit: stamp.commit ?? "unknown", committedAt: stamp.committedAt ?? null, deployedAt: stamp.deployedAt ?? null, source: "deploy-stamp" };
  } catch {
    return { commit: "unknown", committedAt: null, source: "none" };
  }
}

const httpServer = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // The web app calls this from another origin, and its upload carries the
  // file's own MIME type as Content-Type, so the browser preflights it.
  // Auth is the token in the query string, not a cookie, so "*" is safe.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Max-Age": "86400" });
    res.end();
    return;
  }
  // The web app derives its HTTP base from the WebSocket URL, which ends in
  // /meeting, so accept the HTTP routes under that prefix as well.
  const pathname = url.pathname.replace(/^\/meeting(?=\/)/, "");
  if (req.method === "POST" && pathname === "/transcribe-file") {
    handleTranscribeFileUpload(req, res, url);
    return;
  }
  if (req.method === "GET" && pathname === "/version") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ...getDeployedVersion(), startedAt: SERVER_STARTED_AT }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("transcription-relay ok");
});

const wss = new WebSocketServer({ server: httpServer, path: "/meeting" });

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");

  // The browser's socket is open as soon as the handshake completes, and it
  // sends straight away (Generate Minutes connects and fires translate-batch
  // in one go). Verifying the token is a round trip to Supabase, so listen
  // now and hold anything that arrives until we know who this is — a
  // listener attached after the await would silently drop those messages.
  let session = null;
  const early = [];
  ws.on("message", (data, isBinary) => {
    if (session) handleMessage(data, isBinary);
    else early.push([data, isBinary]);
  });
  ws.on("close", () => session?.cleanup());

  const user = await verifySupabaseToken(token);
  if (!user) {
    ws.close(4001, "Unauthorized");
    return;
  }
  if (ws.readyState !== WebSocket.OPEN) return;

  session = createSession(ws, user.id);
  for (const [data, isBinary] of early.splice(0)) handleMessage(data, isBinary);

  function handleMessage(data, isBinary) {
    if (isBinary) {
      session.handleAudioChunk(Buffer.from(data));
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      session.handleControl(msg);
    } catch {
      // ignore malformed control message
    }
  }
});

httpServer.listen(PORT, () => {
  console.log(`transcription-relay listening on :${PORT}`);
});
