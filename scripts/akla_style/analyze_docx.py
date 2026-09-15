#!/usr/bin/env python3
"""Measure how a Word document is actually formatted.

Reads the package XML directly (no Word, no rendering) and reports what a
house-style generator has to reproduce: page setup, the default and used
styles as they resolve, every numbering level in use with its indents, the
direct formatting paragraphs carry on top of their style, fonts and sizes as
used, tables, and the header and footer.

    python3 analyze_docx.py FILE.docx [--json]
"""
import json
import re
import sys
import zipfile
from collections import Counter, defaultdict

from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
NS = {"w": W}


def q(tag):
    return f"{{{W}}}{tag}"


def val(el, tag, attr="val"):
    if el is None:
        return None
    child = el.find(f"w:{tag}", NS)
    if child is None:
        return None
    return child.get(q(attr), True)


def twips_in(v):
    return None if v in (None, True) else round(int(v) / 1440, 3)


def rpr_summary(rpr):
    if rpr is None:
        return {}
    out = {}
    fonts = rpr.find("w:rFonts", NS)
    if fonts is not None:
        out["font"] = fonts.get(q("ascii")) or fonts.get(q("hAnsi")) or fonts.get(q("asciiTheme"))
    sz = val(rpr, "sz")
    if sz not in (None, True):
        out["pt"] = int(sz) / 2
    for flag in ("b", "i", "caps", "smallCaps", "strike"):
        v = val(rpr, flag)
        if v is not None:
            out[flag] = v in (True, "1", "true", "on")
    u = val(rpr, "u")
    if u is not None:
        out["underline"] = u
    color = val(rpr, "color")
    if color is not None:
        out["color"] = color
    highlight = val(rpr, "highlight")
    if highlight:
        out["highlight"] = highlight
    shd = rpr.find("w:shd", NS)
    if shd is not None and shd.get(q("fill")) not in (None, "auto"):
        out["shade"] = shd.get(q("fill"))
    return out


def ppr_summary(ppr):
    if ppr is None:
        return {}
    out = {}
    ind = ppr.find("w:ind", NS)
    if ind is not None:
        for a in ("left", "start", "right", "end", "hanging", "firstLine"):
            if ind.get(q(a)) is not None:
                out[f"ind_{a}"] = twips_in(ind.get(q(a)))
    sp = ppr.find("w:spacing", NS)
    if sp is not None:
        for a in ("before", "after"):
            if sp.get(q(a)) is not None:
                out[f"space_{a}_pt"] = int(sp.get(q(a))) / 20
        if sp.get(q("line")) is not None:
            rule = sp.get(q("lineRule")) or "auto"
            line = int(sp.get(q("line")))
            out["line"] = round(line / 240, 2) if rule == "auto" else f"{line / 20}pt {rule}"
        if sp.get(q("beforeAutospacing")) or sp.get(q("afterAutospacing")):
            out["autospacing"] = True
    jc = val(ppr, "jc")
    if jc:
        out["align"] = jc
    for flag in ("keepNext", "keepLines", "pageBreakBefore", "contextualSpacing"):
        if ppr.find(f"w:{flag}", NS) is not None:
            out[flag] = True
    shd = ppr.find("w:shd", NS)
    if shd is not None and shd.get(q("fill")) not in (None, "auto"):
        out["shade"] = shd.get(q("fill"))
    if ppr.find("w:pBdr", NS) is not None:
        out["border"] = sorted(c.tag.split("}")[1] for c in ppr.find("w:pBdr", NS))
    outline = val(ppr, "outlineLvl")
    if outline is not None:
        out["outline"] = outline
    return out


