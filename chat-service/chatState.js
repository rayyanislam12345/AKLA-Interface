// The document type is the thing asked for, not the documents it is to be
// drawn from: "draft me a project proposal using the term sheet and the due
// diligence report" is a proposal, and was being filed as a Due Diligence
// Report because that name also appeared. Only the words between the verb
// and "using", "from", "based on" and the like are read.
export function inferDraftSkill(message, types) {
  const ask = /\b(draft|prepare|create|write)\b([\s\S]*)/i.exec(message);
  if (!ask) return null;
  const subject = ask[2].split(/\b(?:using|from|based on|on the basis of|with reference to|drawing on|by reference to|in light of|against|per|following|according to)\b|[.;:\n]/i)[0];
  const normalized = ' ' + subject.toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  const matches = types.filter(t => normalized.includes(' ' + t.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' '));
  return matches.length === 1 ? { key: 'draft', documentTypeId: matches[0].id } : null;
}
export function citationIssues(text, sourceCount) {
  return [...new Set([...text.matchAll(/\[Source\s+(\d+)\]/gi)].map(m => Number(m[1])).filter(n => n < 1 || n > sourceCount))];
}

// A message that only asks for the review to run ("review it", "please check
// this") carries no instruction of its own to check.
export function isBareReviewRequest(message) {
  if (!String(message ?? '').trim()) return true;
  return /^\s*(please\s+)?(can you\s+)?(review|verify|check)(\s+(it|this|that|the document|this document|the attached( document)?))?\s*(for me)?\s*(please)?[\s.!?]*$/i.test(String(message ?? ''));
}

// A review costs a law lookup and three passes, so a chat that already has
// one runs another only when the lawyer asks for it in so many words.
export function asksForReviewRerun(message) {
  return /\b(re-?run|run (the |a )?(new |fresh )?review( again)?|review (it |this |the document )?again|fresh review|new review|start (the review )?over)\b/i.test(String(message ?? ''));
}

const TITLE_STOPWORDS = new Set(['the', 'of', 'and', 'for', 'to', 'a', 'an', 'on', 'in', 'with', 'by', 'akla', 'draft', 'docx', 'this', 'that', 'it']);
const titleWords = (text) => new Set(String(text ?? '').toLowerCase().replace(/\[[^\]]*\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w.length > 1 && !TITLE_STOPWORDS.has(w) && !/^\d{4}$/.test(w)));

/**
 * Which document in a conversation a message is about. A chat can produce
 * several (a proposal and its drafting note in one reply) and each can be
 * edited into new copies. Each document is followed to its newest copy; the
 * one open in the panel wins, then the one whose title the message names,
 * then a draft over a note, then the most recent.
 *
 * artifacts: every document row in the thread, oldest first.
 */
export function chooseWorkingDocument(artifacts, { message = '', workingArtifactId = null } = {}) {
  const byPath = new Map(artifacts.filter((a) => a.data?.storagePath).map((a) => [a.data.storagePath, a]));
  const rootOf = (a) => {
    let cur = a;
    for (let guard = 0; guard < 50; guard++) {
      const parent = cur.data?.sourceStoragePath ? byPath.get(cur.data.sourceStoragePath) : null;
      if (!parent || parent === cur) return cur;
      cur = parent;
    }
    return cur;
  };
  const heads = new Map();
  for (const a of artifacts) heads.set(rootOf(a).id, a); // oldest first, so the last seen is the newest copy
  const docs = [...heads.entries()].map(([rootId, head]) => ({ root: artifacts.find((a) => a.id === rootId), head }));
  if (!docs.length) return { chosen: null, others: [] };
  const pick = (doc) => ({ chosen: doc.head, root: doc.root, others: docs.filter((d) => d !== doc).map((d) => d.root) });

  if (workingArtifactId) {
    const open = artifacts.find((a) => a.id === workingArtifactId);
    if (open) return pick(docs.find((d) => d.root.id === rootOf(open).id));
  }
  if (docs.length === 1) return pick(docs[0]);

  const said = titleWords(message);
  const words = docs.map((d) => titleWords(d.root.title));
  const shared = [...words[0]].filter((w) => words.every((set) => set.has(w)));
  const scores = words.map((set) => [...set].filter((w) => !shared.includes(w) && said.has(w)).length);
  const best = Math.max(...scores);
  if (best > 0 && scores.filter((s) => s === best).length === 1) return pick(docs[scores.indexOf(best)]);

  const kindOf = (d) => d.root.data?.sourceKind ?? d.root.kind;
  const drafts = docs.filter((d) => kindOf(d) === 'draft');
  const pool = drafts.length ? drafts : docs;
  return pick(pool[pool.length - 1]);
}
