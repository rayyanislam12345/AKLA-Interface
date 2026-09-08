import { useCallback, useRef, useState } from "react";
import type { Worker } from "tesseract.js";
import {
  createOcrWorker,
  grabFrame,
  readNameLabel,
  readNameLabelDetailed,
  type NameLabelRegion,
  type NameReadResult,
  type SpeakerObservation,
} from "@/lib/speakerVision";
import { canonicaliseNames, type TimelineEntry } from "@/lib/speakerTimeline";

const SAMPLE_INTERVAL_MS = 2000;
const REGION_STORAGE_KEY = "akla.speakerVision.nameLabelRegion";

function loadStoredRegion(): NameLabelRegion | null {
  try {
    const raw = localStorage.getItem(REGION_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as NameLabelRegion) : null;
  } catch {
    return null;
  }
}

// Watches the shared Zoom video for who is currently speaking, by reading the
// name label off the Speaker View tile every couple of seconds. Produces a
// timeline that speakerTimeline.ts aligns against the transcript.
export function useSpeakerVision() {
  const [region, setRegionState] = useState<NameLabelRegion | null>(loadStoredRegion);
  const [observations, setObservations] = useState<SpeakerObservation[]>([]);
  const [sampling, setSampling] = useState(false);
  const [lastRead, setLastRead] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef<number>(0);
  // Guards against a slow OCR pass overlapping the next tick — Tesseract can
  // take longer than the interval on a busy machine.
  const inFlightRef = useRef(false);

  const setRegion = useCallback((next: NameLabelRegion | null) => {
    setRegionState(next);
    try {
      if (next) localStorage.setItem(REGION_STORAGE_KEY, JSON.stringify(next));
      else localStorage.removeItem(REGION_STORAGE_KEY);
    } catch {
      // A calibration that can't be remembered is still usable this session.
    }
  }, []);

  // Binds the captured screen to an offscreen <video> the frames are read
  // from. Safe to call repeatedly with the same stream.
  const attachStream = useCallback(async (stream: MediaStream | null) => {
    if (!stream) {
      videoRef.current?.pause();
      videoRef.current = null;
      return;
    }
    if (!videoRef.current) {
      const video = document.createElement("video");
      video.muted = true;
      video.playsInline = true;
      videoRef.current = video;
    }
    const video = videoRef.current;
    if (video.srcObject !== stream) {
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        setError("Could not read the shared screen for speaker detection.");
      }
    }
  }, []);

  // A still for the calibration UI to draw a box on.
  const captureStillFrame = useCallback((): string | null => {
    const video = videoRef.current;
    if (!video) return null;
    const frame = grabFrame(video);
    return frame ? frame.toDataURL("image/png") : null;
  }, []);

  const start = useCallback(
    async (startedAtMs: number) => {
      if (!region) {
        setError("Calibrate the name label position first.");
        return false;
      }
      if (!videoRef.current) {
        setError("No shared screen to read — start the meeting with meeting audio capture on.");
        return false;
      }

      setError(null);
      setObservations([]);
      startedAtRef.current = startedAtMs;

      try {
        workerRef.current = await createOcrWorker();
      } catch (err: unknown) {
        setError(`Could not start text recognition: ${err instanceof Error ? err.message : String(err)}`);
        return false;
      }

      setSampling(true);
      timerRef.current = setInterval(async () => {
        const worker = workerRef.current;
        const video = videoRef.current;
        if (!worker || !video || inFlightRef.current) return;

        inFlightRef.current = true;
        try {
          const name = await readNameLabel(worker, video, region);
          if (name) {
            const atSec = (Date.now() - startedAtRef.current) / 1000;
            setLastRead(name);
            setObservations((prev) => [...prev, { name, atSec }]);
          }
        } catch {
          // A dropped frame or a failed read isn't worth interrupting a
          // meeting over — the next tick will try again.
        } finally {
          inFlightRef.current = false;
        }
      }, SAMPLE_INTERVAL_MS);

      return true;
    },
    [region]
  );

  const stop = useCallback(async () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setSampling(false);
    const worker = workerRef.current;
    workerRef.current = null;
    if (worker) {
      try {
        await worker.terminate();
      } catch {
        // Already gone.
      }
    }
  }, []);

  // Each reading stands for the couple of seconds around when it was taken.
  // Spellings are folded together first, so one person seen as three OCR
  // variants doesn't split into three "speakers".
  const buildTimeline = useCallback((): TimelineEntry<string>[] => {
    const canonical = canonicaliseNames(observations.map((o) => o.name));
    const halfWindow = SAMPLE_INTERVAL_MS / 2000;
    return observations.map((o) => ({
      speaker: canonical.get(o.name) ?? o.name,
      start: Math.max(0, o.atSec - halfWindow),
      end: o.atSec + halfWindow,
    }));
  }, [observations]);

  const detectedNames = useCallback((): string[] => {
    const canonical = canonicaliseNames(observations.map((o) => o.name));
    return [...new Set([...canonical.values()])];
  }, [observations]);

  // Runs a single read right now and reports everything about it, including
  // the exact crop and why a result was discarded. Without this, a region
  // that's off by a little looks the same as one that's perfect but the
  // label happens to be hidden.
  const testRead = useCallback(async (): Promise<NameReadResult & { error?: string }> => {
    const blank: NameReadResult = { cropDataUrl: null, rawText: "", tidied: "", confidence: null, accepted: null };
    if (!region) return { ...blank, error: "Calibrate the name label position first." };
    if (!videoRef.current) {
      return { ...blank, error: "No shared screen yet — start the meeting, or calibrate to share one." };
    }

    // Reuse the running worker mid-meeting; otherwise spin one up just for
    // this check and dispose of it.
    const existing = workerRef.current;
    const worker = existing ?? (await createOcrWorker());
    try {
      return await readNameLabelDetailed(worker, videoRef.current, region, { includeCrop: true });
    } catch (err: unknown) {
      return { ...blank, error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (!existing) await worker.terminate();
    }
  }, [region]);

  const reset = useCallback(() => {
    setObservations([]);
    setLastRead(null);
    setError(null);
  }, []);

  return {
    region,
    setRegion,
    observations,
    sampling,
    lastRead,
    error,
    attachStream,
    captureStillFrame,
    start,
    stop,
    buildTimeline,
    detectedNames,
    testRead,
    reset,
  };
}
