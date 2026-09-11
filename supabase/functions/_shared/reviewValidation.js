// Pure validation shared by edge functions and local regression tests.
export function parseSuggestions(raw, stopReason, sourceText) {
  if (stopReason !== 'end_turn') throw new Error('Review incomplete: the model did not finish. No clean result was recorded.');
  const text = raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  let rows;
  try { rows = JSON.parse(text); } catch { throw new Error('Review failed: invalid structured response.'); }
  if (!Array.isArray(rows)) throw new Error('Review failed: expected a suggestions array.');
  for (const row of rows) {
    if (!row || ['clause_reference', 'original_text', 'suggested_text', 'rationale'].some(k => typeof row[k] !== 'string')) {
      throw new Error('Review failed: a suggestion has missing or invalid fields.');
    }
    if (!row.original_text.trim() || !sourceText.includes(row.original_text)) {
      throw new Error('Review failed: a suggested change could not be located in the reviewed document.');
    }
    if (!row.rationale.trim() || row.original_text === row.suggested_text) throw new Error('Review failed: invalid change or missing rationale.');
  }
  return rows;
}

export function reviewSegments(text, size = 18000) {
  const segments = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf('\n', end);
      if (boundary > start + size / 2) end = boundary + 1;
    }
    segments.push({ start, end, text: text.slice(start, end) });
    start = end;
  }
  return segments;
}
