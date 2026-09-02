require("dotenv").config();
const { WebSocketServer, WebSocket } = require("ws");
const Anthropic = require("@anthropic-ai/sdk");
const { createServer } = require("http");
const { URL } = require("url");

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;
const PORT = process.env.PORT || 8091;

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

const httpServer = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (req.method === "POST" && url.pathname === "/transcribe-file") {
    handleTranscribeFileUpload(req, res, url);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("transcription-relay ok");
});

const wss = new WebSocketServer({ server: httpServer, path: "/meeting" });

wss.on("connection", async (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");
  const user = await verifySupabaseToken(token);
  if (!user) {
    ws.close(4001, "Unauthorized");
    return;
  }

  const session = createSession(ws, user.id);

  ws.on("message", (data, isBinary) => {
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
  });

  ws.on("close", () => session.cleanup());
});

httpServer.listen(PORT, () => {
  console.log(`transcription-relay listening on :${PORT}`);
});
