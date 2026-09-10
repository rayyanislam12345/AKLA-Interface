import JSZip from "jszip";
import type { PMNode } from "./firmDocx";

// Exports a draft *inside the firm's standard .docx* for its document type,
// rather than into the generic firm-styled file firmDocx.ts builds.
//
// The standard is a real Word file an associate uploaded on the Standardize
// page. Everything about how it looks is kept: its page setup, headers and
// footers, styles, theme, fonts and — most importantly — its own multilevel
// numbering. Only the body text is replaced. The result opens in Word as
// that file with new content, so the numbering, spacing and typefaces are
// the standard's, not an approximation of them.
//
// How the draft's structure is mapped onto the standard: the file is read
// once to find an "exemplar" paragraph for each role — the title, each
// clause level, ordinary body text, enumerated items — and each new
// paragraph is written with the exemplar's paragraph and run properties
// copied verbatim. That copes with how these files are really formatted
// (mostly direct formatting on top of a style that says something else) far
// better than naming styles would. Clause numbering uses the numbering
// definition the standard's own top-level headings use, so "1." / "1.1" /
// "(a)" come out exactly as the firm's file does them.
//
// Pure module, no DOM: the same code runs in the browser (export, and the
// analysis at upload time) and in Node (backfills, tests).

export interface TemplateLevel {
  ilvl: number;
  numFmt: string;
  lvlText: string;
}

interface Exemplar {
  pPr: string; // "<w:pPr>…</w:pPr>" with any numPr removed, or ""
  rPr: string; // "<w:rPr>…</w:rPr>" for runs, or ""
  observed: boolean; // seen in the body (true) or synthesised (false)
}

export interface TemplateProfile {
  title: Exemplar;
  headings: Exemplar[]; // index = clause depth: 0 → "## ", 1 → "### ", 2 → "#### "
  body: Exemplar;
  list: Exemplar;
  // The multilevel numbering the standard's clause headings use, or null
  // when it has none usable (then the firm's own definition is injected).
  numbering: { numId: string; levels: TemplateLevel[] } | null;
  bodyFont: string;
  bodySize: number | null; // points
  // Short, factual description of the standard's formatting for a prompt.
  rules: string;
}

const MAX_HEADING_DEPTH = 3;
const FIRM_NUM_ID = "9001";
const FIRM_ABSTRACT_ID = "9001";

// ---- small XML helpers (string-based; these files are regular enough) ----

