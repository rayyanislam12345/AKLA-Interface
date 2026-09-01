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

async function transliterateToUrduScript(text) {
  const res = await anthropic.messages.create(
    {
      model: "claude-haiku-4-5-20251001",
      max_tokens: 500,
      system:
        "You are a Hindi-Urdu script transliterator. The given text is spoken Urdu that was transcribed by a Hindi speech-to-text model, so it's written in Devanagari (Hindi) script even though it represents Urdu speech. Rewrite it in proper Urdu (Perso-Arabic/Nastaliq) script, preserving the exact same words and pronunciation — this is a script conversion, not a translation, so do not change vocabulary, rephrase, or translate anything. The speaker may have code-switched into English words or phrases that got rendered phonetically in Devanagari; where you recognize this, write those in their standard Urdu-script spelling for English loanwords, or leave them in Latin script if that's how they'd naturally appear in written Urdu. Respond with only the Urdu-script text and nothing else.",
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

async function reprocessDiarization(pcmBuffer, language) {
  const wavBuffer = buildWavBuffer(pcmBuffer);
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
    headers: { Authorization: `Token ${DEEPGRAM_API_KEY}`, "Content-Type": "audio/wav" },
    body: wavBuffer,
  });

  if (!res.ok) {
    throw new Error(`Deepgram batch request failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }

  const data = await res.json();
  const utterances = data.results?.utterances || [];
  return utterances.map((u) => ({ speaker: u.speaker, start: u.start, end: u.end }));
}

function deepgramLanguageFor(uiLanguage) {
  return uiLanguage === "ur" ? "hi" : "en-US";
}

// ---- Per-connection session state (one per browser WebSocket) ----

function createSession(ws) {
  const state = {
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
      transliterateToUrduScript(text)
        .then((urduText) => {
          send({ type: "transcript", id, text: urduText, rawText: text, isFinal: true, speaker, startSec, endSec });
        })
        .catch(() => {
          send({
            type: "transcript",
            id,
            text: "[could not convert to Urdu script]",
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
        if (state.recordingBuffers.length === 0) {
          send({ type: "diarization-result", ok: false, error: "No recorded audio available for this transcript." });
          return;
        }
        const pcm = Buffer.concat(state.recordingBuffers);
        reprocessDiarization(pcm, deepgramLanguageFor(state.currentLanguage))
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

const httpServer = createServer((req, res) => {
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

  const session = createSession(ws);

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
