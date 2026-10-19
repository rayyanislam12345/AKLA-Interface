// list_acts and get_act_outline: what the law library holds, and the shape
// of one Act. A lawyer's claude.ai sees the laws by their library names and
// an Act's section numbers and headings before it reads a section, instead
// of guessing at "s. 199". Both read the library the way the Hub's own
// search does (libraryTools.js: listActs, resolveAct, actText), so a name
// said loosely ("companies act 2017", "CPC") lands on the library's entry,
// and the Act's text comes from the same hour-long cache the searches share.
// Neither touches a project or a document, so there is no "Open in Hub"
// line; the outline carries the Act's official link where the library has
// one, as a statute passage does.

import { z } from "zod";
import { listActs as libListActs, resolveAct, suggestActs, actText as libActText } from "../../libraryTools.js";
import { str } from "../tools.js";

// What one page of the outline may hold: under MAX_RESULT_CHARS with room
// for the head and the tail, so the wrapper never has to cut a line in half.
export const OUTLINE_CHARS = 28_000;
// How far past "199." a heading may run (libraryTools.js TOC_GAP).
const HEADING_SPAN = 250;

/**
 * The heading after a section number, as libraryTools.js reads it (its
 * headingOf is not exported): the words up to the dash that opens the body
 * (".—", ".__", ".-", ":-") or the first full stop, whichever comes first.
 */
function headingOf(rest) {
  const head = rest.slice(0, HEADING_SPAN);
  const ends = [head.search(/\.?\s?(?:[—–]|_{2,}|:-)|\.-(?=\s)/), head.search(/\.\s/)].filter((i) => i > 0);
  return (ends.length ? head.slice(0, Math.min(...ends)) : rest.slice(0, 120)).trim();
}

/**
 * The outline of an Act from its text and section index (actText's `index`,
 * from sectionIndex): { sections: [{ section, heading }], schedules } where
 * `schedules` says the body is followed by Schedules numbered from 1 again
 * (the index's last entry, with section null).
 */
export function outlineOf(doc) {
  const text = String(doc?.text ?? "");
  const index = Array.isArray(doc?.index) ? doc.index : [];
  const sections = [];
  let schedules = false;
  for (let i = 0; i < index.length; i++) {
    const entry = index[i];
    if (!entry.section) { schedules = true; continue; }
    const stop = index[i + 1]?.index ?? text.length;
    // The text at entry.index starts "199. Heading.—…": skip the number and its full stop.
    const rest = text.slice(entry.index + entry.section.length + 1, stop).trimStart();
    sections.push({ section: entry.section, heading: headingOf(rest) });
  }
  return { sections, schedules };
}

/**
 * One page of the outline, from position `from` (0-based, a count of
 * sections to skip), as many lines as fit in `budget` characters; the tail
 * says where to continue.
 */
export function outlineText({ act_name, source_url = null, asked = null }, { sections, schedules }, from = 0, budget = OUTLINE_CHARS) {
  const n = sections.length;
  const named = asked && asked.toLowerCase() !== String(act_name).toLowerCase() ? ` (asked for “${asked}”)` : "";
  if (!n) return `The library's copy of ${act_name}${named} has no section headings the Hub can tell apart. Search it by subject with search_law_library instead.`;
  if (from >= n) return `${act_name}'s outline has ${n} sections; there is nothing at position ${from}. Call again with from: 0.`;
  const lines = [];
  let used = 0;
  let end = from;
  for (; end < n; end++) {
    const s = sections[end];
    const line = s.heading ? `s. ${s.section} — ${s.heading}` : `s. ${s.section}`;
    if (lines.length && used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  const partial = from > 0 || end < n;
  const head = [`${act_name}${named}: ${n} section${n === 1 ? "" : "s"} in the library's copy${partial ? `; sections ${from + 1}–${end} of the outline` : ""}. Read one in full with read_act_section (act "${act_name}", section "<number>").`];
  if (source_url) head.push(`Link: ${source_url}`);
  const tail = end < n
    ? `[The outline continues: call get_act_outline again with from: ${end}.]`
    : schedules ? "[End of the sections. Schedules follow in the text, their paragraphs numbered from 1 again.]" : "[End of the outline.]";
  return `${head.join("\n")}\n\n${lines.join("\n")}\n\n${tail}`;
}

export default function actTools({ supabase, library = {} }) {
  // The library's readers, or a test's stand-ins for them.
  const listActs = library.listActs ?? libListActs;
  const actText = library.actText ?? libActText;

  return [
    {
      name: "list_acts",
      title: "List the laws the firm holds",
      description: "The laws in the firm's law library — the Pakistani Acts, Ordinances, Rules and Regulations the Hub can search and read — by their library names. Call it to find out whether the firm holds a law before searching it, or to get the name to give search_law_library, get_act_outline and read_act_section. Takes nothing; returns one line per law.",
      inputSchema: {},
      async run() {
        const acts = await listActs(supabase);
        if (!acts.length) return "The law library holds no laws yet.";
        return `${acts.length} law${acts.length === 1 ? "" : "s"} in the firm's law library. Name one as written here to search_law_library, get_act_outline or read_act_section:\n\n${acts.map((a) => `- ${a.act_name}`).join("\n")}`;
      },
    },
    {
      name: "get_act_outline",
      title: "Outline of an Act",
      description: `The section numbers and headings of one law in the firm's law library, in order (\"s. 199 — Investments in associated companies and undertaking\"), so you can find the section to read with read_act_section instead of guessing its number. Give the law's name as list_acts shows it, or loosely (\"Companies Act 2017\"). A long Act comes in pages of about ${OUTLINE_CHARS.toLocaleString("en")} characters; the reply says what to pass as from to continue. Returns the outline, not the text of any section.`,
      inputSchema: {
        act: z.string().describe("The law, e.g. \"Companies Act, 2017\"."),
        from: z.number().int().min(0).optional().describe("Position in the outline to start at (a count of sections to skip), from the previous reply. Default 0."),
      },
      async run(input) {
        const asked = str(input.act, 200);
        if (!asked) throw new Error("The act is needed: the law's name, as list_acts shows it.");
        const acts = await listActs(supabase);
        const resolved = resolveAct(asked, acts);
        if (!resolved) {
          const close = suggestActs(asked, acts);
          throw new Error(`The law library holds no law matching "${asked}".${close.length ? ` Closest held: ${close.join("; ")}.` : ""} list_acts gives every law held.`);
        }
        const doc = await actText(supabase, resolved.act_name);
        if (!doc) throw new Error(`${resolved.act_name} has no text in the law library.`);
        const from = Number.isInteger(input.from) && input.from > 0 ? input.from : 0;
        return outlineText({ act_name: doc.act_name ?? resolved.act_name, source_url: doc.source_url, asked }, outlineOf(doc), from);
      },
    },
  ];
}
