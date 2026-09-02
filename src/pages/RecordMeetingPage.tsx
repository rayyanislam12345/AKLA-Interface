import { useEffect, useMemo, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
import { Mic, Square, Wand2, FileText, Download, Upload, Languages, FileUp, Save } from "lucide-react";
import { useMeetingRelay, type MeetingLanguage } from "@/hooks/useMeetingRelay";
import { useGenerateMeetingOutput, type MeetingOutputFormat } from "@/hooks/useGenerateMeetingOutput";
import { useMatters } from "@/hooks/useMatters";
import { useDocumentTypes } from "@/hooks/useMatterDocuments";
import { buildAklaDocxBlob, buildStandardDocxBlob } from "@/lib/meetingDocx";
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

const OUTPUT_LABELS: Record<MeetingOutputFormat, string> = {
  proposal: "Client Proposal Letter",
  "minutes-akla": "Meeting Minutes (AKLA Format)",
  "minutes-standard": "Meeting Minutes",
};

const UPLOAD_DOCUMENT_TYPE_NAME: Record<MeetingOutputFormat, string> = {
  proposal: "Client Proposal Letter",
  "minutes-akla": "Meeting Minutes",
  "minutes-standard": "Meeting Minutes",
};

function buildDocxForFormat(format: MeetingOutputFormat, text: string, title: string) {
  return format === "minutes-standard" ? buildStandardDocxBlob(text, title) : buildAklaDocxBlob(text, title);
}

export default function RecordMeetingPage() {
  const { toast } = useToast();
  const relay = useMeetingRelay();
  const proposalMutation = useGenerateMeetingOutput();
  const minutesMutation = useGenerateMeetingOutput();
  const { data: matters } = useMatters();
  const { data: documentTypes } = useDocumentTypes();

  const [exampleProposals, setExampleProposals] = useState("");
  const [proposalDraft, setProposalDraft] = useState<string | null>(null);
  const [minutesDraft, setMinutesDraft] = useState<{ format: "minutes-akla" | "minutes-standard"; text: string } | null>(null);
  const [translating, setTranslating] = useState(false);
  const [improving, setImproving] = useState(false);

  const [uploadMatterId, setUploadMatterId] = useState<string>("");
  const [uploadingFormat, setUploadingFormat] = useState<MeetingOutputFormat | null>(null);

  const proposalPreviewRef = useRef<HTMLDivElement>(null);
  const minutesPreviewRef = useRef<HTMLDivElement>(null);
  const [buildingProposalPreview, setBuildingProposalPreview] = useState(false);
  const [buildingMinutesPreview, setBuildingMinutesPreview] = useState(false);

  const transcriptFileInputRef = useRef<HTMLInputElement>(null);

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
    buildDocxForFormat(minutesDraft.format, minutesDraft.text, OUTPUT_LABELS[minutesDraft.format])
      .then((blob) => {
        if (!minutesPreviewRef.current) return;
        minutesPreviewRef.current.innerHTML = "";
        return renderAsync(blob, minutesPreviewRef.current, minutesPreviewRef.current, { inWrapper: true });
      })
      .finally(() => setBuildingMinutesPreview(false));
  }, [minutesDraft]);

  const documentTypeIdFor = useMemo(() => {
    return (format: MeetingOutputFormat) => documentTypes?.find((t) => t.name === UPLOAD_DOCUMENT_TYPE_NAME[format])?.id;
  }, [documentTypes]);

  const handleStart = async () => {
    const ok = await relay.startMeeting(relay.language);
    if (!ok && relay.error) toast({ title: "Could not start meeting", description: relay.error, variant: "destructive" });
  };

  const handleStop = () => {
    relay.stopMeeting();
  };

  const handleImproveDiarization = async () => {
    setImproving(true);
    try {
      const result = await relay.improveDiarization();
      if (!result.ok) {
        toast({ title: "Couldn't improve speaker labels", description: result.error, variant: "destructive" });
      } else {
        toast({ title: "Speaker labels reconciled from the full recording" });
      }
    } finally {
      setImproving(false);
    }
  };

  const handleMergeSpeaker = (fromId: number, intoId: number) => {
    relay.mergeSpeakers(fromId, relay.speakerLabel(intoId));
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

  const handleGenerateMinutes = async (format: "minutes-akla" | "minutes-standard") => {
    if (relay.segments.length === 0) return;
    await ensureTranslated();
    const transcriptText = segmentsToEnglishTranscriptText(relay.segments, relay.speakerLabel);
    try {
      const result = await minutesMutation.mutateAsync({ transcriptText, format });
      setMinutesDraft({ format, text: result.draft });
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

  const handleDownload = async (format: MeetingOutputFormat, text: string) => {
    const blob = await buildDocxForFormat(format, text, OUTPUT_LABELS[format]);
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

      const blob = await buildDocxForFormat(format, text, title);
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

      toast({ title: `${title} uploaded to matter` });
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

            <Button variant="outline" onClick={handleImproveDiarization} disabled={!hasContent || improving}>
              <Wand2 className="h-4 w-4 mr-2" />
              {improving ? "Improving…" : "Improve Speaker Labels"}
            </Button>
            <Button variant="outline" onClick={handleSaveTranscript} disabled={!hasContent}>
              <Save className="h-4 w-4 mr-2" />
              Save Transcript
            </Button>

            <span className="text-xs text-muted-foreground ml-auto">
              {relay.recording ? "recording" : relay.connected ? "connected" : "idle"}
            </span>
          </div>

          {relay.error && <p className="text-sm text-destructive">{relay.error}</p>}

          <div className="border rounded-md p-4 max-h-[400px] overflow-y-auto">
            <SegmentList
              segments={relay.segments}
              interimText={relay.interimText}
              interimSpeaker={relay.interimSpeaker}
              speakerLabel={relay.speakerLabel}
              onMergeSpeaker={handleMergeSpeaker}
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
              Generate Proposal
            </Button>
            <Button
              variant="outline"
              onClick={() => handleGenerateMinutes("minutes-standard")}
              disabled={!hasContent || minutesMutation.isPending || translating}
            >
              <FileText className="h-4 w-4 mr-2" />
              Generate Minutes
            </Button>
            <Button
              variant="outline"
              onClick={() => handleGenerateMinutes("minutes-akla")}
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
            <label className="text-sm font-medium">Matter to upload generated documents to</label>
            <Select value={uploadMatterId} onValueChange={setUploadMatterId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a matter" />
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
              {uploadingFormat === "proposal" ? "Uploading…" : "Upload to Matter"}
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
                !documentTypeIdFor(minutesDraft?.format ?? "minutes-standard") ||
                uploadingFormat === minutesDraft?.format
              }
            >
              <Upload className="h-4 w-4 mr-2" />
              {minutesDraft && uploadingFormat === minutesDraft.format ? "Uploading…" : "Upload to Matter"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
