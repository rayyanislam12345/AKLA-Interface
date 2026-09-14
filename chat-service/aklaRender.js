// Every document the AI Workspace writes is delivered as a Word file in the
// firm's house format. The model writes Markdown; the firm's own renderer
// (akla/build_docx.py, from the legal-summary skill) turns it into the Word
// file — Arial, navy and gold heading bars, a real 1. / 1.1. / 1.1.1. / (a)
// outline, the running header with the AK emblem, "Page X of Y" — and AKLA
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

export async function renderAklaDocx({ markdown, title, status = "Draft", date = aklaDate(), timeoutMs = 60_000 }) {
  const dir = await mkdtemp(join(tmpdir(), "akla-"));
  const out = join(dir, "document.docx");
  try {
    const args = [SCRIPT, "-", "-o", out, "--doc-title", String(title ?? "").slice(0, 200), "--doc-status", status, "--doc-date", date];
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
    return { bytes, warnings: String(stderr).split("\n").map((l) => l.trim()).filter(Boolean), check: checkAklaFormat(bytes) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Checks a rendered file against the house format. A failure here means the
 * renderer regressed, so it is recorded on the document for anyone to see.
 */
export function checkAklaFormat(bytes) {
  const files = unzipSync(bytes);
  const part = (name) => (files[name] ? strFromU8(files[name]) : "");
  const doc = part("word/document.xml");
  const styles = part("word/styles.xml");
  const numbering = part("word/numbering.xml");
  const headers = Object.keys(files).filter((n) => /^word\/header\d*\.xml$/.test(n)).map(part).join("");
  const footers = Object.keys(files).filter((n) => /^word\/footer\d*\.xml$/.test(n)).map(part).join("");
  const comments = part("word/comments.xml");
  const findings = [];
  const normal = /<w:style [^>]*w:styleId="Normal"[\s\S]*?<\/w:style>/.exec(styles)?.[0] ?? "";
  if (!/w:ascii="Arial"/.test(normal)) findings.push("Body text is not set in Arial.");
  if (!/<w:sz w:val="22"\/>/.test(normal)) findings.push("Body text is not 11pt.");
  if (!/w:abstractNumId="7100"/.test(numbering) || !/w:lvlText w:val="%1\.%2\.%3\."/.test(numbering)) findings.push("The 1. / 1.1. / 1.1.1. outline is missing.");
  const headingParagraphs = doc.match(/<w:p>(?:(?!<\/w:p>)[\s\S])*?<w:pStyle w:val="Heading1"\/>[\s\S]*?<\/w:p>/g) ?? [];
  const sections = headingParagraphs.length;
  if (headingParagraphs.some((p) => !p.includes('w:fill="0E2841"'))) findings.push("A section heading is missing its navy bar.");
  if (sections && !/FFC000/.test(doc)) findings.push("No gold heading text was found.");
  if (!headers.includes("C00000")) findings.push("The running header's confidentiality line is missing.");
  if (!/PAGE/.test(footers) || !/NUMPAGES/.test(footers)) findings.push("The Page X of Y footer is missing.");
  if (/\[\[\s*AKLA|\[\^[^\]]+\]/i.test(doc)) findings.push("A comment or footnote marker was left in the text.");
  const authors = [...comments.matchAll(/w:author="([^"]*)"/g)].map((m) => m[1]);
  if (authors.some((a) => a !== "AKLA Comments")) findings.push("A comment is not titled AKLA Comments.");
  return { status: findings.length ? "needs_review" : "checked", findings, sections, comments: authors.length };
}
