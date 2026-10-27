"""Measures the formatting of every .docx given: page, fonts, sizes, spacing,
alignment, numbering, headings, title, parties block, headers and footers,
colours, defined terms. Resolves run and paragraph properties through the
style chain and document defaults, so the figures are what Word shows.
Writes one JSON record per file to stdout (JSON lines)."""
import json, re, sys, zipfile
from collections import Counter
from lxml import etree

W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
NS = {"w": W, "a": A}
def q(t): return f"{{{W}}}{t}"

def read(z, name):
    try: return etree.fromstring(z.read(name))
    except KeyError: return None

def val(el, tag, attr="val"):
    if el is None: return None
    c = el.find(f"w:{tag}", NS)
    if c is None: return None
    return c.get(q(attr))

def onoff(el, tag):
    if el is None: return None
    c = el.find(f"w:{tag}", NS)
    if c is None: return None
    v = c.get(q("val"))
    return v not in ("0", "false", "off")

class Styles:
    def __init__(self, z):
        s = read(z, "word/styles.xml")
        th = read(z, "word/theme/theme1.xml")
        self.theme = {}
        if th is not None:
            for k, t in (("minor", "minorFont"), ("major", "majorFont")):
                e = th.find(f".//a:{t}/a:latin", NS)
                if e is not None: self.theme[k] = e.get("typeface")
        self.by_id = {}
        self.default_para = None
        self.default_char = None
        self.rdef = self.pdef = None
        if s is None: return
        dd = s.find("w:docDefaults", NS)
        if dd is not None:
            self.rdef = dd.find("w:rPrDefault/w:rPr", NS)
            self.pdef = dd.find("w:pPrDefault/w:pPr", NS)
        for st in s.findall("w:style", NS):
            sid = st.get(q("styleId"))
            self.by_id[sid] = st
            if st.get(q("default")) in ("1", "true"):
                if st.get(q("type")) == "paragraph": self.default_para = sid
                if st.get(q("type")) == "character": self.default_char = sid

    def chain(self, sid):
        seen = []
        while sid and sid in self.by_id and sid not in seen:
            seen.append(sid)
            b = self.by_id[sid].find("w:basedOn", NS)
            sid = b.get(q("val")) if b is not None else None
        return [self.by_id[x] for x in seen]

    def name(self, sid):
        st = self.by_id.get(sid)
        if st is None: return sid
        n = st.find("w:name", NS)
        return n.get(q("val")) if n is not None else sid

    def font_of(self, rpr):
        if rpr is None: return None
        f = rpr.find("w:rFonts", NS)
        if f is None: return None
        a = f.get(q("ascii")) or f.get(q("hAnsi"))
        if a: return a
        t = f.get(q("asciiTheme")) or f.get(q("hAnsiTheme"))
        if t: return self.theme.get("major" if "major" in t else "minor")
        return None

    def rprop(self, rpr_list, getter):
        for r in rpr_list:
            v = getter(r)
            if v is not None: return v
        return None

def twip_cm(v): return round(int(v) / 567, 2) if v not in (None, "") else None

