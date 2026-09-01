import { useMemo, useState } from "react";
import type { MeetingSegment } from "@/hooks/useMeetingRelay";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface SegmentListProps {
  segments: MeetingSegment[];
  interimText: string | null;
  interimSpeaker: number | undefined;
  speakerLabel: (speakerId: number | undefined) => string;
  onMergeSpeaker: (fromId: number, intoId: number) => void;
}

// Ported from transcription-bot/src/renderer/renderer.js's segment list +
// inline speaker-merge picker — text is never rewritten, only the
// speaker-id-to-label mapping changes, so merged speakers just start
// sharing a display name going forward.
export default function SegmentList({ segments, interimText, interimSpeaker, speakerLabel, onMergeSpeaker }: SegmentListProps) {
  const [mergeMenuFor, setMergeMenuFor] = useState<number | null>(null);

  const knownSpeakerIds = useMemo(() => {
    const ids = new Set<number>();
    for (const s of segments) if (s.speakerId !== undefined) ids.add(s.speakerId);
    return Array.from(ids).sort((a, b) => a - b);
  }, [segments]);

  return (
    <div className="space-y-3">
      {segments.map((seg) => (
        <div key={seg.id} className="text-sm">
          <div className="flex items-center gap-2">
            {seg.speakerId !== undefined && (
              <button
                className="text-xs font-medium text-primary hover:underline shrink-0"
                onClick={() => setMergeMenuFor(mergeMenuFor === seg.speakerId ? null : seg.speakerId!)}
              >
                {speakerLabel(seg.speakerId)}
              </button>
            )}
            {mergeMenuFor === seg.speakerId && seg.speakerId !== undefined && (
              <Select
                onValueChange={(value) => {
                  onMergeSpeaker(seg.speakerId!, Number(value));
                  setMergeMenuFor(null);
                }}
              >
                <SelectTrigger className="h-6 w-40 text-xs">
                  <SelectValue placeholder="Merge into…" />
                </SelectTrigger>
                <SelectContent>
                  {knownSpeakerIds
                    .filter((id) => id !== seg.speakerId)
                    .map((id) => (
                      <SelectItem key={id} value={String(id)}>
                        {speakerLabel(id)}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <p className="text-foreground">{seg.text}</p>
          {seg.translation && <p className="text-muted-foreground pl-4">→ {seg.translation}</p>}
        </div>
      ))}
      {interimText && (
        <div className="text-sm opacity-60">
          {interimSpeaker !== undefined && (
            <p className="text-xs font-medium">{speakerLabel(interimSpeaker)}</p>
          )}
          <p className="italic">{interimText}</p>
        </div>
      )}
      {segments.length === 0 && !interimText && (
        <p className="text-sm text-muted-foreground">Nothing transcribed yet — start recording to see live text here.</p>
      )}
    </div>
  );
}

// Matches renderer.js's getTranscriptText exactly (speaker prefix + raw
// text + an indented "→ translation" line where one exists) so a saved
// transcript round-trips cleanly back through parseTranscriptText below.
export function segmentsToTranscriptText(segments: MeetingSegment[], speakerLabel: (id: number | undefined) => string) {
  return segments
    .map((s) => {
      const label = s.speakerId !== undefined ? speakerLabel(s.speakerId) : s.manualSpeaker;
      const prefix = label ? `${label}: ` : "";
      const translationLine = s.translation ? `\n    → ${s.translation}` : "";
      return `${prefix}${s.text}${translationLine}`;
    })
    .join("\n");
}

const IMPORT_SPEAKER_PREFIX = /^([A-Za-z0-9][\w .'-]{0,40}):\s(.*)$/;
const IMPORT_TRANSLATION_LINE = /^\s{2,}→\s?(.*)$/;

// Ported from renderer.js's importTranscriptText — parses a plain-text
// transcript (either one saved by this app, or a lawyer's own notes) into
// segments. "Name: text" lines become a manual speaker; indented "→ ..."
// lines attach as the translation of the previous line; anything else is a
// speaker-less line.
export function parseTranscriptText(text: string): MeetingSegment[] {
  const segments: MeetingSegment[] = [];
  let nextId = 0;

  for (const rawLine of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    const translationMatch = IMPORT_TRANSLATION_LINE.exec(line);
    if (translationMatch && segments.length > 0) {
      segments[segments.length - 1].translation = translationMatch[1].trim();
      continue;
    }

    const prefixMatch = IMPORT_SPEAKER_PREFIX.exec(line);
    segments.push({
      id: ++nextId,
      text: prefixMatch ? prefixMatch[2] : line,
      manualSpeaker: prefixMatch ? prefixMatch[1].trim() : undefined,
    });
  }

  return segments;
}

// Prefers each segment's translation (English) over its original text —
// this is what feeds proposal/minutes generation regardless of the
// language actually spoken, matching renderer.js's getEnglishTranscriptText.
export function segmentsToEnglishTranscriptText(segments: MeetingSegment[], speakerLabel: (id: number | undefined) => string) {
  return segments
    .map((s) => {
      const label = s.speakerId !== undefined ? speakerLabel(s.speakerId) : s.manualSpeaker;
      const prefix = label ? `${label}: ` : "";
      return `${prefix}${s.translation ?? s.text}`;
    })
    .join("\n");
}
