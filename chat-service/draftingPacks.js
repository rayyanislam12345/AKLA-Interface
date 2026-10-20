// Drafting packs (docs/drafting-fidelity-plan-2026-10-19.md, slice 2): the
// firm's own Word file for a kind of document, cut by
// scripts/drafting-packs/build_pack.py and uploaded as that type's Word
// standard by scripts/drafting-packs/upload_packs.mjs. A pack is an ordinary
// standard (document_type_templates: storage_path, content_html,
// format_rules) with three more columns (20261020140000_drafting_packs.sql):
// `kinds`, the paragraph kinds the drafting engine writes with (docxAgent.js
// validateKinds is the contract), `fingerprint`, the pack's format
// fingerprint (formatFingerprint.js), and `pack_mode`, "form" or "shell".
//
// What this module gives the Hub (server.js) and the claude.ai connector
// (connector/tools/fillStandard.js, fillStandardWrite.js, standards.js,
// saves.js), so the two say the same thing:
// - packOf(row): the pack a template row carries, or null;
// - packPromptBlock(pack): the mode's drafting instructions and the kinds
//   listing, shown beside OPS_PROTOCOL;
// - packForBase: the pack a Word file being worked on was drafted from, so
//   every later edit of the draft writes in the same kinds;
// - packTypesOf / packTypeFor: which types have a pack, and whether a
//   document written as text is one of them (it is then never set in the
//   general house layout);
// - packMap: in a shell pack, which kind each blank paragraph is, and
//   whether it is a fixed part to fill or an example to remove;
// - packFormatRules: the format_rules sentence for a pack, from its
//   fingerprint;
// - withPackColumns: a read that still works before the migration is
//   applied (the columns are then simply absent and no type has a pack).
import { kindsListing, readZip, child, enumerateParagraphs, headingStyles } from "./docxAgent.js";
import { typeNamedIn } from "./chatState.js";

export const PACK_MODES = Object.freeze(["form", "shell"]);
/** The template row's pack columns, as the readers select them (kinds is large: only where it is used). */
export const PACK_COLUMNS = "kinds, pack_mode";
/** The comment a clause the firm's precedents do not have carries (the plan's new-clause rule). */
export const NEW_CLAUSE_COMMENT = "New clause — not in the firm's precedents: <why>";

/**
 * The pack a document_type_templates (or document_template_versions) row
 * carries: { kinds, mode } or null when the row has no kinds list. A row
 * with kinds and no mode is read as a form pack.
 */
export function packOf(row) {
  const kinds = row?.kinds;
  if (!kinds || typeof kinds !== "object" || Array.isArray(kinds)) return null;
  if (!kinds.kinds || typeof kinds.kinds !== "object" || !Object.keys(kinds.kinds).length) return null;
  return { kinds, mode: row.pack_mode === "shell" ? "shell" : "form" };
}

// A select that names the pack columns fails until the migration is
// applied; the read is then made again without them.
const MISSING_COLUMN = /\b(kinds|pack_mode|fingerprint)\b|does not exist|schema cache/i;
/**
 * Runs read(true) — a query that selects the pack columns — and, if the
 * database says a column is missing, read(false). Returns the Supabase
 * result ({ data, error }).
 */
export async function withPackColumns(read) {
  const first = await read(true);
  if (first?.error && MISSING_COLUMN.test(String(first.error.message ?? ""))) return read(false);
  return first;
}

export const SHELL_PACK_INSTRUCTIONS = `THIS STANDARD IS THE FIRM'S SHELL PACK for this kind of document: the firm's own file with only its fixed parts kept (the letterhead line, Ref, Dated, To, Subject, salutation and closing, cover, contents, disclaimer, signature block, footer) and one example paragraph of each kind the firm uses in it, each example's words replaced by [●]. The body is written fresh for this matter. Draft it in three steps, all in this one reply:
1. Fill the fixed parts: replace each [●] in them with the fact (the same fact in every slot it belongs to). A fixed part's value you were not given stays [●], with an AKLA comment saying what is needed.
2. Write the body with "write" operations, placed after the fixed paragraph it follows (in a letter, after the Subject line or the salutation; in a memo, opinion or minutes, after the heading it sits under), in the kinds listed below: a heading kind for each heading, the body or numbered kind for each paragraph, the limb kinds for (a), (b) and (i), (ii), a "footnote" block for a citation, a table kind for a table. Every paragraph of the body is a "write" block: never use insert_after for the body, and never type a number, a bracketed letter or a bullet — Word numbers them.
3. Remove each [●] example paragraph with "remove_block" (from and to both that paragraph, or a run of them) once the body is written, and remove a fixed part this document does not need (an Attachments or Copy to list with nothing in it) together with its heading.
Write in the firm's voice: "the Firm", never "we", in a memo, opinion or proposal; British spelling (-ise); defined terms bold, in brackets, without quotation marks. Never carry wording over from another matter's document.`;

