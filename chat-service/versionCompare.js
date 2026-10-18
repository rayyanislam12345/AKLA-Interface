// What changed between two versions of a document, clause by clause.
//
// Both versions are read the same way (the index worker's reader), laid out
// as paragraphs with their clause numbers, and aligned:
//   1. paragraphs whose words are unchanged (ignoring their number, spacing,
//      quote style and case) anchor the alignment (a longest-matching-block
//      diff, as Python's difflib does it, on paragraph lists);
//   2. between anchors, paragraphs are paired by clause number and by how
//      many words they share; unpaired ones were added or removed;
//   3. an added paragraph that matches a removed one elsewhere was moved.
// Every change gets a nature: wording, numbers_dates_names, definitions,
// clause_added, clause_removed, schedule, renumbering or formatting_only.
// Noise is formatting_only (hidden by default in the Hub): the contents page,
// cover and "Important Note" dates, page headers and footers, page numbers,
// and changes of spacing, punctuation, quote marks or capitals alone.
import { extractForIndex, extensionOf } from "./indexing/extract.js";
import { toParagraphs } from "./proofCheck.js";

export const NATURES = ["wording", "numbers_dates_names", "definitions", "clause_added", "clause_removed", "schedule", "renumbering", "formatting_only"];
export const MAX_SIDE_CHARS = 600;
export const MAX_ITEMS = 500;
const PAIR_THRESHOLD = 0.5;
const MAX_PAIRING_CELLS = 60_000;

// ------------------------------------------------------------ text keys