const stripRsid = (xml: string) => xml.replace(/\s+w:rsid\w*="[^"]*"/g, "");
const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const attr = (xml: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(xml)?.[1];
const child = (xml: string, tag: string) => new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</${tag}>)`).exec(xml)?.[0];
const stripChild = (xml: string, tag: string) => xml.replace(new RegExp(`<${tag}(?:\\s[^>]*)?(?:/>|>[\\s\\S]*?</${tag}>)`, "g"), "");
const paraText = (p: string) =>
  (p.match(/<w:t(?:\s[^>]*)?>[^<]*<\/w:t>/g) ?? []).map((t) => t.replace(/<[^>]+>/g, "")).join("");

interface StyleInfo {
  id: string;
  name: string;
  basedOn?: string;
  numId?: string;
  ilvl?: number;
  outlineLvl?: number;
  rPr: string;
}

function parseStyles(stylesXml: string): Map<string, StyleInfo> {
  const styles = new Map<string, StyleInfo>();
  for (const m of stylesXml.matchAll(/<w:style\s[^>]*>[\s\S]*?<\/w:style>/g)) {
    const xml = m[0];
    const id = attr(xml.slice(0, xml.indexOf(">")), "w:styleId");
    if (!id) continue;
    const pPr = child(xml, "w:pPr") ?? "";
    const numPr = child(pPr, "w:numPr");
    const outline = child(pPr, "w:outlineLvl");
    // The style's own rPr is the one directly under w:style, not the pPr's.
    const rPr = child(xml.replace(pPr, ""), "w:rPr") ?? "";
    styles.set(id, {
      id,
      name: attr(child(xml, "w:name") ?? "", "w:val") ?? id,
      basedOn: attr(child(xml, "w:basedOn") ?? "", "w:val"),
      numId: numPr ? attr(child(numPr, "w:numId") ?? "", "w:val") : undefined,
      ilvl: numPr ? Number(attr(child(numPr, "w:ilvl") ?? "", "w:val") ?? 0) : undefined,
      outlineLvl: outline ? Number(attr(outline, "w:val")) : undefined,
      rPr,
    });
  }
  return styles;
}

// Walks basedOn to find the first style in the chain that sets a property.
function inherited<K extends keyof StyleInfo>(styles: Map<string, StyleInfo>, id: string | undefined, key: K): StyleInfo[K] | undefined {
  const seen = new Set<string>();
  let cur = id;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const s = styles.get(cur);
    if (!s) return undefined;
    if (s[key] !== undefined && s[key] !== "") return s[key];
    cur = s.basedOn;
  }
  return undefined;
}

function parseNumbering(numberingXml: string): { numToAbstract: Map<string, string>; levels: Map<string, TemplateLevel[]> } {
  const numToAbstract = new Map<string, string>();
  const levels = new Map<string, TemplateLevel[]>();
  for (const m of numberingXml.matchAll(/<w:num\s[^>]*w:numId="(\d+)"[^>]*>([\s\S]*?)<\/w:num>/g)) {
    const abs = attr(child(m[2], "w:abstractNumId") ?? "", "w:val");
    if (abs) numToAbstract.set(m[1], abs);
  }
  for (const m of numberingXml.matchAll(/<w:abstractNum\s[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g)) {
    const lv: TemplateLevel[] = [];
    for (const l of m[2].matchAll(/<w:lvl\s[^>]*w:ilvl="(\d)"[^>]*>([\s\S]*?)<\/w:lvl>/g)) {
      lv.push({
        ilvl: Number(l[1]),
        numFmt: attr(child(l[2], "w:numFmt") ?? "", "w:val") ?? "decimal",
        lvlText: attr(child(l[2], "w:lvlText") ?? "", "w:val") ?? "",
      });
    }
    levels.set(m[1], lv);
  }
  return { numToAbstract, levels };
}

interface ParaInfo {
  pPr: string;
  rPr: string;
  text: string;
  styleId?: string;
  numId?: string; // effective (direct or via style); undefined = none
  ilvl: number;
  outlineLvl?: number;
  centered: boolean;
}

// The run formatting most of a paragraph's text carries. Not the first
// run's: a body paragraph often opens with a bold defined term, and copying
// that would embolden every line of the draft.
function dominantRunProps(p: string): string {
  const weight = new Map<string, number>();
  for (const r of p.matchAll(/<w:r(?:\s[^>]*)?>([\s\S]*?)<\/w:r>/g)) {
    const rPr = child(r[1], "w:rPr") ?? "";
    const len = paraText(r[1]).length;
    if (len) weight.set(rPr, (weight.get(rPr) ?? 0) + len);
  }
  let best = "";
  let bestW = -1;
  for (const [rPr, w] of weight) if (w > bestW) { best = rPr; bestW = w; }
  return best;
}

function parseBodyParagraphs(documentXml: string, styles: Map<string, StyleInfo>): ParaInfo[] {
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(documentXml)?.[1] ?? documentXml;
  const out: ParaInfo[] = [];
  for (const m of body.matchAll(/<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g)) {
    const p = stripRsid(m[0]);
    const pPr = child(p, "w:pPr") ?? "";
    const styleId = attr(child(pPr, "w:pStyle") ?? "", "w:val");
    const direct = child(pPr, "w:numPr");
    let numId = direct ? attr(child(direct, "w:numId") ?? "", "w:val") : inherited(styles, styleId, "numId");
    let ilvl = direct ? Number(attr(child(direct, "w:ilvl") ?? "", "w:val") ?? 0) : inherited(styles, styleId, "ilvl") ?? 0;
    if (numId === "0") {
      numId = undefined;
      ilvl = 0;
    }
    out.push({
      pPr,
      rPr: dominantRunProps(p),
      text: paraText(p).trim(),
      styleId,
      numId,
      ilvl,
      outlineLvl: inherited(styles, styleId, "outlineLvl"),
      centered: attr(child(pPr, "w:jc") ?? "", "w:val") === "center",
    });
  }
  return out;
}

// The most common (pPr, rPr) pair among candidate paragraphs.
function mode(paras: ParaInfo[]): { pPr: string; rPr: string; count: number } | null {
  const counts = new Map<string, { pPr: string; rPr: string; count: number }>();
  for (const p of paras) {
    const key = `${p.pPr}\u0000${p.rPr}`;
    const e = counts.get(key) ?? { pPr: p.pPr, rPr: p.rPr, count: 0 };
    e.count++;
    counts.set(key, e);
  }
  let best: { pPr: string; rPr: string; count: number } | null = null;
  for (const e of counts.values()) if (!best || e.count > best.count) best = e;
  return best;
}

const withoutNumbering = (pPr: string) => stripChild(pPr, "w:numPr");

function fontOf(rPr: string): string | undefined {
  const f = child(rPr, "w:rFonts");
  return f ? attr(f, "w:ascii") ?? attr(f, "w:hAnsi") : undefined;
}
function sizeOf(rPr: string): number | undefined {
  const v = attr(child(rPr, "w:sz") ?? "", "w:val");
  return v ? Number(v) / 2 : undefined;
}

function describeLevel(l: TemplateLevel | undefined): string {
  if (!l) return "";
  const sample: Record<string, string> = { decimal: "1", lowerLetter: "a", upperLetter: "A", lowerRoman: "i", upperRoman: "I", bullet: "•" };
  const n = sample[l.numFmt] ?? "1";
  return l.lvlText.replace(/%\d/g, (m) => (m === `%${l.ilvl + 1}` ? n : "1")) || n;
}

// ---- analysis ----

export function analyseTemplate(parts: { documentXml: string; stylesXml: string; numberingXml: string }): TemplateProfile {
  const styles = parseStyles(parts.stylesXml);
  const numbering = parseNumbering(parts.numberingXml);
  const paras = parseBodyParagraphs(parts.documentXml, styles);
  const levelsOf = (numId: string | undefined) => (numId ? numbering.levels.get(numbering.numToAbstract.get(numId) ?? "") : undefined);

  // Title: the first real line of the document.
  const firstText = paras.slice(0, 80).find((p) => p.text.length >= 3 && !p.numId);
  const title: Exemplar = firstText
    ? { pPr: withoutNumbering(firstText.pPr), rPr: firstText.rPr, observed: true }
    : { pPr: `<w:pPr><w:jc w:val="center"/></w:pPr>`, rPr: `<w:rPr><w:b/><w:bCs/></w:rPr>`, observed: false };

  // Clause levels, by outline level. A level nobody used in the body is
  // synthesised from the nearest shallower one rather than taken from a
  // style that may be Word's untouched default (Cambria, blue).
  const headings: Exemplar[] = [];
  for (let depth = 0; depth <= MAX_HEADING_DEPTH; depth++) {
    const m = mode(paras.filter((p) => p.outlineLvl === depth && p.text.length >= 2));
    if (m && m.count >= 3) {
      headings.push({ pPr: withoutNumbering(m.pPr), rPr: m.rPr, observed: true });
    } else {
      const prev = headings[depth - 1];
      const styleAtLevel = [...styles.values()].find((s) => s.outlineLvl === depth);
      headings.push(
        prev
          ? { ...prev, observed: false }
          : styleAtLevel
            ? { pPr: `<w:pPr><w:pStyle w:val="${styleAtLevel.id}"/></w:pPr>`, rPr: "", observed: false }
            : { pPr: "", rPr: `<w:rPr><w:b/><w:bCs/></w:rPr>`, observed: false },
      );
    }
  }

  // Body: the commonest long, unnumbered, non-heading, left/justified paragraph.
  const bodyMode = mode(paras.filter((p) => p.text.length >= 80 && !p.numId && p.outlineLvl === undefined && !p.centered));
  const body: Exemplar = bodyMode
    ? { pPr: withoutNumbering(bodyMode.pPr), rPr: bodyMode.rPr, observed: true }
    : { pPr: `<w:pPr><w:jc w:val="both"/></w:pPr>`, rPr: "", observed: false };

  // Enumerated items: paragraphs numbered "(a)"-style anywhere in the file.
  const listMode = mode(
    paras.filter((p) => {
      const lv = levelsOf(p.numId)?.find((l) => l.ilvl === p.ilvl);
      return !!lv && /^\(%\d\)$/.test(lv.lvlText) && p.text.length >= 10 && p.outlineLvl === undefined;
    }),
  );
  const list: Exemplar = listMode
    ? { pPr: withoutNumbering(listMode.pPr), rPr: listMode.rPr, observed: true }
    : { ...body, observed: false };

  // The clause numbering chain: whatever the top-level headings use, if its
  // first level is a sensible clause number.
  const headingNumIds = paras.filter((p) => p.outlineLvl === 0 && p.numId).map((p) => p.numId!);
  const chainId = headingNumIds.length
    ? [...new Set(headingNumIds)].sort((a, b) => headingNumIds.filter((x) => x === b).length - headingNumIds.filter((x) => x === a).length)[0]
    : inherited(styles, [...styles.values()].find((s) => s.outlineLvl === 0)?.id, "numId");
  const chainLevels = levelsOf(chainId);
  const usable = !!chainId && !!chainLevels && chainLevels.length >= 2 && ["decimal", "upperRoman", "upperLetter"].includes(chainLevels[0].numFmt);
  const num = usable ? { numId: chainId!, levels: chainLevels! } : null;

  // Fonts, for the description.
  const normal = [...styles.values()].find((s) => s.name === "Normal" || s.id === "Normal");
  const docDefaults = child(parts.stylesXml, "w:rPrDefault") ?? "";
  const bodyFont = fontOf(body.rPr) ?? fontOf(child(body.pPr, "w:rPr") ?? "") ?? fontOf(normal?.rPr ?? "") ?? fontOf(docDefaults) ?? "the theme font";
  const bodySize = sizeOf(body.rPr) ?? sizeOf(normal?.rPr ?? "") ?? sizeOf(docDefaults) ?? null;

  const lv = num?.levels ?? [];
  const numberingLine = num
    ? `Clause numbering: ${describeLevel(lv[0])} → ${describeLevel(lv[1])}${lv[2] ? ` → ${describeLevel(lv[2])}` : ""}${lv[3] ? ` → ${describeLevel(lv[3])}` : ""} (Word-generated; never type numbers).`
    : "Clause numbering: 1. → 1.1. → 1.1.1. (the firm's default; the standard's headings carry no usable numbering).";
  const look = (e: Exemplar, styleRPr: string) => {
    const r = e.rPr + (child(e.pPr, "w:rPr") ?? "") + styleRPr;
    const bits: string[] = [];
    if (/<w:b(?:\s|\/)/.test(r) && !/<w:b w:val="(?:0|false)"/.test(r)) bits.push("bold");
    if (/<w:smallCaps(?:\s|\/)/.test(r) && !/<w:smallCaps w:val="(?:0|false)"/.test(r)) bits.push("small caps");
    if (/<w:caps(?:\s|\/)/.test(r)) bits.push("capitals");
    if (/<w:u\s/.test(r)) bits.push("underlined");
    if (/<w:i(?:\s|\/)/.test(r) && !/<w:i w:val="(?:0|false)"/.test(r)) bits.push("italic");
    return bits.join(", ");
  };
  const h1Style = attr(child(headings[0].pPr, "w:pStyle") ?? "", "w:val");
  const h2Style = attr(child(headings[1].pPr, "w:pStyle") ?? "", "w:val");
  const h1Look = look(headings[0], inherited(styles, h1Style, "rPr") ?? "");
  const h2Look = look(headings[1], inherited(styles, h2Style, "rPr") ?? "");
  const bodyJc = attr(child(body.pPr, "w:jc") ?? "", "w:val");
  const rules = [
    numberingLine,
    `Top-level clause headings: ${h1Look || "plain"}${h1Style ? ` (style "${styles.get(h1Style)?.name ?? h1Style}")` : ""}. Sub-clause headings: ${h2Look || "plain"}.`,
    `Body text: ${bodyFont}${bodySize ? ` ${bodySize}pt` : ""}, ${bodyJc === "both" ? "justified" : bodyJc ?? "left-aligned"}${/<w:ind\s/.test(body.pPr) ? ", indented under the clause" : ""}.`,
    `Title: ${attr(child(title.pPr, "w:jc") ?? "", "w:val") === "center" ? "centred" : "left-aligned"}${/<w:b(?:\s|\/)/.test(title.rPr) ? ", bold" : ""}.`,
  ].join(" ");

  return { title, headings, body, list, numbering: num, bodyFont, bodySize, rules };
}

// ---- building ----

// Children that the schema puts before w:numPr inside w:pPr.
const BEFORE_NUMPR = ["w:pStyle", "w:keepNext", "w:keepLines", "w:pageBreakBefore", "w:framePr", "w:widowControl"];

function withNumbering(pPr: string, numId: string, ilvl: number): string {
  const numPr = `<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr>`;
  if (!pPr) return `<w:pPr>${numPr}</w:pPr>`;
  const inner = pPr.replace(/^<w:pPr(?:\s[^>]*)?>/, "").replace(/<\/w:pPr>$/, "");
  const children = inner.match(/<w:[A-Za-z]+(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:[A-Za-z]+>)/g) ?? [];
  let at = 0;
  while (at < children.length && BEFORE_NUMPR.some((t) => new RegExp(`^<${t}[\\s/>]`).test(children[at]))) at++;
  children.splice(at, 0, numPr);
  return `<w:pPr>${children.join("")}</w:pPr>`;
}

function runProps(base: string, opts: { bold?: boolean; italics?: boolean }): string {
  if (!opts.bold && !opts.italics) return base;
  const add = `${opts.bold && !/<w:b(?:\s|\/)/.test(base) ? "<w:b/><w:bCs/>" : ""}${opts.italics && !/<w:i(?:\s|\/)/.test(base) ? "<w:i/><w:iCs/>" : ""}`;
  if (!add) return base;
  if (!base) return `<w:rPr>${add}</w:rPr>`;
  // b/i follow rStyle and rFonts in the schema.
  const m = /^(<w:rPr>(?:<w:rStyle[^>]*\/>)?(?:<w:rFonts[^>]*\/>)?)/.exec(base);
  return m ? base.slice(0, m[1].length) + add + base.slice(m[1].length) : base.replace("<w:rPr>", `<w:rPr>${add}`);
}

function inlineRuns(nodes: PMNode[] | undefined, rPr: string, style: { bold?: boolean; italics?: boolean } = {}): string {
  if (!nodes) return "";
  let xml = "";
  for (const node of nodes) {
    if (node.type === "hardBreak") {
      xml += "<w:r><w:br/></w:r>";
      continue;
    }
    if (node.type !== "text" || !node.text) continue;
    const marks = node.marks ?? [];
    const s = { ...style };
    if (marks.some((m) => m.type === "bold")) s.bold = true;
    if (marks.some((m) => m.type === "italic")) s.italics = true;
    xml += `<w:r>${runProps(rPr, s)}<w:t xml:space="preserve">${escapeXml(node.text)}</w:t></w:r>`;
  }
  return xml;
}

function paragraphsXml(doc: PMNode, profile: TemplateProfile, numId: string, maxLevel: number): string {
  const out: string[] = [];
  // Every "# " line before any other content is part of the title block —
  // a draft often opens with the agreement name and a second line saying
  // what it is for, and the second must not become clause 1.
  let inTitleBlock = true;
  let lastHeadingLevel = -1;
  const para = (pPr: string, runs: string) => out.push(`<w:p>${pPr}${runs}</w:p>`);

  const listItems = (items: PMNode[], level: number) => {
    for (const item of items) {
      const nested = item.content?.find((n) => n.type === "bulletList" || n.type === "orderedList");
      const own = (item.content ?? []).filter((n) => n.type !== "bulletList" && n.type !== "orderedList");
      const inline = own.flatMap((n) => n.content ?? []);
      para(withNumbering(profile.list.pPr, numId, Math.min(level, maxLevel)), inlineRuns(inline, profile.list.rPr));
      if (nested) listItems(nested.content ?? [], level + 1);
    }
  };

  for (const node of doc.content ?? []) {
    switch (node.type) {
      case "heading": {
        const depth = node.attrs?.level ?? 1;
        if (depth === 1 && inTitleBlock) {
          para(profile.title.pPr, inlineRuns(node.content, profile.title.rPr, { bold: true }));
        } else {
          inTitleBlock = false;
          const level = Math.min(Math.max(depth - 2, 0), MAX_HEADING_DEPTH);
          lastHeadingLevel = level;
          const ex = profile.headings[level];
          para(withNumbering(ex.pPr, numId, Math.min(level, maxLevel)), inlineRuns(node.content, ex.rPr));
        }
        break;
      }
      case "paragraph":
        inTitleBlock = false;
        para(profile.body.pPr, inlineRuns(node.content, profile.body.rPr));
        break;
      case "bulletList":
      case "orderedList":
        listItems(node.content ?? [], lastHeadingLevel + 1);
        break;
      case "horizontalRule":
        para(`<w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr></w:pPr>`, "");
        break;
      case "blockquote":
        for (const c of node.content ?? []) if (c.type === "paragraph") para(profile.body.pPr, inlineRuns(c.content, profile.body.rPr));
        break;
      default:
        break;
    }
  }
  return out.join("");
}

// The firm's own 1. / 1.1. / 1.1.1. / (a) definition, for a standard whose
// headings aren't numbered by Word.
function firmAbstractNum(): string {
  const lvl = (i: number, fmt: string, text: string) =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + i * 360}" w:hanging="${360 + i * 180}"/></w:pPr>${i < 3 ? "<w:rPr><w:b/></w:rPr>" : ""}</w:lvl>`;
  return (
    `<w:abstractNum w:abstractNumId="${FIRM_ABSTRACT_ID}"><w:multiLevelType w:val="multilevel"/>` +
    lvl(0, "decimal", "%1.") + lvl(1, "decimal", "%1.%2.") + lvl(2, "decimal", "%1.%2.%3.") + lvl(3, "lowerLetter", "(%4)") +
    lvl(4, "lowerRoman", "(%5)") + `</w:abstractNum>`
  );
}

