import { friendlyError } from "@/lib/friendlyError";
import { plainSaveError, saveDraftToMatter } from "@/lib/saveDraftToMatter";
import { useEffect, useMemo, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
import {
  CheckCircle2,
  Download,
  FileAudio,
  FileText,
  FileUp,
  History,
  Languages,
  Mic,
  MonitorSpeaker,
  MoreHorizontal,
  Save,
  ScanSearch,
  Sparkles,
  Square,
  Upload,
  Wand2,
  XCircle,
} from "lucide-react";
import { useMeetingRelay, type MeetingLanguage } from "@/hooks/useMeetingRelay";
import { useGenerateMeetingOutput, type MeetingOutputFormat } from "@/hooks/useGenerateMeetingOutput";
import { useMatters } from "@/hooks/useMatters";
import { useDocumentTypes } from "@/hooks/useMatterDocuments";
import { buildAklaDocxBlob } from "@/lib/meetingDocx";
import NameLabelCalibrator from "@/components/meeting/NameLabelCalibrator";
import { useSpeakerVision } from "@/hooks/useSpeakerVision";
import { captureFrameFromStream, type NameReadResult } from "@/lib/speakerVision";
import { reassignSpeakerIds, voteSpeakerNames } from "@/lib/speakerTimeline";
import SegmentList, {
  parseTranscriptText,
  segmentsToEnglishTranscriptText,
  segmentsToTranscriptText,
} from "@/components/meeting/SegmentList";
import { useSearchParams } from "react-router-dom";
import { claudeOpenedNotice, documentPrompt, openInClaude } from "@/lib/openInClaude";
import {
  attendeeNames,
  elapsed,
  forgetTranscript,
  keepTranscript,
  keptTranscript,
  meetingDocumentTitle,
  meetingHeader,
  type KeptTranscript,
} from "@/lib/meetingSession";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// Every generation option is AKLA format now — there's no non-AKLA
// alternative left to disambiguate from, but the label still says so since
// it's meaningful information about the output's style either way.
const OUTPUT_LABELS: Record<MeetingOutputFormat, string> = {
  proposal: "Client Proposal Letter (AKLA Format)",
  "minutes-akla": "Meeting Minutes (AKLA Format)",
  "concept-note": "Concept Note (AKLA Format)",
};

const UPLOAD_DOCUMENT_TYPE_NAME: Record<MeetingOutputFormat, string> = {
  proposal: "Client Proposal Letter",
  "minutes-akla": "Meeting Minutes",
  "concept-note": "Concept Note",
};

// The order results are shown in: minutes first, the usual reason for recording.
const FORMAT_ORDER: MeetingOutputFormat[] = ["minutes-akla", "proposal", "concept-note"];

// What this page remembers between meetings, per browser: the project, the
// language, the audio source and whether the transcript is filed on Stop.
// Storage can be refused (a private window); the page then starts from its
// defaults.
const REMEMBER_KEY = "akla.record-meeting";
interface Remembered {
  matterId?: string;
  language?: MeetingLanguage;
  captureMeetingAudio?: boolean;
  fileTranscript?: boolean;
}
function remembered(): Remembered {
  try {
    return JSON.parse(localStorage.getItem(REMEMBER_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function remember(patch: Partial<Remembered>) {
  try {
    localStorage.setItem(REMEMBER_KEY, JSON.stringify({ ...remembered(), ...patch }));
  } catch {
    /* not remembered; nothing else depends on it */
  }
}
const browserStore = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const RELAY_URL = import.meta.env.VITE_TRANSCRIPTION_RELAY_URL as string | undefined;

// Whether the recording server answers, checked on arrival so a broken
// recorder shows before the meeting starts rather than when Start is pressed.
type RecorderState = "checking" | "ready" | "unreachable" | "not-set-up";
function useRecorderState(): RecorderState {
  const [state, setState] = useState<RecorderState>(RELAY_URL ? "checking" : "not-set-up");
  useEffect(() => {
    if (!RELAY_URL) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const base = new URL(RELAY_URL.replace(/^ws/, "http")).origin;
    fetch(`${base}/version`, { signal: controller.signal })
      .then((res) => setState(res.ok ? "ready" : "unreachable"))
      .catch(() => setState("unreachable"))
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, []);
  return state;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// One generated document: its Word preview, Download, and where it was filed.
function OutputCard({
  format,
  text,
  saved,
  saving,
  canSave,
  onDownload,
  onSave,
  onOpenInClaude,
}: {
  format: MeetingOutputFormat;
  text: string;
  saved?: { title: string };
  saving: boolean;
  canSave: boolean;
  onDownload: () => void;
  onSave: () => void;
  onOpenInClaude: () => void;
}) {
  const previewRef = useRef<HTMLDivElement>(null);
  const [building, setBuilding] = useState(false);
  useEffect(() => {
    if (!previewRef.current) return;
    setBuilding(true);
    buildAklaDocxBlob(text, OUTPUT_LABELS[format])
      .then((blob) => {
        if (!previewRef.current) return;
        previewRef.current.innerHTML = "";
        return renderAsync(blob, previewRef.current, previewRef.current, { inWrapper: true });
      })
      .finally(() => setBuilding(false));
  }, [format, text]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 flex-wrap space-y-0 pb-3">
        <CardTitle className="text-base">{UPLOAD_DOCUMENT_TYPE_NAME[format]}</CardTitle>
        <div className="flex items-center gap-2 flex-wrap">
          <Button size="sm" variant="outline" onClick={onDownload}>
            <Download className="h-4 w-4 mr-2" />
            Download (.docx)
          </Button>
          {saved ? (
            <Button size="sm" variant="outline" onClick={onOpenInClaude}>
              <Sparkles className="h-4 w-4 mr-2" />
              Open in Claude
            </Button>
          ) : (
            <Button size="sm" onClick={onSave} disabled={!canSave || saving} title={canSave ? undefined : "Choose the project first"}>
              <Upload className="h-4 w-4 mr-2" />
              {saving ? "Saving…" : "Save to project"}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {saved && (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            Saved to the project as “{saved.title}”.
          </p>
        )}
        {building && <p className="text-sm text-muted-foreground">Building preview…</p>}
        <div ref={previewRef} className="border rounded-md p-4 max-h-[70vh] overflow-auto" />
      </CardContent>
    </Card>
  );
}

export default function RecordMeetingPage() {
  const { toast } = useToast();
  const relay = useMeetingRelay();
  const generation = useGenerateMeetingOutput();
  const { data: matters } = useMatters({ openOnly: true });
  const { data: documentTypes } = useDocumentTypes();
  const recorder = useRecorderState();

  // The meeting: its project, title and who attended. The project is the
  // one this page was opened from (?matter=), else the last one used here.
  const [params] = useSearchParams();
  const [uploadMatterId, setUploadMatterIdState] = useState<string>(() => params.get("matter") ?? remembered().matterId ?? "");
  const setUploadMatterId = (id: string) => {
    setUploadMatterIdState(id);
    remember({ matterId: id });
  };
  const [meetingTitle, setMeetingTitle] = useState("");
  const [attendees, setAttendees] = useState("");
  const [fileTranscript, setFileTranscriptState] = useState(() => remembered().fileTranscript ?? true);
  const setFileTranscript = (on: boolean) => {
    setFileTranscriptState(on);
    remember({ fileTranscript: on });
  };
  const projectName = matters?.find((m) => m.id === uploadMatterId)?.name;

  const [exampleProposals, setExampleProposals] = useState("");
  const [showExamples, setShowExamples] = useState(false);
  // Each generated document keeps its own result: a concept note does not replace the minutes.
  const [drafts, setDrafts] = useState<Partial<Record<MeetingOutputFormat, string>>>({});
  const [generating, setGenerating] = useState<MeetingOutputFormat | null>(null);
  const [translating, setTranslating] = useState(false);
  const [improving, setImproving] = useState(false);
  const [transcribingRecording, setTranscribingRecording] = useState(false);
  const [captureMeetingAudio, setCaptureMeetingAudioState] = useState(() => remembered().captureMeetingAudio ?? false);
  const setCaptureMeetingAudio = (on: boolean) => {
    setCaptureMeetingAudioState(on);
    remember({ captureMeetingAudio: on });
  };
  const [detectSpeakers, setDetectSpeakers] = useState(false);
  const [calibratorOpen, setCalibratorOpen] = useState(false);
  const [calibrationFrame, setCalibrationFrame] = useState<string | null>(null);
  const vision = useSpeakerVision();
  const [testResult, setTestResult] = useState<(NameReadResult & { error?: string }) | null>(null);
  const [testing, setTesting] = useState(false);

  const [uploadingFormat, setUploadingFormat] = useState<MeetingOutputFormat | null>(null);
  // What has been filed, by output: the document and version it became.
  const [saved, setSaved] = useState<Partial<Record<MeetingOutputFormat, { title: string; versionNumber: number; matterId: string }>>>({});
  const [transcriptFiled, setTranscriptFiled] = useState<string | null>(null);

  const transcriptFileInputRef = useRef<HTMLInputElement>(null);
  const recordingFileInputRef = useRef<HTMLInputElement>(null);

  // The language last used, once on arrival.
  const switchLanguage = relay.switchLanguage;
  useEffect(() => {
    const language = remembered().language;
    if (language && language !== relay.language) switchLanguage(language);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // A transcript kept from a meeting that was never finished here: offered
  // once on arrival, for as long as nothing new has been recorded.
  const [recoverable, setRecoverable] = useState<KeptTranscript | null>(() => keptTranscript(browserStore()));
  const recover = () => {
    if (!recoverable) return;
    relay.setSegments(recoverable.segments);
    for (const [id, name] of recoverable.speakerNames) relay.setSpeakerName(id, name);
    setMeetingTitle(recoverable.details.title);
    setAttendees(recoverable.details.attendees);
    if (recoverable.matterId) setUploadMatterId(recoverable.matterId);
    setRecoverable(null);
  };
  const discardRecoverable = () => {
    forgetTranscript(browserStore());
    setRecoverable(null);
  };

  // The transcript on screen is kept in this browser a few seconds after
  // each change, so a crash, a sleeping laptop or a closed tab loses nothing.
  useEffect(() => {
    if (relay.segments.length === 0) return;
    const timer = setTimeout(() => {
      keepTranscript(browserStore(), {
        savedAt: new Date().toISOString(),
        segments: relay.segments,
        speakerNames: Array.from(relay.speakerNames.entries()),
        details: { title: meetingTitle, attendees },
        matterId: uploadMatterId,
      });
    }, 2000);
    return () => clearTimeout(timer);
  }, [relay.segments, relay.speakerNames, meetingTitle, attendees, uploadMatterId]);

  // The running clock while recording.
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!relay.recording) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [relay.recording]);

  // Depends on the stable callback rather than the whole hook object, which
  // is a fresh literal every render and would re-attach on each one.
  const attachVisionStream = vision.attachStream;
  useEffect(() => {
    void attachVisionStream(relay.displayStream);
  }, [relay.displayStream, attachVisionStream]);

  const documentTypeIdFor = useMemo(() => {
    return (format: MeetingOutputFormat) => documentTypes?.find((t) => t.name === UPLOAD_DOCUMENT_TYPE_NAME[format])?.id;
  }, [documentTypes]);

  const wantsSpeakerDetection = captureMeetingAudio && detectSpeakers;

  // Deepgram's segment timestamps are relative to when audio started
  // flowing, so screen observations have to be stamped from the same origin —
  // including when sampling starts partway through, after a mid-meeting
  // calibration. Stamping from "now" in that case would push every
  // observation later than the speech it describes and nothing would line up.
  const meetingStartedAtRef = useRef<number>(0);

  const beginSampling = async () => {
    vision.reset();
    const started = await vision.start(meetingStartedAtRef.current || Date.now());
    if (!started && vision.error) {
      toast({ title: "Speaker detection off", description: vision.error, variant: "destructive" });
    }
    return started;
  };

  const handleStart = async () => {
    // Starting clears the transcript on screen.
    if (relay.segments.length > 0 && !window.confirm("Starting a new meeting clears the transcript on screen. Download it or generate its documents first if you need them. Start anyway?")) return;
    const ok = await relay.startMeeting(relay.language, {
      captureMeetingAudio,
      detectSpeakers: wantsSpeakerDetection,
    });
    if (!ok) {
      if (relay.error) toast({ title: "Could not start meeting", description: relay.error, variant: "destructive" });
      return;
    }
    setRecoverable(null);
    setDrafts({});
    setSaved({});
    setTranscriptFiled(null);
    meetingStartedAtRef.current = Date.now();
    setStartedAt(Date.now());
    setNow(Date.now());
    if (wantsSpeakerDetection) {
      await beginSampling();
    }
  };

  // The segments as they stand when the last words arrive after Stop.
  const segmentsRef = useRef(relay.segments);
  segmentsRef.current = relay.segments;
  const speakerLabelRef = useRef(relay.speakerLabel);
  speakerLabelRef.current = relay.speakerLabel;

  const fileTranscriptToProject = async () => {
    const segments = segmentsRef.current;
    if (!uploadMatterId || segments.length === 0) return;
    const title = meetingDocumentTitle("Meeting Transcript", meetingTitle, new Date());
    const lines = segmentsToTranscriptText(segments, speakerLabelRef.current);
    const markdown = `${meetingHeader({ title: meetingTitle, attendees }, new Date()).replace("Transcript:\n", "")}\n${lines
      .split("\n")
      .filter(Boolean)
      .join("\n\n")}`;
    try {
      const blob = await buildAklaDocxBlob(markdown, "Meeting Transcript");
      await saveDraftToMatter({ matterId: uploadMatterId, documentTypeId: null, documentTypeName: title, title, blob, isAiGenerated: false });
      setTranscriptFiled(title);
      // It is in the project now; nothing to offer back on the next visit.
      forgetTranscript(browserStore());
      toast({ title: `Transcript saved to ${projectName ?? "the project"}`, description: `As “${title}”.` });
    } catch (err) {
      toast({ title: "The transcript was not saved to the project", description: plainSaveError(err), variant: "destructive" });
    }
  };

  const handleStop = () => {
    relay.stopMeeting();
    void vision.stop();
    setStartedAt(null);
    // The last words arrive a moment after Stop.
    if (fileTranscript) setTimeout(() => void fileTranscriptToProject(), 2500);
  };

  // Calibration needs a frame of the shared screen, but before a meeting
  // starts there isn't one — and requiring a meeting first created a
  // deadlock, since sampling refuses to start without a calibration. So
  // outside a meeting this takes a throwaway capture purely to grab one
  // frame, and releases it immediately.
  const handleOpenCalibrator = async () => {
    const live = vision.captureStillFrame();
    if (live) {
      setCalibrationFrame(live);
      setCalibratorOpen(true);
      return;
    }

    try {
      const temp = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const frame = await captureFrameFromStream(temp);
      temp.getTracks().forEach((t) => t.stop());
      if (!frame) {
        toast({ title: "Couldn't read that screen", variant: "destructive" });
        return;
      }
      setCalibrationFrame(frame);
      setCalibratorOpen(true);
    } catch {
      toast({ title: "Screen sharing was cancelled", variant: "destructive" });
    }
  };

  const handleTestRead = async () => {
    setTesting(true);
    try {
      setTestResult(await vision.testRead());
    } finally {
      setTesting(false);
    }
  };

  // Names seen on screen are matched to diarized speakers by overlap, with
  // every observation voting — so a stray OCR misread, or Zoom's highlight
  // lagging a beat behind who's actually talking, gets outvoted rather than
  // renaming someone wrongly.
  const handleApplyDetectedSpeakers = () => {
    const timeline = vision.buildTimeline();
    if (timeline.length === 0) {
      toast({ title: "No speakers detected on screen", variant: "destructive" });
      return;
    }
    const winners = voteSpeakerNames(relay.segments, timeline);
    if (winners.size === 0) {
      toast({
        title: "Couldn't match detected names to speakers",
        description: "The detected names didn't line up in time with any transcribed speech.",
        variant: "destructive",
      });
      return;
    }
    for (const [speakerId, name] of winners) {
      relay.setSpeakerName(speakerId, name);
    }
    toast({ title: `Named ${winners.size} speaker${winners.size === 1 ? "" : "s"} from screen` });
  };

  // The relay returns a better speaker-vs-time timeline from its batch pass;
  // this aligns the existing segments against it by overlap. Only who a
  // segment is attributed to changes — the transcribed text, including any
  // hand-corrections, is left exactly as it is.
  const handleImproveDiarization = async () => {
    setImproving(true);
    try {
      const result = await relay.improveDiarization();
      if (!result.ok || !result.utterances) {
        toast({ title: "Couldn't tidy up who said what", description: result.error, variant: "destructive" });
        return;
      }

      const assignments = reassignSpeakerIds(relay.segments, result.utterances);
      let changed = 0;
      relay.setSegments((prev) =>
        prev.map((segment) => {
          const next = assignments.get(segment.id);
          if (next === undefined || next === segment.speakerId) return segment;
          changed++;
          return { ...segment, speakerId: next, manualSpeaker: undefined };
        })
      );

      toast({
        title: changed
          ? `Speakers updated (${changed} line${changed === 1 ? "" : "s"} reassigned)`
          : "Speakers already matched the full recording",
      });
    } finally {
      setImproving(false);
    }
  };

  const handleMergeSpeaker = (fromId: number, intoId: number) => {
    relay.setSpeakerName(fromId, relay.speakerLabel(intoId));
  };

  const handleRenameSpeaker = (speakerId: number, name: string) => {
    if (!name.trim()) return;
    relay.setSpeakerName(speakerId, name.trim());
  };

  const ensureTranslated = async () => {
    const needsTranslation = relay.segments.filter((s) => Boolean(s.rawText) || /[؀-ۿ]/.test(s.text));
    if (needsTranslation.length === 0) return;
    setTranslating(true);
    try {
      await relay.translateSegments(needsTranslation.map((s) => s.id));
    } finally {
      setTranslating(false);
    }
  };

  const handleUploadToMatter = async (format: MeetingOutputFormat, text: string) => {
    // The three output types are looked up by name; if an admin renamed or
    // removed one, file the document anyway, untyped, and say so — never a
    // greyed-out button with no explanation.
    const documentTypeId = documentTypeIdFor(format) ?? null;
    if (!uploadMatterId) return;
    setUploadingFormat(format);
    try {
      // Named by kind, title and date, so a project's meetings are told apart in its list.
      const title = meetingDocumentTitle(UPLOAD_DOCUMENT_TYPE_NAME[format], meetingTitle, new Date());
      const blob = await buildAklaDocxBlob(text, OUTPUT_LABELS[format]);
      const result = await saveDraftToMatter({ matterId: uploadMatterId, documentTypeId, documentTypeName: title, title, blob });
      setSaved((prev) => ({ ...prev, [format]: { title, versionNumber: result.versionNumber, matterId: uploadMatterId } }));
      toast({
        title: `${title} saved to ${projectName ?? "the project"}`,
        description: [result.indexed ? "Ready for search." : "Saved; it will be searchable shortly.", documentTypeId ? null : `Filed without a document type — the "${UPLOAD_DOCUMENT_TYPE_NAME[format]}" type isn't set up; an administrator can add it.`].filter(Boolean).join(" "),
      });
    } catch (err) {
      // The same wording as every other save to a project.
      toast({ title: "Couldn't save to the project", description: plainSaveError(err), variant: "destructive" });
    } finally {
      setUploadingFormat(null);
    }
  };

  const generate = async (format: MeetingOutputFormat) => {
    if (relay.segments.length === 0) return;
    setGenerating(format);
    try {
      await ensureTranslated();
      const transcriptText =
        meetingHeader({ title: meetingTitle, attendees }, new Date()) +
        segmentsToEnglishTranscriptText(relay.segments, relay.speakerLabel);
      const result = await generation.mutateAsync({
        transcriptText,
        format,
        ...(format === "proposal" ? { exampleProposals } : {}),
      });
      setDrafts((prev) => ({ ...prev, [format]: result.draft }));
      // A new draft is not the one saved before.
      setSaved((prev) => {
        const next = { ...prev };
        delete next[format];
        return next;
      });
      // Straight into the chosen project; with none chosen it waits with its Save button.
      if (uploadMatterId) await handleUploadToMatter(format, result.draft);
      else toast({ title: "Choose a project to save it", description: "Pick the project on the left, then press Save to project." });
    } catch (err) {
      toast({ title: `The ${UPLOAD_DOCUMENT_TYPE_NAME[format].toLowerCase()} could not be generated`, description: friendlyError(err), variant: "destructive" });
    } finally {
      setGenerating(null);
    }
  };

  const handleTranscriptFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (relay.segments.length > 0 && !window.confirm("This replaces the current transcript. Continue?")) return;
    const text = await file.text();
    relay.setSegments(parseTranscriptText(text));
    relay.clearRecording();
    setRecoverable(null);
  };

  // Confirms the replacement up front, before the (potentially slow)
  // transcription runs — unlike handleTranscriptFileSelected above, where
  // parsing a text file is instant so there's nothing wasted by confirming
  // afterward. Ported from transcription-bot's Upload Recording feature.
  const handleRecordingFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (relay.segments.length > 0 && !window.confirm("This replaces the current transcript. Continue?")) return;

    setTranscribingRecording(true);
    try {
      const result = await relay.transcribeFile(file, relay.language);
      if (!result.ok) {
        toast({ title: "Could not transcribe recording", description: result.error, variant: "destructive" });
        return;
      }
      relay.setSegments(result.segments ?? []);
      relay.clearRecording();
      setRecoverable(null);
      if (!result.segments || result.segments.length === 0) {
        toast({ title: "No speech detected in the recording", variant: "destructive" });
      }
    } finally {
      setTranscribingRecording(false);
    }
  };

  const handleSaveTranscript = () => {
    const text = segmentsToTranscriptText(relay.segments, relay.speakerLabel);
    download(new Blob([text], { type: "text/plain" }), "transcript.txt");
  };

  // The recorded meeting's raw audio, built client-side from the same PCM
  // chunks streamed to the relay while recording (see useMeetingRelay) —
  // available once a live meeting has been stopped, until a new meeting
  // starts or an uploaded transcript/recording replaces it.
  const handleDownloadRecording = () => {
    const blob = relay.getRecordingBlob();
    if (blob) download(blob, "meeting-recording.wav");
  };

  const handleDownload = async (format: MeetingOutputFormat, text: string) => {
    const blob = await buildAklaDocxBlob(text, OUTPUT_LABELS[format]);
    download(blob, `${meetingDocumentTitle(UPLOAD_DOCUMENT_TYPE_NAME[format], meetingTitle, new Date()).replace(/[^\w\- ]+/g, "").replace(/\s+/g, "-")}.docx`);
  };

  const openSavedInClaude = async (format: MeetingOutputFormat) => {
    const entry = saved[format];
    const name = matters?.find((m) => m.id === entry?.matterId)?.name;
    if (!entry || !name) return;
    toast(claudeOpenedNotice(await openInClaude(documentPrompt(name, entry.title, "", entry.versionNumber))));
  };

  const hasContent = relay.segments.length > 0;
  const generated = FORMAT_ORDER.filter((f) => drafts[f]);
  const unsaved = generated.some((f) => !saved[f]);
  const busy = !!generating || translating;

  // Leaving or reloading loses a live recording and any document not yet
  // saved, so the browser asks first. (The transcript itself is also kept
  // in this browser and offered back on return.)
  const atRisk = relay.recording || unsaved || (hasContent && generated.length === 0 && !transcriptFiled);
  useEffect(() => {
    if (!atRisk) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [atRisk]);

  const names = attendeeNames(attendees);

  return (
    <div className="space-y-6 max-w-screen-2xl">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Mic className="h-5 w-5 text-primary" />
          Record Meeting
        </h1>
        <p className="text-muted-foreground">
          Choose the project, press Start, and Stop when the meeting ends. The minutes, proposal or concept note you
          generate is saved into the project.
        </p>
      </div>

      {recoverable && !hasContent && (
        <div className="flex items-center gap-3 flex-wrap rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <History className="h-4 w-4 shrink-0" />
          <span className="flex-1 min-w-[16rem]">
            A transcript from{" "}
            {recoverable.savedAt
              ? new Date(recoverable.savedAt).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })
              : "an earlier meeting"}
            {recoverable.details.title ? ` (${recoverable.details.title})` : ""} wasn't finished: {recoverable.segments.length} line
            {recoverable.segments.length === 1 ? "" : "s"}.
          </span>
          <Button size="sm" onClick={recover}>Recover it</Button>
          <Button size="sm" variant="ghost" onClick={discardRecoverable}>Discard</Button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)] items-start">
        {/* Left: before, during and after the meeting. */}
        <div className="space-y-6 lg:sticky lg:top-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Before the meeting</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label>Project</Label>
                <Select value={uploadMatterId} onValueChange={setUploadMatterId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Choose the project" />
                  </SelectTrigger>
                  <SelectContent>
                    {matters?.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="meeting-title">Meeting (optional)</Label>
                <Input id="meeting-title" placeholder="e.g. Kick-off with the PPP Unit" value={meetingTitle} onChange={(e) => setMeetingTitle(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="meeting-attendees">Who attended (optional)</Label>
                <Textarea
                  id="meeting-attendees"
                  placeholder="Names, separated by commas"
                  className="min-h-16"
                  value={attendees}
                  onChange={(e) => setAttendees(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Used in the minutes, and offered when you rename a speaker.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Language</Label>
                  <Select
                    value={relay.language}
                    onValueChange={(v) => {
                      relay.switchLanguage(v as MeetingLanguage);
                      remember({ language: v as MeetingLanguage });
                    }}
                  >
                    <SelectTrigger>
                      <Languages className="h-4 w-4 mr-2 shrink-0" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="en-US">English</SelectItem>
                      <SelectItem value="ur">Urdu (translated to English when you generate a document)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label>Audio</Label>
                  <Select
                    value={captureMeetingAudio ? "mic+meeting" : "mic"}
                    onValueChange={(v) => setCaptureMeetingAudio(v === "mic+meeting")}
                    disabled={relay.recording}
                  >
                    <SelectTrigger>
                      <MonitorSpeaker className="h-4 w-4 mr-2 shrink-0" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mic">Microphone only (in the room)</SelectItem>
                      <SelectItem value="mic+meeting">Microphone + meeting audio (online call)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5" checked={fileTranscript} onChange={(e) => setFileTranscript(e.target.checked)} />
                <span>
                  Save the transcript to the project when I press Stop
                  <span className="block text-xs text-muted-foreground">So Claude and the team can search what was said.</span>
                </span>
              </label>

              {captureMeetingAudio && (
                <div className="space-y-2 rounded-md border bg-muted/30 px-3 py-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={detectSpeakers}
                      disabled={relay.recording}
                      onChange={(e) => setDetectSpeakers(e.target.checked)}
                    />
                    Name speakers from Zoom's screen
                  </label>
                  {detectSpeakers && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button size="sm" variant="outline" onClick={handleOpenCalibrator}>
                        <ScanSearch className="h-4 w-4 mr-2" />
                        {vision.region ? "Change where the name is" : "Show where Zoom puts the name"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleTestRead}
                        disabled={!vision.region || testing}
                        title="Read the name once and show exactly what was seen"
                      >
                        {testing ? "Reading…" : "Check it reads the name"}
                      </Button>
                    </div>
                  )}
                  {detectSpeakers && !vision.region && (
                    <p className="text-xs text-destructive">Show where Zoom puts the name once before starting.</p>
                  )}
                  {vision.sampling && (
                    <p className="text-xs text-muted-foreground">
                      Reading screen… {vision.lastRead ? `last seen: ${vision.lastRead}` : "no name yet"} ({vision.observations.length} samples)
                    </p>
                  )}
                  {!vision.sampling && vision.observations.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-muted-foreground">Detected: {vision.detectedNames().join(", ") || "none"}</span>
                      <Button size="sm" variant="outline" onClick={handleApplyDetectedSpeakers} disabled={!hasContent}>
                        Apply detected names
                      </Button>
                    </div>
                  )}
                  {vision.error && <p className="text-xs text-destructive">{vision.error}</p>}
                  {testResult && (
                    <div className="flex items-start gap-3 border-t pt-2">
                      {testResult.cropDataUrl && (
                        <img src={testResult.cropDataUrl} alt="What the Hub reads" className="border rounded bg-white max-h-16" />
                      )}
                      <div className="text-xs space-y-0.5">
                        {testResult.error ? (
                          <p className="text-destructive">{testResult.error}</p>
                        ) : testResult.accepted ? (
                          <p className="text-green-700">
                            Reading “{testResult.accepted}”
                            {testResult.confidence !== null && ` (${Math.round(testResult.confidence)}% confidence)`}
                          </p>
                        ) : (
                          <>
                            <p className="text-destructive">{testResult.rejectedBecause ?? "Nothing readable."}</p>
                            <p className="text-muted-foreground">
                              Check the box covers only the name, that Zoom is in Speaker View, and that Zoom's “always
                              show participant name” setting is on.
                            </p>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="pt-6 space-y-3">
              {relay.recording ? (
                <Button size="lg" variant="destructive" className="w-full h-14 text-base" onClick={handleStop}>
                  <Square className="h-5 w-5 mr-2" />
                  Stop · {elapsed(now - (startedAt ?? now))}
                </Button>
              ) : (
                <Button
                  size="lg"
                  className="w-full h-14 text-base"
                  onClick={handleStart}
                  disabled={recorder === "not-set-up" || transcribingRecording}
                >
                  <Mic className="h-5 w-5 mr-2" />
                  Start recording
                </Button>
              )}
              <p
                className={cn(
                  "flex items-center gap-1.5 text-xs",
                  relay.recording ? "text-destructive" : recorder === "ready" ? "text-muted-foreground" : recorder === "checking" ? "text-muted-foreground" : "text-destructive",
                )}
              >
                {relay.recording ? (
                  <>
                    <span className="h-2 w-2 rounded-full bg-destructive animate-pulse" />
                    Recording. Keep this tab open.
                  </>
                ) : recorder === "ready" ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                    Recorder ready.
                  </>
                ) : recorder === "checking" ? (
                  "Checking the recorder…"
                ) : recorder === "unreachable" ? (
                  <>
                    <XCircle className="h-3.5 w-3.5" />
                    The recorder isn't answering. Try again in a minute, or ask an administrator.
                  </>
                ) : (
                  <>
                    <XCircle className="h-3.5 w-3.5" />
                    Recording isn't set up on this site. Ask an administrator.
                  </>
                )}
              </p>
              {relay.error && <p className="text-sm text-destructive">{relay.error}</p>}
              {transcribingRecording && <p className="text-sm text-muted-foreground">Transcribing the recording… this takes a few minutes for a long meeting.</p>}
              {transcriptFiled && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                  Transcript saved as “{transcriptFiled}”.
                </p>
              )}
            </CardContent>
          </Card>

          {hasContent && !relay.recording && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">After the meeting</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <Button className="w-full" onClick={() => void generate("minutes-akla")} disabled={busy}>
                  <FileText className="h-4 w-4 mr-2" />
                  {generating === "minutes-akla" ? "Writing the minutes…" : "Generate minutes"}
                </Button>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" onClick={() => void generate("proposal")} disabled={busy}>
                    {generating === "proposal" ? "Writing…" : "Proposal letter"}
                  </Button>
                  <Button variant="outline" onClick={() => void generate("concept-note")} disabled={busy}>
                    {generating === "concept-note" ? "Writing…" : "Concept note"}
                  </Button>
                </div>
                {busy && (
                  <p className="text-sm text-muted-foreground">
                    {translating ? "Translating the transcript…" : "Drafting — this can take a minute…"}
                  </p>
                )}
                {showExamples || exampleProposals ? (
                  <div className="space-y-1.5">
                    <Label htmlFor="example-proposals" className="text-xs">
                      Example proposal letters for the proposal to follow (optional)
                    </Label>
                    <Textarea
                      id="example-proposals"
                      value={exampleProposals}
                      onChange={(e) => setExampleProposals(e.target.value)}
                      placeholder="Paste one or more of the firm's proposal letters…"
                      className="min-h-20"
                    />
                  </div>
                ) : (
                  <button type="button" className="text-xs text-muted-foreground underline underline-offset-2" onClick={() => setShowExamples(true)}>
                    Add example proposal letters for the proposal to follow
                  </button>
                )}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right: the transcript, then what was generated from it. */}
        <div className="space-y-6 min-w-0">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-3">
              <CardTitle className="text-base">
                Transcript
                {meetingTitle.trim() && <span className="ml-2 text-sm font-normal text-muted-foreground">{meetingTitle.trim()}</span>}
              </CardTitle>
              <div className="flex items-center gap-2">
                <input ref={transcriptFileInputRef} type="file" accept=".txt" className="hidden" onChange={handleTranscriptFileSelected} />
                <input ref={recordingFileInputRef} type="file" accept="audio/*" className="hidden" onChange={handleRecordingFileSelected} />
                <DropdownMenu modal={false}>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline">
                      <MoreHorizontal className="h-4 w-4 mr-1.5" />
                      More
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem disabled={relay.recording || transcribingRecording} onSelect={() => recordingFileInputRef.current?.click()}>
                      <FileAudio className="mr-2 h-4 w-4" />
                      Upload a recording…
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={relay.recording} onSelect={() => transcriptFileInputRef.current?.click()}>
                      <FileUp className="mr-2 h-4 w-4" />
                      Upload a transcript (.txt)…
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled={!hasContent || improving} onSelect={() => void handleImproveDiarization()}>
                      <Wand2 className="mr-2 h-4 w-4" />
                      {improving ? "Tidying…" : "Tidy up who said what"}
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!hasContent || !uploadMatterId || relay.recording} onSelect={() => void fileTranscriptToProject()}>
                      <Upload className="mr-2 h-4 w-4" />
                      Save the transcript to the project
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem disabled={!hasContent} onSelect={handleSaveTranscript}>
                      <Save className="mr-2 h-4 w-4" />
                      Download the transcript
                    </DropdownMenuItem>
                    <DropdownMenuItem disabled={!relay.hasRecording} onSelect={handleDownloadRecording}>
                      <Download className="mr-2 h-4 w-4" />
                      Download the recording
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </CardHeader>
            <CardContent>
              <div className="border rounded-md p-4 h-[55vh] min-h-[320px] overflow-y-auto">
                {hasContent || relay.interimText ? (
                  <SegmentList
                    segments={relay.segments}
                    interimText={relay.interimText}
                    interimSpeaker={relay.interimSpeaker}
                    speakerLabel={relay.speakerLabel}
                    onMergeSpeaker={handleMergeSpeaker}
                    onRenameSpeaker={handleRenameSpeaker}
                    onSetManualSpeakerName={relay.setManualSpeakerName}
                    nameSuggestions={names}
                  />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
                    <Mic className="h-8 w-8 opacity-40" />
                    <p>
                      {relay.recording
                        ? "Listening… what is said appears here."
                        : "Press Start recording and what is said appears here, speaker by speaker. Click a speaker's name to rename them."}
                    </p>
                    <p className="text-xs">Already have a recording? Use More › Upload a recording.</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>

          {generated.map((format) => (
            <OutputCard
              key={format}
              format={format}
              text={drafts[format]!}
              saved={saved[format]}
              saving={uploadingFormat === format}
              canSave={!!uploadMatterId}
              onDownload={() => void handleDownload(format, drafts[format]!)}
              onSave={() => void handleUploadToMatter(format, drafts[format]!)}
              onOpenInClaude={() => void openSavedInClaude(format)}
            />
          ))}
        </div>
      </div>

      <NameLabelCalibrator
        frameDataUrl={calibrationFrame}
        open={calibratorOpen}
        onOpenChange={setCalibratorOpen}
        onConfirm={(region) => {
          vision.setRegion(region);
          setCalibratorOpen(false);
          setTestResult(null);
          // Calibrating during a meeting used to leave detection stuck off
          // for the rest of it: sampling had already refused to start for
          // want of a region, and nothing retried once one existed.
          if (relay.recording && wantsSpeakerDetection && !vision.sampling) {
            void beginSampling().then((started) => {
              toast({ title: started ? "Speaker detection started" : "Name label region saved" });
            });
          } else {
            toast({ title: "Name label region saved" });
          }
        }}
      />
    </div>
  );
}
