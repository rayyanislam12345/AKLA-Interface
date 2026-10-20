#!/usr/bin/env python3
"""Cut a drafting pack from a firm template base (drafting plan, Appendix G).

Run with `python3 -I`, passing paths as arguments. Never run it on the
OneDrive data room; run it on a local copy.

  build_pack.py list  <base.docx>                 paragraph listing (after
                                                  revisions are accepted) to
                                                  choose furniture, examples
                                                  and kinds from
  build_pack.py build <config.json> <pack-name>   cut one pack as the config
                                                  describes, write
                                                  <kind>-pack.docx, kinds.json
                                                  and report.json to out_dir

Two modes:
  FORM  (agreements, amendments, escrow, resolutions, consents, IE/IA,
        framework): accept revisions, remove comments, blank deal facts to
        [●] (config literals plus pattern detectors), every blanking listed.
  SHELL (letters, memos, opinions, proposals, minutes): accept revisions,
        remove comments, keep only the furniture blocks and one example of
        each paragraph kind (text replaced by [●]); delete the rest.

Edits are made on the XML. Parts that are not changed are written back
byte-for-byte (styles, numbering, theme, fontTable, settings and any header
or footer the pack does not need to change).

The config holds client facts (literal names to blank), so it lives with
the outputs, never in the repository.
"""
import copy
import json
import os
import re
import sys
import zipfile

from lxml import etree

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PR_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006"
NS = {"w": W_NS, "r": R_NS, "mc": MC_NS}
PH = "●"           # ●
BLANK = "[" + PH + "]"   # [●]
XML_DECL = b'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
PARSER = etree.XMLParser(remove_blank_text=False, resolve_entities=False, huge_tree=True, no_network=True)

A4_W, A4_H = 11906, 16838
PAPER = {(12240, 20160): "US Legal", (12240, 15840): "US Letter", (11906, 16838): "A4",
         (11907, 16839): "A4", (11909, 16834): "A4", (11905, 16837): "A4"}


def w(tag):
    return "{%s}%s" % (W_NS, tag)


def wa(el, name, default=None):
    return el.get(w(name), default) if el is not None else default


STORY = re.compile(r"^word/(document|header\d+|footer\d+|footnotes|endnotes)\.xml$")
REVISION_TAGS = ("ins", "del", "moveFrom", "moveTo", "rPrChange", "pPrChange", "sectPrChange",
                 "tblPrChange", "trPrChange", "tcPrChange", "tblGridChange", "tblPrExChange",
                 "numberingChange", "cellIns", "cellDel", "cellMerge",
                 "moveFromRangeStart", "moveFromRangeEnd", "moveToRangeStart", "moveToRangeEnd",
                 "customXmlInsRangeStart", "customXmlInsRangeEnd", "customXmlDelRangeStart",
                 "customXmlDelRangeEnd", "customXmlMoveFromRangeStart", "customXmlMoveFromRangeEnd",
                 "customXmlMoveToRangeStart", "customXmlMoveToRangeEnd")


# --------------------------------------------------------------------------
# package
# --------------------------------------------------------------------------
class Package:
    """A .docx held as its zip entries. Parts parsed with xml() and flagged
    with touch() are re-serialised on save; every other part is written back
    with its original bytes."""

    def __init__(self, src):
        with zipfile.ZipFile(src) as zf:
            self.infos = zf.infolist()
            self.data = {i.filename: zf.read(i.filename) for i in self.infos}
        self.trees = {}
        self.dirty = set()
        self.removed = set()
        self.notes = []

    def has(self, name):
        return name in self.data and name not in self.removed

    def xml(self, name):
        if name not in self.trees:
            self.trees[name] = etree.fromstring(self.data[name], PARSER)
        return self.trees[name]

    def touch(self, name):
        self.dirty.add(name)

    def remove(self, name):
        self.removed.add(name)

    def parts(self):
        return [i.filename for i in self.infos if i.filename not in self.removed]

    def serialise(self, name):
        if name in self.dirty:
            return XML_DECL + etree.tostring(self.trees[name], encoding="unicode").encode("utf-8")
        return self.data[name]

    def save(self, path):
        tmp = path + ".tmp"
        with zipfile.ZipFile(tmp, "w") as out:
            for info in self.infos:
                if info.filename in self.removed:
                    continue
                zi = zipfile.ZipInfo(info.filename, date_time=info.date_time)
                zi.compress_type = zipfile.ZIP_DEFLATED
                zi.external_attr = info.external_attr
                out.writestr(zi, self.serialise(info.filename))
        os.replace(tmp, path)

    # relationships ------------------------------------------------------
    @staticmethod
    def rels_name(part):
        d, f = os.path.split(part)
        return (d + "/" if d else "") + "_rels/" + f + ".rels"

    def rels(self, part):
        name = self.rels_name(part)
        return self.xml(name) if self.has(name) else None

    @staticmethod
    def resolve(part, target):
        if target.startswith("/"):
            return target[1:]
        base = os.path.dirname(part)
        return os.path.normpath(os.path.join(base, target)).replace("\\", "/")

    def related(self, part, type_suffix=None):
        """[(rId, type, target part)] of internal relationships of a part."""
        rels = self.rels(part)
        out = []
        if rels is None:
            return out
        for rel in rels:
            if rel.get("TargetMode") == "External":
                continue
            t = rel.get("Type", "")
            if type_suffix and not t.endswith("/" + type_suffix):
                continue
            out.append((rel.get("Id"), t, self.resolve(part, rel.get("Target"))))
        return out

    def main_part(self):
        root = self.xml("_rels/.rels")
        for rel in root:
            if rel.get("Type", "").endswith("/officeDocument"):
                return rel.get("Target").lstrip("/")
        return "word/document.xml"

    def drop_part(self, name):
        """Remove a part, its own relationships, its content-type override
        and every relationship that targets it."""
        if not self.has(name):
            return
        self.remove(name)
        rn = self.rels_name(name)
        if self.has(rn):
            self.remove(rn)
        ct = self.xml("[Content_Types].xml")
        for ov in list(ct):
            if ov.get("PartName") == "/" + name:
                ct.remove(ov)
                self.touch("[Content_Types].xml")
        for p in self.parts():
            if not p.endswith(".rels"):
                continue
            owner = p.replace("_rels/", "")[:-5]
            root = self.xml(p)
            for rel in list(root):
                if rel.get("TargetMode") == "External":
                    continue
                if self.resolve(owner, rel.get("Target")) == name:
                    root.remove(rel)
                    self.touch(p)


# --------------------------------------------------------------------------
# helpers on the tree
# --------------------------------------------------------------------------
def unwrap(el):
    parent = el.getparent()
    idx = parent.index(el)
    for i, ch in enumerate(list(el)):
        parent.insert(idx + i, ch)
    parent.remove(el)


def drop(el):
    parent = el.getparent()
    if parent is not None:
        parent.remove(el)


def owning_p(el):
    p = el.getparent()
    while p is not None and p.tag != w("p"):
        p = p.getparent()
    return p


def frag(el, remove=()):
    """An element as a verbatim XML string without namespace declarations."""
    if el is None:
        return ""
    el = copy.deepcopy(el)
    for tag in remove:
        for x in el.findall(w(tag)):
            el.remove(x)
    s = etree.tostring(el, encoding="unicode")
    return re.sub(r'\s+xmlns(?::\w+)?="[^"]*"', "", s)


def runs_of(p):
    """Runs belonging to a paragraph (not those of a nested text-box paragraph)."""
    return [r for r in p.iter(w("r")) if owning_p(r) is p]


def text_runs(p):
    return [r for r in runs_of(p) if r.find(w("t")) is not None]