const unify = (s) => String(s ?? "")
  .replace(/[“”«»„]/g, '"').replace(/[‘’‚`]/g, "'").replace(/[–—―‒−]/g, "-")
  .replace(/[  \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim();
/** Words only: spacing, punctuation, quote marks and capitals do not count. */
export const looseKey = (s) => String(s ?? "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const tokens = (s) => unify(s).match(/[\p{L}\p{N}●][\p{L}\p{N}'.,%/●-]*|\S/gu)?.map((t) => t.replace(/[.,]+$/, "")).filter(Boolean) ?? [];
const wordsOf = (s) => (String(s ?? "").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);

/** How alike two paragraphs are, 0 to 1 (shared words, Dice). */
export function similarity(a, b) {
  const wa = wordsOf(a);
  const wb = wordsOf(b);
  if (!wa.length && !wb.length) return 1;
  if (!wa.length || !wb.length) return 0;
  const counts = new Map();
  for (const w of wa) counts.set(w, (counts.get(w) ?? 0) + 1);
  let shared = 0;
  for (const w of wb) {
    const n = counts.get(w);
    if (n) { shared++; counts.set(w, n - 1); }
  }
  return (2 * shared) / (wa.length + wb.length);
}

// ------------------------------------------------------------ matching blocks

/**
 * difflib's get_matching_blocks on two lists of keys: [[i, j, size], …] in order.
 */
export function matchingBlocks(a, b) {
  const b2j = new Map();
  b.forEach((x, j) => {
    let list = b2j.get(x);
    if (!list) b2j.set(x, (list = []));
    list.push(j);
  });
  const blocks = [];
  const queue = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const next = new Map();
      for (const j of b2j.get(a[i]) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        next.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = next;
    }
    if (!bestsize) continue;
    blocks.push([besti, bestj, bestsize]);
    if (alo < besti && blo < bestj) queue.push([alo, besti, blo, bestj]);
    if (besti + bestsize < ahi && bestj + bestsize < bhi) queue.push([besti + bestsize, ahi, bestj + bestsize, bhi]);
  }
  blocks.sort((x, y) => x[0] - y[0]);
  return blocks;
}

/** Word-level difference: the tokens taken out and put in. */
export function tokenDiff(before, after) {
  const a = tokens(before);
  const b = tokens(after);
  if (a.length > 3000 || b.length > 3000) return null;
  const removed = [];
  const added = [];
  let i = 0;
  let j = 0;
  for (const [mi, mj, size] of [...matchingBlocks(a, b), [a.length, b.length, 0]]) {
    for (; i < mi; i++) removed.push(a[i]);
    for (; j < mj; j++) added.push(b[j]);
    i = mi + size;
    j = mj + size;
  }
  return { removed, added };
}

// ------------------------------------------------------------ natures

const MONTHS = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)$/i;
const NUMBER_WORDS = /^(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|lakh|lakhs|lac|lacs|crore|crores|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|percent|per|cent|only|rupees|pkr|rs|usd|dollars|pakistani)$/i;
const DATE_WORDS = /^(?:dated?|draft|version|ver|rev|revised|as|at|on|of|the|this|day|updated)$/i;

const isNumberish = (t) => /\d/.test(t) || t.split("-").every((w) => NUMBER_WORDS.test(w)) || t.includes("●") || /^\[?●?\]?$/.test(t);
const isDateish = (t) => /\d/.test(t) || MONTHS.test(t) || /^(?:st|nd|rd|th)$/i.test(t) || t.includes("●") || /^[[\]/,-]$/.test(t);
// A name: a capitalised word that is not a sentence's opener or a shouted heading.
const isName = (t) => /^[A-Z][a-z'’]/.test(t) && !/^(?:The|This|That|These|Those|It|In|On|At|Any|Each|Such|If|Where|A|An)$/.test(t);
const isPunct = (t) => !/[\p{L}\p{N}●]/u.test(t);

const DEFINITION_HEAD = /^\s*(?:\(?[a-z0-9]{1,4}\)\s*)?[“"‘'][^“”"'‘’]{1,80}[”"’']\s*(?:(?:,|or|and)\s*[“"‘'][^“”"'‘’]{1,80}[”"’']\s*)*(?:shall\s+)?(?:means?|includes?|has the meaning|shall have the meaning|shall bear the meaning|:)/i;
// A definition: "Term" means …, or any paragraph under a "Definitions" heading.
const isDefinition = (p) => Boolean(p) && (DEFINITION_HEAD.test(p.body) || p.path.some((e) => /^(?:\d+(?:\.\d+)*\.?\s+|(?:Article|Clause|Section)\s+\w+\s+)?definitions?\b/i.test(e)));
const inSchedule = (p) => Boolean(p) && p.path.some((e) => /^(?:schedule|annex(?:ure)?|appendix|exhibit)\b/i.test(e));

// "Clause 14.4" -> "Clause #": a change only in cross-reference numbers is renumbering.
const REF_NUMBERS = /\b((?:sub-?)?clauses?|articles?|sections?|schedules?|annex(?:ure)?s?|appendi(?:x|ces)|exhibits?|parts?|paragraphs?)\s+(?:\d+(?:\.\d+)*|[A-Z]{1,2}|[IVXLC]{1,6})(?:\s*\([a-z0-9]{1,4}\))*/gi;
const withoutRefNumbers = (s) => looseKey(String(s ?? "").replace(REF_NUMBERS, "$1 #"));

function changedNature(prev, cur) {
  if (looseKey(prev.body) === looseKey(cur.body)) {
    return prev.key !== cur.key && (prev.key || cur.key) ? "renumbering" : "formatting_only";
  }
  if (withoutRefNumbers(prev.body) === withoutRefNumbers(cur.body)) return "renumbering";
  const diff = tokenDiff(prev.body, cur.body);
  const changed = diff ? [...diff.removed, ...diff.added].filter((t) => !isPunct(t)) : null;
  if (changed && changed.length && changed.every((t) => isNumberish(t) || isDateish(t) || isName(t))) return "numbers_dates_names";
  if (isDefinition(cur) || isDefinition(prev)) return "definitions";
  if (inSchedule(cur) || inSchedule(prev)) return "schedule";
  return "wording";
}

// ------------------------------------------------------------ noise

const isCoverDateOnly = (text) => {
  const t = unify(text);
  if (t.length > 120) return false;
  const ts = tokens(t).filter((x) => !isPunct(x));
  return ts.length > 0 && ts.some((x) => /\d|●/.test(x) || MONTHS.test(x)) && ts.every((x) => isDateish(x) || DATE_WORDS.test(x) || MONTHS.test(x));
};
const isBlankPageMarker = (text) => /intentionally\s+(?:left\s+)?blank|rest of (?:the )?page|signature pages? follows?/i.test(text) && String(text).length <= 120;

// The cover: everything before the first numbered clause or heading of the body.
function frontMatterEnd(paragraphs) {
  const first = paragraphs.findIndex((p) => !p.toc && p.info && (p.info.kind === "clause" || p.info.kind === "article"));
  return first === -1 ? Math.min(paragraphs.length, 15) : first;
}

function frontDateChange(prev, cur, prevFront, curFront) {
  if (!(prev.index < prevFront && cur.index < curFront)) return false;
  if (unify(prev.text).length > 200 || unify(cur.text).length > 200) return false;
  const diff = tokenDiff(prev.text, cur.text);
  if (!diff) return false;
  const changed = [...diff.removed, ...diff.added].filter((t) => !isPunct(t));
  return changed.length > 0 && changed.every((t) => isDateish(t) || DATE_WORDS.test(t));
}

// ------------------------------------------------------------ output helpers

/** Before and after, cut to the stretch around the first difference when long. */
export function sides(before, after, max = MAX_SIDE_CHARS) {
  const a = String(before ?? "");
  const b = String(after ?? "");
  let k = 0;
  while (k < a.length && k < b.length && a[k] === b[k]) k++;
  const cut = (s) => {
    if (s.length <= max) return s;
    const start = Math.max(0, Math.min(k - 150, s.length - max));
    let out = s.slice(start, start + max);
    if (start > 0) out = `…${out.slice(1)}`;
    if (start + max < s.length) out = `${out.slice(0, -1)}…`;
    return out;
  };
  return { before: a ? cut(a) : "", after: b ? cut(b) : "" };
}

function whereFor(prev, cur) {
  if (cur && prev && prev.key && cur.key && prev.key !== cur.key) return `${cur.where} (was ${prev.key})`;
  return (cur ?? prev).where;
}

// ------------------------------------------------------------ alignment

function pairWithin(prevList, curList) {
  // Order-preserving pairing that maximises total likeness (a small
  // Needleman-Wunsch); paragraphs with the same clause number pair at a
  // lower bar.
  const n = prevList.length;
  const m = curList.length;
  if (!n || !m) return [];
  const score = (a, b) => {
    const s = similarity(a.body, b.body);
    if (s >= PAIR_THRESHOLD) return s;
    if (a.key && a.key === b.key && s >= 0.25) return s + 0.25;
    return -1;
  };
  if (n * m > MAX_PAIRING_CELLS) {
    // Too many to weigh every pair: pair by clause number in order, then
    // neighbours that are alike.
    const pairs = [];
    let j = 0;
    for (let i = 0; i < n && j < m; i++) {
      const k = curList.findIndex((c, idx) => idx >= j && idx < j + 30 && score(prevList[i], c) > 0);
      if (k !== -1) { pairs.push([i, k]); j = k + 1; }
    }
    return pairs;
  }
  const S = Array.from({ length: n }, (_, i) => curList.map((_, j) => score(prevList[i], curList[j])));
  const dp = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const s = S[i - 1][j - 1];
      dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1], s > 0 ? dp[i - 1][j - 1] + s : -Infinity);
    }
  }
  const pairs = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const s = S[i - 1][j - 1];
    if (s > 0 && dp[i][j] === dp[i - 1][j - 1] + s) { pairs.push([i - 1, j - 1]); i--; j--; } else if (dp[i][j] === dp[i - 1][j]) i--;
    else j--;
  }
  return pairs.reverse();
}

function align(prevList, curList) {
  const matched = []; // [prevIdx, curIdx] in list positions
  const blocks = matchingBlocks(prevList.map((p) => looseKey(p.body) || `#${p.text}`), curList.map((p) => looseKey(p.body) || `#${p.text}`));
  let i = 0;
  let j = 0;
  const gaps = [];
  for (const [bi, bj, size] of [...blocks, [prevList.length, curList.length, 0]]) {
    if (i < bi || j < bj) gaps.push([i, bi, j, bj]);
    for (let k = 0; k < size; k++) matched.push([bi + k, bj + k, "same"]);
    i = bi + size;
    j = bj + size;
  }
  const removed = [];
  const added = [];
  for (const [i1, i2, j1, j2] of gaps) {
    const ps = prevList.slice(i1, i2);
    const cs = curList.slice(j1, j2);
    const pairs = pairWithin(ps, cs);
    const pi = new Set(pairs.map((x) => x[0]));
    const ci = new Set(pairs.map((x) => x[1]));
    for (const [a, b] of pairs) matched.push([i1 + a, j1 + b, "paired"]);
    ps.forEach((_, k) => { if (!pi.has(k)) removed.push({ at: i1 + k, gapCur: j1 }); });
    cs.forEach((_, k) => { if (!ci.has(k)) added.push(j1 + k); });
  }
  // Moved: an added paragraph that is a removed one, elsewhere.
  const moved = [];
  const byKey = new Map();
  removed.forEach((r, idx) => {
    const key = looseKey(prevList[r.at].body);
    if (key.length < 20) return;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(idx);
  });
  const usedRemoved = new Set();
  const stillAdded = [];
  for (const a of added) {
    const key = looseKey(curList[a].body);
    const hit = (byKey.get(key) ?? []).find((idx) => !usedRemoved.has(idx));
    if (hit !== undefined) { usedRemoved.add(hit); moved.push([removed[hit].at, a]); } else stillAdded.push(a);
  }
  // Moved and reworded: still alike enough, and long enough to be sure.
  const leftRemoved = removed.map((r, idx) => ({ ...r, idx })).filter((r) => !usedRemoved.has(r.idx));
  const finalAdded = [];
  if (leftRemoved.length * stillAdded.length <= MAX_PAIRING_CELLS) {
    for (const a of stillAdded) {
      const c = curList[a];
      let best = null;
      for (const r of leftRemoved) {
        if (usedRemoved.has(r.idx)) continue;
        const p = prevList[r.at];
        if (p.body.length < 80 || c.body.length < 80) continue;
        const s = similarity(p.body, c.body);
        if (s >= 0.85 && (!best || s > best.s)) best = { r, s };
      }
      if (best) { usedRemoved.add(best.r.idx); moved.push([best.r.at, a]); } else finalAdded.push(a);
    }
  } else finalAdded.push(...stillAdded);
  return {
    matched,
    moved,
    added: finalAdded,
    removed: removed.filter((_, idx) => !usedRemoved.has(idx)),
  };
}

// ------------------------------------------------------------ compare

function emptyCounts() {
  const natures = {};
  for (const n of NATURES) natures[n] = 0;
  return { kinds: { changed: 0, added: 0, removed: 0, moved: 0 }, natures };
}

/**
 * Compares two readings of a document.
 * @param {{ blocks: Array<object>, side?: { headers?: string[], footers?: string[] } } | Array<object>} previous
 * @param {{ blocks: Array<object>, side?: { headers?: string[], footers?: string[] } } | Array<object>} current
 * @returns {{ version: number, compared_at: string, counts: { changed: number, added: number, removed: number, moved: number }, natures: Record<string, number>, shown: number, hidden: number, items: Array<{ where: string, kind: 'changed'|'added'|'removed'|'moved', nature: string, before: string, after: string, noise?: string }>, omitted: number, notes: string[], identical?: boolean, unrelated?: boolean, similarity: number }}
 */
export function compareVersions(previous, current) {
  const prevAll = toParagraphs(previous).paragraphs.filter((p) => !p.pageNumber);
  const curAll = toParagraphs(current).paragraphs.filter((p) => !p.pageNumber);
  const notes = [];
  const items = [];
  const prevFront = frontMatterEnd(prevAll);
  const curFront = frontMatterEnd(curAll);

  // The contents page: one line if anything in it changed.
  const prevToc = prevAll.filter((p) => p.toc);
  const curToc = curAll.filter((p) => p.toc);
  if (prevToc.map((p) => unify(p.text)).join("\n") !== curToc.map((p) => unify(p.text)).join("\n")) {
    const lines = (list) => list.flatMap((p) => p.text.split("\n").map(unify).filter(Boolean));
    const a = lines(prevToc);
    const b = lines(curToc);
    const onlyIn = (x, y) => { const other = new Set(y); return x.filter((l) => !other.has(l)); };
    items.push({
      where: "Contents page",
      kind: a.length && b.length ? "changed" : b.length ? "added" : "removed",
      nature: "formatting_only",
      noise: "contents",
      ...sides(onlyIn(a, b).join(" · "), onlyIn(b, a).join(" · ")),
      order: curToc[0]?.index ?? 0,
    });
  }

  // Page headers and footers (Word files).
  for (const [part, label] of [["headers", "Page header"], ["footers", "Page footer"]]) {
    const a = (previous?.side?.[part] ?? []).map(unify).join(" | ");
    const b = (current?.side?.[part] ?? []).map(unify).join(" | ");
    if (a !== b && (a || b)) {
      items.push({ where: label, kind: a && b ? "changed" : b ? "added" : "removed", nature: "formatting_only", noise: label.toLowerCase(), ...sides(a, b), order: -1 });
    }
  }

  const prevList = prevAll.filter((p) => !p.toc);
  const curList = curAll.filter((p) => !p.toc);
  const { matched, moved, added, removed } = align(prevList, curList);

  const likeness = prevList.length + curList.length ? (2 * (matched.length + moved.length)) / (prevList.length + curList.length) : 1;
  if (prevList.length >= 10 && curList.length >= 10 && likeness < 0.15) {
    notes.push("These two versions share almost no text, so a clause-by-clause list would not help: the later one is a rewrite, or a different document saved as a version of this one.");
    const counts = emptyCounts();
    return { version: 1, compared_at: new Date().toISOString(), counts: counts.kinds, natures: counts.natures, shown: 0, hidden: 0, items: [], omitted: 0, notes, unrelated: true, similarity: Math.round(likeness * 100) / 100 };
  }

  for (const [pi, ci] of matched) {
    const p = prevList[pi];
    const c = curList[ci];
    if (p.text === c.text) continue;
    const labelMoved = p.key !== c.key && (p.key || c.key);
    if (looseKey(p.body) === looseKey(c.body) && !labelMoved) {
      if (unify(p.text) === unify(c.text)) continue; // a non-breaking space, a tab: nothing a reader sees
      items.push({ where: whereFor(p, c), kind: "changed", nature: "formatting_only", ...sides(p.text, c.text), order: c.index });
      continue;
    }
    let nature = changedNature(p, c);
    let noise;
    if (nature !== "formatting_only" && frontDateChange(p, c, prevFront, curFront)) { nature = "formatting_only"; noise = "cover date"; }
    items.push({ where: whereFor(p, c), kind: "changed", nature, ...(noise ? { noise } : {}), ...sides(p.text, c.text), order: c.index });
  }
  for (const [pi, ci] of moved) {
    const p = prevList[pi];
    const c = curList[ci];
    let nature;
    if (looseKey(p.body) === looseKey(c.body)) nature = isDefinition(c) ? "definitions" : inSchedule(c) ? "schedule" : p.key !== c.key ? "renumbering" : "wording";
    else nature = changedNature(p, c);
    items.push({ where: `${c.where} (moved from ${p.where})`, kind: "moved", nature, ...sides(p.text, c.text), order: c.index });
  }
  for (const ci of added) {
    const c = curList[ci];
    let nature = isDefinition(c) ? "definitions" : inSchedule(c) ? "schedule" : "clause_added";
    let noise;
    if (c.index < curFront && isCoverDateOnly(c.text)) { nature = "formatting_only"; noise = "cover date"; } else if (isBlankPageMarker(c.text)) { nature = "formatting_only"; noise = "page marker"; } else if (!looseKey(c.text)) nature = "formatting_only";
    items.push({ where: c.where, kind: "added", nature, ...(noise ? { noise } : {}), before: "", after: sides("", c.text).after, order: c.index });
  }
  for (const r of removed) {
    const p = prevList[r.at];
    let nature = isDefinition(p) ? "definitions" : inSchedule(p) ? "schedule" : "clause_removed";
    let noise;
    if (p.index < prevFront && isCoverDateOnly(p.text)) { nature = "formatting_only"; noise = "cover date"; } else if (isBlankPageMarker(p.text)) { nature = "formatting_only"; noise = "page marker"; } else if (!looseKey(p.text)) nature = "formatting_only";
    const at = r.gapCur < curList.length ? curList[r.gapCur].index - 0.5 : (curList[curList.length - 1]?.index ?? 0) + 0.5;
    items.push({ where: p.where, kind: "removed", nature, ...(noise ? { noise } : {}), before: sides(p.text, "").before, after: "", order: at + r.at / 1e6 });
  }

  items.sort((a, b) => a.order - b.order);
  const grouped = groupRenumbering(items);

  const counts = emptyCounts();
  for (const it of grouped) {
    counts.kinds[it.kind]++;
    counts.natures[it.nature]++;
  }
  const hidden = grouped.filter((it) => it.nature === "formatting_only").length;
  // Keep the substantive ones when there are too many to store.
  let kept = grouped;
  let omitted = 0;
  if (grouped.length > MAX_ITEMS) {
    const real = grouped.filter((it) => it.nature !== "formatting_only");
    const noise = grouped.filter((it) => it.nature === "formatting_only");
    kept = [...real.slice(0, MAX_ITEMS), ...noise.slice(0, Math.max(0, MAX_ITEMS - real.length))].sort((a, b) => a.order - b.order);
    omitted = grouped.length - kept.length;
  }
  if (!grouped.length) notes.push("No changes in the text.");
  else if (grouped.length === hidden) notes.push("Only formatting changed: spacing, punctuation, the contents page, dates on the cover or the page header.");
  return {
    version: 1,
    compared_at: new Date().toISOString(),
    counts: counts.kinds,
    natures: counts.natures,
    shown: grouped.length - hidden,
    hidden,
    items: kept.map(({ order, ...rest }) => rest),
    omitted,
    notes,
    ...(grouped.length ? {} : { identical: true }),
    similarity: Math.round(likeness * 100) / 100,
  };
}

// Inserting one clause renumbers every clause after it. Three or more
// renumbered-only paragraphs in a row become one line.
function groupRenumbering(items) {
  const out = [];
  let run = [];
  const pureRenumber = (it) => it.kind === "changed" && it.nature === "renumbering" && / \(was [^)]+\)$/.test(it.where);
  const flush = () => {
    if (run.length >= 3) {
      const was = (it) => / \(was ([^)]+)\)$/.exec(it.where)?.[1] ?? "";
      const now = (it) => it.where.replace(/ \(was [^)]+\)$/, "");
      const first = run[0];
      const last = run[run.length - 1];
      out.push({
        where: `${now(first)} to ${now(last)}`,
        kind: "changed",
        nature: "renumbering",
        before: `${run.length} paragraphs numbered ${was(first)} to ${was(last)}`,
        after: `now numbered ${now(first).replace(/^(?:Clause|Article|Section) /, "")} to ${now(last).replace(/^(?:Clause|Article|Section) /, "")}, words unchanged`,
        order: first.order,
      });
    } else out.push(...run);
    run = [];
  };
  for (const it of items) {
    if (pureRenumber(it) && looseKey(it.before.replace(/^\S+\s/, "")) === looseKey(it.after.replace(/^\S+\s/, ""))) run.push(it);
    else { flush(); out.push(it); }
  }
  flush();
  return out;
}

// ------------------------------------------------------------ reading a version

export const COMPARABLE_EXTENSIONS = ["docx", "pdf", "txt", "md"];

/** Reads a stored version with the index worker's reader. */
export async function readForCompare(bytes, fileName, options = {}) {
  const ext = extensionOf(fileName);
  if (!COMPARABLE_EXTENSIONS.includes(ext)) {
    const err = new Error("Only Word, PDF and text files can be compared.");
    err.unsupported = true;
    throw err;
  }
  return extractForIndex(bytes, `file.${ext}`, options);
}
