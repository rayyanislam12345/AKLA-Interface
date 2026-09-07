import { useCallback, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

export interface MeetingSegment {
  id: number;
  speakerId?: number;
  text: string;
  rawText?: string;
  translation?: string;
  manualSpeaker?: string;
  startSec?: number;
  endSec?: number;
}

export type MeetingLanguage = "en-US" | "ur";

interface TranscriptEvent {
  type: "transcript";
  id?: number;
  text: string;
  rawText?: string;
  isFinal: boolean;
  speaker?: number;
  startSec?: number;
  endSec?: number;
}

interface DiarizationResultEvent {
  type: "diarization-result";
  ok: boolean;
  utterances?: { speaker: number; start: number; end: number }[];
  error?: string;
}

interface TranslateResultEvent {
  type: "translate-result";
  ok: boolean;
  results: { id: number; translation?: string | null; error?: string }[];
}

const RELAY_URL = import.meta.env.VITE_TRANSCRIPTION_RELAY_URL as string | undefined;

// Wraps raw 16-bit mono PCM chunks (exactly what pcm-worklet.js emits, and
// exactly what's streamed to the relay) in a WAV header — a direct TS port
// of transcription-bot/src/main.js's buildWavBuffer, minus the Node Buffer
// API. Blob's multi-part constructor stands in for Buffer.concat.
function buildWavBlob(pcmChunks: ArrayBuffer[], { sampleRate = 16000, channels = 1, bitsPerSample = 16 } = {}) {
  const dataLength = pcmChunks.reduce((sum, c) => sum + c.byteLength, 0);
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = new ArrayBuffer(44);
  const view = new DataView(header);
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, "data");
  view.setUint32(40, dataLength, true);
  return new Blob([header, ...pcmChunks], { type: "audio/wav" });
}

