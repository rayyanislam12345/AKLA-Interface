// The firm's own skills, for a lawyer's claude.ai: the list of them
// (list_skills) and one skill's instructions in slices (read_skill). A skill
// is an ai_skills row: either written in the Hub's Skills dialog (kind
// "instructions") or uploaded as a Claude skill .zip (kind "claude_skill",
// server.js /skills/upload). For an uploaded zip the Hub keeps the SKILL.md
// body in the `instructions` column at upload (server.js stores
// parseSkillZip's `instructions`, falling back to the description) and sends
// the zip itself to Anthropic, where it runs in the code execution sandbox;
// nothing of the zip stays on the VM. So the column is the one place the
// text lives, for both kinds, and it is read from there. A row whose text
// still opens with SKILL.md front matter (a skill written in the dialog by
// pasting a SKILL.md whole) is shown without it, through the same reader
// the upload uses (claudeSkills.js readFrontMatter).
//
// What claude.ai gets is the instructions: the scripts and templates an
// uploaded skill carries run only in the Hub (they are listed by path so
// Claude knows they exist). Access: skills belong to the firm, not a
// project (select is is_firm_member alone, 20260915090000), and the
// connector has already established membership before any tool runs
// (app.js stillMember), so no further check is made, as for the standards.
// Nothing is written.

import { z } from "zod";
import { readFrontMatter } from "../../claudeSkills.js";
import { MAX_READ_CHARS, DEFAULT_READ_CHARS, str, uuid, when, short } from "../tools.js";
import { hubBase } from "../hubLinks.js";

export const MAX_SKILLS = 300;
// A page of the list, under the wrapper's 30,000 cap with room for the head
// and tail (a description can run to 1,024 characters).
export const SKILLS_PAGE_CHARS = 24_000;
const MAX_DESCRIPTION_CHARS = 1_024;
/** Files of an uploaded skill named in read_skill's head; the rest are counted. */
export const MAX_FILES_SHOWN = 40;

/** The Hub page skills are managed from: the chat workspace, whose composer opens the Skills dialog (src/components/ai/chat/SkillsDialog.tsx). */
export function skillsLink(hubUrl) {
  return `${hubBase(hubUrl)}/ai`;
}

export const openSkills = (hubUrl) => `Open in Hub: ${skillsLink(hubUrl)}`;

const isZipSkill = (row) => row?.kind === "claude_skill";
const kindOf = (row) => (isZipSkill(row) ? "uploaded as a Claude skill (.zip)" : "written in the Hub");
const resultOf = (row) => (row?.produces_document ? "produces a document (a memo or draft the Hub saves as Word)" : "answers in the chat");

