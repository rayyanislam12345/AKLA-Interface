// search_everything: the Hub's project search (src/pages/ProjectSearchPage.tsx)
// for a lawyer's claude.ai. Postgres full-text search over document titles
// and file names, the indexed text of project documents, project notes and
// task titles, across every project at once or one of them; quotes find an
// exact phrase. The database does the work through search_project_content_as
// (migration 20261020100000), the site's search_project_content with the
// user's id passed in rather than read from the session, so the firm-member
// check is the site's and the connector makes no Voyage call for it. Where
// search_project_documents finds passages by meaning in one project, this
// finds the words themselves anywhere.

import { z } from "zod";
import { str, uuid, when, short } from "../tools.js";

export const PAGE_SIZE = 25;
export const KINDS = ["all", "document", "note", "task"];
const MAX_QUERY_CHARS = 200;
const MIGRATION = "supabase/migrations/20261020100000_search_project_content_as.sql";

/** Whether an RPC error means search_project_content_as is not in the database yet. */
export function isMissingFunction(error) {
  if (!error) return false;
  const code = String(error.code ?? "");
  if (code === "PGRST202" || code === "42883") return true;
  return /search_project_content_as/i.test(String(error.message ?? "")) && /could not find|does not exist|schema cache/i.test(String(error.message ?? ""));
}

const kindLabel = { document: "document", note: "note", task: "task" };

export default ({ supabase, helpers }) => [
  {
    name: "search_everything",
    title: "Find words or a phrase across every project",
    description: `Find the words of a query anywhere on the Hub's projects: document titles and file names, the indexed text of project documents, project notes and task titles, across every project at once or within one. Put a phrase in double quotes to find it exactly (e.g. "step-in rights"); a word with a minus in front excludes it. Matches the words themselves, not their meaning (search_project_documents does that, for one project's documents). Only the current version of each document is searched unless allVersions is true. Returns up to ${PAGE_SIZE} results a page, best match first, each with the project, the document version (its versionId for read_document) or the note or task, a snippet with the matched words marked ⟦like this⟧, and its Open in Hub address; the reply says how to see the next page.`,
    inputSchema: {
      query: z.string().describe("The words or phrase to find, 2 to 200 characters. Double quotes for an exact phrase, a leading minus to exclude a word."),
      projectId: z.string().optional().describe("Optional: a project's id, from list_projects, to search only that project."),
      kind: z.enum(KINDS).optional().describe("What to search: all (default), document, note or task."),
      allVersions: z.boolean().optional().describe("Also search superseded versions of documents. Default false: the current version only."),
      page: z.number().int().min(1).optional().describe(`Page of results, from 1. Each page holds ${PAGE_SIZE}.`),
    },
    async run(input, ctx) {
      const userId = uuid(ctx.userId);
      if (!userId) throw new Error("The search needs a signed-in Hub user.");
      const query = str(input.query, MAX_QUERY_CHARS);
      if (!query || query.length < 2) throw new Error("A query of at least 2 characters is needed.");
      const kind = KINDS.includes(input.kind) ? input.kind : "all";
      const allVersions = input.allVersions === true;
      const page = Number.isInteger(input.page) && input.page > 1 ? input.page : 1;
      const matter = input.projectId != null && input.projectId !== "" ? await helpers.needProject(input) : null;

      const { data, error } = await supabase.rpc("search_project_content_as", {
        p_user_id: userId, p_query: query, p_matter_id: matter?.id ?? null, p_kind: kind, p_all_versions: allVersions, p_limit: PAGE_SIZE, p_offset: (page - 1) * PAGE_SIZE,
      });
      if (error) {
        if (isMissingFunction(error)) throw new Error(`The Hub's database does not have the project search for the connector yet (search_project_content_as). Apply ${MIGRATION} to the Supabase project, then search again.`);
        if (/forbidden/i.test(error.message ?? "")) throw new Error("The Hub does not have you as an approved member of the firm, so the projects cannot be searched for you.");
        throw new Error(`Could not search the projects: ${error.message}`);
      }

      const rows = Array.isArray(data) ? data : [];
      const scope = matter ? `${matter.name}'s ${kind === "all" ? "documents, notes and tasks" : `${kindLabel[kind]}s`}` : `every project's ${kind === "all" ? "documents, notes and tasks" : `${kindLabel[kind]}s`}`;
      const versionsNote = kind === "note" || kind === "task" ? "" : allVersions ? " Every version of each document was searched." : " Only the current version of each document was searched; allVersions: true searches the superseded ones too.";
      if (!rows.length) {
        if (page > 1) return `There is no page ${page} of results for “${query}” in ${scope}.`;
        return `Nothing in ${scope} contains “${query}”.${versionsNote} The search matches words, not meaning: try fewer or other words, or search_project_documents for passages on the point in one project.`;
      }

      const total = Number(rows[0]?.total_count ?? rows.length);
      const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
      const first = (page - 1) * PAGE_SIZE + 1;
      const lines = rows.map((r, i) => {
        const n = first + i;
        const snippet = short(r.snippet, 400);
        if (r.kind === "document") {
          const name = `${r.title ?? "Document"}${r.version_number != null ? ` v${r.version_number}` : ""}${r.file_name ? ` (${r.file_name})` : ""}`;
          const where = r.matched_in === "title" ? "matched in the title or file name" : "matched in the text";
          return [`${n}. [document] ${name} — project ${r.matter_name ?? "unknown"}; saved ${when(r.created_at)}; ${where}`, snippet && r.matched_in !== "title" ? `   ${snippet}` : null, r.version_id ? `   versionId: ${r.version_id}` : null, r.version_id ? `   ${helpers.open("version", r.version_id)}` : r.matter_id ? `   ${helpers.open("project", r.matter_id)}` : null].filter(Boolean).join("\n");
        }
        if (r.kind === "note") {
          return [`${n}. [note] Project note on ${r.matter_name ?? "unknown"}, ${when(r.created_at)}`, snippet ? `   ${snippet}` : null, r.matter_id ? `   ${helpers.open("project", r.matter_id)}` : null].filter(Boolean).join("\n");
        }
        return [`${n}. [task] ${r.title ?? "Task"} — project ${r.matter_name ?? "unknown"}${snippet ? `; ${snippet}` : ""}; created ${when(r.created_at)}`, r.matter_id ? `   ${helpers.open("project", r.matter_id)}` : null].filter(Boolean).join("\n");
      });
      const head = `${total} result${total === 1 ? "" : "s"} for “${query}” in ${scope}${pages > 1 ? ` — page ${page} of ${pages}, results ${first}–${first + rows.length - 1}` : ""}.${versionsNote} The matched words are marked ⟦like this⟧; a document's versionId is what read_document takes.`;
      const tail = page < pages ? `[More results: call search_everything again with page: ${page + 1}.]` : "[End of results.]";
      return `${head}\n\n${lines.join("\n\n")}\n\n${tail}`;
    },
  },
];