const RELS_TO_DROP = /\/(comments|commentsExtended|commentsIds|commentsExtensible|people|image|ink|hyperlink|oleObject|chart|diagram\w*)$/;

export interface TemplateDocxResult {
  blob: Blob;
  profile: TemplateProfile;
}

// Reads the standard once and hands back both the analysis (for the
// Standardize page and the prompt) and a builder bound to it.
export async function openTemplateDocx(templateBytes: ArrayBuffer | Uint8Array): Promise<{
  profile: TemplateProfile;
  build: (editorDoc: PMNode) => Promise<Blob>;
}> {
  const zip = await JSZip.loadAsync(templateBytes);
  const read = async (path: string) => (zip.file(path) ? await zip.file(path)!.async("string") : "");
  const documentXml = await read("word/document.xml");
  if (!documentXml) throw new Error("This standard is not a Word document");
  const stylesXml = await read("word/styles.xml");
  let numberingXml = await read("word/numbering.xml");
  const profile = analyseTemplate({ documentXml, stylesXml, numberingXml });

  const build = async (editorDoc: PMNode): Promise<Blob> => {
    const out = await JSZip.loadAsync(templateBytes);

    // Numbering: the standard's own chain, or the firm's injected.
    let numId = profile.numbering?.numId ?? FIRM_NUM_ID;
    let maxLevel = profile.numbering ? Math.max(...profile.numbering.levels.map((l) => l.ilvl)) : 4;
    if (!profile.numbering) {
      numId = FIRM_NUM_ID;
      maxLevel = 4;
      const numEntry = `<w:num w:numId="${FIRM_NUM_ID}"><w:abstractNumId w:val="${FIRM_ABSTRACT_ID}"/></w:num>`;
      if (numberingXml) {
        // abstractNums must all precede nums.
        const firstNum = numberingXml.indexOf("<w:num ");
        numberingXml = firstNum >= 0
          ? numberingXml.slice(0, firstNum) + firmAbstractNum() + numberingXml.slice(firstNum).replace("</w:numbering>", `${numEntry}</w:numbering>`)
          : numberingXml.replace("</w:numbering>", `${firmAbstractNum()}${numEntry}</w:numbering>`);
      } else {
        numberingXml =
          `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
          firmAbstractNum() + numEntry + `</w:numbering>`;
        const rels = await read("word/_rels/document.xml.rels");
        out.file(
          "word/_rels/document.xml.rels",
          rels.replace("</Relationships>", `<Relationship Id="rIdNumbering9001" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`),
        );
        const ct = await read("[Content_Types].xml");
        out.file("[Content_Types].xml", ct.replace("</Types>", `<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`));
      }
      out.file("word/numbering.xml", numberingXml);
    }

    // Body: everything between <w:body> and the section properties goes;
    // the *first* section's properties are kept (a standard often ends in a
    // landscape schedule, and the last section's setup would make the whole
    // draft landscape).
    const bodyOpen = /<w:body(?:\s[^>]*)?>/.exec(documentXml);
    if (!bodyOpen) throw new Error("The standard has no document body");
    const bodyStart = bodyOpen.index + bodyOpen[0].length;
    const bodyEnd = documentXml.lastIndexOf("</w:body>");
    const bodyInner = documentXml.slice(bodyStart, bodyEnd);
    const firstSect = /<w:sectPr(?:\s[^>]*)?>[\s\S]*?<\/w:sectPr>|<w:sectPr(?:\s[^>]*)?\/>/.exec(bodyInner)?.[0] ?? "";
    const newDoc =
      documentXml.slice(0, bodyStart) +
      paragraphsXml(editorDoc, profile, numId, maxLevel) +
      firstSect +
      documentXml.slice(bodyEnd);
    out.file("word/document.xml", newDoc);

    // Parts only the old body referred to — comments, embedded images,
    // ink — would otherwise ride along into every draft.
    const relsPath = "word/_rels/document.xml.rels";
    const rels = await read(relsPath);
    if (rels) {
      const dropped: string[] = [];
      const kept = rels.replace(/<Relationship\s[^>]*\/>/g, (r) => {
        const type = attr(r, "Type") ?? "";
        const target = attr(r, "Target") ?? "";
        const id = attr(r, "Id") ?? "";
        const isHeaderFooter = /\/(header|footer)$/.test(type);
        // Ink is filed under a customXml relationship type, so match its path too.
        if (!isHeaderFooter && (RELS_TO_DROP.test(type) || /^ink\//.test(target)) && !newDoc.includes(`"${id}"`)) {
          dropped.push(target);
          return "";
        }
        return r;
      });
      out.file(relsPath, kept);
      let ct = await read("[Content_Types].xml");
      for (const target of dropped) {
        if (/^https?:/.test(target)) continue;
        const path = target.startsWith("/") ? target.slice(1) : `word/${target}`;
        // Still referenced from a header, footer or footnote part? Keep it.
        let referenced = false;
        for (const name of Object.keys(out.files)) {
          if (name.endsWith(".rels") && name !== relsPath && (await read(name)).includes(target.replace(/^\//, ""))) referenced = true;
        }
        if (referenced) continue;
        out.remove(path);
        ct = ct.replace(new RegExp(`<Override PartName="/${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*/>`), "");
      }
      out.file("[Content_Types].xml", ct);
    }

    return out.generateAsync({
      type: "blob",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      compression: "DEFLATE",
    });
  };

  return { profile, build };
}

// One-shot helpers for the two call sites.
export async function buildTemplateDocxBlob(templateBytes: ArrayBuffer, editorDoc: PMNode): Promise<Blob> {
  const { build } = await openTemplateDocx(templateBytes);
  return build(editorDoc);
}

export async function describeTemplateDocx(templateBytes: ArrayBuffer): Promise<string> {
  const { profile } = await openTemplateDocx(templateBytes);
  return profile.rules;
}