def para_text(p):
    out = []
    for el in p.iter(w("t"), w("tab"), w("br"), w("cr"), w("noBreakHyphen")):
        if owning_p(el) is not p:
            continue
        if el.tag == w("t"):
            out.append(el.text or "")
        elif el.tag == w("noBreakHyphen"):
            out.append("-")
        elif el.tag == w("tab"):
            if el.getparent().tag == w("r"):
                out.append("\t")
        else:
            out.append("\n")
    return "".join(out)


def set_text(t, s):
    t.text = s
    if s != s.strip() or "  " in s:
        t.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")


def body_blocks(body):
    return [el for el in body if el.tag in (w("p"), w("tbl"), w("sdt"))]


def effective_numpr(p, styles):
    ppr = p.find(w("pPr"))
    if ppr is not None:
        np_ = ppr.find(w("numPr"))
        if np_ is not None:
            n, l = np_.find(w("numId")), np_.find(w("ilvl"))
            return (wa(n, "val"), wa(l, "val", "0") if l is not None else "0", "paragraph")
    sid = wa(ppr.find(w("pStyle")), "val") if ppr is not None else None
    seen = set()
    while sid and sid not in seen:
        seen.add(sid)
        st = styles.get(sid)
        if st is None:
            break
        np_ = st.find("w:pPr/w:numPr", NS)
        if np_ is not None:
            n, l = np_.find(w("numId")), np_.find(w("ilvl"))
            if n is not None:
                return (wa(n, "val"), wa(l, "val", "0") if l is not None else "0", "style " + sid)
        sid = wa(st.find(w("basedOn")), "val")
    return (None, None, None)


def style_map(pkg):
    if not pkg.has("word/styles.xml"):
        return {}
    root = pkg.xml("word/styles.xml")
    return {wa(s, "styleId"): s for s in root.findall(w("style"))}


def numbering_map(pkg):
    """numId -> {ilvl: (numFmt, lvlText)}"""
    if not pkg.has("word/numbering.xml"):
        return {}
    root = pkg.xml("word/numbering.xml")
    abstracts = {}
    for a in root.findall(w("abstractNum")):
        lv = {}
        for l in a.findall(w("lvl")):
            lv[wa(l, "ilvl")] = (wa(l.find(w("numFmt")), "val", ""), wa(l.find(w("lvlText")), "val", ""))
        abstracts[wa(a, "abstractNumId")] = lv
    out = {}
    for n in root.findall(w("num")):
        out[wa(n, "numId")] = abstracts.get(wa(n.find(w("abstractNumId")), "val"), {})
    return out


# --------------------------------------------------------------------------
# revisions and comments
# --------------------------------------------------------------------------
def accept_revisions(root):
    """Accept every tracked change in one story part. Returns counts."""
    c = {}

    def bump(k):
        c[k] = c.get(k, 0) + 1

    # row insert/delete marks
    for tr in list(root.iter(w("tr"))):
        trpr = tr.find(w("trPr"))
        if trpr is None:
            continue
        if trpr.find(w("del")) is not None:
            drop(tr)
            bump("deleted rows removed")
            continue
        for x in trpr.findall(w("ins")):
            trpr.remove(x)
            bump("inserted rows accepted")
    # paragraph marks: inserted -> drop the mark; deleted -> merge later
    merge = []
    for p in list(root.iter(w("p"))):
        rpr = p.find("w:pPr/w:rPr", NS)
        if rpr is None:
            continue
        for x in rpr.findall(w("ins")):
            rpr.remove(x)
            bump("inserted paragraph marks accepted")
        dels = rpr.findall(w("del"))
        if dels:
            for x in dels:
                rpr.remove(x)
            merge.append(p)
    for x in list(root.iter(w("moveFrom"), w("del"))):
        if x.getparent() is not None and x.getparent().tag in (w("rPr"), w("trPr")):
            continue
        drop(x)
        bump("deletions accepted")
    for x in list(root.iter(w("ins"), w("moveTo"))):
        if x.getparent() is not None and x.getparent().tag in (w("rPr"), w("trPr")):
            continue
        unwrap(x)
        bump("insertions accepted")
    for tag in ("rPrChange", "pPrChange", "sectPrChange", "tblPrChange", "trPrChange", "tcPrChange",
                "tblGridChange", "tblPrExChange", "numberingChange"):
        for x in list(root.iter(w(tag))):
            drop(x)
            bump("format changes accepted")
    for tag in ("moveFromRangeStart", "moveFromRangeEnd", "moveToRangeStart", "moveToRangeEnd",
                "customXmlInsRangeStart", "customXmlInsRangeEnd", "customXmlDelRangeStart",
                "customXmlDelRangeEnd", "customXmlMoveFromRangeStart", "customXmlMoveFromRangeEnd",
                "customXmlMoveToRangeStart", "customXmlMoveToRangeEnd", "cellIns"):
        for x in list(root.iter(w(tag))):
            drop(x)
    for x in list(root.iter(w("cellDel"))):
        tc = x.getparent().getparent() if x.getparent() is not None else None
        drop(x)
        bump("cell deletions left for review")
    # merge paragraphs whose mark was deleted into the paragraph after them
    for p in merge:
        if p.getparent() is None:
            continue
        ppr = p.find(w("pPr"))
        if ppr is not None and ppr.find(w("sectPr")) is not None:
            continue
        nxt = p.getnext()
        while nxt is not None and nxt.tag != w("p"):
            if nxt.tag in (w("tbl"), w("sdt")):
                nxt = None
                break
            nxt = nxt.getnext()
        content = [ch for ch in p if ch.tag != w("pPr")]
        if nxt is None:
            continue
        nppr = nxt.find(w("pPr"))
        at = 1 if nppr is not None else 0
        for i, ch in enumerate(content):
            nxt.insert(at + i, ch)
        drop(p)
        bump("deleted paragraph marks merged")
    return c


def remove_comments(pkg):
    n = 0
    for part in [p for p in pkg.parts() if STORY.match(p)]:
        root = pkg.xml(part)
        changed = False
        for x in list(root.iter(w("commentRangeStart"), w("commentRangeEnd"))):
            drop(x)
            changed = True
        for ref in list(root.iter(w("commentReference"))):
            r = ref.getparent()
            drop(ref)
            n += 1
            changed = True
            if r is not None and r.tag == w("r") and all(ch.tag == w("rPr") for ch in r):
                drop(r)
        if changed:
            pkg.touch(part)
    dropped = []
    for p in pkg.parts():
        if re.match(r"^word/comments\w*\.xml$", p) or p == "word/people.xml":
            dropped.append(p)
    for p in dropped:
        pkg.drop_part(p)
    return n, dropped


def count_revisions(pkg):
    out = {}
    for part in pkg.parts():
        if not part.endswith(".xml") or not part.startswith("word/"):
            continue
        root = pkg.xml(part)
        n = {}
        for tag in REVISION_TAGS:
            k = sum(1 for _ in root.iter(w(tag)))
            if k:
                n[tag] = k
        if n:
            out[part] = n
    return out


# --------------------------------------------------------------------------
# blanking deal facts
# --------------------------------------------------------------------------
MONTH = r"(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?"
NUMW = (r"(?:(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|"
        r"fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|"
        r"ninety|hundred|thousand|million|billion|lac|lakh|crore|and|point)[\s-]*)+")
