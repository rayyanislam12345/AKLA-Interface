// A project in one page, and a document found by its name: what a lawyer's
// claude.ai asks for first ("brief me on the Karachi port project", "find
// the term sheet in that project") before it reads anything.
//
// get_project_overview reads the same tables the project page reads: the
// matters row, the project's standing instructions (matter_context, written
// by any firm member), each document with its latest version's index card
// (document_versions.card: the summary, parties, key dates and statutes the
// index worker writes for every version the Hub has read) and the Acts
// marked relevant to the project (matter_relevant_laws). Nothing on the Hub
// shows the card as a list today. find_document_by_title is the AI
// workspace's ⌘K search (src/lib/aiSearch.ts, src/hooks/useAiSearch.ts):
// a plain "contains" match on document titles and project names.
//
// Both tools read through the service role; the connector has established
// that the caller is a firm member, which is the Hub's rule for every
// project, as it is for read_document. The one personal table, matter_stars,
// is filtered by the signed-in user here (the site relies on RLS for that).
// Six short queries at most per call, one after the other, because the
// micro instance has about ten connections; the index cards, the heavy
// column, are fetched only for the latest versions on the page shown. No
// writes.

import { z } from "zod";
import { str, uuid, when, short, isOpen, MAX_DOCUMENTS } from "../tools.js";

/** Documents an overview shows in one call, fewer when their cards are long; `from` continues a long project. */
export const OVERVIEW_PAGE = 30;
/** The overview stops adding documents past this, so the wrapper never has to cut it. */
export const OVERVIEW_BUDGET = 27_000;
/** Matches a title search returns, per kind. */
export const FIND_LIMIT = 25;
/** The standing instructions are shown up to this; the rest is on the project page. */
export const CONTEXT_CHARS = 8_000;
const CARD_CHARS = 600;

/**
 * Escapes a query for an ilike pattern, as the site's search does: % and _
 * are wildcards there, and a backslash escapes. A * cannot be sent as
 * itself (PostgREST turns every * in a like value into %, escaped or not),
 * so it stands for one character, the nearest thing to the literal.
 */
export function likePattern(query) {
  const escaped = String(query ?? "").trim().replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, "_");
  return `%${escaped}%`;
}

/** The newest of a document's versions by number, or null. */
export function latestVersion(versions) {
  let best = null;
  for (const v of versions ?? []) if (!best || (v.version_number ?? 0) > (best.version_number ?? 0)) best = v;
  return best;
}

// A missing matter_stars table (the migration not yet applied) means no stars,
// as the site reads it (src/hooks/useMatterStars.ts tableMissing).
const starsMissing = (error) => !!error && (error.code === "42P01" || error.code === "PGRST205" || /matter_stars/.test(error.message ?? ""));

/** What the Hub has done with a version's file, in the words list_project_documents uses. */
const readState = (v) => (v.indexing_status === "indexed" ? "read by the Hub" : v.indexing_status === "failed" ? "could not be read" : v.indexing_status === "pending" ? "being read" : "not read yet");

/** The index-card lines for a version: summary, parties, key dates, statutes. */
function cardLines(card, indent) {
  if (!card || typeof card !== "object") return [];
  const lines = [];
  if (card.card_error && !card.summary) lines.push(`${indent}The card could not be written (${short(card.card_error, 160)}).`);
  if (card.summary) lines.push(`${indent}Summary: ${short(card.summary, CARD_CHARS)}`);
  if (card.parties?.length) lines.push(`${indent}Parties: ${card.parties.map((p) => (p.role ? `${p.name} (${p.role})` : p.name)).join("; ")}`);
  if (card.key_dates?.length) lines.push(`${indent}Key dates: ${card.key_dates.map((d) => (d.what ? `${d.date} — ${d.what}` : d.date)).join("; ")}`);
  if (card.statutes_mentioned?.length) lines.push(`${indent}Statutes mentioned: ${card.statutes_mentioned.join("; ")}`);
  return lines;
}

