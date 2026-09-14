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