export const FORM_PACK_INSTRUCTIONS = `THIS STANDARD IS THE FIRM'S FORM PACK for this kind of document: the firm's settled text with the deal's facts blanked to [●]. Fill the [●] as the fill instructions say, and change a clause's wording only where the lawyer asks, keeping the firm's words around the change. Four more moves, in the kinds listed below:
- A clause the lawyer asks for that the pack does not have is written with "write" (its heading kind, then the clause kinds), placed where its subject belongs in the agreement — never at the end for convenience, never in place of a clause the firm always has. In the same reply, put an AKLA comment on the paragraph it is written after, reading "${NEW_CLAUSE_COMMENT}" and naming the new clause's heading, and list it in your reply. Rewriting the substance of a firm clause gets the same comment; filling facts into it does not.
- A second party, signature block or schedule: "repeat_block" the firm's own, then fill the copy in a later turn.
- A row of a notice, conditions or signature table: "add_row".
- An optional clause or schedule the deal does not need: "remove_block" it together with its heading.
Never type a clause number or a limb letter: Word numbers them. British spelling (-ise).`;

const EDIT_PACK_NOTE = (mode) => `THIS DOCUMENT WAS DRAFTED FROM THE FIRM'S ${mode.toUpperCase()} PACK. A new heading, paragraph, clause or limb is written with "write" in the kinds listed below, not with insert_after, so it takes the firm's own look; a second party or signature block is "repeat_block", a table row "add_row", a section to drop "remove_block". A clause not in the firm's precedents carries the AKLA comment "${NEW_CLAUSE_COMMENT}" (on the paragraph it is written after, naming its heading). Never type numbers: Word numbers them.`;

/**
 * The pack's part of a drafting prompt: the mode's instructions (or, when
 * the file is a draft being edited, the short note) and the kinds listing,
 * for the prompt to show beside OPS_PROTOCOL. "" when there is no pack.
 */
export function packPromptBlock(pack, { editing = false } = {}) {
  if (!pack?.kinds) return "";
  const listing = kindsListing(pack.kinds);
  const text = editing ? EDIT_PACK_NOTE(pack.mode) : pack.mode === "shell" ? SHELL_PACK_INSTRUCTIONS : FORM_PACK_INSTRUCTIONS;
  return listing ? `${text}\n${listing}` : text;
}

const dec = new TextDecoder();
// A paragraph property as the pack builder and Word write it, compared
// without namespaces, revision ids and spacing between tags.
const sameXml = (xml) => String(xml ?? "")
  .replace(/\s+xmlns(?::\w+)?="[^"]*"/g, "")
  .replace(/\s+w:rsid\w*="[^"]*"/g, "")
  .replace(/<w:(?:pPrChange|rPrChange|ins|del)\b[^>]*\/>/g, "")
  .replace(/>\s+</g, "><")
  .trim();
// A paragraph that is nothing but blanks ("[●]", "[Name]"); a signature
// rule of underscores is a fixed line, not a blank.
const ONLY_BLANKS = /^(?:\s*\[[^\]\n]{0,120}\]\s*)+$/;
const firstRunRPr = (pXml) => {
  for (const m of pXml.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)) if (/<w:t[\s>]/.test(m[1])) return child(m[1], "w:rPr") ?? "";
  return "";
};

/**
 * In a shell pack (and in a draft made from one), which kind each blank
 * paragraph is — "¶11 opening: an example, to remove once the body is
 * written", "¶5 addressee: a fixed part, to fill" — read by matching each
 * paragraph's own format to the kinds list (the builder copied the kinds
 * from these very paragraphs). The kinds list's `examples` (the names of
 * the example kinds, added by upload_packs.mjs from packs-config.json) says
 * which are examples; without it, only the kind is named. "" for a form
 * pack, or when nothing matches.
 */