def measure(path):
    z = zipfile.ZipFile(path)
    doc = read(z, "word/document.xml")
    st = Styles(z)
    num = read(z, "word/numbering.xml")
    core = read(z, "docProps/core.xml")
    app = read(z, "docProps/app.xml")
    out = {}
    if core is not None:
        for tag in ("creator", "lastModifiedBy", "title"):
            e = [x for x in core.iter() if etree.QName(x).localname == tag]
            out[tag] = e[0].text if e and e[0].text else None
    if app is not None:
        for tag in ("Company", "Template"):
            e = [x for x in app.iter() if etree.QName(x).localname == tag]
            out[tag.lower()] = e[0].text if e and e[0].text else None

    # numbering: numId -> abstract levels
    abstract, nummap = {}, {}
    if num is not None:
        for an in num.findall("w:abstractNum", NS):
            lv = {}
            for l in an.findall("w:lvl", NS):
                ind = l.find("w:pPr/w:ind", NS)
                lv[int(l.get(q("ilvl")))] = {
                    "fmt": val(l, "numFmt"), "text": val(l, "lvlText"),
                    "left": twip_cm(ind.get(q("left")) or ind.get(q("start"))) if ind is not None else None,
                    "hanging": twip_cm(ind.get(q("hanging"))) if ind is not None and ind.get(q("hanging")) else None,
                    "bold": onoff(l.find("w:rPr", NS), "b"),
                }
            abstract[an.get(q("abstractNumId"))] = lv
        for n in num.findall("w:num", NS):
            a = n.find("w:abstractNumId", NS)
            nummap[n.get(q("numId"))] = abstract.get(a.get(q("val"))) if a is not None else None

    # page setup: the body's last sectPr, plus count of sections and landscape ones
    body = doc.find("w:body", NS)
    sects = doc.findall(".//w:sectPr", NS)
    last = body.find("w:sectPr", NS)
    if last is None and sects: last = sects[-1]
    if last is not None:
        pg = last.find("w:pgSz", NS); mg = last.find("w:pgMar", NS)
        if pg is not None:
            w_, h_ = int(pg.get(q("w")) or 0), int(pg.get(q("h")) or 0)
            out["page"] = "A4" if {abs(w_ - 11906) < 60, abs(h_ - 16838) < 60} == {True} or (abs(w_ - 16838) < 60 and abs(h_ - 11906) < 60) else ("Letter" if (abs(w_-12240)<60 and abs(h_-15840)<60) or (abs(w_-15840)<60 and abs(h_-12240)<60) else ("Legal" if abs(w_-12240)<60 and abs(h_-20160)<60 else f"{w_}x{h_}"))
            out["landscape"] = w_ > h_
        if mg is not None:
            out["margins_cm"] = {k: twip_cm(mg.get(q(k))) for k in ("top", "bottom", "left", "right")}
    out["sections"] = len(sects)
    out["landscape_sections"] = sum(1 for s in sects if (lambda p: p is not None and int(p.get(q("w")) or 0) > int(p.get(q("h")) or 0))(s.find("w:pgSz", NS)))

    fonts, sizes, jc_chars, line, after, before, colours = Counter(), Counter(), Counter(), Counter(), Counter(), Counter(), Counter()
    heading_feats = Counter(); heading_n = 0
    numbered = manual = plain = 0
    lvl_used = Counter(); lvl_fmt = {}
    styles_used = Counter()
    first_indent = Counter()
    paras = []
    defined_bold = defined_total = 0
    curly = straight = 0
    MANUAL = re.compile(r"^\s*(\d+(\.\d+)*\.?|\(?[a-z]{1,3}\)|\(?[ivxl]+\)|[A-Z]\.|Article\s+\d+|ARTICLE\s+\d+|Clause\s+\d+)\s+")
    DEF = re.compile(r"[“\"]([A-Z][^”\"]{1,60})[”\"]")

    for p in body.iter(q("p")):
        ppr = p.find("w:pPr", NS)
        sid = val(ppr, "pStyle") or st.default_para
        chain = st.chain(sid)
        pprs = [ppr] + [c.find("w:pPr", NS) for c in chain] + [st.pdef]
        prs_r_style = [c.find("w:rPr", NS) for c in chain] + [st.rdef]
        texts, chars = [], []
        for r in p.iter(q("r")):
            t = "".join(x.text or "" for x in r.iter(q("t")))
            if not t: continue
            rpr = r.find("w:rPr", NS)
            cs = val(rpr, "rStyle")
            cchain = [c.find("w:rPr", NS) for c in st.chain(cs)] if cs else []
            rl = [rpr] + cchain + prs_r_style
            font = st.rprop(rl, st.font_of) or st.theme.get("minor")
            size = st.rprop(rl, lambda x: val(x, "sz"))
            bold = st.rprop(rl, lambda x: onoff(x, "b")) or False
            caps = st.rprop(rl, lambda x: onoff(x, "caps")) or False
            und = st.rprop(rl, lambda x: (val(x, "u") not in (None, "none")) if x is not None and x.find("w:u", NS) is not None else None) or False
            col = st.rprop(rl, lambda x: val(x, "color"))
            ital = st.rprop(rl, lambda x: onoff(x, "i")) or False
            texts.append(t)
            chars.append((t, font, size, bold, caps, und, col, ital))
        text = "".join(texts)
        if not text.strip(): continue
        jc = None
        for x in pprs:
            v = val(x, "jc")
            if v: jc = v; break
        jc = {"both": "justify", "distribute": "justify", "start": "left", "end": "right"}.get(jc, jc or "left")
        sp = None
        for x in pprs:
            if x is not None and x.find("w:spacing", NS) is not None:
                s = x.find("w:spacing", NS)
                sp = sp or {}
                for k in ("line", "after", "before", "lineRule"):
                    if k not in sp and s.get(q(k)) is not None: sp[k] = s.get(q(k))
        sp = sp or {}
        numpr = None
        for x in pprs[:-1]:
            if x is not None and x.find("w:numPr", NS) is not None:
                numpr = x.find("w:numPr", NS); break
        ilvl = int(val(numpr, "ilvl") or 0) if numpr is not None else None
        nid = val(numpr, "numId") if numpr is not None else None
        levels = nummap.get(nid) if nid and nid != "0" else None
        ind = None
        for x in pprs:
            if x is not None and x.find("w:ind", NS) is not None:
                ind = x.find("w:ind", NS); break
        n = len(text)
        styles_used[st.name(sid)] += n
        for (t, font, size, bold, caps, und, col, ital) in chars:
            fonts[font] += len(t)
            sizes[(int(size) / 2) if size else None] += len(t)
            if col and col.lower() not in ("auto", "000000"): colours[col.upper()] += len(t)
        if levels:
            numbered += 1
            lv = levels.get(ilvl, {})
            lvl_used[ilvl] += 1
            lvl_fmt.setdefault(ilvl, Counter())[(lv.get("fmt"), lv.get("text"), lv.get("left"), lv.get("hanging"))] += 1
        elif MANUAL.match(text): manual += 1
        else: plain += 1
        allbold = all(c[3] for c in chars if c[0].strip())
        allcaps = text.strip().isupper() or all(c[4] for c in chars if c[0].strip())
        allund = all(c[5] for c in chars if c[0].strip())
        if n >= 80:
            jc_chars[jc] += n
            lr = sp.get("lineRule", "auto")
            line[(sp.get("line"), lr)] += n
            after[round(int(sp["after"]) / 20, 1) if sp.get("after") else 0] += n
            before[round(int(sp["before"]) / 20, 1) if sp.get("before") else 0] += n
            if ind is not None:
                fl = ind.get(q("firstLine"))
                first_indent[twip_cm(fl) if fl else 0] += n
        else:
            # a short paragraph that is all bold, all caps or underlined reads as a heading
            stripped = MANUAL.sub("", text).strip()
            if 2 <= len(stripped) <= 70 and (allbold or allcaps or allund) and not stripped.endswith((".", ";", ",")):
                heading_n += 1
                heading_feats["bold"] += allbold; heading_feats["caps"] += allcaps; heading_feats["underline"] += allund
                heading_feats["numbered"] += bool(levels) or bool(MANUAL.match(text))
                heading_feats[f"jc:{jc}"] += 1
        # defined terms: bold inside the quotes?
        pos = 0; flags = []
        for c in chars: flags += [c[3]] * len(c[0])
        for m in DEF.finditer(text):
            defined_total += 1
            s, e = m.span(1)
            if flags[s:e] and all(flags[s:e]): defined_bold += 1
        curly += text.count("“") + text.count("”"); straight += text.count('"')
        paras.append({"t": text[:120], "jc": jc, "bold": allbold, "caps": allcaps, "und": allund,
                      "size": next((c[2] for c in chars if c[0].strip()), None), "num": bool(levels), "ilvl": ilvl})

    def top(c, k=3): return [(k_, round(v / max(1, sum(c.values())), 3)) for k_, v in c.most_common(k)]
    out.update({
        "fonts": top(fonts), "sizes": top(sizes), "justify": top(jc_chars), "line": top(line), "after_pt": top(after), "before_pt": top(before),
        "first_indent_cm": top(first_indent, 2),
        "colours": top(colours, 3), "colour_share": round(sum(colours.values()) / max(1, sum(fonts.values())), 3),
        "paras": len(paras), "numbered": numbered, "manual": manual, "plain": plain,
        "levels": {str(k): [list(x) + [v] for x, v in lvl_fmt[k].most_common(1)] for k in sorted(lvl_fmt)},
        "headings": heading_n, "heading_feats": dict(heading_feats),
        "defined": [defined_bold, defined_total], "quotes": [curly, straight],
        "styles": top(styles_used, 5),
        "title": paras[:6],
        "tables": len(body.findall(".//w:tbl", NS)),
        "toc": b"TOC \\" in z.read("word/document.xml") or b"w:docPartGallery w:val=\"Table of Contents\"" in z.read("word/document.xml"),
    })
    # headers and footers
    hf = {"header": [], "footer": []}
    for n_ in z.namelist():
        m = re.match(r"word/(header|footer)\d*\.xml$", n_)
        if not m: continue
        x = read(z, n_)
        txt = " ".join("".join(t.text or "" for t in p.iter(q("t"))) for p in x.iter(q("p"))).strip()
        raw = z.read(n_)
        page = b"PAGE" in raw
        jcs = [val(p.find("w:pPr", NS), "jc") for p in x.iter(q("p")) if "".join(t.text or "" for t in p.iter(q("t"))).strip() or b"PAGE" in etree.tostring(p)]
        hf[m.group(1)].append({"text": txt[:100], "page": page, "jc": jcs[:2]})
    out["hf"] = hf
    full = "\n".join(p["t"] for p in paras)
    alltext = " ".join("".join(t.text or "" for t in p.iter(q("t"))) for p in body.iter(q("p")))
    marks = {}
    for k, pat in {"this_agreement_made": r"THIS\s+[A-Z ]{0,40}(AGREEMENT|DEED)[^.]{0,40}\b(is\s+made|made|entered)", "between": r"\bBETWEEN\b", "by_and_between": r"by and between", "whereas": r"\bWHEREAS\b", "recitals": r"\bRECITALS\b", "background": r"\bBACKGROUND\b",
                   "now_therefore": r"NOW,?\s+THEREFORE", "now_this": r"NOW THIS (AGREEMENT|DEED)", "witness": r"IN WITNESS WHEREOF", "schedule": r"\bSCHEDULE\b|\bSchedule\s+\d", "annexure": r"\bANNEXURE\b|\bAnnexure\b",
                   "definitions": r"DEFINITIONS AND INTERPRETATION|Definitions and Interpretation|DEFINITIONS", "article": r"\bARTICLE\s+[0-9IVX]+", "resolved": r"\bRESOLVED\b", "dear": r"^\s*Dear\b", "subject_re": r"\b(Subject|Re|RE|SUBJECT)\s*:", "akla": r"Ali Khan Law Associates|\bAKLA\b"}.items():
        marks[k] = len(re.findall(pat, alltext, re.M))
    out["marks"] = marks
    out["chars"] = len(alltext)
    return out

if __name__ == "__main__":
    for line in sys.stdin:
        rec = json.loads(line)
        try: rec.update(measure(rec["path_local"]))
        except Exception as e: rec["error"] = f"{type(e).__name__}: {e}"
        print(json.dumps(rec, default=str))