/** The paths an uploaded skill carries (skill_files, [{ path, size }]), without the skill's own folder and SKILL.md. */
export function filesOf(row) {
  const list = Array.isArray(row?.skill_files) ? row.skill_files : [];
  return list
    .map((f) => (typeof f?.path === "string" ? f.path.trim() : ""))
    .filter(Boolean)
    .map((p) => p.replace(/^[^/]+\//, ""))
    .filter((p) => p && p !== "SKILL.md")
    .sort((a, b) => a.localeCompare(b));
}

/** The skill's instructions as the lawyer's Claude reads them: front matter off, whitespace trimmed. */
export function instructionsOf(row) {
  const text = String(row?.instructions ?? "").replace(/\r\n?/g, "\n");
  return readFrontMatter(text).body.trim();
}

/** "Name (email)", "Name", the email, or null, from a profiles row. */
export function personName(profile) {
  const name = str(profile?.full_name, 120);
  const email = str(profile?.email, 160);
  return name ?? email ?? null;
}

const byLine = (row, names) => {
  const who = row.created_by ? names.get(row.created_by) ?? null : null;
  const added = `added ${when(row.created_at)}`;
  const changed = row.updated_at && row.created_at && row.updated_at.slice(0, 10) !== row.created_at.slice(0, 10) ? `, changed ${when(row.updated_at)}` : "";
  return `${who ? `by ${who}, ` : ""}${added}${changed}`;
};

/** One skill in the list. */
export function skillText(row, names) {
  const out = [`- ${row.name}`, `  skillId: ${row.id}`];
  const description = str(row.description, MAX_DESCRIPTION_CHARS);
  if (description) out.push(`  ${short(description, MAX_DESCRIPTION_CHARS)}`);
  const files = isZipSkill(row) ? filesOf(row) : [];
  out.push(`  ${kindOf(row)}${files.length ? `, with ${files.length} file${files.length === 1 ? "" : "s"} (scripts, references or templates that run only in the Hub)` : ""}; ${resultOf(row)}`);
  out.push(`  ${byLine(row, names)}`);
  return out.join("\n");
}

export default ({ supabase, hubUrl }) => {
  const needSkillId = (input) => {
    const id = uuid(input.skillId);
    if (!id) throw new Error("skillId must be a skill id (a UUID). list_skills gives them.");
    return id;
  };

  // Who added each skill, in one query; a missing profile, or a profiles
  // read that fails, leaves the by-line without a name rather than failing
  // the list.
  const namesOf = async (rows) => {
    const ids = [...new Set(rows.map((r) => r.created_by).filter(Boolean))];
    const names = new Map();
    if (!ids.length) return names;
    const { data, error } = await supabase.from("profiles").select("id, full_name, email").in("id", ids);
    if (error) return names;
    for (const p of data ?? []) {
      const name = personName(p);
      if (name) names.set(p.id, name);
    }
    return names;
  };

  return [
    {
      name: "list_skills",
      title: "List the firm's skills",
      description: `The firm's own skills on the Hub: reusable drafting instructions a lawyer picks from the Hub's composer, each with its id, what it is for (its description), whether it was written in the Hub or uploaded as a Claude skill .zip, whether it produces a document or answers in the chat, and who added it and when. Call it when the lawyer asks for a document or task the firm may have a skill for (a daily agenda, a due diligence volume, a concession agreement, a summary memo), or names a skill, then read_skill to follow its instructions. Read-only; it changes nothing. ${Math.floor(SKILLS_PAGE_CHARS / 1000)},000 characters a page: from is the skill number to start at, and the reply says where to continue.`,
      inputSchema: {
        from: z.number().int().min(1).optional().describe("The skill number to start at, from 1. Default 1."),
      },
      async run(input) {
        const { data, error } = await supabase
          .from("ai_skills")
          .select("id, name, description, kind, produces_document, skill_files, created_by, created_at, updated_at")
          .order("name", { ascending: true })
          .limit(MAX_SKILLS);
        if (error) throw new Error(`Could not list the firm's skills: ${error.message}`);
        const rows = data ?? [];
        if (!rows.length) return `The firm has no skills on the Hub yet. An admin adds one in the Hub's Skills dialog.\n${openSkills(hubUrl)}`;
        const total = rows.length;
        const start = Math.min(Math.max(1, Number.isInteger(input.from) && input.from > 0 ? input.from : 1), total);
        const names = await namesOf(rows);
        const zips = rows.filter(isZipSkill).length;
        const documents = rows.filter((r) => r.produces_document).length;
        const head = [
          `${total} skill${total === 1 ? "" : "s"} on the Hub, by name: ${zips} uploaded as Claude skills, ${total - zips} written in the Hub; ${documents} produce${documents === 1 ? "s" : ""} a document. read_skill gives a skill's instructions.${start > 1 ? ` Skills ${start} to ${total}.` : ""}`,
          openSkills(hubUrl),
        ].join("\n");
        const parts = [head];
        let used = head.length;
        let n = start;
        for (; n <= total; n++) {
          const block = `\n${skillText(rows[n - 1], names)}`;
          if (used + block.length > SKILLS_PAGE_CHARS && n > start) break;
          parts.push(block);
          used += block.length;
        }
        parts.push(n <= total ? `\n[The list continues: call list_skills again with from: ${n}.]` : "\n[End of the list.]");
        return parts.join("\n");
      },
    },
    {
      name: "read_skill",
      title: "Read a firm skill",
      description: `The instructions of one of the firm's skills, in slices of up to ${MAX_READ_CHARS.toLocaleString("en")} characters: the text a lawyer's Hub chat follows when the skill is picked (for an uploaded Claude skill, its SKILL.md). Use it to do in claude.ai what the skill describes, in the firm's own words and order, when the lawyer asks for that kind of work or names the skill; the scripts and templates an uploaded skill carries run only in the Hub, so where the instructions need one, say so and offer the Hub. Read-only; it changes nothing. Start at from: 0; the reply says where to continue. list_skills gives the id.`,
      inputSchema: {
        skillId: z.string().describe("The skill's id, from list_skills."),
        from: z.number().int().min(0).optional().describe("Character offset to start at. Default 0."),
        chars: z.number().int().min(1).optional().describe(`How many characters to return, at most ${MAX_READ_CHARS}. Default ${DEFAULT_READ_CHARS}.`),
      },
      async run(input) {
        const id = needSkillId(input);
        const { data: row, error } = await supabase
          .from("ai_skills")
          .select("id, name, description, instructions, kind, produces_document, skill_files, created_by, created_at, updated_at")
          .eq("id", id)
          .maybeSingle();
        if (error) throw new Error(`Could not read the skill: ${error.message}`);
        if (!row) throw new Error("There is no skill with that id. list_skills gives them.");
        const names = await namesOf([row]);
        const text = instructionsOf(row);
        const label = `the firm's skill "${row.name}"`;
        const head = [`${label[0].toUpperCase()}${label.slice(1)}, ${kindOf(row)}, ${byLine(row, names)}; ${resultOf(row)}.`];
        const description = str(row.description, MAX_DESCRIPTION_CHARS);
        if (description) head.push(`What it is for: ${description}`);
        const files = isZipSkill(row) ? filesOf(row) : [];
        if (files.length) {
          const shown = files.slice(0, MAX_FILES_SHOWN);
          head.push(`Files in the skill (${files.length}; they run only in the Hub, where the skill runs in Anthropic's sandbox): ${shown.join(", ")}${files.length > shown.length ? `, and ${files.length - shown.length} more` : ""}.`);
        }
        head.push(openSkills(hubUrl));
        if (!text) return `${head.join("\n")}\n\nThe skill holds no instructions text.`;
        const from = Number.isInteger(input.from) && input.from > 0 ? input.from : 0;
        const chars = Math.min(MAX_READ_CHARS, Number.isInteger(input.chars) && input.chars > 0 ? input.chars : DEFAULT_READ_CHARS);
        if (from >= text.length) return `${label[0].toUpperCase()}${label.slice(1)} is ${text.length.toLocaleString("en")} characters long; there is nothing at ${from.toLocaleString("en")}.`;
        const end = Math.min(text.length, from + chars);
        head.push(`Characters ${(from + 1).toLocaleString("en")}–${end.toLocaleString("en")} of ${text.length.toLocaleString("en")}.`);
        const tail = end < text.length ? `[The instructions continue: call read_skill again with from: ${end}.]` : "[End of the instructions.]";
        return `${head.join("\n")}\n\nINSTRUCTIONS:\n\n${text.slice(from, end)}\n\n${tail}`;
      },
    },
  ];
};
