// Fitting a conversation's documents into the prompt.
//
// A document used to go in whole up to 60,000 characters, and one that did
// not fit in what was left of the budget was dropped with a notice. The M6
// Transaction Structure Report extracts to 524,000 characters, so a request
// to draft from it, the term sheet and the concept note left it out
// entirely. Now every document goes in: the budget is shared so that short
// documents are whole and long ones are cut down to their opening and the
// passages that matter to the conversation, marked as excerpts.

const STOPWORDS = new Set(
  "the and for with that this from into onto upon under over what which who whom whose will shall would should could have has had been being were was are is its it's their there they them then than also such each any all may might must can not nor but only very more most some other same about above below after before between through during without within against among draft please document documents docs project matter based using details pick make write prepare create".split(" "),
);

/** "Draft it from the project docs", "use all the documents": every document on the project. */
export function mentionsProjectDocuments(message) {
  return /\b(?:(?:project|matter|project's|matter's)\s+(?:docs?|documents?|files?|materials?|papers?)|all\s+(?:of\s+)?(?:the\s+|our\s+|my\s+)?(?:project\s+)?(?:docs?|documents?|files?|materials?)|(?:docs?|documents?|files?)\s+(?:on|in|for|of)\s+(?:the\s+|this\s+)?(?:project|matter)|available\s+(?:docs?|documents?|files?))\b/i.test(
    String(message ?? ""),
  );
}

function terms(query) {
  const counts = new Map();
  for (const word of String(query ?? "").toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? []) {
    if (!STOPWORDS.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.keys()];
}

// Pieces of about `size` characters that end on a paragraph or line break.
function pieces(text, size = 1500) {
  const out = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + size);
    if (end < text.length) {
      const para = text.lastIndexOf("\n\n", end);
      const line = text.lastIndexOf("\n", end);
      const cut = para > start + size / 2 ? para : line > start + size / 2 ? line : end;
      end = cut;
    }
    out.push({ start, end, text: text.slice(start, end) });
    start = end;
  }
  return out;
}

/**
 * At most `budget` characters of `text`: its opening, which carries the
 * contents and summary of a report, then the passages that best match the
 * query, in document order. With no useful query the passages are spread
 * evenly through the document instead.
 */
export function excerptDocument(text, budget, query) {
  if (text.length <= budget) return { text, excerpted: false };
  const gap = "\n\n[… passage omitted …]\n\n";
  const openingSize = Math.floor(budget * 0.25);
  const opening = pieces(text.slice(0, openingSize * 2), openingSize)[0];
  const rest = pieces(text.slice(opening.end)).map((p) => ({ ...p, start: p.start + opening.end, end: p.end + opening.end }));
  const wanted = terms(query);
  const scored = rest.map((p, index) => {
    const lower = p.text.toLowerCase();
    let score = 0;
    for (const t of wanted) {
      let at = lower.indexOf(t);
      let hits = 0;
      while (at >= 0 && hits < 3) {
        hits++;
        at = lower.indexOf(t, at + t.length);
      }
      score += hits;
    }
    return { ...p, index, score };
  });
  const anyMatch = scored.some((p) => p.score > 0);
  let order;
  if (anyMatch) {
    order = [...scored].sort((a, b) => b.score - a.score || a.index - b.index);
  } else {
    // Evenly through the document: every k-th piece first, then the rest.
    const step = Math.max(1, Math.round(scored.length / Math.max(1, Math.floor((budget - opening.text.length) / 1500))));
    order = [...scored.filter((_, i) => i % step === 0), ...scored.filter((_, i) => i % step !== 0)];
  }
  let used = opening.text.length;
  const chosen = [];
  for (const p of order) {
    if (used + p.text.length + gap.length > budget) continue;
    chosen.push(p);
    used += p.text.length + gap.length;
  }
  chosen.sort((a, b) => a.start - b.start);
  let out = opening.text;
  let lastEnd = opening.end;
  for (const p of chosen) {
    out += p.start > lastEnd ? `${gap}${p.text}` : p.text;
    lastEnd = p.end;
  }
  if (lastEnd < text.length) out += gap.trimEnd();
  return { text: out, excerpted: true };
}

/**
 * Shares `total` characters across the documents: each gets what it needs
 * up to an equal share of what is left, so short ones are whole and the
 * long ones divide the remainder.
 */
export function fitDocuments(docs, total, query) {
  const byLength = docs.map((d, i) => ({ d, i })).sort((a, b) => a.d.text.length - b.d.text.length);
  let remaining = total;
  const shares = new Array(docs.length);
  byLength.forEach(({ d, i }, k) => {
    const share = Math.floor(remaining / (byLength.length - k));
    shares[i] = Math.min(d.text.length, share);
    remaining -= shares[i];
  });
  return docs.map((d, i) => {
    const { text, excerpted } = excerptDocument(d.text, shares[i], query);
    return { ...d, text, excerpted, fullChars: d.text.length };
  });
}
