// What an uploaded file's name already says about it, so an associate does
// not type it: the firm's document type it names, and where it is in its
// life as a document status. Pure: no React, no database. Tested in
// tests/documentDefaults.test.js.

import type { Stage } from "./fileNames.ts";

export type DocumentStatusValue =
  | "not_started"
  | "drafting"
  | "internal_review"
  | "with_counterparty"
  | "negotiation"
  | "finalized"
  | "executed";

const STATUS_BY_STAGE: Record<Stage, DocumentStatusValue> = {
  "Working draft": "drafting",
  "AI markup": "drafting",
  "For partner review": "internal_review",
  Circulated: "with_counterparty",
  Received: "with_counterparty",
  "Client comments": "negotiation",
  Compared: "negotiation",
  Final: "finalized",
  Execution: "executed",
};

/**
 * The status a file's name implies, or null when its name carries no stage.
 * A new document with no stage in its name is "drafting": it exists, so it
 * has been started.
 */
export function statusFromStage(stage: Stage | null): DocumentStatusValue | null {
  return stage ? STATUS_BY_STAGE[stage] : null;
}

// Short forms the firm writes in file names, by the type name they stand for.
// Used only when the firm has a type of that name.
const ALIASES: Record<string, string[]> = {
  "Shareholders Agreement": ["SHA"],
  "Share Purchase Agreement": ["SPA"],
  "Non-Disclosure Agreement": ["NDA"],
  "Memorandum of Understanding": ["MOU"],
  "Letter of Intent": ["LOI"],
  "Power Purchase Agreement": ["PPA"],
  "Implementation Agreement": ["IA"],
};

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    // "Shareholders'" / "Shareholder's" / "Shareholders" read the same.
    .replace(/\b(\w+?)s\b/g, "$1");

/**
 * The firm's document type a title names, or null. A type matches when its
 * whole name (or one "/" part of it, or the name without its bracketed short
 * form) appears in the title as words, and that name is at least two words
 * long, so "Letter" alone does not claim every letter; a bracketed short form
 * such as "(CTA)" or a known one such as "SHA" matches as a capitalised word.
 * The longest match wins.
 */
export function guessDocumentType<T extends { id: string; name: string }>(title: string, types: T[]): T | null {
  const haystack = ` ${words(title)} `;
  const raw = ` ${title.replace(/[^A-Za-z0-9]+/g, " ")} `;
  let best: { type: T; score: number } | null = null;
  const consider = (type: T, score: number) => {
    if (!best || score > best.score) best = { type, score };
  };
  for (const type of types) {
    const bare = type.name.replace(/\([^)]*\)/g, " ");
    const names = [bare, ...bare.split("/")].map(words).filter((n) => n.split(" ").length >= 2);
    for (const n of names) if (haystack.includes(` ${n} `)) consider(type, n.length);
    const shorts = [
      ...[...type.name.matchAll(/\(([A-Z]{2,6})\)/g)].map((m) => m[1]),
      ...(ALIASES[type.name] ?? []),
    ];
    for (const short of shorts) if (new RegExp(` ${short} `, "i").test(raw) && raw.includes(` ${short.toUpperCase()} `)) consider(type, short.length);
  }
  return best ? (best as { type: T }).type : null;
}