export function packMap(bytes, pack) {
  if (pack?.mode !== "shell" || !pack.kinds?.kinds) return "";
  let entries;
  try { entries = readZip(bytes); } catch { return ""; }
  const xml = entries["word/document.xml"] ? dec.decode(entries["word/document.xml"]) : "";
  if (!xml) return "";
  const headings = headingStyles(entries["word/styles.xml"] ? dec.decode(entries["word/styles.xml"]) : "");
  const kinds = Object.entries(pack.kinds.kinds).map(([name, k]) => ({ name, label: k?.label ?? "", pPr: sameXml(k?.pPr), rPr: sameXml(k?.rPr) }));
  const examples = new Set(Array.isArray(pack.kinds.examples) ? pack.kinds.examples : []);
  const exampleTables = Object.entries(pack.kinds.tables ?? {}).filter(([t]) => examples.has(t)).map(([name, t]) => ({ name, tblPr: sameXml(t?.tblPr) }));
  const lines = [];
  for (const p of enumerateParagraphs(xml, headings)) {
    if (!ONLY_BLANKS.test(p.text)) continue;
    const pXml = xml.slice(p.start, p.end);
    if (p.inTable) {
      // The table holding it, by its format: an example table goes whole.
      const tblStart = xml.lastIndexOf("<w:tbl>", p.start);
      const tblPr = tblStart >= 0 ? sameXml(child(xml.slice(tblStart, p.start), "w:tblPr") ?? "") : "";
      const table = exampleTables.filter((t) => t.tblPr === tblPr).map((t) => t.name);
      if (table.length) lines.push(`¶${p.index} [table]: in the example table ${table.join(" or ")}; remove the whole table with remove_block once the body is written (a table of the body is written with its table kind)`);
      else if (examples.size) lines.push(`¶${p.index} [table]: a fixed part, to fill`);
      continue;
    }
    const pPr = sameXml(child(pXml, "w:pPr") ?? "");
    let found = kinds.filter((k) => k.pPr === pPr);
    if (found.length > 1) {
      const rPr = sameXml(firstRunRPr(pXml));
      const narrowed = found.filter((k) => k.rPr === rPr);
      if (narrowed.length) found = narrowed;
    }
    if (!found.length) continue;
    const names = found.map((k) => k.name).join(" or ");
    const isExample = found.every((k) => examples.has(k.name));
    const isFixed = examples.size && found.every((k) => !examples.has(k.name));
    // Two kinds the builder took from paragraphs formatted alike: the
    // example among them is named, for the reader to judge by its place.
    const maybe = !isExample && !isFixed ? found.filter((k) => examples.has(k.name)).map((k) => k.name) : [];
    lines.push(`¶${p.index} ${names}${isExample ? ": an example, to remove once the body is written" : isFixed ? ": a fixed part, to fill" : maybe.length ? `: if it is the ${maybe.join(" or ")} example (judge by its place), remove it once the body is written; otherwise fill it` : ""}`);
  }
  if (!lines.length) return "";
  return `WHICH KIND EACH BLANK PARAGRAPH IS:\n${lines.join("\n")}`;
}

/**
 * The pack the Word file being worked on was drafted from: the standard's
 * own row when the file is the standard (or a draft of the current one),
 * else the filing of that standard in document_template_versions, found by
 * its storage path — so a draft keeps writing in its pack's kinds after the
 * standard is replaced. null when the file did not come from a standard or
 * the standard is not a pack.
 * @param base { templatePath, documentTypeId } (server.js docxBase)
 * @param templateRow the type's current template row, when read (with PACK_COLUMNS)
 */
export async function packForBase(supabase, base, templateRow = null) {
  const path = base?.templatePath;
  if (!path) return null;
  if (templateRow?.storage_path === path && Object.hasOwn(templateRow, "kinds")) return packOf(templateRow);
  const { data, error } = await withPackColumns((withPack) => supabase
    .from("document_template_versions")
    .select(withPack ? `storage_path, ${PACK_COLUMNS}` : "storage_path")
    .eq("storage_path", path)
    .maybeSingle());
  if (error) {
    console.error(`could not read the pack of ${path}: ${error.message}`);
    return null;
  }
  return packOf(data);
}

/**
 * The document types that have a pack, [{ id, name, mode }]: those whose
 * template row has a pack mode (the upload sets it with the kinds). [] when
 * the read fails or the migration is not applied.
 */
export async function packTypesOf(supabase) {
  try {
    const { data, error } = await supabase
      .from("document_type_templates")
      .select("document_type_id, pack_mode, document_type:document_types(id, name)")
      .not("pack_mode", "is", null);
    if (error) return [];
    return (data ?? []).map((r) => {
      const t = Array.isArray(r.document_type) ? r.document_type[0] : r.document_type;
      return t?.id && t?.name ? { id: t.id, name: t.name, mode: r.pack_mode } : null;
    }).filter(Boolean);
  } catch {
    return [];
  }
}

