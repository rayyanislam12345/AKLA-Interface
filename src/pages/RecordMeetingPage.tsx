import { friendlyError } from "@/lib/friendlyError";
import { plainSaveError, saveDraftToMatter } from "@/lib/saveDraftToMatter";
import { useEffect, useMemo, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
import { Mic, Square, Wand2, FileText, Download, Upload, Languages, FileUp, FileAudio, MonitorSpeaker, ScanSearch, Save, Sparkles } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

// Every generation option is AKLA format now — there's no non-AKLA
// alternative left to disambiguate from, but the label still says so since
// it's meaningful information about the output's style either way.
const OUTPUT_LABELS: Record<MeetingOutputFormat, string> = {
  proposal: "Client Proposal Letter (AKLA Format)",
  "minutes-akla": "Meeting Minutes (AKLA Format)",
  "concept-note": "Concept Note (AKLA Format)",
};

// What this page remembers between meetings, per browser: the project, the
// language and the audio source. Storage can be refused (a private window);
// the page then starts from its defaults.
const REMEMBER_KEY = "akla.record-meeting";
function remembered(): { matterId?: string; language?: MeetingLanguage; captureMeetingAudio?: boolean } {
  try {
    return JSON.parse(localStorage.getItem(REMEMBER_KEY) ?? "{}");
  } catch {
    return {};
  }
}
function remember(patch: Partial<ReturnType<typeof remembered>>) {
  try {
    localStorage.setItem(REMEMBER_KEY, JSON.stringify({ ...remembered(), ...patch }));
  } catch {
    /* not remembered; nothing else depends on it */
  }
}

const UPLOAD_DOCUMENT_TYPE_NAME: Record<MeetingOutputFormat, string> = {
  proposal: "Client Proposal Letter",
  "minutes-akla": "Meeting Minutes",
  "concept-note": "Concept Note",
};

export default function RecordMeetingPage() {
  const { toast } = useToast();
  const relay = useMeetingRelay();
  const proposalMutation = useGenerateMeetingOutput();
  const minutesMutation = useGenerateMeetingOutput();
  const { data: matters } = useMatters({ openOnly: true });
  const { data: documentTypes } = useDocumentTypes();

  const [exampleProposals, setExampleProposals] = useState("");
  const [proposalDraft, setProposalDraft] = useState<string | null>(null);
  // The second pane is shared: minutes and the concept note are both AKLA
  // numbered-outline markdown and render through the same builder, so the
  // format travels with the draft rather than being a separate piece of state.
  const [minutesDraft, setMinutesDraft] = useState<
    { format: "minutes-akla" | "concept-note"; text: string } | null
  >(null);
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

  // The project: the one this page was opened from (?matter=), else the last
  // one used here.
  const [params] = useSearchParams();
  const [uploadMatterId, setUploadMatterIdState] = useState<string>(() => params.get("matter") ?? remembered().matterId ?? "");
  const setUploadMatterId = (id: string) => {
    setUploadMatterIdState(id);
    remember({ matterId: id });
  };
  const [uploadingFormat, setUploadingFormat] = useState<MeetingOutputFormat | null>(null);
  // What has been filed, by output: the document and version it became.
  const [saved, setSaved] = useState<Partial<Record<MeetingOutputFormat, { title: string; versionNumber: number; matterId: string }>>>({});
  const [showExamples, setShowExamples] = useState(false);
  const projectName = matters?.find((m) => m.id === uploadMatterId)?.name;

  // The language last used, once on arrival.
  const switchLanguage = relay.switchLanguage;
  useEffect(() => {
    const language = remembered().language;
    if (language && language !== relay.language) switchLanguage(language);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const proposalPreviewRef = useRef<HTMLDivElement>(null);
  const minutesPreviewRef = useRef<HTMLDivElement>(null);
  const [buildingProposalPreview, setBuildingProposalPreview] = useState(false);
  const [buildingMinutesPreview, setBuildingMinutesPreview] = useState(false);

  const transcriptFileInputRef = useRef<HTMLInputElement>(null);
  const recordingFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!proposalDraft || !proposalPreviewRef.current) return;
    setBuildingProposalPreview(true);
    buildAklaDocxBlob(proposalDraft, OUTPUT_LABELS.proposal)
      .then((blob) => {
        if (!proposalPreviewRef.current) return;
        proposalPreviewRef.current.innerHTML = "";
        return renderAsync(blob, proposalPreviewRef.current, proposalPreviewRef.current, { inWrapper: true });
      })
      .finally(() => setBuildingProposalPreview(false));
  }, [proposalDraft]);

  useEffect(() => {
    if (!minutesDraft || !minutesPreviewRef.current) return;
    setBuildingMinutesPreview(true);
    buildAklaDocxBlob(minutesDraft.text, OUTPUT_LABELS[minutesDraft.format])
      .then((blob) => {
        if (!minutesPreviewRef.current) return;
        minutesPreviewRef.current.innerHTML = "";
        return renderAsync(blob, minutesPreviewRef.current, minutesPreviewRef.current, { inWrapper: true });
      })
      .finally(() => setBuildingMinutesPreview(false));
  }, [minutesDraft]);

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
    meetingStartedAtRef.current = Date.now();
    if (wantsSpeakerDetection) {
      await beginSampling();
    }
  };

  const handleStop = () => {
    relay.stopMeeting();
    void vision.stop();
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
        toast({ title: "Couldn't improve speaker labels", description: result.error, variant: "destructive" });
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
          ? `Speaker labels updated (${changed} segment${changed === 1 ? "" : "s"} reassigned)`
          : "Speaker labels already matched the full recording",
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

  const handleGenerateProposal = async () => {
    if (relay.segments.length === 0) return;
    await ensureTranslated();
    const transcriptText = segmentsToEnglishTranscriptText(relay.segments, relay.speakerLabel);
    try {
      const result = await proposalMutation.mutateAsync({ transcriptText, format: "proposal", exampleProposals });
      setProposalDraft(result.draft);
      await fileAutomatically("proposal", result.draft);
    } catch (err: any) {
      toast({ title: "Proposal generation failed", description: friendlyError(err), variant: "destructive" });
    }
  };

  const handleGenerateMinutes = async () => {
    if (relay.segments.length === 0) return;
    await ensureTranslated();
    const transcriptText = segmentsToEnglishTranscriptText(relay.segments, relay.speakerLabel);
    try {
      const result = await minutesMutation.mutateAsync({ transcriptText, format: "minutes-akla" });
      setMinutesDraft({ format: "minutes-akla", text: result.draft });
      await fileAutomatically("minutes-akla", result.draft);
    } catch (err: any) {
      toast({ title: "Minutes generation failed", description: friendlyError(err), variant: "destructive" });
    }
  };

  const handleGenerateConceptNote = async () => {
    if (relay.segments.length === 0) return;
    await ensureTranslated();
    const transcriptText = segmentsToEnglishTranscriptText(relay.segments, relay.speakerLabel);
    try {
      const result = await minutesMutation.mutateAsync({ transcriptText, format: "concept-note" });
      setMinutesDraft({ format: "concept-note", text: result.draft });
      await fileAutomatically("concept-note", result.draft);
    } catch (err: any) {
      toast({ title: "Concept note generation failed", description: friendlyError(err), variant: "destructive" });
    }
  };

  const handleUploadTranscriptClick = () => {
    if (relay.recording) return;
    transcriptFileInputRef.current?.click();
  };

  const handleTranscriptFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (relay.segments.length > 0 && !window.confirm("This replaces the current transcript. Continue?")) return;
    const text = await file.text();
    relay.setSegments(parseTranscriptText(text));
    relay.clearRecording();
  };

  const handleUploadRecordingClick = () => {
    if (relay.recording) return;
    recordingFileInputRef.current?.click();
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
      if (!result.segments || result.segments.length === 0) {
        toast({ title: "No speech detected in the recording", variant: "destructive" });
      }
    } finally {
      setTranscribingRecording(false);
    }
  };

  const handleSaveTranscript = () => {
    const text = segmentsToTranscriptText(relay.segments, relay.speakerLabel);
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "transcript.txt";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // The recorded meeting's raw audio, built client-side from the same PCM
  // chunks streamed to the relay while recording (see useMeetingRelay) —
  // available once a live meeting has been stopped, until a new meeting
  // starts or an uploaded transcript/recording replaces it.
  const handleDownloadRecording = () => {
    const blob = relay.getRecordingBlob();
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "meeting-recording.wav";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleDownload = async (format: MeetingOutputFormat, text: string) => {
    const blob = await buildAklaDocxBlob(text, OUTPUT_LABELS[format]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${OUTPUT_LABELS[format].replace(/\s+/g, "-")}.docx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleUploadToMatter = async (format: MeetingOutputFormat, text: string) => {
    // The three output types are looked up by name; if an admin renamed or
    // removed one, file the document anyway, untyped, and say so — never a
    // greyed-out button with no explanation.
    const documentTypeId = documentTypeIdFor(format) ?? null;
    if (!uploadMatterId) return;
    setUploadingFormat(format);
    try {
      // Dated, so a project's meetings are told apart in its list.
      const title = `${UPLOAD_DOCUMENT_TYPE_NAME[format]} — ${new Date().toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`;
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

  // A generated document goes straight into the chosen project; with no
  // project chosen it waits on the page with its Save button.
  const fileAutomatically = async (format: MeetingOutputFormat, text: string) => {
    // A new draft is not the one saved before.
    setSaved((prev) => {
      const next = { ...prev };
      delete next[format];
      return next;
    });
    if (uploadMatterId) await handleUploadToMatter(format, text);
    else toast({ title: "Choose a project to save it", description: "Pick the project at the top of the page, then press Save to project." });
  };

  const openSavedInClaude = async (format: MeetingOutputFormat) => {
    const entry = saved[format];
    const name = matters?.find((m) => m.id === entry?.matterId)?.name;
    if (!entry || !name) return;
    toast(claudeOpenedNotice(await openInClaude(documentPrompt(name, entry.title, "", entry.versionNumber))));
  };

  const hasContent = relay.segments.length > 0;
  const proposalUnsaved = !!proposalDraft && !saved.proposal;
  const minutesUnsaved = !!minutesDraft && !saved[minutesDraft.format];

  // Leaving or reloading loses a live recording, the transcript on screen and
  // any document not yet saved, so the browser asks first.
  const atRisk = relay.recording || proposalUnsaved || minutesUnsaved || (hasContent && !proposalDraft && !minutesDraft);
  useEffect(() => {
    if (!atRisk) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [atRisk]);

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Mic className="h-5 w-5 text-primary" />
          Record Meeting
        </h1>
        <p className="text-muted-foreground">
          Choose the project, press Start, and Stop when the meeting ends. The transcript tells speakers apart; the
          minutes, proposal or concept note you generate is saved into the project.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-end gap-3 flex-wrap">
            <div className="space-y-2">
              <label className="text-sm font-medium">Project</label>
              <Select value={uploadMatterId} onValueChange={setUploadMatterId}>
                <SelectTrigger className="w-64">
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
            <div className="space-y-2">
              <label className="text-sm font-medium">Language</label>
              <Select
                value={relay.language}
                onValueChange={(v) => {
                  relay.switchLanguage(v as MeetingLanguage);
                  remember({ language: v as MeetingLanguage });
                }}
              >
                <SelectTrigger className="w-48">
                  <Languages className="h-4 w-4 mr-2" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en-US">English</SelectItem>
                  <SelectItem value="ur">Urdu (translated to English when you generate a document)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">Audio source</label>
              <Select
                value={captureMeetingAudio ? "mic+meeting" : "mic"}
                onValueChange={(v) => setCaptureMeetingAudio(v === "mic+meeting")}
                disabled={relay.recording}
              >
                <SelectTrigger className="w-56">
                  <MonitorSpeaker className="h-4 w-4 mr-2 shrink-0" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mic">Microphone only</SelectItem>
                  <SelectItem value="mic+meeting">Microphone + meeting audio</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button onClick={handleStart} disabled={relay.recording}>
              <Mic className="h-4 w-4 mr-2" />
              Start
            </Button>
            <Button variant="destructive" onClick={handleStop} disabled={!relay.recording}>
              <Square className="h-4 w-4 mr-2" />
              Stop
            </Button>

            <input
              ref={transcriptFileInputRef}
              type="file"
              accept=".txt"
              className="hidden"
              onChange={handleTranscriptFileSelected}
            />
            <Button variant="outline" onClick={handleUploadTranscriptClick} disabled={relay.recording}>
              <FileUp className="h-4 w-4 mr-2" />
              Upload transcript…
            </Button>

            <input
              ref={recordingFileInputRef}
              type="file"
              accept="audio/*"
              className="hidden"
              onChange={handleRecordingFileSelected}
            />
            <Button variant="outline" onClick={handleUploadRecordingClick} disabled={relay.recording || transcribingRecording}>
              <FileAudio className="h-4 w-4 mr-2" />
              {transcribingRecording ? "Transcribing…" : "Upload recording…"}
            </Button>

            <Button variant="outline" onClick={handleImproveDiarization} disabled={!hasContent || improving}>
              <Wand2 className="h-4 w-4 mr-2" />
              {improving ? "Tidying…" : "Tidy up who said what"}
            </Button>
            <Button variant="outline" onClick={handleSaveTranscript} disabled={!hasContent}>
              <Save className="h-4 w-4 mr-2" />
              Download transcript
            </Button>
            <Button variant="outline" onClick={handleDownloadRecording} disabled={!relay.hasRecording}>
              <Download className="h-4 w-4 mr-2" />
              Download recording
            </Button>

            <span className="text-xs text-muted-foreground ml-auto">
              {relay.recording ? "Recording…" : ""}
            </span>
          </div>

          {captureMeetingAudio && (
            <div className="flex items-center gap-3 flex-wrap rounded-md border bg-muted/30 px-3 py-2">
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
                <>
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
                </>
              )}

              {detectSpeakers && !vision.region && (
                <span className="text-xs text-destructive">Show where Zoom puts the name once before starting.</span>
              )}
              {vision.sampling && (
                <span className="text-xs text-muted-foreground">
                  Reading screen… {vision.lastRead ? `last seen: ${vision.lastRead}` : "no name yet"} (
                  {vision.observations.length} samples)
                </span>
              )}
              {!vision.sampling && vision.observations.length > 0 && (
                <>
                  <span className="text-xs text-muted-foreground">
                    Detected: {vision.detectedNames().join(", ") || "none"}
                  </span>
                  <Button size="sm" variant="outline" onClick={handleApplyDetectedSpeakers} disabled={!hasContent}>
                    Apply detected names
                  </Button>
                </>
              )}
              {vision.error && <span className="text-xs text-destructive">{vision.error}</span>}

              {testResult && (
                <div className="w-full flex items-start gap-3 border-t pt-2 mt-1">
                  {testResult.cropDataUrl && (
                    <img
                      src={testResult.cropDataUrl}
                      alt="What the Hub reads"
                      className="border rounded bg-white max-h-16"
                    />
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

          {relay.error && <p className="text-sm text-destructive">{relay.error}</p>}

          <div className="border rounded-md p-4 max-h-[400px] overflow-y-auto">
            <SegmentList
              segments={relay.segments}
              interimText={relay.interimText}
              interimSpeaker={relay.interimSpeaker}
              speakerLabel={relay.speakerLabel}
              onMergeSpeaker={handleMergeSpeaker}
              onRenameSpeaker={handleRenameSpeaker}
              onSetManualSpeakerName={relay.setManualSpeakerName}
            />
          </div>

          {showExamples || exampleProposals ? (
            <div className="space-y-2">
              <label className="text-sm font-medium">
                Example proposals <span className="text-muted-foreground font-normal">(optional — paste the firm's own letters for the proposal to follow their style)</span>
              </label>
              <Textarea
                value={exampleProposals}
                onChange={(e) => setExampleProposals(e.target.value)}
                placeholder="Paste one or more example proposal letters here…"
                className="min-h-20"
              />
            </div>
          ) : (
            <button type="button" className="text-xs text-muted-foreground underline underline-offset-2" onClick={() => setShowExamples(true)}>
              Add example proposal letters for the proposal to follow (optional)
            </button>
          )}

          <div className="flex gap-2 flex-wrap">
            <Button
              variant="outline"
              onClick={handleGenerateProposal}
              disabled={!hasContent || proposalMutation.isPending || translating}
            >
              <FileText className="h-4 w-4 mr-2" />
              Generate Proposal (AKLA Format)
            </Button>
            <Button
              variant="outline"
              onClick={handleGenerateMinutes}
              disabled={!hasContent || minutesMutation.isPending || translating}
            >
              <FileText className="h-4 w-4 mr-2" />
              Generate Minutes (AKLA Format)
            </Button>
            <Button
              variant="outline"
              onClick={handleGenerateConceptNote}
              disabled={!hasContent || minutesMutation.isPending || translating}
            >
              <FileText className="h-4 w-4 mr-2" />
              Generate Concept Note
            </Button>
          </div>

          {(translating || proposalMutation.isPending || minutesMutation.isPending) && (
            <p className="text-sm text-muted-foreground">
              {translating ? "Translating transcript…" : "Drafting — this can take a moment…"}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {OUTPUT_LABELS.proposal} — Draft
          </p>
          {buildingProposalPreview && <p className="text-sm text-muted-foreground">Building preview…</p>}
          {proposalDraft ? (
            <div ref={proposalPreviewRef} className="border rounded-md p-4 max-h-[600px] overflow-y-auto overflow-x-auto" />
          ) : (
            <div className="border rounded-md p-4 text-sm text-muted-foreground">No proposal generated yet.</div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <Button variant="outline" onClick={() => proposalDraft && handleDownload("proposal", proposalDraft)} disabled={!proposalDraft}>
              <Download className="h-4 w-4 mr-2" />
              Download (.docx)
            </Button>
            {saved.proposal ? (
              <>
                <span className="text-sm text-muted-foreground">Saved to the project as “{saved.proposal.title}”.</span>
                <Button variant="outline" onClick={() => void openSavedInClaude("proposal")}>
                  <Sparkles className="h-4 w-4 mr-2" />
                  Open in Claude
                </Button>
              </>
            ) : (
              <Button
                onClick={() => proposalDraft && handleUploadToMatter("proposal", proposalDraft)}
                disabled={!proposalDraft || !uploadMatterId || uploadingFormat === "proposal"}
                title={uploadMatterId ? undefined : "Choose the project at the top of the page first"}
              >
                <Upload className="h-4 w-4 mr-2" />
                {uploadingFormat === "proposal" ? "Saving…" : "Save to project"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {minutesDraft ? OUTPUT_LABELS[minutesDraft.format] : "Meeting Minutes"} — Draft
          </p>
          {buildingMinutesPreview && <p className="text-sm text-muted-foreground">Building preview…</p>}
          {minutesDraft ? (
            <div ref={minutesPreviewRef} className="border rounded-md p-4 max-h-[600px] overflow-y-auto overflow-x-auto" />
          ) : (
            <div className="border rounded-md p-4 text-sm text-muted-foreground">No minutes generated yet.</div>
          )}
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              variant="outline"
              onClick={() => minutesDraft && handleDownload(minutesDraft.format, minutesDraft.text)}
              disabled={!minutesDraft}
            >
              <Download className="h-4 w-4 mr-2" />
              Download (.docx)
            </Button>
            {minutesDraft && saved[minutesDraft.format] ? (
              <>
                <span className="text-sm text-muted-foreground">Saved to the project as “{saved[minutesDraft.format]!.title}”.</span>
                <Button variant="outline" onClick={() => void openSavedInClaude(minutesDraft.format)}>
                  <Sparkles className="h-4 w-4 mr-2" />
                  Open in Claude
                </Button>
              </>
            ) : (
              <Button
                onClick={() => minutesDraft && handleUploadToMatter(minutesDraft.format, minutesDraft.text)}
                disabled={!minutesDraft || !uploadMatterId || uploadingFormat === minutesDraft?.format}
                title={uploadMatterId ? undefined : "Choose the project at the top of the page first"}
              >
                <Upload className="h-4 w-4 mr-2" />
                {minutesDraft && uploadingFormat === minutesDraft.format ? "Saving…" : "Save to project"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

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
