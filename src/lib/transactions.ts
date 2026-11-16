// The Transactions Hub's pure helpers: the sheet's status words, the date
// stamps in the sheet's own format, what counts as stale or moved today, the
// plain-words line a Hub edit leaves in the row's comments, and the two
// groupings of the page. No imports, so tests/transactions.test.js runs them
// in node exactly as the browser does.

export const TRANSACTION_STATUSES = [
  "Not Started",
  "In Progress",
  "With Boss",
  "With Client",
  "With Counterparty",
  "With Client And AKLA",
  "On Hold",
  "Closed",
] as const;
export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number];

export const UPDATE_SOURCES = ["load", "hub", "excel", "agenda", "email", "whatsapp"] as const;
export type UpdateSource = (typeof UPDATE_SOURCES)[number];

// A line the Hub wrote from somewhere other than a person typing here.
export const AUTO_SOURCES: readonly string[] = ["agenda", "excel", "email", "whatsapp"];

export const DEFAULT_STALE_AFTER_DAYS = 10;

export interface TransactionRowLike {
  id: string;
  sort_order: number;
  client: string;
  project: string;
  deliverable: string;
  team: string[] | null;
  currently_with: string | null;
  status: string;
  latest_update: string | null;
  latest_update_at: string | null;
  created_at?: string;
}

/** Closed is done; On Hold is parked. Neither is waiting on anyone. */
export function isOpenStatus(status: string | null | undefined): boolean {
  return status !== "Closed" && status !== "On Hold";
}

// The firm works on Karachi time whatever the browser says, so "today" and
// the stamps on the sheet come from that zone.
const ZONE = "Asia/Karachi";

interface ZonedParts {
  year: string;
  month: string; // "10"
  day: string; // "28"
  hour: string;
  minute: string;
}