// A letter shows itself by its lines: a Ref, a Subject (or Re) and a
// salutation, whatever its title.
const LETTER_LINES = [
  /^\s*(?:\*\*)?\s*(?:our\s+)?ref(?:erence)?(?:\s*no\.?)?\s*(?:\*\*)?\s*[:.]/im,
  /^\s*(?:\*\*)?\s*(?:subject|re)\s*(?:\*\*)?\s*:/im,
  /^\s*(?:\*\*)?\s*dear\b/im,
];
const LETTER_TYPE = /^letter\b/i;

/**
 * Which pack type a document written as text is, or null: the type it was
 * drafted under when that type has a pack; else the type its title (or its
 * first "# " heading) names at its head ("Letter to the Project Director",
 * "Legal Opinion — …", "Minutes of …"); else a letter by its Ref, Subject
 * and salutation lines. "Notes on the Escrow Agreement" is not an escrow
 * agreement: only the head of the title counts.
 * @param doc { documentTypeId?, title?, markdown? }
 * @param packTypes packTypesOf's list
 */
export function packTypeFor(doc, packTypes) {
  if (!packTypes?.length) return null;
  const byId = doc?.documentTypeId ? packTypes.find((t) => t.id === doc.documentTypeId) : null;
  if (byId) return byId;
  const heading = /^\s*#\s+(.+)$/m.exec(String(doc?.markdown ?? ""))?.[1] ?? "";
  for (const title of [doc?.title, heading]) {
    const found = title ? typeNamedIn(String(title).replace(/^\s*draft\s*:\s*/i, ""), packTypes, { head: true }) : null;
    if (found) return found;
  }
  const md = String(doc?.markdown ?? "");
  const letter = packTypes.find((t) => LETTER_TYPE.test(t.name));
  if (letter && LETTER_LINES.every((re) => re.test(md))) return letter;
  return null;
}

/** What the Hub says when a document of a pack type was written as text: where it goes instead. */
export function packPointer(typeName) {
  return `The firm drafts a ${typeName} in its own Word file, so this is kept as text and not set in the general house layout. To have it in the firm's form, ask: "Draft this as a ${typeName} from the firm's standard".`;
}

/** The connector's one sentence when a draft of a pack type is offered to save_draft_to_project. */
export function packRedirectSentence(type) {
  return `${type.name} is drafted in the firm's own Word file, so nothing was saved: open it with open_standard_for_filling (documentTypeId ${type.id}) and file the draft with fill_standard_to_project.`;
}

const cm = (twips) => `${(Number(twips) / 567).toFixed(2).replace(/\.?0+$/, "")} cm`;

/**
 * The format_rules sentence for a pack, from its fingerprint and kinds: the
 * page, the margins, the body font and size, the heading styles and the
 * kinds. It goes into the drafting prompt as "How the standard is
 * formatted", as the admin upload's analysis does for any other standard.
 */
export function packFormatRules(fp, kinds, mode) {
  const s = fp?.sections?.[0];
  const parts = [];
  if (s) {
    const page = s.pgSz?.name ?? (s.pgSz ? `${cm(s.pgSz.w)} × ${cm(s.pgSz.h)}` : "page");
    const m = s.pgMar ?? {};
    const sections = fp.sections.length > 1 ? ` (${fp.sections.length} sections; this is the first)` : "";
    parts.push(`The firm's ${mode === "shell" ? "shell" : "form"} pack, ${page}${sections}, margins ${cm(m.top)} top, ${cm(m.bottom)} bottom, ${cm(m.left)} left, ${cm(m.right)} right.`);
  } else {
    parts.push(`The firm's ${mode === "shell" ? "shell" : "form"} pack.`);
  }
  if (fp?.body?.font) parts.push(`Body text ${fp.body.font}${fp.body.sizeHalfPts ? ` ${fp.body.sizeHalfPts / 2} pt` : ""}.`);
  const headings = Object.entries(fp?.headingStyles ?? {}).slice(0, 3).map(([level, id]) => `level ${level} "${id}"`);
  if (headings.length) parts.push(`Heading styles: ${headings.join(", ")}.`);
  const paragraphKinds = Object.entries(kinds?.kinds ?? {}).map(([name, k]) => `${name} (${k?.label ?? "paragraph"})`);
  const tableKinds = Object.keys(kinds?.tables ?? {});
  if (paragraphKinds.length) parts.push(`Paragraph kinds: ${paragraphKinds.join(", ")}${tableKinds.length ? `; table kinds: ${tableKinds.join(", ")}` : ""}${kinds?.footnote ? "; footnotes" : ""}.`);
  parts.push(`Word numbers every clause and limb; never type a number. Blanks are ${fp?.placeholder ?? "[●]"}.`);
  return parts.join(" ");
}
