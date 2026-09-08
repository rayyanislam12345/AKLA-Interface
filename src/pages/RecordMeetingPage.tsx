import { useEffect, useMemo, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
import { Mic, Square, Wand2, FileText, Download, Upload, Languages, FileUp, FileAudio, MonitorSpeaker, ScanSearch, Save } from "lucide-react";
import { useMeetingRelay, type MeetingLanguage } from "@/hooks/useMeetingRelay";
import { useGenerateMeetingOutput, type MeetingOutputFormat } from "@/hooks/useGenerateMeetingOutput";
import { useMatters } from "@/hooks/useMatters";
import { useDocumentTypes } from "@/hooks/useMatterDocuments";
import { buildAklaDocxBlob } from "@/lib/meetingDocx";
import NameLabelCalibrator from "@/components/meeting/NameLabelCalibrator";
import { useSpeakerVision } from "@/hooks/useSpeakerVision";
import { reassignSpeakerIds, voteSpeakerNames } from "@/lib/speakerTimeline";
import SegmentList, {
  parseTranscriptText,
  segmentsToEnglishTranscriptText,
  segmentsToTranscriptText,
} from "@/components/meeting/SegmentList";
import { supabase } from "@/integrations/supabase/client";
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
};

const UPLOAD_DOCUMENT_TYPE_NAME: Record<MeetingOutputFormat, string> = {
  proposal: "Client Proposal Letter",
  "minutes-akla": "Meeting Minutes",
};

