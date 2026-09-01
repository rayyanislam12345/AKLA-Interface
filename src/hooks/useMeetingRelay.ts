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

// Ported from transcription-bot/src/renderer/renderer.js — same segment
// model and speaker-merge-by-relabeling approach, driven over a WebSocket
// to the transcription-relay service instead of Electron IPC.
export function useMeetingRelay() {
  const [connected, setConnected] = useState(false);
  const [recording, setRecording] = useState(false);
  const [language, setLanguage] = useState<MeetingLanguage>("en-US");
  const [segments, setSegments] = useState<MeetingSegment[]>([]);
  const [interimText, setInterimText] = useState<string | null>(null);
  const [interimSpeaker, setInterimSpeaker] = useState<number | undefined>();
  const [speakerNames, setSpeakerNames] = useState<Map<number, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const pendingTranslateResolvers = useRef<Map<number, (r: TranslateResultEvent["results"]) => void>>(new Map());
  const pendingDiarizeResolvers = useRef<((r: DiarizationResultEvent) => void)[]>([]);

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

      ws.onopen = () => setConnected(true);
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
            resolve(Boolean(msg.ok));
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

  const startAudioPipeline = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    const audioContext = new AudioContext({ sampleRate: 16000 });
    audioContextRef.current = audioContext;
    await audioContext.audioWorklet.addModule("/pcm-worklet.js");

    const source = audioContext.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(audioContext, "pcm-recorder");
    workletNodeRef.current = worklet;
    worklet.port.onmessage = (event) => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(event.data);
      }
    };

    // Route through a silent gain node — keeps the audio graph alive
    // without the worklet's connection being audible to the user.
    const silentGain = audioContext.createGain();
    silentGain.gain.value = 0;
    source.connect(worklet);
    worklet.connect(silentGain);
    silentGain.connect(audioContext.destination);
  }, []);

  const stopAudioPipeline = useCallback(() => {
    workletNodeRef.current?.disconnect();
    workletNodeRef.current = null;
    audioContextRef.current?.close();
    audioContextRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const startMeeting = useCallback(
    async (initialLanguage: MeetingLanguage) => {
      setSegments([]);
      setSpeakerNames(new Map());
      setLanguage(initialLanguage);

      const connectedOk = wsRef.current?.readyState === WebSocket.OPEN ? true : await connect();
      if (!connectedOk) return false;

      send({ type: "start", language: initialLanguage });
      try {
        await startAudioPipeline();
      } catch (err: any) {
        setError(err.message || "Could not access the microphone.");
        return false;
      }
      setRecording(true);
      return true;
    },
    [connect, send, startAudioPipeline]
  );

  const stopMeeting = useCallback(() => {
    send({ type: "stop" });
    stopAudioPipeline();
    setRecording(false);
    setInterimText(null);
  }, [send, stopAudioPipeline]);

  const switchLanguage = useCallback(
    (newLanguage: MeetingLanguage) => {
      setLanguage(newLanguage);
      send({ type: "switch-language", language: newLanguage });
    },
    [send]
  );

  const improveDiarization = useCallback((): Promise<DiarizationResultEvent> => {
    return new Promise((resolve) => {
      pendingDiarizeResolvers.current.push(resolve);
      send({ type: "improve-diarization" });
    });
  }, [send]);

  const mergeSpeakers = useCallback((fromId: number, intoLabel: string) => {
    setSpeakerNames((prev) => {
      const next = new Map(prev);
      next.set(fromId, intoLabel);
      return next;
    });
  }, []);

  // Groups consecutive same-speaker segments and requests a batch
  // translation for whichever ones need it (Urdu, or already have rawText).
  const translateSegments = useCallback(
    (ids: number[]) => {
      return new Promise<void>((resolve) => {
        const targets = segments.filter((s) => ids.includes(s.id));
        if (targets.length === 0) {
          resolve();
          return;
        }
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
    [segments, send]
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

  return {
    connected,
    recording,
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
    mergeSpeakers,
    translateSegments,
    speakerLabel,
    disconnect,
  };
}