function zonedParts(at: Date): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function toDate(at: Date | string): Date | null {
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** YYYY-MM-DD on Karachi's calendar. */
export function karachiDateKey(at: Date | string): string {
  const d = toDate(at);
  if (!d) return "";
  const p = zonedParts(d);
  return `${p.year}-${p.month}-${p.day}`;
}

/** "09:14", the Karachi clock time of a stamp. */
export function zonedTime(at: Date | string): string {
  const d = toDate(at);
  if (!d) return "";
  const p = zonedParts(d);
  return `${p.hour}:${p.minute}`;
}

/** "Oct 28", for the table. */
export function formatShortDate(at: Date | string): string {
  const d = toDate(at);
  if (!d) return "";
  const p = zonedParts(d);
  return `${MONTHS_SHORT[Number(p.month) - 1]} ${Number(p.day)}`;
}

/** "October 28, 2026", for headers and the history. */
export function formatLongDate(at: Date | string): string {
  const d = toDate(at);
  if (!d) return "";
  const p = zonedParts(d);
  return `${MONTHS_LONG[Number(p.month) - 1]} ${Number(p.day)}, ${p.year}`;
}

function bracket(at: Date, author: string | null | undefined): string {
  const p = zonedParts(at);
  const time = `${p.hour}:${p.minute}`;
  return author ? `[${time} · ${author}]` : `[${time}]`;
}

/** "Oct 28 [09:14 · Usama]", the sheet's own stamp, short for the table. */
export function formatUpdateStamp(at: Date | string, author?: string | null): string {
  const d = toDate(at);
  if (!d) return "";
  return `${formatShortDate(d)} ${bracket(d, author)}`;
}

/** "October 28, 2026 [09:14 · Usama]", for the full history. */
export function formatUpdateStampLong(at: Date | string, author?: string | null): string {
  const d = toDate(at);
  if (!d) return "";
  return `${formatLongDate(d)} ${bracket(d, author)}`;
}

/** Whole Karachi calendar days from `since` to `now`; 0 on the same day. */
export function daysSince(since: Date | string, now: Date = new Date()): number {
  const a = karachiDateKey(since);
  const b = karachiDateKey(now);
  if (!a || !b) return 0;
  const toUtc = (key: string) => {
    const [y, m, d] = key.split("-").map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((toUtc(b) - toUtc(a)) / 86_400_000);
}

export function isMovedToday(row: Pick<TransactionRowLike, "latest_update_at">, now: Date = new Date()): boolean {
  return !!row.latest_update_at && karachiDateKey(row.latest_update_at) === karachiDateKey(now);
}

/** Days a row has sat without a line; a row never updated counts from its creation. */
export function idleDays(row: Pick<TransactionRowLike, "latest_update_at" | "created_at">, now: Date = new Date()): number {
  const since = row.latest_update_at ?? row.created_at;
  return since ? daysSince(since, now) : 0;
}

/** Open (not Closed, not On Hold) and quiet for longer than the firm allows. */
export function isStale(
  row: Pick<TransactionRowLike, "status" | "latest_update_at" | "created_at">,
  staleAfterDays: number = DEFAULT_STALE_AFTER_DAYS,
  now: Date = new Date(),
): boolean {
  return isOpenStatus(row.status) && idleDays(row, now) > staleAfterDays;
}

export const FIELD_LABELS: Record<string, string> = {
  status: "Status",
  currently_with: "Currently with",
  team: "Team",
  deliverable: "Deliverable",
  client: "Client",
  project: "Project",
};

function asText(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join(", ");
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

/**
 * One plain-words line for a field edit, as a person would have typed it in
 * the sheet's comments cell: "Status: With Boss → With Client",
 * "Currently with: Boss" (nothing before), "Team: cleared".
 */
export function changeLine(field: string, before: unknown, after: unknown): string {
  const label = FIELD_LABELS[field] ?? field;
  const was = asText(before);
  const now = asText(after);
  if (!now) return `${label}: cleared`;
  if (!was) return `${label}: ${now}`;
  return `${label}: ${was} → ${now}`;
}

/** The lines for every field that changed, joined for a single update line; "" when nothing did. */
export function changeLines(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  fields: string[] = Object.keys(FIELD_LABELS),
): string {
  return fields
    .filter((f) => f in after && asText(before[f]) !== asText(after[f]))
    .map((f) => changeLine(f, before[f], after[f]))
    .join("; ");
}

export interface RowGroup<R> {
  key: string;
  heading: string;
  rows: R[];
}

/** Client · Project groups in the sheet's order (first row's sort_order decides). */
export function groupByProject<R extends TransactionRowLike>(rows: R[]): RowGroup<R>[] {
  const groups = new Map<string, RowGroup<R>>();
  for (const row of [...rows].sort((a, b) => a.sort_order - b.sort_order)) {
    const key = `${row.client.trim().toLowerCase()}|${row.project.trim().toLowerCase()}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, heading: `${row.client} · ${row.project}`, rows: [] };
      groups.set(key, g);
    }
    g.rows.push(row);
  }
  return [...groups.values()];
}

export const UNASSIGNED = "Unassigned";

/** One group per team member, a row under each of its members; Unassigned last. */
export function groupByPerson<R extends TransactionRowLike>(rows: R[]): RowGroup<R>[] {
  const groups = new Map<string, RowGroup<R>>();
  const add = (name: string, row: R) => {
    let g = groups.get(name);
    if (!g) {
      g = { key: name, heading: name, rows: [] };
      groups.set(name, g);
    }
    g.rows.push(row);
  };
  for (const row of [...rows].sort((a, b) => a.sort_order - b.sort_order)) {
    const names = (row.team ?? []).map((n) => n.trim()).filter(Boolean);
    if (!names.length) add(UNASSIGNED, row);
    for (const n of new Set(names)) add(n, row);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.key === UNASSIGNED) return 1;
    if (b.key === UNASSIGNED) return -1;
    return a.heading.localeCompare(b.heading);
  });
}

/** Case-insensitive match over everything a person might remember of a row. */
export function rowMatches(row: TransactionRowLike, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [row.client, row.project, row.deliverable, (row.team ?? []).join(", "), row.currently_with, row.latest_update]
    .filter(Boolean)
    .some((field) => field!.toLowerCase().includes(q));
}

/** Reads the first present text under any of `keys` from a loose JSON object. */
export function pickText(obj: unknown, ...keys: string[]): string {
  if (!obj || typeof obj !== "object") return "";
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return "";
}

/** A team cell from JSON: an array of names, or one comma-separated string. */
export function pickTeam(obj: unknown, ...keys: string[]): string[] {
  if (!obj || typeof obj !== "object") return [];
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    const v = o[k];
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    if (typeof v === "string" && v.trim()) return v.split(/[,;/]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * What a tray item holds, read once and defensively: the intake writes the
 * parsed block, the sheet's two cell values or the unreadable file under
 * whichever keys it has, and a missing key must never blank the page.
 */
export interface TrayItemView {
  person: string;
  personId: string | null;
  transaction: string;
  deliverable: string;
  scope: string;
  file: string;
  date: string;
  field: string;
  sheetValue: string;
  hubValue: string;
  beforeValue: string;
  rowId: string;
  hours: string;
  error: string;
  guessRowId: string;
  guessNewRow: { client: string; project: string; deliverable: string; team: string[] } | null;
  confidence: string;
}

export function readTrayItem(item: { payload: unknown; guess?: unknown }): TrayItemView {
  const p = item.payload;
  const g = item.guess;
  const newRow = g && typeof g === "object" && (g as Record<string, unknown>).new_row;
  const personId = pickText(p, "person_id", "author_id");
  return {
    person: pickText(p, "person", "person_name", "author", "name"),
    personId: personId || null,
    transaction: pickText(p, "transaction", "project", "matter"),
    deliverable: pickText(p, "deliverable", "complete_deliverable", "title"),
    scope: pickText(p, "scope", "scope_of_task", "text", "body", "narrative"),
    file: pickText(p, "file", "file_name", "agenda_file", "source_ref", "source"),
    date: pickText(p, "date", "agenda_date", "work_date", "at"),
    field: pickText(p, "field", "column"),
    sheetValue: pickText(p, "sheet", "sheet_value", "excel", "excel_value"),
    hubValue: pickText(p, "hub", "hub_value"),
    beforeValue: pickText(p, "before", "before_value", "previous", "snapshot"),
    rowId: pickText(p, "row_id") || pickText(g, "row_id"),
    hours: pickText(p, "hours"),
    error: pickText(p, "error", "reason", "message"),
    guessRowId: pickText(g, "row_id"),
    guessNewRow: newRow
      ? {
          client: pickText(newRow, "client"),
          project: pickText(newRow, "project", "transaction"),
          deliverable: pickText(newRow, "deliverable"),
          team: pickTeam(newRow, "team"),
        }
      : null,
    confidence: pickText(g, "confidence"),
  };
}

// ---- the timeline and the compact table

export interface ChangePart {
  field: string;
  label: string;
  was: string;
  now: string;
}

const LABEL_TO_FIELD = Object.fromEntries(Object.entries(FIELD_LABELS).map(([f, l]) => [l.toLowerCase(), f]));

/**
 * The parts of a line changeLines() wrote ("Status: With Boss → With Client;
 * Currently with: Umer"), or null when the line is a note a person typed.
 * Every piece must start with a field label, so a note that happens to
 * mention "Status:" mid-sentence stays a note.
 */
export function parseChangeLine(body: string | null | undefined): ChangePart[] | null {
  if (!body) return null;
  const pieces = body.split(/;\s+/).map((p) => p.trim()).filter(Boolean);
  if (!pieces.length) return null;
  const parts: ChangePart[] = [];
  for (const piece of pieces) {
    const m = piece.match(/^([A-Za-z ]+?):\s(.*)$/);
    if (!m) return null;
    const field = LABEL_TO_FIELD[m[1].trim().toLowerCase()];
    if (!field) return null;
    const rest = m[2].trim();
    if (rest === "cleared") parts.push({ field, label: m[1].trim(), was: "", now: "" });
    else {
      const arrow = rest.indexOf(" → ");
      if (arrow === -1) parts.push({ field, label: m[1].trim(), was: "", now: rest });
      else parts.push({ field, label: m[1].trim(), was: rest.slice(0, arrow), now: rest.slice(arrow + 3) });
    }
  }
  return parts;
}

export interface DayGroup<U> {
  key: string;
  label: string;
  items: U[];
}

/** Updates bucketed by Karachi day, in the order given (newest first from the query). */
export function groupByDay<U extends { at: string }>(updates: U[]): DayGroup<U>[] {
  const groups: DayGroup<U>[] = [];
  for (const u of updates) {
    const key = karachiDateKey(u.at);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(u);
    else groups.push({ key, label: formatLongDate(u.at), items: [u] });
  }
  return groups;
}

/**
 * One entry for a line written on several rows at once (the same words, by
 * the same person, in the same minute), with the rows it was written on; a
 * project's timeline then reads once what the sheet repeats per deliverable.
 */
export function mergeSameLines<U extends { at: string; author: string | null; body: string; source: string }>(
  items: U[],
  rowName: (item: U) => string,
): { item: U; rows: string[] }[] {
  const out: { item: U; rows: string[] }[] = [];
  const seen = new Map<string, { item: U; rows: string[] }>();
  for (const item of items) {
    const key = [karachiDateKey(item.at), zonedTime(item.at), item.author ?? "", item.source, item.body.trim()].join("\u0001");
    const name = rowName(item);
    const hit = seen.get(key);
    if (hit) {
      if (name && !hit.rows.includes(name)) hit.rows.push(name);
      continue;
    }
    const entry = { item, rows: name ? [name] : [] };
    seen.set(key, entry);
    out.push(entry);
  }
  return out;
}
