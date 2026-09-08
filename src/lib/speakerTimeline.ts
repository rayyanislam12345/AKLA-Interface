// Aligning an externally-derived "who was talking when" timeline against
// segments that were transcribed live. Two things produce such a timeline:
// Deepgram's batch pass (higher-accuracy diarizer, speakers as numbers), and
// on-screen speaker detection (Zoom's active speaker, as names). Both align
// the same way, so both go through here.
//
// Transcribed text is never touched — only who a segment is attributed to.

export interface TimelineEntry<TSpeaker> {
  speaker: TSpeaker;
  start: number;
  end: number;
}

interface TimedSegment {
  startSec?: number;
  endSec?: number;
}

// Greatest overlap wins, so a segment straddling a speaker change or a
// slightly different utterance boundary still resolves to the speaker who
// held most of it. Returns undefined when nothing overlaps at all.
export function pickSpeakerForRange<TSpeaker>(
  timeline: TimelineEntry<TSpeaker>[],
  startSec: number,
  endSec: number
): TSpeaker | undefined {
  let best: TSpeaker | undefined;
  let bestOverlap = 0;

  for (const entry of timeline) {
    const overlap = Math.min(endSec, entry.end) - Math.max(startSec, entry.start);
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      best = entry.speaker;
    }
  }

  return bestOverlap > 0 ? best : undefined;
}

// Which diarized speaker id each segment should now carry, keyed by segment
// id rather than object identity — the result is applied inside a state
// updater, by which point React may be handing back different objects than
// the ones this was computed from. Only segments with timing can be placed;
// anything without it (a typed line, an imported transcript) is left alone
// rather than guessed at.
export function reassignSpeakerIds<TSegment extends TimedSegment & { id: number }>(
  segments: TSegment[],
  timeline: TimelineEntry<number>[]
): Map<number, number> {
  const assignments = new Map<number, number>();

  for (const segment of segments) {
    if (segment.startSec === undefined || segment.endSec === undefined) continue;
    const speaker = pickSpeakerForRange(timeline, segment.startSec, segment.endSec);
    if (speaker !== undefined) assignments.set(segment.id, speaker);
  }

  return assignments;
}

// Names observed on screen are noisier than Deepgram's speaker ids: OCR
// misreads, and Zoom's active-speaker highlight lags and flickers during
// crosstalk. So rather than naming each segment from whatever was on screen
// at that instant, every observation overlapping a given speaker id votes,
// and the id takes the name it was seen with most. A handful of bad reads
// get outvoted, and Deepgram's own consistency about who-is-who is kept.
export function voteSpeakerNames<TSegment extends TimedSegment & { speakerId?: number }>(
  segments: TSegment[],
  timeline: TimelineEntry<string>[]
): Map<number, string> {
  const votesById = new Map<number, Map<string, number>>();

  for (const segment of segments) {
    if (segment.speakerId === undefined) continue;
    if (segment.startSec === undefined || segment.endSec === undefined) continue;

    for (const entry of timeline) {
      const overlap = Math.min(segment.endSec, entry.end) - Math.max(segment.startSec, entry.start);
      if (overlap <= 0) continue;

      const votes = votesById.get(segment.speakerId) ?? new Map<string, number>();
      // Weighted by seconds of overlap, so a name that held a long turn
      // counts for more than one that clipped the edge of it.
      votes.set(entry.speaker, (votes.get(entry.speaker) ?? 0) + overlap);
      votesById.set(segment.speakerId, votes);
    }
  }

  const winners = new Map<number, string>();
  for (const [speakerId, votes] of votesById) {
    let bestName: string | undefined;
    let bestScore = 0;
    for (const [name, score] of votes) {
      if (score > bestScore) {
        bestScore = score;
        bestName = name;
      }
    }
    if (bestName) winners.set(speakerId, bestName);
  }

  return winners;
}

// Levenshtein, capped at the shorter string's length — only ever run on
// short name strings, so the full matrix is fine.
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = row;
  }
  return prev[b.length];
}

export function nameSimilarity(a: string, b: string): number {
  const x = a.trim().toLowerCase();
  const y = b.trim().toLowerCase();
  if (!x || !y) return 0;
  const longest = Math.max(x.length, y.length);
  return 1 - editDistance(x, y) / longest;
}

// OCR gives back the same person spelled several ways ("Abbas Mukhtar",
// "Abbes Mukhtor", "Abbas Mukhta"). Group the variants and let the most
// frequently-seen spelling stand for the group, so downstream only ever sees
// one name per person without anyone having to supply a roster up front.
export function canonicaliseNames(
  observations: string[],
  { threshold = 0.75 }: { threshold?: number } = {}
): Map<string, string> {
  const counts = new Map<string, number>();
  for (const raw of observations) {
    const name = raw.trim();
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }

  // Most-seen spellings first, so clusters form around the reading that won
  // most often rather than whichever happened to appear first.
  const byFrequency = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  const canonical = new Map<string, string>();
  const clusterHeads: string[] = [];

  for (const [name] of byFrequency) {
    const head = clusterHeads.find((candidate) => nameSimilarity(candidate, name) >= threshold);
    if (head) {
      canonical.set(name, head);
    } else {
      clusterHeads.push(name);
      canonical.set(name, name);
    }
  }

  return canonical;
}