CURRENCY = r"(?:PKR|Pak\s*Rs\.?|Rs\.?|USD|US\$|U\.S\.\s*\$|\$|EUR|€|GBP|£|AED|SAR)"
DETECTORS = [
    ("CNIC number", re.compile(r"\b\d{5}-\d{7}-\d\b")),
    ("NTN / registration number", re.compile(r"\b\d{7}-\d\b")),
    ("IBAN", re.compile(r"\bPK\d{2}\s?[A-Z]{4}(?:\s?\d){16}\b")),
    ("email address", re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")),
    ("web address", re.compile(r"\b(?:https?://|www\.)\S+")),
    ("date", re.compile(r"\b\d{1,2}(?:st|nd|rd|th)?\s+(?:day\s+of\s+)?" + MONTH + r",?\s+\d{4}\b")),
    ("date", re.compile(r"\b" + MONTH + r"\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}\b")),
    ("date", re.compile(r"\b(?:" + MONTH + r")\s+\d{4}\b")),
    ("date", re.compile(r"\b\d{1,2}[./-]\d{1,2}[./-](?:19|20)\d{2}\b")),
    ("amount", re.compile(CURRENCY + r"\s?\d[\d,]*(?:\.\d+)?(?:/-)?(?:\s*(?:million|billion|mn|bn|m)\b)?", re.I)),
    ("amount in words", re.compile(r"\((?:Pak(?:istani)?\s+)?(?:Rupees|US\s+Dollars|United\s+States\s+Dollars|Dollars|Euros?)\s+[^)]{2,200}\)", re.I)),
    ("amount in words", re.compile(r"\b(?:Pak(?:istani)?\s+)?Rupees\s+" + NUMW + r"(?:only|Only)?", re.I)),
    ("percentage", re.compile(r"\b" + NUMW + r"\s*(?:per\s?cent|percent)?\s*\(\s*\d+(?:\.\d+)?\s*(?:%|per\s?cent|percent)\s*\)", re.I)),
    ("percentage", re.compile(r"\b\d+(?:\.\d+)?\s?(?:%|per\s?cent\b|percent\b)", re.I)),
    ("percentage", re.compile(r"\b" + NUMW + r"\s*\(\s*\d+(?:\.\d+)?\s*\)\s*(?:per\s?cent|percent)\b", re.I)),
    ("figure", re.compile(r"(?<![\w.])\d{1,3}(?:,\d{3})+(?:\.\d+)?(?![\w])")),
    ("figure", re.compile(r"(?<![\w.])\d{5,}(?![\w])")),
    ("person name", re.compile(r"\b(?:Mr|Mrs|Ms|Dr|Engr|Mian|Begum)\.?\s+(?:[A-Z][A-Za-z'.-]*\.?\s?){1,5}")),
    ("company name", re.compile(r"\b(?!(?:The|This|That|Such|Each|Any|Every|Other|Said|Relevant|A|An)\b)(?:[A-Z][\w&'.-]*\s+){1,7}"
                                r"(?:\((?:Private|Pvt\.?)\)\s+)?(?:Limited|Ltd\.?|LLC|Inc\.?|PLC|LLP)(?![\w])")),
]
LABELS = re.compile(r"^(\s*(?:Name|Designation|Title|Address|Attention|Attn|Email|E-mail|Tel(?:ephone)?|Phone|Fax|"
                    r"Mobile|Cell|CNIC(?: No\.?)?|NTN|Contact(?: Person)?|Witness|Place|Date|Dated|Ref(?:erence)?|"
                    r"Our Ref|Your Ref|Registration No\.?)\s*(?:No\.)?\s*[:\t]\s*)(\S.*)$", re.I)
TIME_PERIOD = re.compile(r"\b" + NUMW + r"\s*\(\d+\)\s*(?:Business\s+|calendar\s+|working\s+)?(?:Days?|days?|weeks?|months?|years?|hours?)", re.I)
ADDRESS = re.compile(r"(?:registered\s+office|principal\s+office|head\s+office|principal\s+place\s+of\s+business|offices?|address|residing|resident)"
                     r"\s+(?:is\s+)?(?:situated\s+|located\s+)?at\s+([^;()]+?)(?=\s*\(|;|,\s*(?:through|represented|acting|hereinafter|and\s+includes)|\s+and\s+having\b|\s+for\s+and\s+on\s+behalf\b|\.\s*$|$)", re.I)


NAME_STOP = {"To", "Be", "Printed", "On", "For", "And", "Of", "Behalf", "By", "Between", "The", "This", "With", "In", "At",
             "From", "As", "Under", "Through", "Its", "Their", "Dear", "Name", "Copy", "Is", "Was", "Our", "Your", "Subject",
             "Ref", "Dated", "Re", "Attention", "Signed", "Executed", "Witness", "Whereas", "Now", "Therefore", "Messrs", "M/s",
             "Letterhead", "Party", "Parties", "Among", "Amongst", "Agreement", "Executed", "Sealed", "Delivered"}


class Blanker:
    """Finds deal facts in paragraph text and replaces them with [●]."""

    def __init__(self, literals=(), keep=(), detectors=True, labels=True, addresses=True):
        lits = []
        self.regexes = []
        for l in literals:
            if isinstance(l, str):
                l = {"text": l, "reason": "named in the config"}
            if "regex" in l:
                self.regexes.append((re.compile(l["regex"], re.I if l.get("ci") else 0), l["reason"]))
                continue
            lits.append(l)
            if l["text"].upper() != l["text"] and not l.get("exact"):
                lits.append({"text": l["text"].upper(), "reason": l["reason"]})
        self.literals = sorted(lits, key=lambda x: -len(x["text"]))
        self.keep = [k for k in keep]
        self.detectors = detectors
        self.labels = labels
        self.addresses = addresses
        self.log = []          # (part, where, original, reason)
        self.kept = []         # time periods kept, for the owner

    def spans(self, text):
        found = []
        for l in self.literals:
            start = 0
            while True:
                i = text.find(l["text"], start)
                if i < 0:
                    break
                found.append((i, i + len(l["text"]), l["reason"]))
                start = i + len(l["text"])
        for rx, reason in self.regexes:
            for m in rx.finditer(text):
                if m.end() > m.start():
                    found.append((m.start(), m.end(), reason))
        if self.labels:
            for line_start, line in _lines(text):
                m = LABELS.match(line)
                if m and not _is_blank(m.group(2)):
                    s = line_start + m.start(2)
                    found.append((s, line_start + len(line.rstrip()), "value after '" + m.group(1).strip(" :\t") + "' label"))
        if self.addresses:
            for m in ADDRESS.finditer(text):
                if "\n" in m.group(1) or "\t" in m.group(1) or _is_blank(m.group(1)) or len(m.group(1)) < 6:
                    continue
                found.append((m.start(1), m.end(1), "address"))
        if self.detectors:
            for reason, rx in DETECTORS:
                for m in rx.finditer(text):
                    if "\n" in m.group(0) or "\t" in m.group(0):
                        continue
                    st = m.start()
                    if reason == "company name":
                        # drop capitalised lead-in words ("To Be Printed On X Limited")
                        while True:
                            mm = re.match(r"([A-Z][\w&'.-]*)\s+", text[st:m.end()])
                            if not mm or mm.group(1) not in NAME_STOP:
                                break
                            st += mm.end()
                        if not re.search(r"\s", text[st:m.end()]):
                            continue
                    found.append((st, m.end(), reason))
        for m in TIME_PERIOD.finditer(text):
            self.kept.append(m.group(0))
        # keep-list wins
        keep_spans = []
        for k in self.keep:
            start = 0
            while True:
                i = text.find(k, start)
                if i < 0:
                    break
                keep_spans.append((i, i + len(k)))
                start = i + len(k)
        found = [f for f in found if not any(a <= f[0] and f[1] <= b for a, b in keep_spans)]
        found = [f for f in found if text[f[0]:f[1]].strip() and text[f[0]:f[1]].strip() != BLANK]
        # merge overlaps, keep the earliest-listed reason of the widest span
        found.sort(key=lambda f: (f[0], -(f[1] - f[0])))
        merged = []
        for s, e, r in found:
            if merged and s < merged[-1][1]:
                ps, pe, pr = merged[-1]
                merged[-1] = (ps, max(pe, e), pr)
            else:
                merged.append((s, e, r))
        # trim whitespace/punctuation at the edges
        out = []
        for s, e, r in merged:
            while s < e and text[s] in " ,;":
                s += 1
            while e > s and text[e - 1] in " ,;:":
                e -= 1
            if e > s:
                out.append((s, e, r))
        return out

    def blank_paragraph(self, p, where):
        segs = []
        for el in p.iter(w("t"), w("tab"), w("br"), w("cr"), w("noBreakHyphen")):
            if owning_p(el) is not p:
                continue
            if el.tag == w("t"):
                segs.append([el, el.text or ""])
            elif el.tag == w("tab") and el.getparent().tag != w("r"):
                continue
            else:
                segs.append([None, "\n" if el.tag != w("tab") else "\t"])
        text = "".join(s[1] for s in segs)
        if not text.strip():
            return 0
        spans = self.spans(text)
        if not spans:
            return 0
        bounds = []
        pos = 0
        for s in segs:
            bounds.append((pos, pos + len(s[1])))
            pos += len(s[1])
        for s, e, reason in reversed(spans):
            self.log.append((where[0], where[1], text[s:e], reason))
            first = True
            for i, (a, b) in enumerate(bounds):
                if b <= s or a >= e or segs[i][0] is None:
                    continue
                t = segs[i][1]
                ls, le = max(s, a) - a, min(e, b) - a
                if first:
                    t = t[:ls] + BLANK + t[le:]
                    first = False
                else:
                    t = t[:ls] + t[le:]
                segs[i][1] = t
        for el, t in segs:
            if el is not None and (el.text or "") != t:
                set_text(el, t)
        return len(spans)


def _lines(text):
    pos = 0
    for line in text.split("\n"):
        yield pos, line
        pos += len(line) + 1


def _is_blank(s):
    s = s.strip()
    return not s or s == BLANK or bool(re.fullmatch(r"[_.\-\s\[\]●…]+", s))


# --------------------------------------------------------------------------
# page set-up, letterhead, notes, orphans
# --------------------------------------------------------------------------
def to_a4(root):
    changes = []
    for i, sp in enumerate(root.iter(w("sectPr"))):
        sz = sp.find(w("pgSz"))
        if sz is None:
            continue
        ww, hh = int(wa(sz, "w", "0")), int(wa(sz, "h", "0"))
        land = wa(sz, "orient") == "landscape" or ww > hh
        key = (min(ww, hh), max(ww, hh))
        name = PAPER.get(key, "%sx%s" % key)
        if name == "A4" and not land:
            continue
        sz.set(w("w"), str(A4_W))
        sz.set(w("h"), str(A4_H))
        if sz.get(w("orient")) is not None:
            del sz.attrib[w("orient")]
        if sz.get(w("code")) is not None:
            sz.set(w("code"), "9")
        mar = sp.find(w("pgMar"))
        if land and mar is not None:
            # landscape -> portrait: the margins turn with the page
            t, r, b, l = (wa(mar, k) for k in ("top", "right", "bottom", "left"))
            mar.set(w("top"), l); mar.set(w("right"), t); mar.set(w("bottom"), r); mar.set(w("left"), b)
        changes.append("section %d: %s%s -> A4 portrait (margins kept%s)" % (i + 1, name, " landscape" if land else "",
                                                                           ", turned with the page" if land else ""))
    return changes


def section_report(root):
    out = []
    for i, sp in enumerate(root.iter(w("sectPr"))):
        sz, mar = sp.find(w("pgSz")), sp.find(w("pgMar"))
        ww, hh = int(wa(sz, "w", "0")), int(wa(sz, "h", "0"))
        refs = ["%s %s" % (r.tag.split("}")[1].replace("Reference", ""), wa(r, "type")) for r in sp if r.tag in (w("headerReference"), w("footerReference"))]
        out.append({
            "section": i + 1,
            "page": PAPER.get((min(ww, hh), max(ww, hh)), "%sx%s twips" % (ww, hh)),
            "orientation": "landscape" if ww > hh else "portrait",
            "size_twips": [ww, hh],
            "margins_twips": {k: wa(mar, k) for k in ("top", "right", "bottom", "left", "header", "footer")} if mar is not None else None,
            "title_page": sp.find(w("titlePg")) is not None,
            "headers_footers": refs,
            "columns": wa(sp.find(w("cols")), "num", "1"),
        })
    return out


def letterhead_line(pkg, doc_part, line, rpr=None):
    """Letters: the header that shows on page 1 carries only `line`; every
    other header and every footer is emptied."""
    root = pkg.xml(doc_part)
    rid_part = {rid: tgt for rid, _, tgt in pkg.related(doc_part)}
    sects = list(root.iter(w("sectPr")))
    first = sects[0] if sects else None
    first_hdr = None
    if first is not None:
        refs = {wa(r, "type", "default"): r.get("{%s}id" % R_NS) for r in first.findall(w("headerReference"))}
        if first.find(w("titlePg")) is not None and "first" in refs:
            first_hdr = rid_part.get(refs["first"])
        else:
            first_hdr = rid_part.get(refs.get("default"))
    done = []
    for rid, typ, part in pkg.related(doc_part):
        if not (typ.endswith("/header") or typ.endswith("/footer")):
            continue
        hroot = pkg.xml(part)
        paras = [ch for ch in hroot if ch.tag == w("p")]
        keep = paras[0] if paras else etree.SubElement(hroot, w("p"))
        for ch in list(hroot):
            if ch is not keep:
                hroot.remove(ch)
        ppr = keep.find(w("pPr"))
        for ch in list(keep):
            if ch is not ppr:
                keep.remove(ch)
        if ppr is not None:
            for x in list(ppr):
                if x.tag not in (w("pStyle"), w("jc")):
                    ppr.remove(x)
            if ppr.find(w("jc")) is None:
                pass
        if part == first_hdr:
            r = etree.SubElement(keep, w("r"))
            if rpr is not None:
                r.append(copy.deepcopy(rpr))
            t = etree.SubElement(r, w("t"))
            set_text(t, line)
            done.append("%s: only the line %s" % (part, line))
        else:
            done.append("%s: emptied" % part)
        pkg.touch(part)
        prune_part_rels(pkg, part)
    return done


def used_rids(root):
    ids = set()
    for el in root.iter():
        for k, v in el.attrib.items():
            if k.startswith("{%s}" % R_NS):
                ids.add(v)
    return ids


PRUNABLE = ("/image", "/oleObject", "/package", "/chart", "/diagramData", "/diagramLayout",
            "/diagramQuickStyle", "/diagramColors", "/hyperlink", "/footnotes_unused")


def prune_part_rels(pkg, part):
    """Drop relationships of a part that its XML no longer uses (images,
    embedded objects, charts, links), and the target parts nothing else uses."""
    rels = pkg.rels(part)
    if rels is None:
        return []
    used = used_rids(pkg.xml(part))
    gone = []
    for rel in list(rels):
        t = rel.get("Type", "")
        if rel.get("Id") in used or not any(t.endswith(s) for s in PRUNABLE):
            continue
        rels.remove(rel)
        pkg.touch(pkg.rels_name(part))
        if rel.get("TargetMode") != "External":
            tgt = pkg.resolve(part, rel.get("Target"))
            gone.append(tgt)
    for tgt in gone:
        still = False
        for p in pkg.parts():
            if p.endswith(".rels"):
                owner = p.replace("_rels/", "")[:-5]
                for r in pkg.xml(p):
                    if r.get("TargetMode") != "External" and pkg.resolve(owner, r.get("Target")) == tgt:
                        still = True
        if not still and pkg.has(tgt):
            pkg.drop_part(tgt)
    return gone


def prune_notes(pkg, doc_part, keep_part_refs=True):
    """Remove footnotes/endnotes no longer referenced from the body."""
    removed = {}
    root = pkg.xml(doc_part)
    for kind in ("footnote", "endnote"):
        part = "word/%ss.xml" % kind
        if not pkg.has(part):
            continue
        refs = {wa(x, "id") for x in root.iter(w(kind + "Reference"))}
        for hp in [p for p in pkg.parts() if re.match(r"^word/(header|footer)\d+\.xml$", p)]:
            refs |= {wa(x, "id") for x in pkg.xml(hp).iter(w(kind + "Reference"))}
        nroot = pkg.xml(part)
        n = 0
        for note in list(nroot.findall(w(kind))):
            if wa(note, "type") in ("separator", "continuationSeparator", "continuationNotice"):
                continue
            if wa(note, "id") not in refs:
                nroot.remove(note)
                n += 1
        if n:
            pkg.touch(part)
            prune_part_rels(pkg, part)
        removed[kind] = n
    return removed


def fix_orphans(root):
    """Remove bookmark/permission ends without starts and vice versa."""
    n = 0
    for s_tag, e_tag in (("bookmarkStart", "bookmarkEnd"), ("permStart", "permEnd")):
        starts = {wa(x, "id"): x for x in root.iter(w(s_tag))}
        ends = {wa(x, "id"): x for x in root.iter(w(e_tag))}
        for i, x in starts.items():
            if i not in ends:
                drop(x); n += 1
        for i, x in ends.items():
            if i not in starts:
                drop(x); n += 1
    return n


def field_balance(root):
    depth = 0
    bad = 0
    for x in root.iter(w("fldChar")):
        t = wa(x, "fldCharType")
        if t == "begin":
            depth += 1
        elif t == "end":
            depth -= 1
            if depth < 0:
                bad += 1
                depth = 0
    return depth + bad


# --------------------------------------------------------------------------
# reports
# --------------------------------------------------------------------------
def shapes_report(pkg):
    out = []
    for part in [p for p in pkg.parts() if STORY.match(p)]:
        root = pkg.xml(part)
        for el in root.iter("{%s}AlternateContent" % MC_NS, w("pict"), w("object"), "{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}inline",
                            "{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}anchor"):
            # report the outermost only
            anc = el.getparent()
            nested = False
            while anc is not None:
                if anc.tag in ("{%s}AlternateContent" % MC_NS, w("pict"), w("object"), "{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}inline",
                               "{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}anchor"):
                    nested = True
                    break
                anc = anc.getparent()
            if nested:
                continue
            txbx = [t for t in el.iter(w("txbxContent"))]
            text = ""
            if txbx:
                text = " / ".join(para_text(p) for p in txbx[0].iter(w("p")) if para_text(p).strip())
            pic = any(True for _ in el.iter("{http://schemas.openxmlformats.org/drawingml/2006/picture}pic")) or any(True for _ in el.iter("{urn:schemas-microsoft-com:vml}imagedata"))
            p = owning_p(el)
            out.append({"part": part, "kind": el.tag.split("}")[1], "text_box": bool(txbx), "picture": pic,
                        "text": text[:200], "paragraph_text": (para_text(p)[:80] if p is not None else ""),
                        "must_fill": bool(txbx) and part == "word/document.xml" and bool(text.strip())})
    return out


def toc_report(root):
    out = []
    for x in root.iter(w("instrText")):
        if re.match(r"\s*TOC\b", x.text or ""):
            out.append((x.text or "").strip())
    for x in root.iter(w("fldSimple")):
        if re.match(r"\s*TOC\b", wa(x, "instr", "")):
            out.append(wa(x, "instr").strip())
    return out


def listing(pkg):
    doc = pkg.main_part()
    root = pkg.xml(doc)
    body = root.find(w("body"))
    styles = style_map(pkg)
    nums = numbering_map(pkg)
    lines = []
    for i, b in enumerate(body_blocks(body)):
        if b.tag == w("tbl"):
            rows = b.findall(w("tr"))
            cols = len(rows[0].findall(w("tc"))) if rows else 0
            lines.append("%4d TABLE %dx%d style=%s | %s" % (i, len(rows), cols, wa(b.find("w:tblPr/w:tblStyle", NS), "val"),
                                                           " | ".join(para_text(p)[:30] for p in (rows[0].iter(w("p")) if rows else []))[:150]))
            for ri, tr in enumerate(rows[:60]):
                for ci, tc in enumerate(tr.findall(w("tc"))):
                    for pi, p in enumerate(tc.findall(w("p"))):
                        t = para_text(p)
                        if t.strip():
                            lines.append("       %d/%d/%d/%d %s" % (i, ri, ci, pi, _describe(p, styles, nums, t)))
            continue
        if b.tag == w("sdt"):
            ps = list(b.iter(w("p")))
            gal = wa(b.find(".//w:docPartGallery", NS), "val")
            lines.append("%4d SDT %s (%d paragraphs) %s" % (i, gal or "", len(ps), (para_text(ps[0])[:80] if ps else "")))
            continue
        lines.append("%4d %s" % (i, _describe(b, styles, nums, para_text(b))))
    return "\n".join(lines)


def _describe(p, styles, nums, text):
    ppr = p.find(w("pPr"))
    sid = wa(ppr.find(w("pStyle")), "val") if ppr is not None else None
    nid, lvl, src = effective_numpr(p, styles)
    fmt = ""
    if nid and nid != "0":
        f = nums.get(nid, {}).get(lvl)
        fmt = " num=%s/%s%s %s" % (nid, lvl, "(style)" if src and src.startswith("style") else "", ("%s '%s'" % f) if f else "?")
    ind = ppr.find(w("ind")) if ppr is not None else None
    ind_s = ""
    if ind is not None:
        ind_s = " ind=%s/%s%s" % (wa(ind, "left", wa(ind, "start", "")), "h" + wa(ind, "hanging") if wa(ind, "hanging") else "", "f" + wa(ind, "firstLine") if wa(ind, "firstLine") else "")
    jc = wa(ppr.find(w("jc")), "val") if ppr is not None else None
    tr = text_runs(p)
    rpr = tr[0].find(w("rPr")) if tr else None
    b = rpr is not None and rpr.find(w("b")) is not None and wa(rpr.find(w("b")), "val", "1") not in ("0", "false")
    u = rpr is not None and rpr.find(w("u")) is not None
    caps = rpr is not None and rpr.find(w("caps")) is not None
    flags = []
    if ppr is not None and ppr.find(w("sectPr")) is not None:
        flags.append("SECT")
    if any(True for _ in p.iter(w("footnoteReference"))):
        flags.append("FN")
    if any(True for _ in p.iter(w("txbxContent"))) or any(True for _ in p.iter("{%s}AlternateContent" % MC_NS)):
        flags.append("SHAPE")
    if any(True for _ in p.iter(w("drawing"))):
        flags.append("DRAWING")
    if any(re.match(r"\s*TOC", x.text or "") for x in p.iter(w("instrText"))):
        flags.append("TOC")
    return "[%s%s%s%s%s%s%s] %s %s" % (sid or "-", fmt, ind_s, " jc=" + jc if jc else "", " B" if b else "", " U" if u else "",
                                      " CAPS" if caps else "", " ".join(flags), text.replace("\t", "→").replace("\n", "↵")[:110])


# --------------------------------------------------------------------------
# selectors and kinds
# --------------------------------------------------------------------------
def select(body, sel):
    """'12' -> 12th top-level block; '12/1/0/0' -> block 12 (table), row 1,
    cell 0, paragraph 0; 'fn:3' -> footnote id 3 (first paragraph)."""
    parts = str(sel).split("/")
    blocks = body_blocks(body)
    el = blocks[int(parts[0])]
    if len(parts) == 1:
        return el
    r, c, p = (int(x) for x in parts[1:4])
    tr = el.findall(w("tr"))[r]
    tc = tr.findall(w("tc"))[c]
    return tc.findall(w("p"))[p]


def kind_of(p, styles, label):
    ppr = p.find(w("pPr"))
    tr = text_runs(p)
    rpr = tr[0].find(w("rPr")) if tr else None
    if rpr is None and ppr is not None and not tr:
        rpr = ppr.find(w("rPr"))
    nid, lvl, _ = effective_numpr(p, styles)
    return {
        "pPr": frag(ppr, remove=("sectPr", "pPrChange")) if ppr is not None else "",
        "rPr": frag(rpr, remove=("rPrChange",)) if rpr is not None else "",
        "styleId": wa(ppr.find(w("pStyle")), "val") if ppr is not None and ppr.find(w("pStyle")) is not None else None,
        "numId": int(nid) if nid is not None and nid.isdigit() else None,
        "ilvl": int(lvl) if nid is not None and lvl is not None and lvl.isdigit() else None,
        "label": label,
    }


def table_kind(tbl, styles, label):
    rows = tbl.findall(w("tr"))

    def row(tr):
        if tr is None:
            return {"trPr": "", "tcPr": "", "pPr": "", "rPr": ""}
        tc = tr.find(w("tc"))
        p = tc.find(w("p")) if tc is not None else None
        k = kind_of(p, styles, "") if p is not None else {"pPr": "", "rPr": ""}
        return {"trPr": frag(tr.find(w("trPr")), remove=("trPrChange",)), "tcPr": frag(tc.find(w("tcPr")), remove=("tcPrChange",)) if tc is not None else "",
                "pPr": k["pPr"], "rPr": k["rPr"]}
    return {
        "tblPr": frag(tbl.find(w("tblPr")), remove=("tblPrChange",)),
        "tblGrid": frag(tbl.find(w("tblGrid")), remove=("tblGridChange",)) if tbl.find(w("tblGrid")) is not None else None,
        "header": row(rows[0] if rows else None),
        "body": row(rows[1] if len(rows) > 1 else (rows[0] if rows else None)),
        "label": label,
    }


def footnote_kind(pkg, doc_part, ref_el):
    """ref_el: a body w:footnoteReference."""
    if ref_el is None or not pkg.has("word/footnotes.xml"):
        return None
    fid = wa(ref_el, "id")
    note = None
    for n in pkg.xml("word/footnotes.xml").findall(w("footnote")):
        if wa(n, "id") == fid:
            note = n
    if note is None:
        return None
    p = note.find(w("p"))
    ppr = p.find(w("pPr")) if p is not None else None
    tr = [r for r in text_runs(p) if r.find(w("footnoteRef")) is None] if p is not None else []
    rpr = tr[0].find(w("rPr")) if tr else None
    ref_run = ref_el.getparent()
    return {"pPr": frag(ppr, remove=("pPrChange", "sectPr")) if ppr is not None else "",
            "rPr": frag(rpr, remove=("rPrChange",)) if rpr is not None else "",
            "refRPr": frag(ref_run.find(w("rPr")), remove=("rPrChange",)) if ref_run is not None and ref_run.find(w("rPr")) is not None else ""}


# --------------------------------------------------------------------------
# shell stripping
# --------------------------------------------------------------------------
def example_paragraph(p, text=BLANK, keep_footnote=False):
    """Reduce a paragraph to its pPr and one run (the first text run's look)
    reading `text`; optionally keep its first footnote reference run."""
    tr = text_runs(p)
    ppr = p.find(w("pPr"))
    fn_run = None
    if keep_footnote:
        for r in runs_of(p):
            if r.find(w("footnoteReference")) is not None:
                fn_run = r
                break
    if tr:
        run = tr[0]
        for ch in list(run):
            if ch.tag != w("rPr"):
                run.remove(ch)
    else:
        run = etree.Element(w("r"))
    t = etree.SubElement(run, w("t"))
    set_text(t, text)
    for ch in list(p):
        if ch is not ppr:
            p.remove(ch)
    p.append(run)
    if fn_run is not None:
        p.append(fn_run)
    return fn_run


def blank_note(pkg, fid):
    part = "word/footnotes.xml"
    for n in pkg.xml(part).findall(w("footnote")):
        if wa(n, "id") != fid:
            continue
        ps = n.findall(w("p"))
        for extra in ps[1:]:
            n.remove(extra)
        p = ps[0]
        ref = None
        for r in runs_of(p):
            if r.find(w("footnoteRef")) is not None:
                ref = r
                break
        tr = [r for r in text_runs(p) if r is not ref]
        ppr = p.find(w("pPr"))
        sep = None
        for r in runs_of(p):   # the space/tab run after the mark
            if r is not ref and r.find(w("tab")) is not None and r.find(w("t")) is None:
                sep = r
                break
        run = tr[0] if tr else etree.Element(w("r"))
        for ch in list(run):
            if ch.tag != w("rPr"):
                run.remove(ch)
        t = etree.SubElement(run, w("t"))
        set_text(t, (" " if sep is None and tr and (tr[0].findtext(w("t")) or "").startswith(" ") else "") + BLANK)
        for ch in list(p):
            if ch not in (ppr, ref, sep):
                p.remove(ch)
        p.append(run)
        pkg.touch(part)


def strip_table_to_example(tbl, keep_rows=2, keep_footnote=False, first_text=BLANK, log=None):
    """Keep the first `keep_rows` rows; every cell keeps one paragraph whose
    text becomes [●] (empty cells stay empty); the very first cell's text
    becomes `first_text`."""
    rows = tbl.findall(w("tr"))
    for tr in rows[keep_rows:]:
        tbl.remove(tr)
    first = True
    for tr in tbl.findall(w("tr")):
        for tc in tr.findall(w("tc")):
            paras = tc.findall(w("p"))
            had_text = any(para_text(p).strip() for p in paras)
            if log and had_text:
                log(" / ".join(para_text(p) for p in paras if para_text(p).strip()))
            for ch in list(tc):
                if ch.tag in (w("tbl"),) or (ch.tag == w("p") and ch is not paras[0]):
                    tc.remove(ch)
            if not paras:
                continue
            if first:
                example_paragraph(paras[0], first_text, keep_footnote=keep_footnote)
                first = False
            elif had_text:
                example_paragraph(paras[0])
            else:
                ppr = paras[0].find(w("pPr"))
                for ch in list(paras[0]):
                    if ch is not ppr:
                        paras[0].remove(ch)


def toc_reduce(block):
    """Keep a contents field but drop its cached entries (they list the old
    document's headings). Leaves: [title paragraph(s)], one paragraph with
    begin/instr/separate + a [●] entry + end."""
    paras = list(block.iter(w("p")))
    begin_p = None
    for p in paras:
        if any(re.match(r"\s*TOC", x.text or "") for x in p.iter(w("instrText"))):
            begin_p = p
            break
    if begin_p is None:
        return "no TOC field found"
    # rebuild the begin paragraph: runs up to and including 'separate', a [●], an end
    new_children = []
    sep_seen = False
    entry_rpr = None
    for ch in list(begin_p):
        if ch.tag == w("pPr"):
            continue
        if not sep_seen:
            new_children.append(ch)
            if any(wa(f, "fldCharType") == "separate" for f in ch.iter(w("fldChar"))):
                sep_seen = True
        elif entry_rpr is None:
            r = ch if ch.tag == w("r") else next(iter(ch.iter(w("r"))), None)
            if r is not None and r.find(w("rPr")) is not None:
                entry_rpr = copy.deepcopy(r.find(w("rPr")))
    for ch in list(begin_p):
        if ch.tag != w("pPr") and ch not in new_children:
            begin_p.remove(ch)
    r = etree.SubElement(begin_p, w("r"))
    if entry_rpr is not None:
        r.append(entry_rpr)
    set_text(etree.SubElement(r, w("t")), BLANK)
    r2 = etree.SubElement(begin_p, w("r"))
    fc = etree.SubElement(r2, w("fldChar"))
    fc.set(w("fldCharType"), "end")
    # drop every later paragraph of the field (entries and the one with 'end')
    after = False
    for p in paras:
        if p is begin_p:
            after = True
            continue
        if after:
            drop(p)
    return "contents field kept; its old entries removed (update the field in Word to rebuild it)"


# --------------------------------------------------------------------------
# the build
# --------------------------------------------------------------------------
def prepare(pkg):
    """Accept revisions everywhere and remove comments."""
    acc = {}
    for part in [p for p in pkg.parts() if STORY.match(p)]:
        root = pkg.xml(part)
        c = accept_revisions(root)
        if c:
            pkg.touch(part)
            acc[part] = c
    ncom, dropped = remove_comments(pkg)
    return acc, ncom, dropped


def build(cfg, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    pkg = Package(cfg["base"])
    report = {"name": cfg["name"], "mode": cfg["mode"], "base": os.path.basename(cfg["base"])}
    report["revisions_before"] = count_revisions(pkg)
    acc, ncom, dropped = prepare(pkg)
    report["revisions_accepted"] = acc
    report["comments_removed"] = ncom
    report["comment_parts_removed"] = dropped
    doc = pkg.main_part()
    root = pkg.xml(doc)
    body = root.find(w("body"))
    styles = style_map(pkg)
    blanker = Blanker(cfg.get("literals", []), cfg.get("keep_literals", []),
                      detectors=cfg.get("detectors", True))
    blocks = body_blocks(body)
    kinds_sel = dict(cfg.get("kinds", {}))    # selector -> kind name
    labels = cfg.get("labels", {})            # kind name -> label
    tables_sel = dict(cfg.get("tables", {}))  # selector -> table kind name
    fn_sel = cfg.get("footnote_example")
    footnote_info = None
    held = {}   # kind name -> element (resolved before any deletion)
    for sel, name in kinds_sel.items():
        held[name] = select(body, sel)
    held_tables = {name: select(body, sel) for sel, name in tables_sel.items()}
    fn_para = select(body, fn_sel) if fn_sel is not None else None

    if cfg["mode"] == "shell":
        shell = cfg["shell"]
        keep = {int(k): v for k, v in shell.get("keep", {}).items()}       # furniture: mode
        examples = {int(k): v for k, v in shell.get("examples", {}).items()}  # block -> kind name
        ex_text = cfg.get("example_text", {})
        ex_tables = {int(k): v for k, v in shell.get("example_tables", {}).items()}
        tocs = set(int(k) for k in shell.get("toc", []))
        deleted = 0
        emptied_sect = 0
        for i, b in enumerate(blocks):
            if i in keep or i in tocs:
                continue
            if i in examples:
                name = examples[i]
                held.setdefault(name, b)
                fr = example_paragraph(b, ex_text.get(name, BLANK), keep_footnote=(b is fn_para))
                if b is fn_para and fr is not None:
                    blank_note(pkg, wa(fr.find(w("footnoteReference")), "id"))
                continue
            if i in ex_tables:
                strip_table_to_example(b)
                held_tables.setdefault(ex_tables[i], b)
                continue
            ppr = b.find(w("pPr")) if b.tag == w("p") else None
            if ppr is not None and ppr.find(w("sectPr")) is not None:
                for ch in list(b):
                    if ch is not ppr:
                        b.remove(ch)
                emptied_sect += 1
                continue
            body.remove(b)
            deleted += 1
        toc_notes = [toc_reduce(blocks[i]) for i in tocs]
        # furniture modes
        for i, mode in keep.items():
            b = blocks[i]
            paras = list(b.iter(w("p"))) if b.tag != w("p") else [b]
            if mode == "keep":
                for p in paras:
                    blanker.blank_paragraph(p, (doc, "block %d" % i))
            elif mode == "blank":
                for p in paras:
                    pic = any(True for _ in p.iter(w("drawing"), w("pict"), w("object")))
                    if para_text(p).strip() or pic:
                        blanker.log.append((doc, "block %d" % i, para_text(p).strip() or "(picture)", "furniture value blanked"))
                        example_paragraph(p)
            elif mode == "label":
                for p in paras:
                    _label_blank(p, blanker, (doc, "block %d" % i))
            elif mode == "label_first_col" and b.tag == w("tbl"):
                for tr in b.findall(w("tr")):
                    for ci, tc in enumerate(tr.findall(w("tc"))):
                        for p in tc.findall(w("p")):
                            if ci == 0:
                                blanker.blank_paragraph(p, (doc, "block %d" % i))
                            elif para_text(p).strip():
                                blanker.log.append((doc, "block %d" % i, para_text(p), "table value blanked"))
                                example_paragraph(p)
            elif mode == "empty":
                for p in paras:
                    blanker.log.append((doc, "block %d" % i, para_text(p) or "(picture)", "furniture emptied"))
                    ppr = p.find(w("pPr"))
                    for ch in list(p):
                        if ch is not ppr:
                            p.remove(ch)
            elif isinstance(mode, dict) and "text" in mode:
                if b.tag == w("tbl"):
                    strip_table_to_example(b, keep_rows=len(b.findall(w("tr"))), keep_footnote=mode.get("keep_footnote", False),
                                           first_text=mode["text"], log=lambda t: blanker.log.append((doc, "block %d" % i, t, "furniture replaced by fixed text")))
                else:
                    for j, p in enumerate(paras):
                        if j == 0:
                            blanker.log.append((doc, "block %d" % i, para_text(p), "furniture replaced by fixed text"))
                            example_paragraph(p, mode["text"], keep_footnote=mode.get("keep_footnote", False))
                        else:
                            drop(p)
            else:
                raise SystemExit("unknown furniture mode %r for block %d" % (mode, i))
        report["shell"] = {"blocks_before": len(blocks), "deleted": deleted, "section_paragraphs_emptied": emptied_sect,
                           "furniture_kept": len(keep), "examples": len(examples) + len(ex_tables), "toc": toc_notes}
        # headers/footers/footnotes kept: blank facts
        for part in [p for p in pkg.parts() if re.match(r"^word/(header|footer)\d+\.xml$", p)]:
            if cfg.get("letterhead_line"):
                continue
            n = sum(blanker.blank_paragraph(p, (part, "")) for p in pkg.xml(part).iter(w("p")))
            if n:
                pkg.touch(part)
    else:
        # FORM: blank facts everywhere text lives
        for part in [p for p in pkg.parts() if STORY.match(p)]:
            proot = pkg.xml(part)
            n = 0
            for k, p in enumerate(proot.iter(w("p"))):
                n += blanker.blank_paragraph(p, (part, "paragraph %d" % k))
            if n:
                pkg.touch(part)
        for i in sorted((int(x) for x in cfg.get("delete_blocks", [])), reverse=True):
            b = blocks[i]
            blanker.log.append((doc, "block %d" % i, para_text(b) if b.tag == w("p") else "(table)", "deal-specific paragraph removed"))
            drop(b)
        for sel, text in cfg.get("replace_paragraphs", {}).items():
            p = select(body, sel)
            blanker.log.append((doc, "block " + sel, para_text(p), "paragraph replaced: " + text))
            example_paragraph(p, text)
    pkg.touch(doc)

    # letters: letterhead
    if cfg.get("letterhead_line"):
        src = held.get(cfg.get("letterhead_look", "body"))
        tr = text_runs(src) if src is not None else []
        look = tr[0].find(w("rPr")) if tr else None
        report["letterhead"] = letterhead_line(pkg, doc, cfg["letterhead_line"], look)
    # A4
    report["page_changes"] = to_a4(root)
    # tidy
    report["notes_removed"] = prune_notes(pkg, doc)
    if cfg["mode"] == "shell":
        for part in ("word/footnotes.xml", "word/endnotes.xml"):
            if pkg.has(part):
                n = sum(blanker.blank_paragraph(p, (part, "kept note")) for p in pkg.xml(part).iter(w("p")))
                if n:
                    pkg.touch(part)
    report["orphans_removed"] = fix_orphans(root)
    for part in [p for p in pkg.parts() if STORY.match(p)]:
        if part in pkg.dirty:
            fix_orphans(pkg.xml(part))
    report["unused_relationships_removed"] = prune_part_rels(pkg, doc)
    # blank the file's properties (title, author)
    report["properties_blanked"] = blank_properties(pkg)
    report["field_imbalance"] = field_balance(root)
    report["revisions_left"] = count_revisions(pkg)
    report["sections"] = section_report(root)
    report["shapes"] = shapes_report(pkg)
    report["toc_fields"] = toc_report(root)
    report["blankings"] = [{"part": a, "where": b, "text": c, "reason": d} for a, b, c, d in blanker.log]
    report["time_periods_kept"] = sorted(set(blanker.kept))
    report["wide_tables"] = wide_tables(root)

    # kinds.json
    kinds = {}
    for name, el in held.items():
        if el.tag != w("p"):
            raise SystemExit("kind %s does not point at a paragraph" % name)
        kinds[name] = kind_of(el, styles, labels.get(name, name))
    tables = {name: table_kind(t, styles, labels.get(name, name)) for name, t in held_tables.items()}
    fn = None
    ref = None
    if fn_para is not None:
        ref = next(iter(fn_para.iter(w("footnoteReference"))), None)
    if ref is None:
        ref = next(iter(root.iter(w("footnoteReference"))), None)
    if ref is not None and ref.getparent() is not None:
        fn = footnote_kind(pkg, doc, ref)
    kj = {"kinds": kinds, "tables": tables, "footnote": fn}
    base = cfg["kind"]
    pack = os.path.join(out_dir, "%s-pack.docx" % base)
    pkg.save(pack)
    with open(os.path.join(out_dir, "kinds.json"), "w", encoding="utf-8") as f:
        json.dump(kj, f, ensure_ascii=False, indent=2)
    report["changed_parts"] = sorted(pkg.dirty - pkg.removed)
    report["removed_parts"] = sorted(pkg.removed)
    report["carried_byte_for_byte"] = sorted(p for p in pkg.parts() if p not in pkg.dirty)
    with open(os.path.join(out_dir, "report.json"), "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    return pack, report, kj


def _label_blank(p, blanker, where):
    """Keep the label before the first colon or tab; blank the rest."""
    text = para_text(p)
    m = re.match(r"^(.*?[:\t]\s*)(\S.*)$", text, re.S)
    if not m:
        if text.strip():
            blanker.log.append((where[0], where[1], text, "furniture value blanked"))
            example_paragraph(p)
        return
    lit = Blanker([{"text": m.group(2).rstrip(), "reason": "furniture value after its label"}], detectors=False, labels=False, addresses=False)
    lit.blank_paragraph(p, where)
    blanker.log.extend(lit.log)


def blank_properties(pkg):
    done = []
    if pkg.has("docProps/core.xml"):
        root = pkg.xml("docProps/core.xml")
        for el in root:
            tag = el.tag.split("}")[1]
            if tag in ("title", "subject", "creator", "lastModifiedBy", "description", "keywords", "category") and (el.text or "").strip():
                el.text = ""
                done.append("core:" + tag)
        if done:
            pkg.touch("docProps/core.xml")
    if pkg.has("docProps/app.xml"):
        root = pkg.xml("docProps/app.xml")
        ch = False
        for el in root:
            tag = el.tag.split("}")[1]
            if tag in ("Company", "Manager") and (el.text or "").strip():
                el.text = ""
                done.append("app:" + tag)
                ch = True
            if tag == "TitlesOfParts":
                for lp in el.iter("{http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes}lpstr"):
                    if lp.text:
                        lp.text = ""
                        ch = True
                        done.append("app:TitlesOfParts")
        if ch:
            pkg.touch("docProps/app.xml")
    if pkg.has("docProps/custom.xml"):
        names = [el.get("name") for el in pkg.xml("docProps/custom.xml")]
        done.append("custom properties kept as they were: " + ", ".join(n for n in names if n))
    return done


def wide_tables(root):
    out = []
    for sp in root.iter(w("sectPr")):
        pass
    sects = list(root.iter(w("sectPr")))
    if not sects:
        return out
    sp = sects[-1]
    sz, mar = sp.find(w("pgSz")), sp.find(w("pgMar"))
    text_w = int(wa(sz, "w", "0")) - int(wa(mar, "left", "0")) - int(wa(mar, "right", "0"))
    body = root.find(w("body"))
    for i, b in enumerate(body_blocks(body)):
        if b.tag != w("tbl"):
            continue
        tw = b.find("w:tblPr/w:tblW", NS)
        ind = b.find("w:tblPr/w:tblInd", NS)
        grid = sum(int(wa(g, "w", "0")) for g in b.iter(w("gridCol")))
        width = int(wa(tw, "w", "0")) if tw is not None and wa(tw, "type") == "dxa" else grid
        off = int(wa(ind, "w", "0")) if ind is not None and wa(ind, "type", "dxa") == "dxa" else 0
        if width + off > text_w + 30:
            out.append({"block": i, "table_width_twips": width, "indent": off, "text_width_twips": text_w})
    return out


def main(argv):
    if len(argv) >= 3 and argv[1] == "list":
        pkg = Package(argv[2])
        prepare(pkg)
        print(listing(pkg))
        return 0
    if len(argv) >= 3 and argv[1] == "info":
        pkg = Package(argv[2])
        info = {"revisions": count_revisions(pkg)}
        acc, ncom, dropped = prepare(pkg)
        root = pkg.xml(pkg.main_part())
        info.update({"accepted": acc, "comments": ncom, "sections": section_report(root), "toc": toc_report(root),
                     "shapes": shapes_report(pkg), "revisions_left": count_revisions(pkg),
                     "footnotes": sum(1 for _ in root.iter(w("footnoteReference"))),
                     "parts": pkg.parts()})
        for part in [p for p in pkg.parts() if re.match(r"^word/(header|footer)\d+\.xml$", p)]:
            info[part] = [para_text(p) for p in pkg.xml(part).iter(w("p")) if para_text(p).strip()][:12]
        print(json.dumps(info, ensure_ascii=False, indent=1))
        return 0
    if len(argv) >= 4 and argv[1] == "build":
        with open(argv[2], encoding="utf-8") as f:
            cfgs = json.load(f)
        cfg = cfgs["packs"][argv[3]]
        cfg["name"] = argv[3]
        if not os.path.isabs(cfg["base"]):
            cfg["base"] = os.path.join(cfgs["bases"], cfg["base"])
        out_dir = os.path.join(cfgs["out_root"], cfg["folder"])
        pack, report, kj = build(cfg, out_dir)
        print(pack)
        return 0
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
