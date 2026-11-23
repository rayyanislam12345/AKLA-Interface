// What the Hub did on its own (a document filed, a line added to a row, a
// note kept, a project proposed) read into something a page can show: the
// words for each kind, the "From Usama by WhatsApp · 28 Oct, 11:02" line,
// what can still be undone, and the arrivals grouped by day. Also the key a
// project's name is matched by, the same as the database computes it. Pure,
// so tests/intake.test.js runs it in node exactly as the browser does.

import { groupByDay, karachiDateKey, pickText, zonedTime } from "./transactions.ts";
import type { DayGroup } from "./transactions.ts";

export const ACTION_KINDS = ["version_filed", "row_update", "row_moved", "row_created", "note_added", "project_created"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

// A project the Hub created is closed or deleted from its own page, not undone here.
export const UNDOABLE_KINDS: readonly string[] = ["version_filed", "row_update", "row_moved", "row_created", "note_added"];

const VERBS: Record<string, string> = {
  version_filed: "Filed",
  row_moved: "Row moved",
  row_update: "Row updated",
  note_added: "Noted",
  row_created: "New row",
  project_created: "New project",
};

/** The one or two words that say what kind of thing happened. */
export function actionVerb(kind: string | null | undefined): string {
  return VERBS[kind ?? ""] ?? "Arrived";
}

export interface IntakeAction {
  id: string;
  /** One arrival: a filing and the row line it caused share it. */
  groupId: string;
  kind: string;
  source: string;
  sourceRef: string;
  summary: string;
  createdAt: string;
  undoneAt: string | null;
  matterId: string | null;
  rowId: string | null;
  documentId: string | null;
  versionId: string | null;
  noteId: string | null;
  /** Who it came from, as the sender was recorded. */
  from: string;
  /** The WhatsApp group, or the mailbox for an email. */
  chat: string;
  /** When the message was sent; "" when the service did not say. */
  sent: string;
  via: string;
  file: string;
  title: string;
  subject: string;
  webUrl: string;
  versionNumber: number | null;
  createdDocument: boolean;
  /** The project's and the row's names, when the query brought them along. */
  projectName: string;
  rowDeliverable: string;
}

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function idOrNull(value: unknown): string | null {
  return text(value) || null;
}

/**
 * One action, read once and defensively: the service writes `detail` under
 * the keys it has, an older entry may lack some, and a missing key must
 * never blank the page.
 */
export function readAction(raw: unknown): IntakeAction {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const d = r.detail && typeof r.detail === "object" && !Array.isArray(r.detail) ? (r.detail as Record<string, unknown>) : {};
  const id = text(r.id);
  const kind = text(r.kind);
  const version = Number(d.version_number);
  return {
    id,
    groupId: text(r.group_id) || id,
    kind,
    source: text(r.source).toLowerCase(),
    sourceRef: text(r.source_ref),
    summary: text(r.summary) || actionVerb(kind),
    createdAt: text(r.created_at),
    undoneAt: idOrNull(r.undone_at),
    matterId: idOrNull(r.matter_id),
    rowId: idOrNull(r.row_id),
    documentId: idOrNull(r.document_id),
    versionId: idOrNull(r.version_id),
    noteId: idOrNull(r.note_id),
    from: pickText(d, "from", "person", "sender"),
    chat: pickText(d, "chat"),
    sent: pickText(d, "sent", "sent_at", "date"),
    via: pickText(d, "via"),
    file: pickText(d, "file", "file_name"),
    title: pickText(d, "title"),
    subject: pickText(d, "subject"),
    webUrl: pickText(d, "web_url"),
    versionNumber: d.version_number !== null && d.version_number !== undefined && Number.isFinite(version) ? version : null,
    createdDocument: d.created_document === true || d.created_document === "true",
    projectName: pickText(r.matter, "name"),
    rowDeliverable: pickText(r.row, "deliverable"),
  };
}

/**
 * A sender as a name alone: "Owais Sb <owais@…>" and "Usama (+92 300 …)"
 * are how mail and WhatsApp record a person; neither the address nor the
 * number belongs on the page.
 */
export function personName(raw: string | null | undefined): string {
  const s = (raw ?? "").trim();
  const name = s
    .replace(/\s*<[^>]*>/g, "")
    .replace(/\s*\(\+?[\d\s-]{6,}\)/g, "")
    .replace(/^["']+|["']+$/g, "")
    .trim();
  return name || s.replace(/[<>]/g, "").trim();
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const NO_ZONE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

// A stamp with no zone is UTC, as the Filer records its times; a browser
// would otherwise read it on its own clock.
function instant(at: Date | string): Date | string {
  if (at instanceof Date) return at;
  const m = at.trim().match(NO_ZONE);
  return m ? `${m[1]}T${m[2]}Z` : at.trim();
}

/**
 * The exact moment a stamp names, as an ISO string; "" for a bare date, a
 * stamp that cannot be read, or one in the future. A line added to a row
 * from an email is dated by this, so it sits where the email was sent.
 */
export function exactInstant(at: string | null | undefined, now: Date = new Date()): string {
  const s = (at ?? "").trim();
  if (!s || DATE_ONLY.test(s) || !/\d{2}:\d{2}/.test(s)) return "";
  const d = new Date(instant(s));
  if (Number.isNaN(d.getTime()) || d.getTime() > now.getTime()) return "";
  return d.toISOString();
}

/** "28 Oct" on Karachi's calendar; the year is added only when it is not this one. */
export function formatDayMonth(at: Date | string, now: Date = new Date()): string {
  // A bare date is that calendar day, whatever the zone.
  const key = typeof at === "string" && DATE_ONLY.test(at.trim()) ? at.trim() : karachiDateKey(instant(at));
  if (!key) return "";
  const [year, month, day] = key.split("-").map(Number);
  const base = `${day} ${MONTHS[month - 1]}`;
  return String(year) === karachiDateKey(now).slice(0, 4) ? base : `${base} ${year}`;
}

/** "28 Oct, 11:02", Karachi time; the day alone when the stamp carries no time. */
export function formatDayTime(at: Date | string, now: Date = new Date()): string {
  const day = formatDayMonth(at, now);
  if (!day) return "";
  if (typeof at === "string" && DATE_ONLY.test(at.trim())) return day;
  return `${day}, ${zonedTime(instant(at))}`;
}

/** The Filer records an email's "chat" as its mailbox: "Outlook - <mailbox> (Inbox)". */
export function isMailbox(chat: string | null | undefined): boolean {
  return /^outlook\b/i.test((chat ?? "").trim());
}

function possessive(name: string): string {
  return `${name}'s`;
}

type Channel = "agenda" | "excel" | "whatsapp" | "email" | "";

function channelOf(source: string, via: string): Channel {
  const s = source.toLowerCase();
  if (s === "agenda" || s === "excel") return s;
  const v = via.toLowerCase();
  if (v === "whatsapp" || v === "email") return v;
  return s === "whatsapp" || s === "email" ? s : "";
}

/**
 * Where an action came from and when, in one muted line:
 * "From Owais Sb by email · 28 Oct, 11:02", "From Haya's agenda · 28 Oct, 08:00",
 * "From Usama by WhatsApp, AKLA TEAM - OFFICE · 28 Oct, 14:30". The time is
 * when the message was sent, or when the Hub acted if that is not known.
 */
export function actionSourceLine(
  action: Pick<IntakeAction, "source" | "via" | "from" | "chat" | "sent" | "createdAt">,
  now: Date = new Date(),
): string {
  const who = personName(action.from);
  let where: string;
  switch (channelOf(action.source, action.via)) {
    case "agenda":
      where = who ? `From ${possessive(who)} agenda` : "From a daily agenda";
      break;
    case "excel":
      where = "From the sheet";
      break;
    case "whatsapp": {
      const group = action.chat && !isMailbox(action.chat) ? `, ${action.chat}` : "";
      where = `${who ? `From ${who} by WhatsApp` : "By WhatsApp"}${group}`;
      break;
    }
    case "email":
      where = who ? `From ${who} by email` : "By email";
      break;
    default:
      where = who ? `From ${who}` : "Filed automatically";
  }
  const when = formatDayTime(action.sent, now) || formatDayTime(action.createdAt, now);
  return [where, when].filter(Boolean).join(" · ");
}

/**
 * The line under a Needs-a-look document or message: who sent it, where, and
 * the day. "from Usama · AKLA TEAM - OFFICE · 17 Oct"; an email says "email"
 * instead of naming a mailbox.
 */
export function arrivedFromLine(
  item: { person?: string; chat?: string; via?: string; date?: string },
  now: Date = new Date(),
): string {
  const who = personName(item.person);
  const where = item.chat && !isMailbox(item.chat) ? item.chat : (item.via ?? "").trim() || (isMailbox(item.chat) ? "email" : "");
  return [who ? `from ${who}` : "", where, item.date ? formatDayMonth(item.date, now) : ""].filter(Boolean).join(" · ");
}

export function isUndone(action: Pick<IntakeAction, "undoneAt">): boolean {
  return !!action.undoneAt;
}

/** Still as the Hub left it, and of a kind that can be taken back from here. */
export function canUndo(action: Pick<IntakeAction, "kind" | "undoneAt">): boolean {
  return !action.undoneAt && UNDOABLE_KINDS.includes(action.kind);
}

export type ArrivedFilter = "all" | "documents" | "rows" | "notes";

export function matchesArrivedFilter(action: Pick<IntakeAction, "kind">, filter: ArrivedFilter): boolean {
  switch (filter) {
    case "documents":
      return action.kind === "version_filed";
    case "rows":
      return action.kind === "row_update" || action.kind === "row_moved" || action.kind === "row_created";
    case "notes":
      return action.kind === "note_added";
    default:
      return true;
  }
}

export interface Arrival<A> {
  key: string;
  /** When the newest thing in it happened; arrivals are listed and dated by this. */
  at: string;
  /** What the arrival is shown as: the filing when there is one. */
  lead: A;
  /** What else the same arrival did (the row line a filing wrote), oldest first. */
  rest: A[];
}

// Which action of an arrival names it: the document, before the row line it wrote.
const LEAD_ORDER = ["version_filed", "project_created", "row_created", "row_moved", "row_update", "note_added"];

function leadRank(kind: string): number {
  const i = LEAD_ORDER.indexOf(kind);
  return i === -1 ? LEAD_ORDER.length : i;
}

type Groupable = Pick<IntakeAction, "id" | "groupId" | "kind" | "createdAt">;

/**
 * Actions of one arrival (one group_id) together, in the order the arrivals
 * are given (newest first from the query).
 */
export function groupArrivals<A extends Groupable>(actions: A[]): Arrival<A>[] {
  const byKey = new Map<string, { at: string; items: A[] }>();
  for (const a of actions) {
    const key = a.groupId || a.id;
    const hit = byKey.get(key);
    if (hit) hit.items.push(a);
    else byKey.set(key, { at: a.createdAt, items: [a] });
  }
  return [...byKey.entries()].map(([key, { at, items }]) => {
    const sorted = [...items].sort((x, y) => leadRank(x.kind) - leadRank(y.kind) || x.createdAt.localeCompare(y.createdAt));
    return { key, at, lead: sorted[0], rest: sorted.slice(1) };
  });
}

/** Arrivals under their Karachi day, as the Timeline heads its days. */
export function groupArrivalsByDay<A extends Groupable>(actions: A[]): DayGroup<Arrival<A>>[] {
  return groupByDay(groupArrivals(actions));
}

/** How many separate arrivals a list of actions holds. */
export function countArrivals(actions: Pick<IntakeAction, "id" | "groupId">[]): number {
  return new Set(actions.map((a) => a.groupId || a.id)).size;
}

/** The first instant of today in Karachi (UTC+5 all year), for "arrived today". */
export function karachiDayStartIso(now: Date = new Date()): string {
  return `${karachiDateKey(now)}T00:00:00+05:00`;
}

/**
 * The key a project's name is matched by, exactly as the database's
 * project_names.name_key: lower-case, every run of characters outside a-z
 * and 0-9 becomes one space, trimmed. "M-6 Motorway" and "m6  motorway" differ
 * ("m 6 motorway", "m6 motorway"); "ADB – M6" and "adb m6" do not.
 */
export function nameKey(name: string | null | undefined): string {
  return (name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