def analyze(path):
    z = zipfile.ZipFile(path)
    names = set(z.namelist())
    parse = lambda n: etree.fromstring(z.read(n)) if n in names else None
    doc = parse("word/document.xml")
    styles = parse("word/styles.xml")
    numbering = parse("word/numbering.xml")
    body = doc.find("w:body", NS)
    report = {"file": path.split("/")[-1]}

    # ---- page setup
    sects = doc.findall(".//w:sectPr", NS)
    pages = []
    for s in sects:
        pg = s.find("w:pgSz", NS)
        mar = s.find("w:pgMar", NS)
        pages.append({
            "size_in": [twips_in(pg.get(q("w"))), twips_in(pg.get(q("h")))] if pg is not None else None,
            "orient": pg.get(q("orient")) if pg is not None else None,
            "margins_in": {a: twips_in(mar.get(q(a))) for a in ("top", "bottom", "left", "right", "header", "footer", "gutter")} if mar is not None else None,
            "titlePg": s.find("w:titlePg", NS) is not None,
            "cols": val(s, "cols", "num"),
        })
    report["sections"] = [dict(t) for t in {json.dumps(p, sort_keys=True): p for p in pages}.values()]

    # ---- styles
    by_id = {}
    if styles is not None:
        for st in styles.findall("w:style", NS):
            by_id[st.get(q("styleId"))] = st
        dd = styles.find("w:docDefaults", NS)
        report["doc_defaults"] = {
            "run": rpr_summary(dd.find("w:rPrDefault/w:rPr", NS)) if dd is not None else {},
            "paragraph": ppr_summary(dd.find("w:pPrDefault/w:pPr", NS)) if dd is not None else {},
        }

    def resolve(style_id, seen=None):
        seen = seen or set()
        st = by_id.get(style_id)
        if st is None or style_id in seen:
            return {}, {}
        seen.add(style_id)
        base = val(st, "basedOn")
        p, r = resolve(base, seen) if base else ({}, {})
        p = {**p, **ppr_summary(st.find("w:pPr", NS))}
        r = {**r, **rpr_summary(st.find("w:rPr", NS))}
        return p, r

    # ---- numbering definitions
    abstract = {}
    num_to_abs = {}
    num_overrides = {}
    if numbering is not None:
        for a in numbering.findall("w:abstractNum", NS):
            levels = {}
            for lvl in a.findall("w:lvl", NS):
                ilvl = int(lvl.get(q("ilvl")))
                levels[ilvl] = {
                    "fmt": val(lvl, "numFmt"),
                    "text": val(lvl, "lvlText"),
                    "start": val(lvl, "start"),
                    "suffix": val(lvl, "suff") or "tab",
                    "align": val(lvl, "lvlJc"),
                    "pStyle": val(lvl, "pStyle"),
                    **ppr_summary(lvl.find("w:pPr", NS)),
                    **{f"num_{k}": v for k, v in rpr_summary(lvl.find("w:rPr", NS)).items()},
                }
            link = val(a, "styleLink") or val(a, "numStyleLink")
            abstract[a.get(q("abstractNumId"))] = {"levels": levels, "link": link}
        for n in numbering.findall("w:num", NS):
            num_to_abs[n.get(q("numId"))] = val(n, "abstractNumId")
            if n.findall("w:lvlOverride", NS):
                num_overrides[n.get(q("numId"))] = len(n.findall("w:lvlOverride", NS))

    # ---- paragraphs: style, numbering, direct formatting, run formatting
    combos = defaultdict(lambda: {"count": 0, "direct": Counter(), "runs": Counter(), "examples": []})
    fonts = Counter()
    sizes = Counter()
    used_num = Counter()
    for p in body.iter(q("p")):
        ppr = p.find("w:pPr", NS)
        style = val(ppr, "pStyle") or "Normal"
        numpr = ppr.find("w:numPr", NS) if ppr is not None else None
        num_id = val(numpr, "numId") if numpr is not None else None
        ilvl = val(numpr, "ilvl") if numpr is not None else None
        if num_id is None and style in by_id:
            # numbering inherited from the style
            sp = by_id[style].find("w:pPr/w:numPr", NS)
            if sp is not None:
                num_id = val(sp, "numId")
                ilvl = val(sp, "ilvl") or "0"
        if num_id in (None, True, "0"):
            num_id = None
        key = f"{style}" + (f" | num {num_id} lvl {ilvl or 0}" if num_id else "")
        text = "".join(t.text or "" for t in p.iter(q("t"))).strip()
        c = combos[key]
        c["count"] += 1
        if num_id:
            used_num[(num_id, str(ilvl or 0))] += 1
        direct = {k: v for k, v in ppr_summary(ppr).items()} if ppr is not None else {}
        c["direct"][json.dumps(direct, sort_keys=True)] += 1
        for r in p.findall("w:r", NS):
            rs = rpr_summary(r.find("w:rPr", NS))
            if not (r.find("w:t", NS) is not None and (r.find("w:t", NS).text or "").strip()):
                continue
            c["runs"][json.dumps(rs, sort_keys=True)] += 1
            if rs.get("font"):
                fonts[rs["font"]] += 1
            if rs.get("pt"):
                sizes[rs["pt"]] += 1
        if text and len(c["examples"]) < 2:
            c["examples"].append(text[:90])

    out_combos = []
    for key, c in sorted(combos.items(), key=lambda kv: -kv[1]["count"]):
        style = key.split(" | ")[0]
        sp, sr = resolve(style)
        entry = {
            "paragraphs": key,
            "count": c["count"],
            "style_paragraph": sp,
            "style_run": sr,
            "direct_paragraph_most_common": [json.loads(k) | {"n": n} for k, n in c["direct"].most_common(3)],
            "direct_run_most_common": [json.loads(k) | {"n": n} for k, n in c["runs"].most_common(3)],
            "examples": c["examples"],
        }
        if " | num " in key:
            nid = key.split("num ")[1].split(" ")[0]
            lvl = int(key.split("lvl ")[1])
            abs_id = num_to_abs.get(nid)
            entry["numbering_level"] = abstract.get(abs_id, {}).get("levels", {}).get(lvl)
        out_combos.append(entry)
    report["paragraph_kinds"] = out_combos[:40]

    report["numbering_in_use"] = []
    for (nid, lvl), n in sorted(used_num.items(), key=lambda kv: (kv[0][0], kv[0][1])):
        abs_id = num_to_abs.get(nid)
        report["numbering_in_use"].append({"numId": nid, "abstract": abs_id, "level": lvl, "paragraphs": n, "overrides": num_overrides.get(nid, 0), "definition": abstract.get(abs_id, {}).get("levels", {}).get(int(lvl))})

    report["fonts_in_runs"] = fonts.most_common(6)
    report["sizes_in_runs_pt"] = sizes.most_common(8)

    # ---- tables
    tables = []
    for t in body.iter(q("tbl")):
        tpr = t.find("w:tblPr", NS)
        rows = t.findall("w:tr", NS)
        first = rows[0] if rows else None
        first_cell = first.find("w:tc", NS) if first is not None else None
        shade = first_cell.find("w:tcPr/w:shd", NS) if first_cell is not None else None
        first_run = first_cell.find(".//w:r/w:rPr", NS) if first_cell is not None else None
        grid = [twips_in(g.get(q("w"))) for g in t.findall("w:tblGrid/w:gridCol", NS)]
        mar = tpr.find("w:tblCellMar", NS) if tpr is not None else None
        tables.append({
            "style": val(tpr, "tblStyle"),
            "rows": len(rows),
            "cols_in": grid,
            "width": ({k.split("}")[1]: v for k, v in tpr.find("w:tblW", NS).attrib.items()} if tpr is not None and tpr.find("w:tblW", NS) is not None else None),
            "align": val(tpr, "jc"),
            "indent_in": twips_in(val(tpr, "tblInd", "w")),
            "borders": sorted(c.tag.split("}")[1] + ":" + (c.get(q("val")) or "") + ":" + (c.get(q("sz")) or "") + ":" + (c.get(q("color")) or "") for c in (tpr.find("w:tblBorders", NS) if tpr is not None and tpr.find("w:tblBorders", NS) is not None else [])),
            "cell_margins_in": {c.tag.split("}")[1]: twips_in(c.get(q("w"))) for c in mar} if mar is not None else None,
            "header_row_repeats": first is not None and first.find("w:trPr/w:tblHeader", NS) is not None,
            "header_fill": shade.get(q("fill")) if shade is not None else None,
            "header_run": rpr_summary(first_run),
            "first_row_text": [" ".join((x.text or "") for x in c.iter(q("t"))).strip()[:30] for c in (first.findall("w:tc", NS) if first is not None else [])][:6],
        })
    report["tables"] = {"count": len(tables), "distinct": [dict(json.loads(k)) | {"n": n} for k, n in Counter(json.dumps({k: v for k, v in tb.items() if k not in ("rows", "first_row_text", "cols_in")}, sort_keys=True) for tb in tables).most_common(5)], "examples": tables[:3]}

    # ---- header and footer
    hf = {}
    for n in sorted(names):
        m = re.match(r"word/(header|footer)(\d+)\.xml$", n)
        if not m:
            continue
        x = parse(n)
        paras = []
        for p in x.iter(q("p")):
            text = "".join(t.text or "" for t in p.iter(q("t"))).strip()
            instr = " ".join((i.text or "").strip() for i in p.iter(q("instrText"))).strip()
            runs = [rpr_summary(r.find("w:rPr", NS)) for r in p.findall(".//w:r", NS) if r.find("w:t", NS) is not None]
            if text or instr:
                paras.append({"text": text[:80], "fields": instr, "paragraph": ppr_summary(p.find("w:pPr", NS)), "run": runs[0] if runs else {}})
        hf[n.split("/")[1]] = {"paragraphs": paras[:8], "images": len(x.findall(".//{http://schemas.openxmlformats.org/drawingml/2006/main}blip")), "tables": len(x.findall(".//w:tbl", NS))}
    report["headers_footers"] = hf
    report["comments"] = len(parse("word/comments.xml").findall("w:comment", NS)) if "word/comments.xml" in names else 0
    report["footnotes"] = max(0, len(parse("word/footnotes.xml").findall("w:footnote", NS)) - 2) if "word/footnotes.xml" in names else 0
    return report


if __name__ == "__main__":
    result = analyze(sys.argv[1])
    print(json.dumps(result, indent=1, ensure_ascii=False, default=str))