export default function RecordMeetingPage() {
  const { toast } = useToast();
  const relay = useMeetingRelay();
  const proposalMutation = useGenerateMeetingOutput();
  const minutesMutation = useGenerateMeetingOutput();
  const { data: matters } = useMatters();
  const { data: documentTypes } = useDocumentTypes();

  const [exampleProposals, setExampleProposals] = useState("");
  const [proposalDraft, setProposalDraft] = useState<string | null>(null);
  const [minutesDraft, setMinutesDraft] = useState<{ format: "minutes-akla"; text: string } | null>(null);
  const [translating, setTranslating] = useState(false);
  const [improving, setImproving] = useState(false);
  const [transcribingRecording, setTranscribingRecording] = useState(false);
  const [captureMeetingAudio, setCaptureMeetingAudio] = useState(false);
  const [detectSpeakers, setDetectSpeakers] = useState(false);
  const [calibratorOpen, setCalibratorOpen] = useState(false);
  const [calibrationFrame, setCalibrationFrame] = useState<string | null>(null);
  const vision = useSpeakerVision();

  const [uploadMatterId, setUploadMatterId] = useState<string>("");
  const [uploadingFormat, setUploadingFormat] = useState<MeetingOutputFormat | null>(null);

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

  const handleStart = async () => {
    const ok = await relay.startMeeting(relay.language, {
      captureMeetingAudio,
      detectSpeakers: wantsSpeakerDetection,
    });
    if (!ok) {
      if (relay.error) toast({ title: "Could not start meeting", description: relay.error, variant: "destructive" });
      return;
    }
    if (wantsSpeakerDetection) {
      vision.reset();
      // Same clock as the transcript: Deepgram's timestamps are relative to
      // when audio started flowing, so observations are stamped from here.
      const started = await vision.start(Date.now());
      if (!started && vision.error) {
        toast({ title: "Speaker detection off", description: vision.error, variant: "destructive" });
      }
    }
  };

  const handleStop = () => {
    relay.stopMeeting();
    void vision.stop();
  };

  const handleOpenCalibrator = () => {
    setCalibrationFrame(vision.captureStillFrame());
    setCalibratorOpen(true);
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
    } catch (err: any) {
      toast({ title: "Proposal generation failed", description: err.message, variant: "destructive" });
    }
  };

  const handleGenerateMinutes = async () => {
    if (relay.segments.length === 0) return;
    await ensureTranslated();
    const transcriptText = segmentsToEnglishTranscriptText(relay.segments, relay.speakerLabel);
    try {
      const result = await minutesMutation.mutateAsync({ transcriptText, format: "minutes-akla" });
      setMinutesDraft({ format: "minutes-akla", text: result.draft });
    } catch (err: any) {
      toast({ title: "Minutes generation failed", description: err.message, variant: "destructive" });
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
    const documentTypeId = documentTypeIdFor(format);
    if (!uploadMatterId || !documentTypeId) return;
    setUploadingFormat(format);
    try {
      const { data: userData } = await supabase.auth.getUser();
      const title = OUTPUT_LABELS[format];

      const { data: matterDocument, error: createError } = await supabase
        .from("matter_documents")
        .insert({
          matter_id: uploadMatterId,
          document_type_id: documentTypeId,
          title,
          status: "drafting",
          created_by: userData.user?.id,
        })
        .select("id")
        .single();
      if (createError) throw createError;

      const blob = await buildAklaDocxBlob(text, title);
      const fileName = `${title.replace(/\s+/g, "-")}.docx`;
      const storagePath = `${uploadMatterId}/${matterDocument.id}/v1-${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from("matter-documents")
        .upload(storagePath, blob, {
          contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });
      if (uploadError) throw uploadError;

      const { error: versionError } = await supabase.from("document_versions").insert({
        matter_document_id: matterDocument.id,
        version_number: 1,
        storage_path: storagePath,
        file_name: fileName,
        is_ai_generated: true,
        uploaded_by: userData.user?.id,
      });
      if (versionError) throw versionError;

      const { error: processError } = await supabase.functions.invoke("process-document", {
        body: {
          filePath: storagePath,
          fileName,
          fileType: blob.type,
          bucket: "matter-documents",
          matterId: uploadMatterId,
          documentTypeId,
          isPrecedent: false,
        },
      });
      if (processError) console.error("Document uploaded but RAG ingestion failed:", processError);

      toast({ title: `${title} uploaded to project` });
    } catch (err: any) {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    } finally {
      setUploadingFormat(null);
    }
  };

  const hasContent = relay.segments.length > 0;

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <Mic className="h-5 w-5 text-primary" />
          Record Meeting
        </h1>
        <p className="text-muted-foreground">
          Live transcription with speaker diarization — draft a proposal or meeting minutes when you're done.
        </p>
      </div>

      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-end gap-3 flex-wrap">
            <div className="space-y-2">
              <label className="text-sm font-medium">Language</label>
              <Select value={relay.language} onValueChange={(v) => relay.switchLanguage(v as MeetingLanguage)}>
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
              Start Meeting
            </Button>
            <Button variant="destructive" onClick={handleStop} disabled={!relay.recording}>
              <Square className="h-4 w-4 mr-2" />
              Stop Meeting
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
              Upload Transcript…
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
              {transcribingRecording ? "Transcribing…" : "Upload Recording…"}
            </Button>

            <Button variant="outline" onClick={handleImproveDiarization} disabled={!hasContent || improving}>
              <Wand2 className="h-4 w-4 mr-2" />
              {improving ? "Improving…" : "Improve Speaker Labels"}
            </Button>
            <Button variant="outline" onClick={handleSaveTranscript} disabled={!hasContent}>
              <Save className="h-4 w-4 mr-2" />
              Save Transcript
            </Button>
            <Button variant="outline" onClick={handleDownloadRecording} disabled={!relay.hasRecording}>
              <Download className="h-4 w-4 mr-2" />
              Download Recording
            </Button>

            <span className="text-xs text-muted-foreground ml-auto">
              {relay.recording ? "recording" : relay.connected ? "connected" : "idle"}
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

              <Button size="sm" variant="outline" onClick={handleOpenCalibrator} disabled={!relay.displayStream}>
                <ScanSearch className="h-4 w-4 mr-2" />
                {vision.region ? "Recalibrate name label" : "Calibrate name label"}
              </Button>

              {detectSpeakers && !vision.region && (
                <span className="text-xs text-destructive">Calibrate once before starting.</span>
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

          <div className="space-y-2">
            <label className="text-sm font-medium">
              Example proposals <span className="text-muted-foreground font-normal">(optional — paste the firm's own template/samples to match its style)</span>
            </label>
            <Textarea
              value={exampleProposals}
              onChange={(e) => setExampleProposals(e.target.value)}
              placeholder="Paste one or more example proposal letters here…"
              className="min-h-20"
            />
          </div>

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
          </div>

          {(translating || proposalMutation.isPending || minutesMutation.isPending) && (
            <p className="text-sm text-muted-foreground">
              {translating ? "Translating transcript…" : "Drafting — this can take a moment…"}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-6">
          <div className="space-y-2 max-w-xs">
            <label className="text-sm font-medium">Project to upload generated documents to</label>
            <Select value={uploadMatterId} onValueChange={setUploadMatterId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a project" />
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
              Save Proposal (.docx)
            </Button>
            <Button
              onClick={() => proposalDraft && handleUploadToMatter("proposal", proposalDraft)}
              disabled={!proposalDraft || !uploadMatterId || !documentTypeIdFor("proposal") || uploadingFormat === "proposal"}
            >
              <Upload className="h-4 w-4 mr-2" />
              {uploadingFormat === "proposal" ? "Uploading…" : "Upload to Project"}
            </Button>
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
              Save Minutes (.docx)
            </Button>
            <Button
              onClick={() => minutesDraft && handleUploadToMatter(minutesDraft.format, minutesDraft.text)}
              disabled={
                !minutesDraft ||
                !uploadMatterId ||
                !documentTypeIdFor(minutesDraft?.format ?? "minutes-akla") ||
                uploadingFormat === minutesDraft?.format
              }
            >
              <Upload className="h-4 w-4 mr-2" />
              {minutesDraft && uploadingFormat === minutesDraft.format ? "Uploading…" : "Upload to Project"}
            </Button>
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
          toast({ title: "Name label region saved" });
        }}
      />
    </div>
  );
}