// Ported from transcription-bot/src/renderer/renderer.js — same segment
// model and speaker-merge-by-relabeling approach, driven over a WebSocket
// to the transcription-relay service instead of Electron IPC.
export function useMeetingRelay() {
  const [connected, setConnected] = useState(false);
  const [recording, setRecording] = useState(false);
  const [hasRecording, setHasRecording] = useState(false);
  const [language, setLanguage] = useState<MeetingLanguage>("en-US");
  const [segments, setSegments] = useState<MeetingSegment[]>([]);
  const [interimText, setInterimText] = useState<string | null>(null);
  const [interimSpeaker, setInterimSpeaker] = useState<number | undefined>();
  const [speakerNames, setSpeakerNames] = useState<Map<number, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const pendingTranslateResolvers = useRef<Map<number, (r: TranslateResultEvent["results"]) => void>>(new Map());
  const pendingDiarizeResolvers = useRef<((r: DiarizationResultEvent) => void)[]>([]);
  const pendingStartResolver = useRef<((ok: boolean) => void) | null>(null);
  // The recorded meeting's raw PCM chunks — kept client-side purely so the
  // user can download the recording after stopping; never sent anywhere but
  // the relay's live audio stream.
  const recordedChunksRef = useRef<ArrayBuffer[]>([]);
  // The last manually-typed speaker name (for segments with no diarized
  // speakerId, e.g. Urdu) — defaults the next such segment to the same name
  // so consecutive turns from the same undiarized person don't need
  // retyping. Ported from transcription-bot/src/renderer/renderer.js's
  // lastManualSpeakerLabel.
  const lastManualSpeakerLabelRef = useRef("");

  const send = useCallback((payload: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload));
    }
  }, []);

  const handleTranscript = useCallback((msg: TranscriptEvent) => {
    if (!msg.isFinal) {
      setInterimText(msg.text || null);
      setInterimSpeaker(msg.speaker);
      return;
    }
    setInterimText(null);
    setInterimSpeaker(undefined);
    setSegments((prev) => [
      ...prev,
      {
        id: msg.id ?? prev.length + 1,
        speakerId: msg.speaker,
        text: msg.text,
        rawText: msg.rawText,
        // No diarization for this segment (e.g. Urdu) — default to whatever
        // name was last typed for a manual speaker, so consecutive turns
        // from the same undiarized person don't need retyping every time.
        manualSpeaker: msg.speaker === undefined ? lastManualSpeakerLabelRef.current || undefined : undefined,
        startSec: msg.startSec,
        endSec: msg.endSec,
      },
    ]);
  }, []);

  const connect = useCallback(async () => {
    setError(null);
    if (!RELAY_URL) {
      setError("Transcription relay is not configured (VITE_TRANSCRIPTION_RELAY_URL).");
      return false;
    }
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) {
      setError("Not signed in.");
      return false;
    }

    return new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`${RELAY_URL}?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      // Resolves as soon as the socket itself is open — separate from
      // whether a meeting has actually been started (see pendingStartResolver
      // / startMeeting below). Previously this only resolved on a
      // "start-ack" message, which meant calling connect() on its own (as
      // improveDiarization/translateSegments below now need to, for an
      // upload-only session that never called startMeeting) would hang
      // forever: nothing sends "start" until after connect() resolves, so
      // the "start-ack" this awaited would never arrive.
      ws.onopen = () => {
        setConnected(true);
        resolve(true);
      };
      ws.onerror = () => {
        setError("Could not connect to the transcription relay.");
        resolve(false);
      };
      ws.onclose = () => {
        setConnected(false);
        setRecording(false);
      };
      ws.onmessage = (event) => {
        let msg: any;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        switch (msg.type) {
          case "start-ack":
            if (!msg.ok) setError(msg.error || "Failed to start meeting.");
            pendingStartResolver.current?.(Boolean(msg.ok));
            pendingStartResolver.current = null;
            return;
          case "transcript":
            handleTranscript(msg);
            return;
          case "diarization-result": {
            const resolver = pendingDiarizeResolvers.current.shift();
            resolver?.(msg);
            return;
          }
          case "translate-result": {
            const resolvers = pendingTranslateResolvers.current;
            for (const s of msg.results as TranslateResultEvent["results"]) {
              resolvers.get(s.id)?.([s]);
              resolvers.delete(s.id);
            }
            return;
          }
          case "error":
            setError(msg.message || "Relay error.");
            return;
          default:
            return;
        }
      };
    });
  }, [handleTranscript]);

  // "mic" captures only this machine's microphone — i.e. only what the
  // person running the app says. "mic+meeting" additionally captures the
  // audio coming out of a shared tab/screen, so remote participants on a
  // Zoom/Teams/Meet call land in the transcript too.
  const startAudioPipeline = useCallback(
    async ({ captureMeetingAudio }: { captureMeetingAudio: boolean }) => {
      const audioContext = new AudioContext({ sampleRate: 16000 });
      audioContextRef.current = audioContext;
      await audioContext.audioWorklet.addModule("/pcm-worklet.js");

      const worklet = new AudioWorkletNode(audioContext, "pcm-recorder");
      workletNodeRef.current = worklet;
      worklet.port.onmessage = (event) => {
        // event.data is a fresh, transferred ArrayBuffer per chunk (see
        // pcm-worklet.js) — safe to keep a reference to it here as well as
        // sending it; WebSocket.send() copies rather than detaching it.
        recordedChunksRef.current.push(event.data);
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(event.data);
        }
      };

      // Both sources feed the same worklet node, which sums them. 0.8 on
      // each leaves headroom so two people talking at once can't clip the
      // summed signal into distortion the recognizer then has to fight.
      const connectSource = (stream: MediaStream) => {
        const gain = audioContext.createGain();
        gain.gain.value = 0.8;
        audioContext.createMediaStreamSource(stream).connect(gain);
        gain.connect(worklet);
      };

      const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = micStream;
      connectSource(micStream);

      if (captureMeetingAudio) {
        // video:true is requested only because browsers won't offer the
        // "share audio" checkbox for a video-less request; the video track
        // is stopped immediately below since nothing renders it. The
        // browser's own picker and persistent sharing indicator handle
        // consent for the person running this — they always see it.
        const displayStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        displayStreamRef.current = displayStream;
        displayStream.getVideoTracks().forEach((t) => t.stop());

        const displayAudioTracks = displayStream.getAudioTracks();
        if (displayAudioTracks.length === 0) {
          displayStream.getTracks().forEach((t) => t.stop());
          displayStreamRef.current = null;
          throw new Error(
            "That capture had no audio. Re-share and tick “Also share tab audio” (or “Share system audio”) in the picker."
          );
        }
        connectSource(new MediaStream(displayAudioTracks));

        // Fires if the user hits the browser's own "Stop sharing" button —
        // the mic keeps recording, so say so rather than silently dropping
        // everyone else out of the transcript.
        displayAudioTracks[0].addEventListener("ended", () => {
          setError("Meeting audio sharing stopped — only your microphone is being transcribed now.");
        });
      }

      // Route through a silent gain node — keeps the audio graph alive
      // without the worklet's connection being audible to the user.
      const silentGain = audioContext.createGain();
      silentGain.gain.value = 0;
      worklet.connect(silentGain);
      silentGain.connect(audioContext.destination);
    },
    []
  );

  const stopAudioPipeline = useCallback(() => {
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    audioContextRef.current?.close();
    audioContextRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    displayStreamRef.current?.getTracks().forEach((t) => t.stop());
    displayStreamRef.current = null;
  }, []);

  // Opens the relay socket if it isn't already — used by startMeeting and
  // also by improveDiarization/translateSegments/transcribeFile below, none
  // of which require a meeting to actually be started, just a socket to send
  // control messages over (an upload-only session, with no live recording
  // ever started, otherwise has no open socket at all).
  const ensureConnected = useCallback(async (): Promise<boolean> => {
    return wsRef.current?.readyState === WebSocket.OPEN ? true : connect();
  }, [connect]);

  const startMeeting = useCallback(
    async (initialLanguage: MeetingLanguage, { captureMeetingAudio = false } = {}) => {
      setSegments([]);
      setSpeakerNames(new Map());
      setLanguage(initialLanguage);
      recordedChunksRef.current = [];
      lastManualSpeakerLabelRef.current = "";
      setHasRecording(false);

      const connectedOk = await ensureConnected();
      if (!connectedOk) return false;

      const startedOk = await new Promise<boolean>((resolve) => {
        pendingStartResolver.current = resolve;
        send({ type: "start", language: initialLanguage });
      });
      if (!startedOk) return false;

      try {
        await startAudioPipeline({ captureMeetingAudio });
      } catch (err: any) {
        // Includes the user dismissing the screen-share picker, which throws
        // NotAllowedError — not worth a scary message.
        setError(
          err?.name === "NotAllowedError"
            ? "Audio capture was not allowed. Grant microphone access, and pick a tab/screen if capturing meeting audio."
            : err.message || "Could not access the microphone."
        );
        return false;
      }
      setRecording(true);
      return true;
    },
    [ensureConnected, send, startAudioPipeline]
  );

  const stopMeeting = useCallback(() => {
    send({ type: "stop" });
    stopAudioPipeline();
    setRecording(false);
    setHasRecording(recordedChunksRef.current.length > 0);
    setInterimText(null);
  }, [send, stopAudioPipeline]);

  // Builds a downloadable WAV of the current meeting's recorded audio, or
  // null if there isn't one (nothing recorded yet, or the transcript came
  // from an upload instead — see clearRecording).
  const getRecordingBlob = useCallback((): Blob | null => {
    if (recordedChunksRef.current.length === 0) return null;
    return buildWavBlob(recordedChunksRef.current);
  }, []);

  // Called when an uploaded transcript/recording replaces the current one —
  // any previously recorded live audio no longer corresponds to what's
  // displayed, so it shouldn't be offered for download anymore.
  const clearRecording = useCallback(() => {
    recordedChunksRef.current = [];
    setHasRecording(false);
  }, []);

  const switchLanguage = useCallback(
    (newLanguage: MeetingLanguage) => {
      setLanguage(newLanguage);
      send({ type: "switch-language", language: newLanguage });
    },
    [send]
  );

  const improveDiarization = useCallback(async (): Promise<DiarizationResultEvent> => {
    const connectedOk = await ensureConnected();
    if (!connectedOk) {
      return { type: "diarization-result", ok: false, error: "Could not connect to the transcription relay." };
    }
    return new Promise((resolve) => {
      pendingDiarizeResolvers.current.push(resolve);
      send({ type: "improve-diarization" });
    });
  }, [ensureConnected, send]);

  // Relabels a diarized speaker — used both to merge one speaker id into
  // another's current name (Deepgram split one person into two ids) and to
  // give a speaker an actual name typed in fresh; either way it's just a
  // speakerId->label override, text is never rewritten.
  const setSpeakerName = useCallback((speakerId: number, name: string) => {
    setSpeakerNames((prev) => {
      const next = new Map(prev);
      next.set(speakerId, name);
      return next;
    });
  }, []);

  // Sets (or edits) the manual speaker name on one segment with no diarized
  // speakerId (e.g. Urdu) — remembers it as the default for the next such
  // segment too (see handleTranscript above).
  const setManualSpeakerName = useCallback((segmentId: number, name: string) => {
    const trimmed = name.trim();
    lastManualSpeakerLabelRef.current = trimmed;
    setSegments((prev) => prev.map((s) => (s.id === segmentId ? { ...s, manualSpeaker: trimmed || undefined } : s)));
  }, []);

  // Groups consecutive same-speaker segments and requests a batch
  // translation for whichever ones need it (Urdu, or already have rawText).
  const translateSegments = useCallback(
    async (ids: number[]) => {
      const targets = segments.filter((s) => ids.includes(s.id));
      if (targets.length === 0) return;

      const connectedOk = await ensureConnected();
      if (!connectedOk) return; // best-effort; the caller's UI already surfaces relay.error

      return new Promise<void>((resolve) => {
        const groups: { id: number; text: string }[][] = [];
        let currentGroup: { id: number; text: string }[] = [];
        let currentSpeaker: number | string | undefined;
        for (const seg of targets) {
          const key = seg.manualSpeaker ?? seg.speakerId;
          if (key !== currentSpeaker && currentGroup.length > 0) {
            groups.push(currentGroup);
            currentGroup = [];
          }
          currentSpeaker = key;
          currentGroup.push({ id: seg.id, text: seg.rawText ?? seg.text });
        }
        if (currentGroup.length > 0) groups.push(currentGroup);

        let remaining = targets.length;
        const applyResult = (id: number, translation?: string | null) => {
          if (translation) {
            setSegments((prev) => prev.map((s) => (s.id === id ? { ...s, translation } : s)));
          }
          remaining -= 1;
          if (remaining <= 0) resolve();
        };
        for (const t of targets) {
          pendingTranslateResolvers.current.set(t.id, (results) => {
            applyResult(t.id, results[0]?.translation);
          });
        }
        send({ type: "translate-batch", groups });
      });
    },
    [segments, send, ensureConnected]
  );

  const disconnect = useCallback(() => {
    stopAudioPipeline();
    wsRef.current?.close();
    wsRef.current = null;
    setConnected(false);
    setRecording(false);
  }, [stopAudioPipeline]);

  const speakerLabel = useCallback(
    (speakerId: number | undefined) => {
      if (speakerId === undefined) return "";
      const custom = speakerNames.get(speakerId);
      if (custom) return custom;
      return `Speaker ${speakerId + 1}`;
    },
    [speakerNames]
  );

  // Transcribes an already-recorded meeting file. A one-shot HTTP POST to
  // the relay (not a WebSocket control message like everything else here) —
  // it doesn't need a persistent session, and this way the browser's File
  // object can stream straight into the request body with its own MIME type
  // as Content-Type, matching transcription-bot's Upload Recording feature
  // (ported from src/main.js's transcribeAudioFile / meeting:transcribe-file).
  const transcribeFile = useCallback(
    async (file: File, fileLanguage: MeetingLanguage): Promise<{ ok: boolean; segments?: MeetingSegment[]; error?: string }> => {
      if (!RELAY_URL) {
        return { ok: false, error: "Transcription relay is not configured (VITE_TRANSCRIPTION_RELAY_URL)." };
      }
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token) {
        return { ok: false, error: "Not signed in." };
      }

      const httpBase = RELAY_URL.replace(/^ws/, "http");
      const url = `${httpBase}/transcribe-file?token=${encodeURIComponent(token)}&language=${encodeURIComponent(fileLanguage)}`;

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": file.type || "application/octet-stream" },
          body: file,
        });
        const body = await res.json();
        if (!res.ok || !body.ok) {
          return { ok: false, error: body.error || `Transcription failed (${res.status}).` };
        }
        return { ok: true, segments: body.segments as MeetingSegment[] };
      } catch (err: any) {
        return { ok: false, error: err.message || "Could not reach the transcription relay." };
      }
    },
    []
  );

  return {
    connected,
    recording,
    hasRecording,
    language,
    segments,
    setSegments,
    interimText,
    interimSpeaker,
    speakerNames,
    error,
    startMeeting,
    stopMeeting,
    switchLanguage,
    improveDiarization,
    setSpeakerName,
    setManualSpeakerName,
    translateSegments,
    transcribeFile,
    getRecordingBlob,
    clearRecording,
    speakerLabel,
    disconnect,
  };
}