export default ({ supabase, helpers }) => {
  const { needProject, open } = helpers;

  /** Whether the signed-in lawyer has starred this project. */
  async function starredBy(userId, matterId) {
    if (!userId) return false;
    const { data, error } = await supabase.from("matter_stars").select("matter_id").eq("user_id", userId).eq("matter_id", matterId).maybeSingle();
    if (error) { if (starsMissing(error)) return false; throw new Error(`Could not read the starred projects: ${error.message}`); }
    return !!data;
  }

  const projectLine = (m) => {
    const bits = [m.client?.name, m.sector, m.matter_type, m.status && !isOpen(m.status) ? "closed" : null].filter(Boolean);
    return `${m.name}${bits.length ? ` — ${bits.join("; ")}` : ""}`;
  };

  return [
    {
      name: "get_project_overview",
      title: "Overview of a project",
      description: `One page on a project: its name, client and sector; the standing instructions the firm keeps for it on the Hub (facts and wishes established in earlier work, to follow in anything you draft or answer for it); the Acts marked relevant to it; and every document with its latest version's id, whether the Hub has read it, and its index card (summary, parties, key dates, statutes mentioned). Call it first when asked to brief on, draft for or answer about a project, then read_document or search_project_documents for the text. Documents are shown ${OVERVIEW_PAGE} at a time, from the ${MAX_DOCUMENTS} a project can list; the reply says where to continue.`,
      inputSchema: {
        projectId: z.string().describe("The project's id, from list_projects or find_document_by_title."),
        from: z.number().int().min(0).optional().describe("Which document to start the list at (0-based). Default 0."),
      },
      async run(input, ctx) {
        const matter = await needProject(input);
        const from = Number.isInteger(input.from) && input.from > 0 ? input.from : 0;
        const starred = await starredBy(ctx?.userId, matter.id);

        const { data: context, error: contextError } = await supabase.from("matter_context").select("content, updated_at").eq("matter_id", matter.id).maybeSingle();
        if (contextError) throw new Error(`Could not read the project's standing instructions: ${contextError.message}`);

        const { data: laws, error: lawsError } = await supabase.from("matter_relevant_laws").select("act_name, status").eq("matter_id", matter.id).order("act_name", { ascending: true });
        if (lawsError) throw new Error(`Could not read the project's relevant laws: ${lawsError.message}`);

        const { data: docRows, error: docsError } = await supabase
          .from("matter_documents")
          .select("id, title, status, document_type:document_types(name), versions:document_versions(id, version_number, file_name, is_ai_generated, created_at, indexing_status, label)")
          .eq("matter_id", matter.id)
          .order("title", { ascending: true })
          .limit(MAX_DOCUMENTS);
        if (docsError) throw new Error(`Could not list the project's documents: ${docsError.message}`);
        const docs = docRows ?? [];

        // The cards of the latest versions on this page only (at most
        // OVERVIEW_PAGE rows): a card carries the clause outline and the
        // defined terms, too much to pull for every version of every document.
        const pageDocs = docs.slice(from, from + OVERVIEW_PAGE);
        const latestIds = pageDocs.map((d) => latestVersion(d.versions)?.id).filter(Boolean);
        const cards = new Map();
        if (latestIds.length) {
          const { data: cardRows, error: cardsError } = await supabase.from("document_versions").select("id, card").in("id", latestIds);
          if (cardsError) throw new Error(`Could not read the documents' index cards: ${cardsError.message}`);
          for (const r of cardRows ?? []) cards.set(r.id, r.card);
        }

        const out = [];
        out.push(`${projectLine(matter)}${starred ? "; starred by you" : ""}`, `projectId: ${matter.id}`, open("project", matter.id));

        out.push("", "STANDING INSTRUCTIONS");
        const content = String(context?.content ?? "").trim();
        if (!content) out.push("None written on the Hub yet.");
        else {
          out.push(`(the project's context on the Hub${context.updated_at ? `, updated ${when(context.updated_at)}` : ""}; follow it in anything you draft or answer for this project)`);
          out.push(content.length > CONTEXT_CHARS ? `${content.slice(0, CONTEXT_CHARS)}\n[The instructions continue on the project page; only their first ${CONTEXT_CHARS.toLocaleString("en")} characters are shown.]` : content);
        }

        out.push("", `RELEVANT LAWS (${(laws ?? []).length})`);
        if (!laws?.length) out.push("None marked on the Hub. search_law_library searches every Act the firm holds.");
        else for (const l of laws) out.push(`- ${l.act_name}${l.status === "needs_upload" ? " (not in the law library yet)" : " (in the law library: search_law_library and read_act_section read it)"}`);

        out.push("", `DOCUMENTS (${docs.length})`);
        if (!docs.length) out.push(`${matter.name} has no documents yet.`);
        else if (from >= docs.length) out.push(`There are ${docs.length} documents; there is nothing at ${from}.`);
        else {
          // A page is at most OVERVIEW_PAGE documents, and fewer when their
          // cards would take the result past the budget: the reply says
          // where to continue either way.
          const blocks = [];
          let used = out.join("\n").length;
          for (const d of pageDocs) {
            const lines = [];
            const head = `- ${d.title}${d.document_type?.name ? ` (${d.document_type.name})` : ""}${d.status ? ` — ${String(d.status).replace(/_/g, " ")}` : ""}`;
            const v = latestVersion(d.versions);
            if (!v) lines.push(`${head}; no versions saved`);
            else {
              const count = d.versions.length;
              const flags = [...new Set([v.is_ai_generated ? "AI draft" : null, v.label ? v.label : null, readState(v)].filter(Boolean))];
              lines.push(`${head}; ${count} version${count === 1 ? "" : "s"}, latest v${v.version_number}${v.file_name ? ` ${v.file_name}` : ""}, saved ${when(v.created_at)} [${flags.join(", ")}]`);
              lines.push(`  versionId: ${v.id}`, `  ${open("version", v.id)}`);
              const card = cardLines(cards.get(v.id), "  ");
              if (card.length) lines.push(...card);
              else lines.push(v.indexing_status === "indexed" ? "  Index card: not written." : "  Index card: not written yet (the Hub has not read this file).");
            }
            const block = lines.join("\n");
            if (blocks.length && used + block.length + 1 > OVERVIEW_BUDGET) break;
            blocks.push(block);
            used += block.length + 1;
          }
          const end = from + blocks.length;
          if (from > 0 || end < docs.length) out.push(`Showing documents ${from + 1}–${end} of ${docs.length}.`);
          out.push(...blocks);
          if (end < docs.length) out.push(`[${docs.length - end} more document${docs.length - end === 1 ? "" : "s"}: call get_project_overview again with from: ${end}.]`);
        }
        return out.join("\n");
      },
    },
    {
      name: "find_document_by_title",
      title: "Find a document by its title",
      description: `Find project documents, and projects, whose title contains some words (case does not matter): the way to get a document's id when you know what it is called, e.g. "term sheet" or "concession agreement". Give projectId to look within one project; without it the whole Hub is searched and matching project names are listed too. Returns up to ${FIND_LIMIT} documents, each with its project, its latest version's id (what read_document and get_document_summary take) and its Hub page. It matches titles only; search_project_documents looks inside the documents' text.`,
      inputSchema: {
        query: z.string().describe("Words from the title, e.g. \"term sheet\"."),
        projectId: z.string().optional().describe("Optional: a project's id, to look only within it."),
      },
      async run(input) {
        const query = str(input.query, 200);
        if (!query) throw new Error("Some words from the title are needed.");
        const matter = input.projectId != null && String(input.projectId).trim() ? await needProject(input) : null;
        const pattern = likePattern(query);

        let q = supabase
          .from("matter_documents")
          .select("id, title, status, matter_id, matter:matters(id, name), document_type:document_types(name), versions:document_versions(id, version_number, file_name, is_ai_generated, indexing_status)")
          .ilike("title", pattern);
        if (matter) q = q.eq("matter_id", matter.id);
        const { data: docRows, error: docsError } = await q.order("title", { ascending: true }).limit(FIND_LIMIT);
        if (docsError) throw new Error(`Could not search the document titles: ${docsError.message}`);
        const docs = docRows ?? [];

        let projects = [];
        if (!matter) {
          const { data, error } = await supabase.from("matters").select("id, name, status, sector, matter_type, client:clients(name)").ilike("name", pattern).order("name", { ascending: true }).limit(FIND_LIMIT);
          if (error) throw new Error(`Could not search the project names: ${error.message}`);
          projects = data ?? [];
        }

        const where = matter ? ` in ${matter.name}` : " on the Hub";
        if (!docs.length && !projects.length) return `No document${matter ? "" : " or project"} title contains “${query}”${where}. Try fewer or other words; search_project_documents looks inside a project's documents.`;

        const out = [];
        out.push(`${docs.length === FIND_LIMIT ? `The first ${FIND_LIMIT}` : docs.length} document${docs.length === 1 ? "" : "s"} whose title contains “${query}”${where}${docs.length === FIND_LIMIT ? " (there may be more: give more words)" : ""}:`, "");
        if (!docs.length) out.push("(none)");
        for (const d of docs) {
          const v = latestVersion(d.versions);
          const head = `- ${d.title}${d.document_type?.name ? ` (${d.document_type.name})` : ""}${d.status ? ` — ${String(d.status).replace(/_/g, " ")}` : ""}; project ${d.matter?.name ?? "unknown"}`;
          out.push(head, `  projectId: ${d.matter_id}`, `  documentId: ${d.id}`);
          if (!v) { out.push("  no versions saved", `  ${open("project", d.matter_id)}`); continue; }
          const flags = [v.is_ai_generated ? "AI draft" : null, readState(v)].filter(Boolean);
          out.push(`  latest v${v.version_number}${v.file_name ? ` ${v.file_name}` : ""} of ${d.versions.length} [${flags.join(", ")}]`, `  versionId: ${v.id}`, `  ${open("version", v.id)}`);
        }
        if (projects.length) {
          out.push("", `Project${projects.length === 1 ? "" : "s"} whose name contains “${query}”:`, "");
          for (const m of projects) out.push(`- ${projectLine(m)}`, `  projectId: ${m.id}`, `  ${open("project", m.id)}`);
        }
        return out.join("\n");
      },
    },
  ];
};
