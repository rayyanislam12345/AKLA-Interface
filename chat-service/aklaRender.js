// Every document the AI Workspace writes is delivered as a Word file in the
// firm's house format, in one of two layouts: an agreement's, or a memo's
// (aklaLayout below). The model writes Markdown; akla/build_docx.py turns it
// into the Word file to the firm's Word Formatting and Shortcuts Guide, as
// measured from circulated firm documents — A4, Arial 11, the title on a navy
// banner, "1." section headings in bold small caps with a rule beneath, a
// 1. / 1.1. / 1.1.1. outline and (a) (i) A. lists owned by named AKLA styles,
// the running header and "Page X of Y" after a clean first page — and AKLA
// comments into native Word comments. The format is applied by construction
// and then checked, rather than asked of the model and hoped for.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { unzipSync, strFromU8 } from "fflate";

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, "akla", "build_docx.py");
const VENV_PYTHON = join(here, ".akla-venv", "bin", "python");
const python = () => process.env.AKLA_PYTHON ?? (existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3");

/** "September 04, 2026", the firm's date form, in Pakistan time. */
export function aklaDate(date = new Date()) {
  return date.toLocaleDateString("en-US", { month: "long", day: "2-digit", year: "numeric", timeZone: "Asia/Karachi" });
}

/** "Notes On The Agreement [AKLA][September 04, 2026].docx" */
export function aklaFileName(title, date = aklaDate()) {
  const stem = String(title ?? "Document")
    .replace(/[\\/:*?"<>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150) || "Document";
  return `${stem} [AKLA][${date}].docx`;
}

// The firm sets an agreement differently from a memo (docs/house-format.md):
// a cover page, the parties and recitals, bold small caps throughout and no
// banner or emblem. These say which documents are agreements.
const MEMO_CATEGORIES = new Set(["Reports", "Meetings & Correspondence", "General/Legal"]);
const AGREEMENT_WORDS = /\b(agreement|deed|contract|term\s*sheet|heads\s+of\s+terms|undertaking|guarantee|indenture|memorandum\s+of\s+understanding|mou|side\s+letter|letter\s+of\s+(?:lien|hypothecation|comfort|credit)|charter|articles\s+of\s+association|power\s+of\s+attorney|pledge|mortgage|assignment|lease|licen[cs]e|novation)\b/i;
const MEMO_WORDS = /\b(notes?\s+on|memo\b|memorandum\s+(?:on|of\s+law|regarding)|report|minutes|meeting\s+notes|proposal|opinion|summary|review|analysis|research|concept\s+(?:note|paper)|briefing|advice|issues\s+list|checklist|register|tracker|comments\s+on|mark-?up\s+of)\b/i;

/**
 * "agreement" or "memo": the layout a document is set in. The document's
 * type decides where it has one; otherwise its title, and then its first
 * heading, by the words that name an agreement ("Notes on the Concession
 * Agreement" is a memo: the memo words win).
 */
export function aklaLayout({ title, markdown, category } = {}) {
  if (category) return MEMO_CATEGORIES.has(category) ? "memo" : "agreement";
  const heading = /^\s*#\s+(.+)$/m.exec(String(markdown ?? ""))?.[1] ?? "";
  for (const text of [title, heading]) {
    const t = String(text ?? "");
    if (!t.trim()) continue;
    if (MEMO_WORDS.test(t)) return "memo";
    if (AGREEMENT_WORDS.test(t)) return "agreement";
  }
  return "memo";
}

export async function renderAklaDocx({ markdown, title, status = "Draft", date = aklaDate(), layout = "memo", timeoutMs = 60_000 }) {
  const dir = await mkdtemp(join(tmpdir(), "akla-"));
  const out = join(dir, "document.docx");
  try {
    const args = [SCRIPT, "-", "-o", out, "--doc-title", String(title ?? "").slice(0, 200), "--doc-status", status, "--doc-date", date, "--layout", layout === "agreement" ? "agreement" : "memo"];
    const stderr = await new Promise((resolve, reject) => {
      const child = spawn(python(), args, { stdio: ["pipe", "ignore", "pipe"] });
      let err = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("The Word renderer took too long"));
      }, timeoutMs);
      child.stderr.on("data", (d) => {
        err += d;
      });
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new Error(`The Word renderer could not start: ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(err);
        else reject(new Error(`The Word renderer failed: ${err.trim().split("\n").pop() || `exit ${code}`}`));
      });
      child.stdin.end(markdown);
    });
    const bytes = new Uint8Array(await readFile(out));
    return { bytes, layout, warnings: String(stderr).split("\n").map((l) => l.trim()).filter(Boolean), check: checkAklaFormat(bytes, { layout }) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Checks a rendered file against the house format. A failure here means the
 * renderer regressed, so it is recorded on the document for anyone to see.
 */
export function checkAklaFormat(bytes, { layout = "memo" } = {}) {
  const files = unzipSync(bytes);
  const part = (name) => (files[name] ? strFromU8(files[name]) : "");
  const doc = part("word/document.xml");
  const styles = part("word/styles.xml");
  const numbering = part("word/numbering.xml");
  const headers = Object.keys(files).filter((n) => /^word\/header\d*\.xml$/.test(n)).map(part).join("");
  const footers = Object.keys(files).filter((n) => /^word\/footer\d*\.xml$/.test(n)).map(part).join("");
  const comments = part("word/comments.xml");
  const findings = [];
  const styleXml = (id) => new RegExp(`<w:style [^>]*w:styleId="${id}"[\\s\\S]*?<\\/w:style>`).exec(styles)?.[0] ?? "";

  // Page: A4 with one-inch margins, a clean first page (the Guide).
  const pgSz = /<w:pgSz [^>]*\/>/.exec(doc)?.[0] ?? "";
  if (!/w:w="1190\d"/.test(pgSz) || !/w:h="168\d\d"/.test(pgSz)) findings.push("The page is not A4.");
  if (!/<w:titlePg\/>/.test(doc)) findings.push("The first page is not kept clean of the running header and page number.");

  // Text: Arial 11 through Normal, and every paragraph on a named AKLA style.
  const normal = styleXml("Normal");
  if (!/w:ascii="Arial"/.test(normal)) findings.push("Body text is not set in Arial.");
  if (!/<w:sz w:val="22"\/>/.test(normal)) findings.push("Body text is not 11pt.");
  const unstyled = (doc.match(/<w:p>|<w:p (?![^>]*\/>)[^>]*>/g) ?? []).length - (doc.match(/<w:pStyle w:val="AKLA/g) ?? []).length;
  if (unstyled > 0) findings.push(`${unstyled} paragraph(s) are not on an AKLA style.`);

  // Outline: 1. / 1.1. / 1.1.1. owned by the heading and body styles.
  if (!/w:abstractNumId="7100"/.test(numbering) || !/w:lvlText w:val="%1\.%2\.%3\."/.test(numbering)) findings.push("The 1. / 1.1. / 1.1.1. outline is missing.");
  const heading1 = styleXml("AKLAHeading1");
  if (!/<w:numId w:val="7101"\/>/.test(heading1)) findings.push("Section headings are not numbered by their style.");
  if (!/<w:bottom [^>]*w:val="single"/.test(heading1)) findings.push("Section headings have no rule beneath.");
  if (!/<w:sz w:val="26"\/>/.test(heading1) || !/<w:smallCaps\/>/.test(heading1) || !/<w:b\/>/.test(heading1)) findings.push("Section headings are not 13pt bold small caps.");
  if (!/<w:numId w:val="7101"\/>/.test(styleXml("AKLABody1")) || !/<w:numId w:val="7101"\/>/.test(styleXml("AKLABody2"))) findings.push("Body paragraphs are not numbered by their style.");

  // Title, header, footer: a memo's title on the navy banner and a red
  // confidentiality line; an agreement's title centred over a rule, and no
  // banner, emblem or red line anywhere.
  if (layout === "agreement") {
    if (!/<w:pStyle w:val="AKLAAgreementTitle"\/>/.test(doc)) findings.push("The agreement's title is missing.");
    if (/w:fill="002060"/.test(doc) || headers.includes("C00000") || /<w:drawing/.test(headers)) findings.push("The agreement carries memo furniture (a banner, the emblem or a red line).");
  } else {
    if (/<w:pStyle w:val="AKLATitle"\/>/.test(doc) && !/w:fill="002060"/.test(doc)) findings.push("The title is not on the navy banner.");
    if (!headers.includes("C00000")) findings.push("The running header's confidentiality line is missing.");
  }
  if (!/PAGE/.test(footers) || !/NUMPAGES/.test(footers)) findings.push("The Page X of Y footer is missing.");

  if (/\[\[\s*AKLA|\[\^[^\]]+\]/i.test(doc)) findings.push("A comment or footnote marker was left in the text.");
  const authors = [...comments.matchAll(/w:author="([^"]*)"/g)].map((m) => m[1]);
  if (authors.some((a) => a !== "AKLA Comments")) findings.push("A comment is not titled AKLA Comments.");
  const sections = (doc.match(/<w:pStyle w:val="AKLAHeading1"\/>/g) ?? []).length;
  return { status: findings.length ? "needs_review" : "checked", findings, sections, comments: authors.length };
}
