// Review suggestions that touch the same words become one suggestion.
//
// The three passes read the document independently, so the legal pass and
// the conflicts pass can each propose a rewrite of the same clause. Shown
// separately, the second can never be marked in the document once the first
// has changed its words, and accepting one silently discards the other. A
// lawyer should see one proposed wording for a stretch of text, with every
// reason for it.

const PASS_ORDER = ["legal_clauses", "content_conflicts", "formatting", "chat"];
const PASS_LABEL = {
  legal_clauses: "Legal clauses & citations",
  content_conflicts: "Content & conflicts",
  formatting: "Formatting",
  chat: "Follow-up",
};

// Where two versions of a quote differ, word by word, as ranges of the old.
function hunks(oldText, newText) {
  const a = oldText.match(/\s+|\S+/g) ?? [];
  const b = newText.match(/\s+|\S+/g) ?? [];
  if (a.length * b.length > 4_000_000) return null;
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out = [];
  let i = 0, j = 0, pos = 0, open = null;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      if (open) { out.push(open); open = null; }
      pos += a[i].length; i++; j++;
    } else if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) {
      open ??= { start: pos, end: pos, inserted: "" };
      open.inserted += b[j]; j++;
    } else {
      open ??= { start: pos, end: pos, inserted: "" };
      pos += a[i].length; open.end = pos; i++;
    }
  }
  if (open) out.push(open);
  return out;
}

/** Groups of suggestions whose quoted text overlaps in the document. */
export function overlapGroups(suggestions, fullText) {
  const placed = suggestions.map((s, index) => {
    const start = fullText.indexOf(s.original_text);
    return { s, index, start, end: start < 0 ? -1 : start + s.original_text.length };
  });
  const located = placed.filter((p) => p.start >= 0).sort((x, y) => x.start - y.start || y.end - x.end);
  const groups = [];
  for (const p of located) {
    const last = groups[groups.length - 1];
    if (last && p.start < last.end) {
      last.members.push(p);
      last.end = Math.max(last.end, p.end);
    } else {
      groups.push({ start: p.start, end: p.end, members: [p] });
    }
  }
  // Suggestions not found in the text cannot overlap anything; keep them.
  for (const p of placed.filter((q) => q.start < 0)) groups.push({ start: -1, end: -1, members: [p] });
  return groups.sort((x, y) => Math.min(...x.members.map((m) => m.index)) - Math.min(...y.members.map((m) => m.index)));
}

/**
 * Every change in a group written into the group's whole span, when no two
 * of them touch the same words. Returns null when they do.
 */
export function combineMechanically(group, fullText) {
  const span = fullText.slice(group.start, group.end);
  const all = [];
  for (const { s, start } of group.members) {
    const local = hunks(s.original_text, s.suggested_text);
    if (!local) return null;
    for (const h of local) all.push({ start: h.start + start - group.start, end: h.end + start - group.start, inserted: h.inserted });
  }
  const unique = all
    .filter((h, k) => all.findIndex((o) => o.start === h.start && o.end === h.end && o.inserted === h.inserted) === k)
    .sort((x, y) => x.start - y.start || x.end - y.end);
  for (let k = 1; k < unique.length; k++) {
    const prev = unique[k - 1];
    const cur = unique[k];
    const collide = cur.start < prev.end || (cur.start === prev.start && prev.start === prev.end && cur.start === cur.end);
    if (collide) return null;
  }
  let text = span;
  for (const h of [...unique].reverse()) text = text.slice(0, h.start) + h.inserted + text.slice(h.end);
  return text;
}

function mergedRow(group, fullText, suggestedText, note) {
  const members = group.members.map((m) => m.s);
  const lead = [...members].sort((x, y) => PASS_ORDER.indexOf(x.review_type) - PASS_ORDER.indexOf(y.review_type))[0];
  const references = [...new Set(members.map((m) => m.clause_reference).filter(Boolean))];
  const rationale = members
    .map((m) => `${PASS_LABEL[m.review_type] ?? m.review_type}${m.clause_reference ? ` (${m.clause_reference})` : ""}: ${m.rationale}`)
    .join("\n\n");
  return {
    ...lead,
    clause_reference: references.join(" · ") || lead.clause_reference,
    original_text: fullText.slice(group.start, group.end),
    suggested_text: suggestedText,
    rationale: note ? `${rationale}\n\n${note}` : rationale,
  };
}

/**
 * Merges overlapping suggestions. `combine` is asked for one wording when
 * two suggestions rewrite the same words differently; it receives the span
 * and the members, and returns the combined text or null.
 */
export async function mergeOverlapping(suggestions, fullText, { combine } = {}) {
  const merged = [];
  let groupsMerged = 0;
  for (const group of overlapGroups(suggestions, fullText)) {
    if (group.members.length === 1) { merged.push(group.members[0].s); continue; }
    groupsMerged++;
    let text = combineMechanically(group, fullText);
    let note = "";
    if (text === null && combine) {
      try { text = await combine(fullText.slice(group.start, group.end), group.members.map((m) => m.s)); } catch { text = null; }
    }
    if (typeof text !== "string" || !text.trim() || text === fullText.slice(group.start, group.end)) {
      // No safe single wording: keep the lead suggestion's change, and put
      // the other proposals in front of the lawyer rather than drop them.
      const lead = [...group.members].sort((x, y) => PASS_ORDER.indexOf(x.s.review_type) - PASS_ORDER.indexOf(y.s.review_type))[0];
      const span = fullText.slice(group.start, group.end);
      const offset = lead.start - group.start;
      text = span.slice(0, offset) + lead.s.suggested_text + span.slice(offset + lead.s.original_text.length);
      note = `Other wording proposed for this passage, not applied: ${group.members.filter((m) => m !== lead).map((m) => `"${m.s.suggested_text}"`).join("; ")}`;
    }
    merged.push(mergedRow(group, fullText, text, note));
  }
  return { suggestions: merged, groupsMerged };
}
