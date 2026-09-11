export function inferDraftSkill(message, types) {
  if (!/\b(draft|prepare|create|write)\b/i.test(message)) return null;
  const normalized = ' ' + message.toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' ';
  const matches = types.filter(t => normalized.includes(' ' + t.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' '));
  return matches.length === 1 ? { key: 'draft', documentTypeId: matches[0].id } : null;
}
export function citationIssues(text, sourceCount) {
  return [...new Set([...text.matchAll(/\[Source\s+(\d+)\]/gi)].map(m => Number(m[1])).filter(n => n < 1 || n > sourceCount))];
}
