// The parts of a recorded meeting that outlive the page: its details
// (title, who attended), the names documents are filed under, and a copy of
// the transcript kept in the browser so a crash, a sleeping laptop or a
// closed tab does not lose it. Pure: storage is passed in. Tested in
// tests/meetingSession.test.js.

import type { MeetingSegment } from "../hooks/useMeetingRelay.ts";

export interface MeetingDetails {
  title: string;
  attendees: string;
}

/** The names typed in "Who attended", split on commas, semicolons and new lines. */
export function attendeeNames(attendees: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const raw of attendees.split(/[,;\n]+/)) {
    const name = raw.trim();
    if (name && !seen.has(name.toLowerCase())) {
      seen.add(name.toLowerCase());
      names.push(name);
    }
  }
  return names;
}

export const longDate = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

/** The lines put before the transcript so the minutes carry the meeting's title, date and attendees. */
export function meetingHeader(details: MeetingDetails, date: Date): string {
  const lines = [`Date: ${longDate(date)}`];
  if (details.title.trim()) lines.unshift(`Meeting: ${details.title.trim()}`);
  const names = attendeeNames(details.attendees);
  if (names.length) lines.push(`Attendees: ${names.join(", ")}`);
  return `${lines.join("\n")}\n\nTranscript:\n`;
}

/** "Meeting Minutes — KPT kick-off — 23 October 2026"; without a title, "Meeting Minutes — 23 October 2026". */
export function meetingDocumentTitle(kind: string, title: string, date: Date): string {
  return [kind, title.trim(), longDate(date)].filter(Boolean).join(" — ");
}

/** The running clock: 0:07, 12:34, 1:02:09. */
export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// ------------------------------------------------------------ the kept copy

export const KEPT_TRANSCRIPT_KEY = "akla.record-meeting.transcript";

export interface KeptTranscript {
  savedAt: string;
  segments: MeetingSegment[];
  speakerNames: Array<[number, string]>;
  details: MeetingDetails;
  matterId: string;
}

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** Keeps the transcript; a full or refused store is ignored (the page works without it). */
export function keepTranscript(store: Store | null, kept: KeptTranscript): void {
  try {
    store?.setItem(KEPT_TRANSCRIPT_KEY, JSON.stringify(kept));
  } catch {
    /* not kept */
  }
}

/** The kept transcript, or null when there is none, it is empty or it can't be read. */
export function keptTranscript(store: Store | null): KeptTranscript | null {
  try {
    const raw = store?.getItem(KEPT_TRANSCRIPT_KEY);
    if (!raw) return null;
    const kept = JSON.parse(raw) as KeptTranscript;
    if (!Array.isArray(kept.segments) || kept.segments.length === 0) return null;
    return {
      savedAt: String(kept.savedAt ?? ""),
      segments: kept.segments,
      speakerNames: Array.isArray(kept.speakerNames) ? kept.speakerNames : [],
      details: { title: kept.details?.title ?? "", attendees: kept.details?.attendees ?? "" },
      matterId: kept.matterId ?? "",
    };
  } catch {
    return null;
  }
}

export function forgetTranscript(store: Store | null): void {
  try {
    store?.removeItem(KEPT_TRANSCRIPT_KEY);
  } catch {
    /* nothing kept */
  }
}
