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

Both modes, straight after revisions are accepted (config "auto_number",
on unless set to false; a shell converts only what it keeps): clause and
limb numbers typed by hand ("4.1.1<tab>", "(a)<tab>", "(i)<tab>", "A.<tab>")
become Word's own numbering. Each goes onto the list the document already
uses at that place (the clause list's level that numbers the same way, a
sibling's list, or the closest list by indent); a typed list that starts
again gets a w:num on the same list with a start override; a list the
document lacks is a copy of the closest one in the new format. The typed
number and its tab leave the text (run formatting kept); the paragraph's
own indent is dropped when the list level gives the same, else written out
in full so nothing moves. Every number must then read exactly as before,
typed or not, under three readings of how Word shares a list's counters,
or the build stops. Kinds on a clause list get "restart": false.

Literals may be regexes; {"regex", "with", "reason"} substitutes the match
(backreferences allowed) instead of blanking it to [●].

Spelling (config "spelling", "british" unless set to false): American
-ize/-yze/-ization forms and the style sheet's word list (color, program,
installment ...) become British in every story part, case kept, across run
boundaries, only the letters that differ touched. The list and its
exceptions (size, seize, prize, citizen ...) are read from
chat-service/styleSheets/core.json. Kept as written: a capitalised
Organization in a proper name, "spelling_keep" phrases, and words inside
quotation marks unless "spelling_quotes_own" lists the quoted text as the
firm's own. Every change is counted in report.json "spelling".

"unquote_terms": [{"term", "reason"}] puts a quoted defined term in the
firm's form: “Term” loses its quotation marks and is bold.

Wave-2 options (each runs only when its key is in the config, so a config
without them builds exactly as before):
  "font_map" / "size_map"   move fonts ({"Times New Roman": "Arial"}, theme
                            fonts too) and sizes in half-points ({"25": "22"})
                            in the story parts, styles and list levels
  "margins_twips"           set every section's margins (twips)
  "turn_margins": false     landscape -> portrait keeps the margins as they
                            are instead of turning them with the page
  "keep_landscape": true    a landscape page stays landscape, on A4
  "fit_tables": true        tables wider than the text width (body, headers,
                            footers) are scaled down to it
  "cut": "shell"            a form pack cut like a shell (a fresh standard:
                            the firm's furniture and kinds only)
  "compose"                 [{"after": <block>, "blocks": [{"kind", "text"}]}]
                            writes the firm's own text in the pack's kinds
                            (**Term** bold); "compose_spacer" (a kind) puts an
                            empty paragraph after each block; "compose_restart"
                            (kinds) starts each run of those lists again at (a)
  "drop_examples": true     the shell's [●] examples go once kinds.json holds
                            their look (a composed pack)
  "heading_numbers"         {"pattern", "numId", "lvlText"}: a typed heading
                            line ("Article 2") becomes level 1 of its clauses'
                            list, so 2.1 counts from it
  "unquote_all": true       every quoted defined term in a defining formula
                            takes the firm's form (bold, no quotation marks)
  shell "table_headers_kept" a list of example tables whose first row keeps its
                            words, or {table: n} for n header rows, blanked like
                            furniture; shell "table_rows" {table: rows kept}

Edits are made on the XML. Parts that are not changed are written back
byte-for-byte (styles, numbering, theme, fontTable, settings and any header
or footer the pack does not need to change).

The config holds client facts (literal names to blank), so it lives with
the outputs, never in the repository.
"""
import collections
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
                # "with" turns a blanking into a substitution: the match is
                # replaced by that text (backreferences allowed) instead of [●].
                self.regexes.append((re.compile(l["regex"], re.I if l.get("ci") else 0), l["reason"], l.get("with")))
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
        subs = {}  # (start, end) -> replacement text, for "with" entries
        for rx, reason, sub in self.regexes:
            for m in rx.finditer(text):
                if m.end() > m.start():
                    found.append((m.start(), m.end(), reason))
                    if sub is not None:
                        subs[(m.start(), m.end())] = m.expand(sub)
        self._subs = subs
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
        found = [f for f in found if text[f[0]:f[1]].strip() and text[f[0]:f[1]].strip() != BLANK
                 and (f[0], f[1]) not in subs or (f[0], f[1]) in subs and text[f[0]:f[1]] != subs[(f[0], f[1])]]
        # merge overlaps, keep the earliest-listed reason of the widest span
        found.sort(key=lambda f: (f[0], -(f[1] - f[0])))
        merged = []
        for s, e, r in found:
            if merged and s < merged[-1][1]:
                ps, pe, pr = merged[-1]
                merged[-1] = (ps, max(pe, e), pr)
            else:
                merged.append((s, e, r))
        # trim whitespace/punctuation at the edges (a substitution is kept exact)
        out = []
        for s, e, r in merged:
            if (s, e) in subs:
                out.append((s, e, r))
                continue
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
        subs = getattr(self, "_subs", {})
        if not spans:
            return 0
        bounds = []
        pos = 0
        for s in segs:
            bounds.append((pos, pos + len(s[1])))
            pos += len(s[1])
        for s, e, reason in reversed(spans):
            put = subs.get((s, e), BLANK)
            self.log.append((where[0], where[1], text[s:e], reason if put == BLANK else reason + " -> " + put))
            first = True
            for i, (a, b) in enumerate(bounds):
                if b <= s or a >= e or segs[i][0] is None:
                    continue
                t = segs[i][1]
                ls, le = max(s, a) - a, min(e, b) - a
                if first:
                    t = t[:ls] + put + t[le:]
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
def to_a4(root, turn=True, keep_landscape=False):
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
        if keep_landscape and land:
            # "keep_landscape": a wide table's page stays landscape, on A4
            if name == "A4":
                continue
            sz.set(w("w"), str(A4_H))
            sz.set(w("h"), str(A4_W))
            changes.append("section %d: %s landscape -> A4 landscape (margins kept)" % (i + 1, name))
            continue
        sz.set(w("w"), str(A4_W))
        sz.set(w("h"), str(A4_H))
        if sz.get(w("orient")) is not None:
            del sz.attrib[w("orient")]
        if sz.get(w("code")) is not None:
            sz.set(w("code"), "9")
        mar = sp.find(w("pgMar"))
        if land and mar is not None and turn:
            # landscape -> portrait: the margins turn with the page
            t, r, b, l = (wa(mar, k) for k in ("top", "right", "bottom", "left"))
            mar.set(w("top"), l); mar.set(w("right"), t); mar.set(w("bottom"), r); mar.set(w("left"), b)
        changes.append("section %d: %s%s -> A4 portrait (margins kept%s)" % (i + 1, name, " landscape" if land else "",
                                                                           ", turned with the page" if land and turn else ""))
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


def strip_table_to_example(tbl, keep_rows=2, keep_footnote=False, first_text=BLANK, log=None, keep_header=False):
    """Keep the first `keep_rows` rows; every cell keeps one paragraph whose
    text becomes [●] (empty cells stay empty); the very first cell's text
    becomes `first_text`. With keep_header the first row keeps its words
    (column headings are the firm's furniture)."""
    rows = tbl.findall(w("tr"))
    for tr in rows[keep_rows:]:
        tbl.remove(tr)
    first = True
    for ri, tr in enumerate(tbl.findall(w("tr"))):
        if ri < int(keep_header):
            continue
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
# automatic numbering: clause and limb numbers typed by hand ("4.1.1<tab>",
# "(a)<tab>", "(i)<tab>", "A.<tab>") become Word list items
# --------------------------------------------------------------------------
ROMANS = [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"), (40, "xl"),
          (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")]
PPR_BEFORE_NUMPR = ("pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr", "widowControl")
# a typed number at the very start of a paragraph, then (spaces and) at least
# one tab: "4.1.1<tab>", "(a)<tab>", "(iv) <tab>", "A.<tab>", "(1)<tab>", "b.<tab>"
TYPED_NUM = re.compile(r"^( *)(\d{1,3}(?:\.\d{1,3})*[A-Z](?:\.\d{1,3})*\.?(?= *\t| +\S)|"
                       r"(?:\d{1,3}(?:\.\d{1,3}){1,3}\.?|\d{1,3}\.|\d{1,3}\)|\(\d{1,3}\)|\([a-z]{1,4}\)|\([A-Z]{1,4}\)|"
                       r"[A-Z]\.|[a-z]\.|[a-z]\))(?= *\t))([ \t]*)")
# an inserted clause numbered with a letter: "12.3A", "12.3A.1", "8.1.1A"
SUFFIXED = re.compile(r"(\d{1,3}(?:\.\d{1,3})*[A-Z](?:\.\d{1,3})*)(\.?)")
# the same without a tab: listed for the owner, never converted
NEAR_NUM = re.compile(r"^( *)(\d{1,3}(?:\.\d{1,3}){0,3}\.?|\(\d{1,3}\)|\([a-z]{1,4}\)|\([A-Z]{1,4}\)|[A-Z]\.) +(?=\S)")


def to_roman(n):
    out = ""
    for v, s in ROMANS:
        while n >= v:
            out += s
            n -= v
    return out


def from_roman(s):
    s = s.lower()
    if not s or not re.fullmatch(r"[ivxl]+", s):
        return None
    for n in range(1, 90):
        if to_roman(n) == s:
            return n
    return None


def to_letter(n):
    return chr(97 + (n - 1) % 26) * ((n - 1) // 26 + 1)


def from_letter(s):
    s = s.lower()
    if not s or len(set(s)) != 1 or not s[0].isalpha():
        return None
    return (len(s) - 1) * 26 + ord(s[0]) - 96


def fmt_num(n, fmt):
    if fmt in ("lowerLetter", "upperLetter"):
        s = to_letter(n)
        return s.upper() if fmt == "upperLetter" else s
    if fmt in ("lowerRoman", "upperRoman"):
        s = to_roman(n)
        return s.upper() if fmt == "upperRoman" else s
    if fmt == "decimalZero":
        return "%02d" % n
    if fmt in ("none", "bullet"):
        return ""
    return str(n)


def _int(v):
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


class Level:
    def __init__(self, el):
        self.el = el
        self.ilvl = int(wa(el, "ilvl", "0"))
        self.fmt = wa(el.find(w("numFmt")), "val", "decimal")
        self.text = wa(el.find(w("lvlText")), "val", "")
        self.start = _int(wa(el.find(w("start")), "val", "1"))
        self.start = 1 if self.start is None else self.start
        self.pstyle = wa(el.find(w("pStyle")), "val")
        self.islgl = el.find(w("isLgl")) is not None
        self.restart = _int(wa(el.find(w("lvlRestart")), "val"))
        ind = el.find("w:pPr/w:ind", NS)
        self.ind = ind_of(ind)

    def key(self):
        """What the level looks like: ('multi', parts, trailing dot) for
        "%1.%2.%3"-style clause numbers, else (format, template) with the
        level's own number as '%': ('lowerLetter', '(%)')."""
        return level_key(self.text, self.fmt, self.ilvl)

    def describe(self):
        return "'%s' %s" % (self.text, self.fmt)


def level_key(text, fmt, ilvl):
    parts = re.findall(r"%\d|\d+", text)
    if re.fullmatch(r"(?:%\d|\d+)(?:\.(?:%\d|\d+))+\.?", text) and any(p.startswith("%") for p in parts):
        return ("multi", len(parts), text.endswith("."))
    if fmt == "none" and re.fullmatch(r"\d+(?:\.\d+)+\.?", text):
        return ("multi", len(parts), text.endswith("."))
    if fmt == "bullet":
        return ("bullet", text)
    ph = re.findall(r"%(\d)", text)
    if len(ph) == 1 and int(ph[0]) == ilvl + 1:
        return (fmt, text.replace("%" + ph[0], "%"))
    return ("other", fmt, text)


def ind_of(ind):
    """(left, first) of a w:ind; first is negative for a hanging indent;
    either may be None when the element does not say."""
    if ind is None:
        return (None, None)
    left = _int(wa(ind, "left", wa(ind, "start")))
    first = None
    if wa(ind, "hanging") is not None:
        first = -(_int(wa(ind, "hanging")) or 0)
    elif wa(ind, "firstLine") is not None:
        first = _int(wa(ind, "firstLine")) or 0
    return (left, first)


def merge_ind(base, over):
    return (over[0] if over[0] is not None else base[0], over[1] if over[1] is not None else base[1])


class Numbering:
    """numbering.xml as lists and levels, kept in step with additions."""

    def __init__(self, pkg, styles):
        self.pkg = pkg
        self.styles = styles
        self.root = pkg.xml("word/numbering.xml") if pkg.has("word/numbering.xml") else None
        self.abs_el = {}
        self.nums = {}       # numId -> (abstractId, {ilvl: start override}, {ilvl: Level override})
        self.added_nums = []
        self.added_abstracts = []
        self.changed_levels = []
        if self.root is None:
            return
        for a in self.root.findall(w("abstractNum")):
            self.abs_el[wa(a, "abstractNumId")] = a
        for n in self.root.findall(w("num")):
            self._read_num(n)
        self._levels = {}

    def _read_num(self, n):
        starts, lvls = {}, {}
        for o in n.findall(w("lvlOverride")):
            il = int(wa(o, "ilvl", "0"))
            so = o.find(w("startOverride"))
            if so is not None:
                starts[il] = _int(wa(so, "val", "1")) or 0
            lv = o.find(w("lvl"))
            if lv is not None:
                lvls[il] = Level(lv)
        self.nums[wa(n, "numId")] = (wa(n.find(w("abstractNumId")), "val"), starts, lvls)

    def abstract_of(self, num_id):
        """The abstract that holds the levels (a numStyleLink followed)."""
        a = self.nums.get(num_id, (None,))[0]
        seen = set()
        while a in self.abs_el and a not in seen:
            seen.add(a)
            el = self.abs_el[a]
            link = wa(el.find(w("numStyleLink")), "val")
            if not link or el.find(w("lvl")) is not None:
                return a
            st = self.styles.get(link)
            nid = wa(st.find("w:pPr/w:numPr/w:numId", NS), "val") if st is not None else None
            if nid is None or nid not in self.nums:
                return a
            a = self.nums[nid][0]
        return a

    def abstract_levels(self, aid):
        if aid not in self._levels:
            el = self.abs_el.get(aid)
            self._levels[aid] = {int(wa(l, "ilvl", "0")): Level(l) for l in el.findall(w("lvl"))} if el is not None else {}
        return self._levels[aid]

    def levels(self, num_id):
        """{ilvl: (Level, start)} for a num, overrides applied."""
        if num_id not in self.nums:
            return {}
        cache = self.__dict__.setdefault("_num_levels", {})
        if num_id not in cache:
            cache[num_id] = self._levels_of(num_id)
        return cache[num_id]

    def _levels_of(self, num_id):
        _, starts, lvls = self.nums[num_id]
        out = {}
        for il, lv in self.abstract_levels(self.abstract_of(num_id)).items():
            lv = lvls.get(il, lv)
            out[il] = (lv, starts.get(il, lv.start))
        for il, lv in lvls.items():
            if il not in out:
                out[il] = (lv, starts.get(il, lv.start))
        return out

    def overrides(self, num_id):
        return set(self.nums.get(num_id, (None, {}, {}))[1])

    def is_clause_list(self, aid):
        return any(lv.key()[0] == "multi" for lv in self.abstract_levels(aid).values())

    def deepest_multi(self, aid):
        return max([il for il, lv in self.abstract_levels(aid).items() if lv.key()[0] == "multi"], default=-1)

    # additions -----------------------------------------------------------
    def _next_num_id(self):
        return str(max([int(k) for k in self.nums if str(k).isdigit()] + [0]) + 1)

    def add_num(self, aid, starts, why):
        """A w:num on an existing list with its start overridden: a list
        started again (or started part-way, as the typed numbers were)."""
        nid = self._next_num_id()
        n = etree.Element(w("num"))
        n.set(w("numId"), nid)
        a = etree.SubElement(n, w("abstractNumId"))
        a.set(w("val"), aid)
        for il in sorted(starts):
            o = etree.SubElement(n, w("lvlOverride"))
            o.set(w("ilvl"), str(il))
            so = etree.SubElement(o, w("startOverride"))
            so.set(w("val"), str(starts[il]))
        last = self.root.findall(w("num"))
        if last:
            last[-1].addnext(n)
        else:
            mac = self.root.find(w("numIdMacAtCleanup"))
            if mac is not None:
                mac.addprevious(n)
            else:
                self.root.append(n)
        self._read_num(n)
        self.added_nums.append({"numId": int(nid), "abstractNumId": int(aid), "starts": {str(k): v for k, v in starts.items()}, "why": why})
        self.pkg.touch("word/numbering.xml")
        return nid

    def change_level(self, aid, ilvl, fmt, text, start, why):
        """Give a level no paragraph uses a new number format; returns an
        undo function."""
        lv = next(l for l in self.abs_el[aid].findall(w("lvl")) if int(wa(l, "ilvl", "0")) == ilvl)
        old = copy.deepcopy(lv)
        for tag, val in (("start", str(start)), ("numFmt", fmt), ("lvlText", text)):
            el = lv.find(w(tag))
            if el is None:
                el = etree.SubElement(lv, w(tag))
            el.set(w("val"), val)
        self._levels.pop(aid, None)
        self.__dict__.get("_num_levels", {}).clear()
        rec = {"abstractNumId": int(aid), "level": ilvl + 1, "was": "'%s' %s" % (wa(old.find(w("lvlText")), "val"), wa(old.find(w("numFmt")), "val")),
               "now": "'%s' %s" % (text, fmt), "why": why}
        self.changed_levels.append(rec)
        self.pkg.touch("word/numbering.xml")

        def undo():
            lv.getparent().replace(lv, old)
            self._levels.pop(aid, None)
            self.__dict__.get("_num_levels", {}).clear()
            self.changed_levels.remove(rec)
        return undo

    def add_suffix_abstract(self, model_aid, comps, dot, why):
        """A list of its own for an inserted clause group ("12.3A", then
        "12.3A.1", "12.3A.2"): a copy of the clause list it sits in, its
        levels reading "%1", "%1.%2A", "%1.%2A.%3" and starting where the
        typed numbers do, so the main clause count is never touched."""
        el = copy.deepcopy(self.abs_el[model_aid])
        new_id = str(max(int(k) for k in self.abs_el) + 1)
        el.set(w("abstractNumId"), new_id)
        for tag in ("styleLink", "numStyleLink", "multiLevelType"):
            for x in el.findall(w(tag)):
                el.remove(x)
        nsid = el.find(w("nsid"))
        if nsid is not None:
            nsid.set(w("val"), "%08X" % (0x5A000000 + int(new_id)))
        j = next(i for i, c in enumerate(comps) if not c.isdigit())
        for lv in el.findall(w("lvl")):
            i = int(wa(lv, "ilvl", "0"))
            for x in lv.findall(w("pStyle")) + lv.findall(w("lvlRestart")) + lv.findall(w("isLgl")):
                lv.remove(x)
            parts = ["%%%d" % (k + 1) + ("A" if k == j else "") for k in range(i + 1)]
            if i < j:
                start, text = int(comps[i]), ".".join(parts)
            elif i == j:
                start, text = int(re.match(r"\d+", comps[j]).group(0)), ".".join(parts).replace("A", comps[j][-1])
            else:
                start, text = 1, ".".join(parts).replace("A", comps[j][-1])
            for tag, val in (("start", str(start)), ("numFmt", "decimal"), ("lvlText", text + ("." if dot and i >= j else ""))):
                x = lv.find(w(tag))
                if x is None:
                    x = etree.SubElement(lv, w(tag))
                x.set(w("val"), val)
        last = self.root.findall(w("abstractNum"))[-1]
        last.addnext(el)
        self.abs_el[new_id] = el
        self._levels.pop(new_id, None)
        self.added_abstracts.append({"abstractNumId": int(new_id), "modelled_on": int(model_aid), "level": j, "numFmt": "decimal", "why": why})
        self.pkg.touch("word/numbering.xml")
        return new_id

    def remove_num(self, nid):
        for n in self.root.findall(w("num")):
            if wa(n, "numId") == nid:
                self.root.remove(n)
        self.nums.pop(nid, None)
        self.__dict__.get("_num_levels", {}).pop(nid, None)
        self.added_nums = [x for x in self.added_nums if str(x["numId"]) != nid]

    def remove_abstract(self, aid):
        el = self.abs_el.pop(aid)
        el.getparent().remove(el)
        self._levels.pop(aid, None)
        self.added_abstracts = [x for x in self.added_abstracts if str(x["abstractNumId"]) != aid]

    def add_abstract(self, model_aid, ilvl, fmt, why):
        """A copy of an existing list with one level's number format changed."""
        el = copy.deepcopy(self.abs_el[model_aid])
        new_id = str(max(int(k) for k in self.abs_el) + 1)
        el.set(w("abstractNumId"), new_id)
        for tag in ("styleLink", "numStyleLink"):
            for x in el.findall(w(tag)):
                el.remove(x)
        nsid = el.find(w("nsid"))
        if nsid is not None:
            nsid.set(w("val"), "%08X" % (0x5A000000 + int(new_id)))
        for lv in el.findall(w("lvl")):
            if int(wa(lv, "ilvl", "0")) == ilvl:
                lv.find(w("numFmt")).set(w("val"), fmt)
            ps = lv.find(w("pStyle"))
            if ps is not None:
                lv.remove(ps)
        last = self.root.findall(w("abstractNum"))[-1]
        last.addnext(el)
        self.abs_el[new_id] = el
        self._levels.pop(new_id, None)
        self.added_abstracts.append({"abstractNumId": int(new_id), "modelled_on": int(model_aid), "level": ilvl, "numFmt": fmt, "why": why})
        self.pkg.touch("word/numbering.xml")
        return new_id


def para_numbering(p, styles, nb):
    """(numId, ilvl) a paragraph is numbered with, or None (numId 0 counts
    as none). Style numbering without an ilvl takes the level that names the
    style."""
    ppr = p.find(w("pPr"))
    nid = lvl = None
    np_ = ppr.find(w("numPr")) if ppr is not None else None
    if np_ is not None:
        nid = wa(np_.find(w("numId")), "val")
        lvl = wa(np_.find(w("ilvl")), "val")
    sid = wa(ppr.find(w("pStyle")), "val") if ppr is not None else None
    if nid is None:
        seen = set()
        s = sid
        while s and s not in seen:
            seen.add(s)
            st = styles.get(s)
            if st is None:
                break
            snp = st.find("w:pPr/w:numPr", NS)
            if snp is not None:
                if nid is None:
                    nid = wa(snp.find(w("numId")), "val")
                if lvl is None:
                    lvl = wa(snp.find(w("ilvl")), "val")
                if nid is not None:
                    break
            s = wa(st.find(w("basedOn")), "val")
        if nid is not None and lvl is None and sid:
            for il, lv in nb.abstract_levels(nb.abstract_of(nid)).items():
                if lv.pstyle == sid:
                    lvl = str(il)
    if nid is None or nid == "0" or nid not in nb.nums:
        return None
    return (nid, int(lvl or 0))


def style_ind(p, styles, pkg):
    """The indent a paragraph gets from its style chain and the defaults."""
    out = (None, None)
    if pkg.has("word/styles.xml"):
        d = pkg.xml("word/styles.xml").find("w:docDefaults/w:pPrDefault/w:pPr/w:ind", NS)
        out = merge_ind(out, ind_of(d))
    ppr = p.find(w("pPr"))
    sid = wa(ppr.find(w("pStyle")), "val") if ppr is not None else None
    if sid is None:
        for s in styles.values():
            if wa(s, "type") == "paragraph" and wa(s, "default") in ("1", "true"):
                sid = wa(s, "styleId")
    chain = []
    while sid and sid not in chain:
        chain.append(sid)
        st = styles.get(sid)
        sid = wa(st.find(w("basedOn")), "val") if st is not None else None
    for sid in reversed(chain):
        st = styles.get(sid)
        if st is not None:
            out = merge_ind(out, ind_of(st.find("w:pPr/w:ind", NS)))
    return out


MODELS = ("own", "shared", "shared_level")
MODEL_NAMES = {"own": "one counter per list", "shared": "a list's nums share counters, an override restarts every level it names",
               "shared_level": "a list's nums share counters, an override restarts only the paragraph's level and below (LibreOffice)"}


class Counter:
    """Word's list counters, three ways, since which nums share a counter is
    not pinned down: "own" - every w:num counts on its own; "shared" - nums
    on one list share counters and a num's start overrides restart the
    levels they name where that num is first used; "shared_level" - the same,
    but only overrides at or below the paragraph's own level take effect
    (LibreOffice's reading). A pack must read the same under all three."""

    def __init__(self, nb, mode):
        self.nb = nb
        self.mode = mode
        self.state = {}
        self.seen = set()

    def clone(self):
        c = Counter(self.nb, self.mode)
        c.state = {k: dict(v) for k, v in self.state.items()}
        c.seen = set(self.seen)
        return c

    def step(self, num_id, ilvl):
        levels = self.nb.levels(num_id)
        shared = self.mode != "own"
        key = self.nb.abstract_of(num_id) if shared else num_id
        st = self.state.setdefault(key, {})
        if shared and num_id not in self.seen:
            for il in self.nb.overrides(num_id):
                if self.mode == "shared" or il >= ilvl:
                    st.pop(il, None)
        self.seen.add(num_id)
        if ilvl not in levels:
            return ""
        lv, start = levels[ilvl]
        st[ilvl] = st[ilvl] + 1 if ilvl in st else start
        for il in [x for x in st if x > ilvl]:
            r = levels[il][0].restart if il in levels else None
            if r is None or (r != 0 and ilvl <= r - 1):
                del st[il]
        if lv.fmt == "bullet":
            return lv.text

        def sub(m):
            j = int(m.group(1)) - 1
            jl = levels.get(j)
            v = st.get(j, jl[1] if jl else 1)
            return fmt_num(v, "decimal" if lv.islgl else (jl[0].fmt if jl else "decimal"))
        return re.sub(r"%(\d)", sub, lv.text)


def typed_readings(label):
    """Every way a typed label can be read: [(key, value, parts)]."""
    m = SUFFIXED.fullmatch(label)
    if m:
        comps = m.group(1).split(".")
        j = [i for i, c in enumerate(comps) if re.fullmatch(r"\d+[A-Z]", c)]
        if len(j) == 1 and all(c.isdigit() for i, c in enumerate(comps) if i != j[0]):
            last = comps[-1]
            return [(("suffix", len(comps), j[0], bool(m.group(2))), int(re.match(r"\d+", last).group(0)), comps)]
        return []
    m = re.fullmatch(r"(\d+(?:\.\d+)+)(\.?)", label)
    if m:
        parts = [int(x) for x in m.group(1).split(".")]
        return [(("multi", len(parts), bool(m.group(2))), parts[-1], parts)]
    for rx, tmpl in ((r"(\d+)\.", "%."), (r"(\d+)\)", "%)"), (r"\((\d+)\)", "(%)")):
        m = re.fullmatch(rx, label)
        if m:
            return [(("decimal", tmpl), int(m.group(1)), None)]
    for rx, tmpl in ((r"\(([A-Za-z]+)\)", "(%)"), (r"([A-Za-z])\.", "%."), (r"([a-z])\)", "%)")):
        m = re.fullmatch(rx, label)
        if not m:
            continue
        s = m.group(1)
        up = s.isupper()
        out = []
        lv = from_letter(s)
        if lv is not None:
            out.append((("upperLetter" if up else "lowerLetter", tmpl), lv, None))
        rv = from_roman(s)
        if rv is not None:
            out.append((("upperRoman" if up else "lowerRoman", tmpl), rv, None))
        return out
    return []


def _field_state_paragraphs(body):
    """Paragraphs that sit inside a contents (TOC) field's result."""
    inside = set()
    stack = []
    for el in body.iter(w("fldChar"), w("instrText"), w("p"), w("fldSimple")):
        if el.tag == w("p"):
            if any(t == "TOC" and sep for t, sep in stack):
                inside.add(el)
            continue
        if el.tag == w("fldSimple"):
            continue
        if el.tag == w("instrText"):
            if stack and not stack[-1][1] and stack[-1][0] is None:
                m = re.match(r"\s*(\w+)", el.text or "")
                if m:
                    stack[-1] = (m.group(1).upper(), False)
            continue
        t = wa(el, "fldCharType")
        if t == "begin":
            stack.append((None, False))
        elif t == "separate" and stack:
            stack[-1] = (stack[-1][0], True)
            p = owning_p(el)
            if stack[-1][0] == "TOC" and p is not None:
                inside.add(p)
        elif t == "end" and stack:
            stack.pop()
    return inside


def _in_field(p, upto):
    """True when any of the first `upto` characters of the paragraph sit in
    a field (its code or its result)."""
    depth = 0
    pos = 0
    for el in p.iter(w("fldChar"), w("t"), w("tab"), w("fldSimple")):
        if owning_p(el) is not p:
            continue
        if el.tag == w("fldSimple"):
            return True
        if el.tag == w("fldChar"):
            t = wa(el, "fldCharType")
            depth += 1 if t == "begin" else (-1 if t == "end" else 0)
            continue
        if el.tag == w("tab") and el.getparent().tag != w("r"):
            continue
        n = len(el.text or "") if el.tag == w("t") else 1
        if n and depth > 0 and pos < upto:
            return True
        pos += n
        if pos >= upto:
            return False
    return False


def strip_prefix(p, n):
    """Remove the first n characters of a paragraph's text (text and tabs),
    then any run left with nothing but its formatting."""
    left = n
    touched = []
    for el in list(p.iter(w("t"), w("tab"), w("br"), w("cr"), w("noBreakHyphen"))):
        if left <= 0:
            break
        if owning_p(el) is not p:
            continue
        if el.tag == w("tab") and el.getparent().tag != w("r"):
            continue
        r = el.getparent()
        if el.tag == w("t"):
            s = el.text or ""
            k = min(len(s), left)
            set_text(el, s[k:])
            left -= k
            if not el.text:
                r.remove(el)
        else:
            r.remove(el)
            left -= 1
        touched.append(r)
    for r in touched:
        if r.getparent() is not None and all(ch.tag == w("rPr") for ch in r):
            r.getparent().remove(r)
    # a leading space left in the first text run
    for t in p.iter(w("t")):
        if owning_p(t) is p:
            if t.text and t.text != t.text.lstrip(" "):
                set_text(t, t.text.lstrip(" "))
            if t.text:
                break


def set_numpr(p, num_id, ilvl):
    ppr = p.find(w("pPr"))
    if ppr is None:
        ppr = etree.Element(w("pPr"))
        p.insert(0, ppr)
    old = ppr.find(w("numPr"))
    if old is not None:
        ppr.remove(old)
    np_ = etree.Element(w("numPr"))
    il = etree.SubElement(np_, w("ilvl"))
    il.set(w("val"), str(ilvl))
    ni = etree.SubElement(np_, w("numId"))
    ni.set(w("val"), str(num_id))
    at = 0
    for i, ch in enumerate(ppr):
        if ch.tag in tuple(w(t) for t in PPR_BEFORE_NUMPR):
            at = i + 1
    ppr.insert(at, np_)


def set_ind(p, before, level_ind):
    """Keep the paragraph where it was: drop its own indent when the list
    level gives the same; otherwise write it out in full (left and
    hanging/first line) so the level's indent does not seep in."""
    ppr = p.find(w("pPr"))
    ind = ppr.find(w("ind"))
    lvl = (level_ind[0] or 0, level_ind[1] or 0)
    was = (before[0] or 0, before[1] or 0)
    keys = ("left", "start", "hanging", "firstLine", "leftChars", "startChars", "hangingChars", "firstLineChars")
    if was == lvl:
        if ind is None:
            return "level"
        for k in keys:
            if ind.get(w(k)) is not None:
                del ind.attrib[w(k)]
        if not ind.attrib:
            ppr.remove(ind)
        return "dropped"
    if ind is None:
        ind = etree.Element(w("ind"))
        sib = None
        for t in ("contextualSpacing", "mirrorIndents", "suppressOverlap", "jc", "textDirection", "textAlignment",
                  "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr", "sectPr", "pPrChange"):
            sib = ppr.find(w(t))
            if sib is not None:
                break
        if sib is not None:
            sib.addprevious(ind)
        else:
            ppr.append(ind)
        how = "kept (from its style)"
    else:
        how = "kept"
    for k in keys:
        if ind.get(w(k)) is not None:
            del ind.attrib[w(k)]
    ind.set(w("left"), str(was[0]))
    if was[1] < 0:
        ind.set(w("hanging"), str(-was[1]))
    else:
        ind.set(w("firstLine"), str(was[1]))
    return how


def body_paragraphs(body):
    """Body paragraphs in reading order, text boxes left out."""
    return [p for p in body.iter(w("p")) if not any(a.tag == w("txbxContent") for a in p.iterancestors())]


def numbering_labels(body, styles, nb, mode):
    c = Counter(nb, mode)
    out = {}
    for p in body_paragraphs(body):
        n = para_numbering(p, styles, nb)
        if n:
            out[p] = c.step(*n)
    return out


def auto_number(pkg, only=None, skip=()):
    """Turn typed clause and limb numbers into Word list items, mapped onto
    the lists the document already uses. Returns the report; raises when the
    automatic numbers would not read as the typed ones did."""
    rep = {"converted": [], "lists_used": {}, "numbering_added": {"nums": [], "abstracts": [], "levels_changed": []}, "left_typed": [],
           "not_numbers": [], "anomalies_kept": [], "indents": {}, "sequence_check": None}
    if not pkg.has("word/numbering.xml"):
        rep["left_typed"].append("the document has no numbering part; nothing converted")
        return rep
    styles = style_map(pkg)
    nb = Numbering(pkg, styles)
    root = pkg.xml(pkg.main_part())
    body = root.find(w("body"))
    paras = body_paragraphs(body)
    in_toc = _field_state_paragraphs(body)
    before = {m: numbering_labels(body, styles, nb, m) for m in MODELS}
    # numbers in the base that read differently by how Word shares a list's
    # counters: the base's own, reported, never caused here
    rep["base_ambiguous"] = [dict({"text": para_text(p)[:60]}, **{m: before[m].get(p) for m in MODELS})
                             for p in paras if p in before["own"] and len({before[m].get(p) for m in MODELS}) > 1]

    # 1. what each paragraph shows: an automatic number, a typed one, or none
    items = []
    for p in paras:
        n = para_numbering(p, styles, nb)
        text = para_text(p)
        cell = next((a for a in p.iterancestors(w("tc"))), None)
        ppr = p.find(w("pPr"))
        sid = wa(ppr.find(w("pStyle")), "val") if ppr is not None else None
        own = ind_of(ppr.find(w("ind")) if ppr is not None else None)
        it = {"p": p, "cell": cell, "auto": n, "typed": None}
        if n:
            lv, _ = nb.levels(n[0]).get(n[1], (None, None))
            if lv is None:
                continue
            label = before["own"].get(p, "")
            key = lv.key()
            val = None
            for k, v, parts in typed_readings(label):
                if k == key:
                    val = v
            it.update(key=key, value=val, label=label, ind=merge_ind(lv.ind, own), num=n)
            items.append(it)
            continue
        m = TYPED_NUM.match(text)
        if not m:
            mm = NEAR_NUM.match(text)
            if mm and p not in in_toc and not (sid or "").upper().startswith("TOC"):
                rep["not_numbers"].append({"text": text[:70], "why": "a number-like start with no tab after it: read as running text"})
            continue
        label = m.group(2)
        why = None
        if p in in_toc or (sid or "").upper().startswith("TOC"):
            continue   # a contents entry: Word rebuilds it
        if (only is not None and p not in only) or p in skip:
            continue
        if not text[m.end():].strip():
            why = "nothing follows the number"
        elif _in_field(p, m.end()):
            why = "the number is inside a field"
        elif not typed_readings(label):
            why = "not a list number"
        if why:
            rep["left_typed"].append({"text": text[:70], "why": why})
            continue
        it.update(typed=label, cut=m.end(), readings=typed_readings(label), ind=merge_ind(style_ind(p, styles, pkg), own),
                  own_ind=own)
        items.append(it)

    # 2. the outline: which typed numbers are siblings, and under what
    def key_value(it, stack):
        if not it["typed"]:
            return it["key"], it["value"]
        reads = it["readings"]
        if len(reads) == 1:
            return reads[0][0], reads[0][1]
        # (i), (v), (x), (I) ...: a letter when it follows the letter before
        # it at no deeper indent, else a roman numeral
        for key, val, _ in reads:
            if key[0].endswith("Letter"):
                for e in reversed(stack):
                    if e["key"] == key and e["last"] == val - 1 and (it["ind"][0] or 0) <= (e["ind"][0] or 0) + 200:
                        return key, val
        for key, val, _ in reads:
            if key[0].endswith("Roman"):
                for e in reversed(stack):
                    if e["key"] == key and e["last"] == val - 1:
                        return key, val
        roman = [r for r in reads if r[0][0].endswith("Roman")]
        if roman and roman[0][1] == 1:
            return roman[0][0], roman[0][1]
        letter = [r for r in reads if r[0][0].endswith("Letter")]
        return (letter or reads)[0][0], (letter or reads)[0][1]

    stacks = {}
    run_no = [0]
    for i, it in enumerate(items):
        scope = it["cell"]
        stack = stacks.setdefault(scope, [])
        key, val = key_value(it, stack)
        it["key"] = key
        if it["typed"]:
            it["value"] = val
            if key[0] in ("multi", "suffix"):
                it["parts"] = [r[2] for r in it["readings"] if r[0] == key][0]
        if key[0] in ("multi", "suffix"):
            run_no[0] += 1
            it["run"], it["parent"] = run_no[0], None
            stacks[scope] = [{"key": key, "last": val, "item": it, "run": run_no[0], "ind": it["ind"]}]
            continue
        j = next((k for k in range(len(stack) - 1, -1, -1) if stack[k]["key"] == key), None)
        if j is not None:
            e = stack[j]
            same = val is not None and e["last"] is not None and val == e["last"] + 1
            if same:
                it["run"], it["prev"] = e["run"], e["item"]
            else:
                run_no[0] += 1
                it["run"] = run_no[0]
                it["broke"] = e["item"]
            it["parent"] = stack[j - 1]["item"] if j > 0 else None
            del stack[j:]
        else:
            run_no[0] += 1
            it["run"] = run_no[0]
            it["parent"] = stack[-1]["item"] if stack else None
        stack.append({"key": key, "last": val, "item": it, "run": it["run"], "ind": it["ind"]})

    # 3. a list and level for each typed number, in reading order, checked
    # against both counting models as we go
    counters = tuple(Counter(nb, m) for m in MODELS)
    suffix_lists = {}
    usage = {}
    for it in items:
        if it["auto"]:
            a = nb.abstract_of(it["auto"][0])
            usage[a] = usage.get(a, 0) + 1

    def levels_like(num_id, key, deeper_than=-1):
        return [il for il, (lv, _) in sorted(nb.levels(num_id).items())
                if il > deeper_than and lv.key() == key and not lv.pstyle]

    def global_levels(key, ind):
        out = []
        for aid in nb.abs_el:
            lv_map = nb.abstract_levels(aid)
            if not lv_map:
                continue
            clause = nb.is_clause_list(aid)
            for il, lv in lv_map.items():
                if lv.key() != key or lv.pstyle:
                    continue
                if clause and key[0] != "multi" and il <= nb.deepest_multi(aid):
                    continue
                d = abs((lv.ind[0] or 0) - (ind[0] or 0)) + abs((lv.ind[1] or 0) - (ind[1] or 0))
                out.append((0 if key[0] == "multi" or not clause else 1, il > 0 and key[0] != "multi", d, -usage.get(aid, 0), int(aid), il))
        out.sort()
        return [(str(x[4]), x[5]) for x in out]

    def try_label(num_id, ilvl):
        return tuple(c.clone().step(num_id, ilvl) for c in counters)

    def fits(num_id, ilvl, idx, label):
        """The typed label comes out here, and no automatic number after it
        changes (under either counting model)."""
        for c in counters:
            cc = c.clone()
            if cc.step(num_id, ilvl) != label:
                return False
            for x in items[idx + 1:]:
                if x["auto"] and cc.step(*x["auto"]) != before[c.mode].get(x["p"]):
                    return False
        return True

    for idx, it in enumerate(items):
        if it["auto"]:
            for c in counters:
                c.step(*it["auto"])
            continue
        key, label = it["key"], it["typed"]
        cands = []      # (numId, ilvl) to carry on
        homes = []      # (abstractId, ilvl) to start a list again on
        if key[0] == "suffix":
            comps, j = it["parts"], key[2]
            group = ".".join(comps[:j + 1])
            il = len(comps) - 1
            chosen = None
            if group in suffix_lists and fits(suffix_lists[group], il, idx, label):
                chosen = (suffix_lists[group], il)
            else:
                model = next((nb.abstract_of(x["num"][0]) for x in reversed(items[:idx]) if x.get("num") and x["key"][0] == "multi"), None)
                model = model or next((a for a in nb.abs_el if nb.is_clause_list(a)), None)
                if model is not None:
                    aid = nb.add_suffix_abstract(model, comps, key[3], "%s: an inserted clause numbered with a letter; a list of its own, copied from the clause list %s, so the clauses around it keep their numbers" % (group, model))
                    nid = nb.add_num(aid, {}, "inserted clause %s" % group)
                    if fits(nid, il, idx, label):
                        chosen = (nid, il)
                        suffix_lists[group] = nid
                    else:
                        nb.remove_num(nid)
                        nb.remove_abstract(aid)
            if chosen is None:
                rep["left_typed"].append({"text": para_text(it["p"])[:70], "why": "no list could show %s without changing another number" % label})
                continue
            for c in counters:
                c.step(*chosen)
            it["num"] = chosen
            it["restarted"] = None
            continue
        if key[0] == "multi":
            seen_nums = set()
            near = [x for x in reversed(items[:idx]) if x.get("num")] + [x for x in items[idx + 1:] if x["auto"]][:40]
            for x in near:
                nid = x["num"][0]
                if nid in seen_nums:
                    continue
                seen_nums.add(nid)
                for il in levels_like(nid, key):
                    cands.append((nid, il))
                    homes.append((nb.abstract_of(nid), il))
                if len(seen_nums) > 12:
                    break
        else:
            prev = it.get("prev")
            if prev is not None and prev.get("num"):
                cands.append(prev["num"])
                homes.append((nb.abstract_of(prev["num"][0]), prev["num"][1]))
            for x in items[idx + 1:]:
                if x["run"] == it["run"] and x["auto"]:
                    cands.append(x["auto"])
                    homes.append((nb.abstract_of(x["auto"][0]), x["auto"][1]))
                    break
            # under a clause: the clause list's own level for it, if it has one
            par = it.get("parent")
            if par is not None and par.get("num") and it["cell"] is None and nb.is_clause_list(nb.abstract_of(par["num"][0])):
                for il in levels_like(par["num"][0], key, par["num"][1]):
                    cands.append((par["num"][0], il))
                    homes.append((nb.abstract_of(par["num"][0]), il))
        homes += global_levels(key, it["ind"])
        chosen = None
        for nid, il in cands:
            if fits(nid, il, idx, label):
                chosen = (nid, il)
                break
        if chosen is None and key[0] == "multi":
            # "3.1" under an automatic "3." whose list has the next level
            # unused: that level becomes "%1.%2", so the number carries on
            # from its own heading
            head = ".".join(str(x) for x in it["parts"][:-1])
            for x in reversed(items[:idx]):
                if not (x["auto"] and x.get("label", "").strip() in (head, head + ".")):
                    continue
                nid, pil = x["num"]
                aid = nb.abstract_of(nid)
                nxt = nb.abstract_levels(aid).get(pil + 1)
                plv = nb.abstract_levels(aid).get(pil)
                used = any(y.get("num") and nb.abstract_of(y["num"][0]) == aid and y["num"][1] == pil + 1 for y in items)
                if nxt is None or plv is None or used or nxt.pstyle or plv.fmt != "decimal":
                    break
                text = plv.text.rstrip(".") + ".%" + str(pil + 2) + ("." if key[2] else "")
                undo = nb.change_level(aid, pil + 1, "decimal", text, 1,
                                       "%s sits under the automatic %s, whose list had this level unused" % (label, x["label"]))
                if fits(nid, pil + 1, idx, label):
                    chosen = (nid, pil + 1)
                else:
                    undo()
                break
        restarted = None
        if chosen is None:
            if not homes:
                if key[0] == "multi" or key[0] not in ("lowerLetter", "upperLetter", "lowerRoman", "upperRoman", "decimal"):
                    rep["left_typed"].append({"text": para_text(it["p"])[:70], "why": "no list in the document numbers like %s" % label})
                    continue
                # a list like the closest one with this template, in this format
                models = []
                for aid in list(nb.abs_el):
                    for il, lv in nb.abstract_levels(aid).items():
                        k = lv.key()
                        if len(k) == 2 and k[1] == key[1] and not lv.pstyle and not (nb.is_clause_list(aid) and il <= nb.deepest_multi(aid)):
                            d = abs((lv.ind[0] or 0) - (it["ind"][0] or 0)) + abs((lv.ind[1] or 0) - (it["ind"][1] or 0))
                            models.append((il > 0, d, -usage.get(aid, 0), int(aid), il))
                if not models:
                    rep["left_typed"].append({"text": para_text(it["p"])[:70], "why": "no list in the document to model a %s list on" % label})
                    continue
                models.sort()
                _, _, _, maid, mil = models[0]
                aid = nb.add_abstract(str(maid), mil, key[0],
                                      "no list in the pack numbers %s; a copy of list %s with its level %d in %s" % (label, maid, mil + 1, key[0]))
                homes = [(aid, mil)]
            def starts_for(aid, il):
                if key[0] != "multi":
                    return {il: it["value"]}
                # each part of the typed number is the start of the level
                # its placeholder names; a fixed part must already agree
                comps = re.findall(r"%\d|\d+", nb.abstract_levels(aid)[il].text)
                if len(comps) != len(it["parts"]):
                    return None
                out = {}
                for c, v in zip(comps, it["parts"]):
                    if c.startswith("%"):
                        out[int(c[1]) - 1] = v
                    elif int(c) != v:
                        return None
                return out or None
            if it["value"] in (1, None) or key[0] == "multi":
                why = "typed list %s" % label
            else:
                why = "typed list starts at %s" % label
                b = it.get("broke")
                after = (b.get("typed") or b.get("label")) if b is not None else None
                rep["anomalies_kept"].append({"text": para_text(it["p"])[:70], "typed": label,
                                              "why": ("the base's typed numbers go from %s to %s" % (after, label) if after else "a typed list that starts at %s" % label)
                                              + "; the list starts at %s so the pack reads as the base did" % label})
            seen_homes = set()
            for aid, il in homes:
                if (aid, il) in seen_homes:
                    continue
                seen_homes.add((aid, il))
                st = starts_for(aid, il)
                if not st:
                    continue
                nid = nb.add_num(aid, st, why)
                if fits(nid, il, idx, label):
                    chosen = (nid, il)
                    break
                nb.remove_num(nid)
            if chosen is None and homes:
                # every list it could join is also counted later on: a list
                # of its own, a copy of the first choice
                aid, il = homes[0]
                st = starts_for(aid, il)
                if st:
                    lv = nb.abstract_levels(aid)[il]
                    new_aid = nb.add_abstract(aid, il, lv.fmt, "%s: list %s is counted again later in the document, so a copy keeps the two apart" % (label, aid))
                    nid = nb.add_num(new_aid, st, why)
                    if fits(nid, il, idx, label):
                        chosen = (nid, il)
                    else:
                        nb.remove_num(nid)
                        nb.remove_abstract(new_aid)
            if chosen is None:
                rep["left_typed"].append({"text": para_text(it["p"])[:70], "why": "no list in the document can show %s without changing another number" % label})
                continue
            restarted = chosen[0]
        for c in counters:
            c.step(*chosen)
        it["num"] = chosen
        it["restarted"] = restarted

    pos = {p: i for i, p in enumerate(paras)}
    last = None
    for it in items:
        between = paras[pos[last["p"]] + 1:pos[it["p"]]] if last is not None else []
        if it["typed"] and it.get("num") and last is not None and last.get("cell") is it["cell"] and \
                not any(para_text(q).strip() for q in between) and (last.get("typed") or last.get("label")) == it["typed"]:
            rep["anomalies_kept"].append({"text": para_text(it["p"])[:70], "typed": it["typed"],
                                          "why": "the base types %s twice in a row; kept as typed (a list started again at %s)" % (it["typed"], it["typed"])})
        last = it

    # 4. write it: the number off the text, the list on the paragraph
    for it in items:
        if not it["typed"] or not it.get("num"):
            continue
        p = it["p"]
        nid, il = it["num"]
        lv, _ = nb.levels(nid)[il]
        strip_prefix(p, it["cut"])
        set_numpr(p, nid, il)
        how = set_ind(p, it["ind"], lv.ind)
        rep["indents"][how] = rep["indents"].get(how, 0) + 1
        aid = nb.abstract_of(nid)
        lk = "list %s level %d %s" % (aid, il + 1, lv.describe())
        rep["lists_used"][lk] = rep["lists_used"].get(lk, 0) + 1
        rep["converted"].append({"typed": it["typed"], "numId": int(nid), "ilvl": il, "abstractNumId": int(aid),
                                 "indent": how, "text": para_text(p)[:60]})
    rep["numbering_added"] = {"nums": nb.added_nums, "abstracts": nb.added_abstracts, "levels_changed": nb.changed_levels}
    if rep["converted"]:
        pkg.touch(pkg.main_part())

    # 5. the sequence check: every number reads as before, typed or not
    bad = []
    for mode in MODELS:
        after = numbering_labels(body, styles, nb, mode)
        for it in items:
            want = it["typed"] if it["typed"] and it.get("num") else before[mode].get(it["p"])
            if want is None:
                continue
            got = after.get(it["p"])
            if got != want:
                bad.append({"model": MODEL_NAMES[mode], "want": want, "got": got, "text": para_text(it["p"])[:60]})
    rep["sequence_check"] = {"paragraphs_checked": sum(1 for it in items if it["typed"] and it.get("num") or it["auto"]),
                             "models": [MODEL_NAMES[m] for m in MODELS], "mismatches": bad}
    if bad:
        raise SystemExit("auto numbering: %d numbers would change, first: %s" % (len(bad), bad[:3]))
    return rep


def run_on_kinds(kinds, pkg):
    """Kinds numbered by a clause list ("1.", "1.1", "1.1.1") run on through
    the document: the drafting engine must not start them again."""
    if not pkg.has("word/numbering.xml"):
        return []
    nb = Numbering(pkg, style_map(pkg))
    out = []
    for name, k in kinds.items():
        if k.get("numId") is None or str(k["numId"]) not in nb.nums:
            continue
        aid = nb.abstract_of(str(k["numId"]))
        lv = nb.levels(str(k["numId"])).get(k.get("ilvl") or 0)
        if lv and nb.is_clause_list(aid) and (k.get("ilvl") or 0) <= nb.deepest_multi(aid):
            k["restart"] = False
            out.append(name)
    return out


# --------------------------------------------------------------------------
# spelling: British -ise everywhere (the owner's decision of 20 Oct 2026)
# --------------------------------------------------------------------------
CORE_SHEET = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..",
                                           "chat-service", "styleSheets", "core.json"))
# the wording check's own patterns (chat-service/proofCheck.js), case-blind
# here so ORGANIZE becomes ORGANISE too
IZE_WORD = re.compile(r"\b[A-Za-z]*?(?:iz(?:e|es|ed|ing|ation|ations|ational|er|ers|able)|yz(?:e|es|ed|ing|er|ers))\b", re.I)
IZE_KEEP = re.compile(r"(?:size|sized|sizes|sizing|seize|seized|seizes|seizing|seizure|prize|prizes|prized|maize|baize|assize|"
                      r"assizes|citizen\w*|denizen\w*|wizard\w*|blizzard\w*)$")
IZE_SUFFIX = re.compile(r"iz(e|es|ed|ing|ation|ations|ational|er|ers|able)$")
YZE_SUFFIX = re.compile(r"yz(e|es|ed|ing|er|ers)$")
# words before "Organization" that do not make it a name ("The Organization")
NAME_LEADS = {"the", "this", "that", "such", "each", "any", "every", "an", "a", "its", "their", "said", "relevant", "other", "no", "our", "your"}
# a quotation: “…”, "…", or ‘…’ opened at the start or after a space or bracket
QUOTED = re.compile(r"[“\"][^“”\"\n]{0,400}[”\"]|(?:^|(?<=[\s(\[]))‘[^‘’\n]{1,200}’(?![A-Za-z])")


def match_case(model, word):
    if len(model) > 1 and model == model.upper():
        return word.upper()
    if model[:1].isupper():
        return word[:1].upper() + word[1:]
    return word


def edit_segments(segs, bounds, pos, old, new):
    """Replace text[pos:pos+len(old)] by `new` in the paragraph's text
    segments, touching only the letters that differ (authori[z]e ->
    authori[s]e, colo[]r -> colo[u]r), so every other letter keeps its run."""
    a = 0
    while a < min(len(old), len(new)) and old[a] == new[a]:
        a += 1
    b = 0
    while b < min(len(old), len(new)) - a and old[len(old) - 1 - b] == new[len(new) - 1 - b]:
        b += 1
    s, e, mid = pos + a, pos + len(old) - b, new[a:len(new) - b]
    if s == e:
        # a pure insertion goes after the letter before it
        for i, (x, y) in enumerate(bounds):
            if segs[i][0] is not None and x < s <= y:
                segs[i][1] = segs[i][1][:s - x] + mid + segs[i][1][s - x:]
                return
        return
    first = True
    for i, (x, y) in enumerate(bounds):
        if y <= s or x >= e or segs[i][0] is None:
            continue
        ls, le = max(s, x) - x, min(e, y) - x
        segs[i][1] = segs[i][1][:ls] + (mid if first else "") + segs[i][1][le:]
        first = False


def paragraph_segments(p):
    """[[w:t or None, text]] of a paragraph's own text, as blank_paragraph reads it."""
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
    return segs


def write_segments(segs):
    for el, t in segs:
        if el is not None and (el.text or "") != t:
            set_text(el, t)


class Speller:
    """American -ize/-yze/-ization forms, and the style sheet's word list
    (color, favor, program, installment ...), made British, case kept, across
    run boundaries. Kept: the sheet's exceptions (size, seize, prize,
    citizen ...), a capitalised Organization in a proper name, "program"
    after computer/software/training, any phrase the config lists in
    "spelling_keep", and words inside quotation marks (a term quoted from
    another instrument) unless the config lists the quoted text in
    "spelling_quotes_own" as the firm's own."""

    def __init__(self, sheet_path=CORE_SHEET, keep_phrases=(), quotes_own=()):
        if not os.path.exists(sheet_path):
            raise SystemExit("spelling: the style sheet %s is not there (set \"spelling\": false to build without it)" % sheet_path)
        with open(sheet_path, encoding="utf-8") as f:
            sp = json.load(f).get("spelling", {})
        if sp.get("convention") != "ise":
            raise SystemExit("spelling: %s does not ask for -ise" % sheet_path)
        self.sheet_path = sheet_path
        self.words = {k.lower(): v for k, v in (sp.get("words") or {}).items()}
        self.keep = {k.lower() for k in sp.get("keep") or []}
        self.keep_after = {k.lower(): [x.lower() for x in v] for k, v in (sp.get("keep_after") or {}).items()}
        self.map_rx = re.compile(r"\b(" + "|".join(re.escape(k) for k in sorted(self.words, key=len, reverse=True)) + r")\b", re.I) if self.words else None
        self.keep_phrases = [k for k in keep_phrases if k]
        self.quotes_own = set(quotes_own)
        self.changes = {}     # (part, from, to) -> count
        self.kept = {}        # (part, word, why) -> count

    def _bump(self, d, k):
        d[k] = d.get(k, 0) + 1

    def british(self, text, m, mapped):
        """The British form of the word matched, or (None, why kept)."""
        word = m.group(0)
        lower = word.lower()
        if mapped:
            prev = re.search(r"([A-Za-z]+)\s+$", text[max(0, m.start() - 20):m.start()])
            if prev and prev.group(1).lower() in self.keep_after.get(lower, []):
                return None, "after '%s'" % prev.group(1)
            return match_case(word, self.words[lower]), None
        if len(lower) < 5 or lower in self.keep or IZE_KEEP.search(lower):
            return None, "an exception the style sheet keeps"
        if lower.startswith("organization") and word[:1].isupper():
            before = text[max(0, m.start() - 30):m.start()]
            after = text[m.end():m.end() + 30]
            lead = re.search(r"([A-Z][\w&-]*)\s+$", before)
            if (lead and lead.group(1).lower() not in NAME_LEADS) or re.match(r"\s+(?:for|of)\s+[A-Z]", after):
                return None, "a named Organization (a proper name keeps its own spelling)"
        new = YZE_SUFFIX.sub(r"ys\1", IZE_SUFFIX.sub(r"is\1", lower))
        if new == lower:
            return None, None
        return match_case(word, new), None

    def paragraph(self, p, part):
        segs = paragraph_segments(p)
        text = "".join(s[1] for s in segs)
        if not text.strip():
            return 0
        guard = []
        for k in self.keep_phrases:
            for mm in re.finditer(re.escape(k), text):
                guard.append((mm.start(), mm.end(), "listed in spelling_keep"))
        for mm in QUOTED.finditer(text):
            inner = mm.group(0)[1:-1]
            if inner not in self.quotes_own:
                guard.append((mm.start(), mm.end(), "inside quotation marks (a term quoted from another instrument)"))
        edits = {}
        for rx, mapped in ((IZE_WORD, False), (self.map_rx, True)):
            if rx is None:
                continue
            for m in rx.finditer(text):
                if m.start() in edits:
                    continue
                g = next((why for a, b, why in guard if a <= m.start() and m.end() <= b), None)
                new, why = self.british(text, m, mapped)
                if new is None or new == m.group(0):
                    if why:
                        self._bump(self.kept, (part, m.group(0), why))
                    continue
                if g:
                    self._bump(self.kept, (part, m.group(0), g))
                    continue
                edits[m.start()] = (m.group(0), new)
        if not edits:
            return 0
        bounds = []
        pos = 0
        for s in segs:
            bounds.append((pos, pos + len(s[1])))
            pos += len(s[1])
        for at in sorted(edits, reverse=True):
            old, new = edits[at]
            edit_segments(segs, bounds, at, old, new)
            self._bump(self.changes, (part, old, new))
        write_segments(segs)
        return len(edits)

    def run(self, pkg):
        """Every story part (document, headers, footers, footnotes, endnotes);
        only parts that change are re-written."""
        for part in [x for x in pkg.parts() if STORY.match(x)]:
            n = sum(self.paragraph(p, part) for p in pkg.xml(part).iter(w("p")))
            if n:
                pkg.touch(part)

    def report(self):
        ch = [{"part": a, "from": b, "to": c, "count": n} for (a, b, c), n in sorted(self.changes.items())]
        kept = [{"part": a, "word": b, "why": c, "count": n} for (a, b, c), n in sorted(self.kept.items())]
        repo = os.path.dirname(os.path.dirname(os.path.dirname(CORE_SHEET)))
        sheet = os.path.relpath(self.sheet_path, repo) if os.path.abspath(self.sheet_path).startswith(repo + os.sep) else self.sheet_path
        return {"convention": "british (-ise)", "sheet": sheet,
                "changed": sum(x["count"] for x in ch), "changes": ch, "kept": kept}


# --------------------------------------------------------------------------
# a quoted defined term put in the firm's form: (the **Term**), no quotes
# --------------------------------------------------------------------------
def _is_bold(r):
    b = r.find("w:rPr/w:b", NS)
    return b is not None and wa(b, "val", "1") not in ("0", "false")


def _set_bold(r):
    rpr = r.find(w("rPr"))
    if rpr is None:
        rpr = etree.Element(w("rPr"))
        r.insert(0, rpr)
    for x in rpr.findall(w("b")):
        rpr.remove(x)
    b = etree.Element(w("b"))
    at = 0
    for i, ch in enumerate(rpr):
        if ch.tag in (w("rStyle"), w("rFonts")):
            at = i + 1
    rpr.insert(at, b)


def _split_run(t, start, end):
    """The run holding w:t `t` split so that t.text[start:end] is a run of
    its own (copies of the run's rPr on each piece); returns that run."""
    r = t.getparent()
    if [ch.tag for ch in r if ch.tag != w("rPr")] != [w("t")]:
        raise SystemExit("unquote_terms: a run holding more than its text; put the term in its own run by hand")
    s = t.text or ""
    pieces = [(s[:start], False), (s[start:end], True), (s[end:], False)]
    out = None
    for txt, mine in pieces:
        if not txt:
            continue
        nr = copy.deepcopy(r)
        set_text(nr.find(w("t")), txt)
        r.addprevious(nr)
        if mine:
            out = nr
    r.getparent().remove(r)
    return out


def unquote_terms(pkg, terms, log):
    """terms: [{"term", "reason"}]. Each “Term” (or "Term") loses its
    quotation marks and is bold; a run left with no text is removed."""
    if not terms:
        return 0
    n = 0
    for part in [x for x in pkg.parts() if STORY.match(x)]:
        changed = False
        for p in list(pkg.xml(part).iter(w("p"))):
            for spec in terms:
                term = spec["term"]
                while True:
                    segs = paragraph_segments(p)
                    text = "".join(s[1] for s in segs)
                    m = re.search(r"[“\"](" + re.escape(term) + r")[”\"]", text)
                    if not m:
                        break
                    bounds = []
                    pos = 0
                    for s in segs:
                        bounds.append((pos, pos + len(s[1])))
                        pos += len(s[1])
                    had = {id(sg[0]) for sg in segs if sg[0] is not None and sg[1]}
                    edit_segments(segs, bounds, m.end() - 1, text[m.end() - 1], "")
                    edit_segments(segs, bounds, m.start(), text[m.start()], "")
                    write_segments(segs)
                    emptied = [sg[0] for sg in segs if sg[0] is not None and not sg[1] and id(sg[0]) in had]
                    # bold on every letter of the term
                    ts, te = m.start(), m.end() - 2
                    pos = 0
                    for el, t in [(s[0], s[1]) for s in paragraph_segments(p)]:
                        a, b = pos, pos + len(t)
                        pos = b
                        if el is None or b <= ts or a >= te:
                            continue
                        r = el.getparent()
                        if _is_bold(r):
                            continue
                        ls, le = max(ts, a) - a, min(te, b) - a
                        piece = r if (ls, le) == (0, len(t)) else _split_run(el, ls, le)
                        _set_bold(piece)
                    for t in emptied:   # a run that held only a quotation mark
                        r = t.getparent()
                        if r is not None and r.getparent() is not None and [ch.tag for ch in r if ch.tag != w("rPr")] == [w("t")]:
                            r.getparent().remove(r)
                    log.append((part, "", m.group(0), "%s -> %s (bold, no quotation marks)" % (spec.get("reason", "defined term in the firm's form"), term)))
                    n += 1
                    changed = True
        if changed:
            pkg.touch(part)
    return n


# --------------------------------------------------------------------------
# the build
# --------------------------------------------------------------------------
# --------------------------------------------------------------------------
# wave-2 options (each runs only when its config key is present, so a
# config without them builds exactly as before)
# --------------------------------------------------------------------------
FONT_ATTRS = ("ascii", "hAnsi", "cs", "eastAsia")
FONT_PARTS = re.compile(r"^word/(document|header\d+|footer\d+|footnotes|endnotes|styles|numbering)\.xml$")


def convert_fonts(pkg, font_map, size_map, extra=()):
    """"font_map": {"Times New Roman": "Arial"} and "size_map": {"25": "22"}
    (half-points): every explicit font and size in the story parts, styles
    (document defaults included) and list levels is moved to the house
    font and size. A theme font reference (asciiTheme ...) whose theme
    typeface is mapped is replaced by the explicit house font. `extra` are
    detached elements (kind examples) to convert as well."""
    theme = {}
    for part in [p for p in pkg.parts() if re.match(r"^word/theme/theme\d+\.xml$", p)]:
        root = pkg.xml(part)
        A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
        for key, tag in (("minor", "minorFont"), ("major", "majorFont")):
            el = root.find(".//%s%s/%slatin" % (A, tag, A))
            if el is not None:
                theme[key] = el.get("typeface")
    counts = collections.Counter()

    def fix(root, where):
        n = 0
        for rf in root.iter(w("rFonts")):
            for a in FONT_ATTRS:
                v = rf.get(w(a))
                if v in font_map:
                    rf.set(w(a), font_map[v])
                    counts["%s -> %s" % (v, font_map[v])] += 1
                    n += 1
            for a in ("asciiTheme", "hAnsiTheme", "cstheme", "eastAsiaTheme"):
                v = rf.get(w(a))
                if v is None:
                    continue
                face = theme.get("major" if v.startswith("major") else "minor")
                if face in font_map:
                    del rf.attrib[w(a)]
                    plain = {"asciiTheme": "ascii", "hAnsiTheme": "hAnsi", "cstheme": "cs", "eastAsiaTheme": "eastAsia"}[a]
                    rf.set(w(plain), font_map[face])
                    counts["theme %s (%s) -> %s" % (v, face, font_map[face])] += 1
                    n += 1
        for tag in ("sz", "szCs"):
            for el in root.iter(w(tag)):
                v = el.get(w("val"))
                if v in size_map:
                    el.set(w("val"), size_map[v])
                    counts["size %s -> %s half-points" % (v, size_map[v])] += 1
                    n += 1
        return n

    for part in [p for p in pkg.parts() if FONT_PARTS.match(p)]:
        if fix(pkg.xml(part), part):
            pkg.touch(part)
    for el in extra:
        if el is not None and el.getparent() is None:
            fix(el, "example")
    # a paragraph or run with no explicit font falls back to the document
    # defaults: make sure those name the house font
    if pkg.has("word/styles.xml") and font_map:
        st = pkg.xml("word/styles.xml")
        house = sorted(set(font_map.values()))[0]
        rpr = st.find("w:docDefaults/w:rPrDefault/w:rPr", NS)
        if rpr is not None:
            rf = rpr.find(w("rFonts"))
            if rf is None:
                rf = etree.Element(w("rFonts"))
                rpr.insert(0, rf)
            if not any(rf.get(w(a)) for a in FONT_ATTRS[:2]):
                for a in list(rf.attrib):
                    if a.endswith("Theme") or a.endswith("theme"):
                        del rf.attrib[a]
                rf.set(w("ascii"), house)
                rf.set(w("hAnsi"), house)
                rf.set(w("cs"), house)
                counts["document default font set to %s" % house] += 1
                pkg.touch("word/styles.xml")
    return dict(counts)


def set_margins(root, margins):
    """"margins_twips": {"top": ..., "bottom": ..., "left": ..., "right": ...}
    written on every section."""
    out = []
    for i, sp in enumerate(root.iter(w("sectPr"))):
        mar = sp.find(w("pgMar"))
        if mar is None:
            continue
        was = {k: wa(mar, k) for k in margins}
        for k, v in margins.items():
            mar.set(w(k), str(v))
        out.append("section %d: margins %s -> %s" % (i + 1, was, margins))
    return out


def fit_tables(root, pkg=None):
    """Scale every table wider than the text width (after the page turned
    or shrank) down to the text width: grid, table width and cell widths
    alike, in proportion. With `pkg`, tables in headers and footers too."""
    sects = list(root.iter(w("sectPr")))
    if not sects:
        return []
    sp = sects[-1]
    sz, mar = sp.find(w("pgSz")), sp.find(w("pgMar"))
    text_w = int(wa(sz, "w", "0")) - int(wa(mar, "left", "0")) - int(wa(mar, "right", "0"))
    out = []
    body = root.find(w("body"))
    tables = [(i, b) for i, b in enumerate(body_blocks(body)) if b.tag == w("tbl")]
    if pkg is not None:
        for part in [p for p in pkg.parts() if re.match(r"^word/(header|footer)\d+\.xml$", p)]:
            tables += [(part, t) for t in pkg.xml(part).iter(w("tbl"))]
    for i, b in tables:
        if b.tag != w("tbl"):
            continue
        tblpr = b.find(w("tblPr"))
        tw = tblpr.find(w("tblW")) if tblpr is not None else None
        ind = tblpr.find(w("tblInd")) if tblpr is not None else None
        grid = [g for g in b.find(w("tblGrid")).findall(w("gridCol"))] if b.find(w("tblGrid")) is not None else []
        gw = sum(int(wa(g, "w", "0")) for g in grid)
        width = int(wa(tw, "w", "0")) if tw is not None and wa(tw, "type") == "dxa" else gw
        off = int(wa(ind, "w", "0")) if ind is not None and wa(ind, "type", "dxa") == "dxa" else 0
        if not width or width + off <= text_w + 30:
            continue
        f = (text_w - max(off, 0)) / float(width + 0)
        for g in grid:
            g.set(w("w"), str(int(int(wa(g, "w", "0")) * f)))
        if tw is not None and wa(tw, "type") == "dxa":
            tw.set(w("w"), str(int(width * f)))
        for tcw in b.iter(w("tcW")):
            if wa(tcw, "type", "dxa") == "dxa" and wa(tcw, "w"):
                tcw.set(w("w"), str(int(int(wa(tcw, "w")) * f)))
        if isinstance(i, str) and pkg is not None:
            pkg.touch(i)
        out.append({"block": i, "was_twips": width, "now_twips": int(width * f), "text_width_twips": text_w})
    return out


DEFINING_QUOTE = re.compile(r"[“\"]([A-Z][^“”\"\n]{0,70}?)[”\"](?=\s*(?:\)|,|;|and\b|or\b|means\b|shall\s+mean|shall\s+have|has\s+the\s+meaning|shall\s+bear))")


def defined_terms_quoted(pkg, skip=()):
    """"unquote_all": every quoted defined term in a defining formula
    ((the “Term”) or “Term” means ...), for unquote_terms."""
    found = collections.OrderedDict()
    for part in [x for x in pkg.parts() if STORY.match(x)]:
        for p in pkg.xml(part).iter(w("p")):
            for m in DEFINING_QUOTE.finditer(para_text(p)):
                t = m.group(1).strip()
                if t and t not in skip and len(t.split()) <= 8:
                    found[t] = True
    return [{"term": t, "reason": "a quoted defined term made the firm's form"} for t in sorted(found, key=lambda x: -len(x))]


def number_headings(pkg, body, spec):
    """"heading_numbers": {"pattern": "^Article (\\d+)$", "numId": "13",
    "lvlText": "Article %1"}: a heading number typed as its own line
    ("Article 2" above the article's title) becomes level 1 of the clause
    list the article's clauses are on, so "2.1" counts from the heading in
    Word and LibreOffice alike. The list's first level, used by no other
    paragraph, takes the typed line's look; every paragraph on another num
    of the same list is moved onto `numId` (their start overrides are no
    longer needed)."""
    rx = re.compile(spec["pattern"])
    nroot = pkg.xml("word/numbering.xml")
    num_id = str(spec["numId"])
    absid = None
    for n in nroot.findall(w("num")):
        if wa(n, "numId") == num_id:
            absid = wa(n.find(w("abstractNumId")), "val")
    if absid is None:
        raise SystemExit("heading_numbers: no w:num %s" % num_id)
    same = {wa(n, "numId") for n in nroot.findall(w("num")) if wa(n.find(w("abstractNumId")), "val") == absid}
    absn = [a for a in nroot.findall(w("abstractNum")) if wa(a, "abstractNumId") == absid][0]
    lvl0 = [l for l in absn.findall(w("lvl")) if wa(l, "ilvl") == "0"][0]
    heads = [p for p in body_paragraphs(body) if rx.match(para_text(p).strip())]
    if not heads:
        return {"headings": 0}
    for p in body_paragraphs(body):
        ppr = p.find(w("pPr"))
        np_ = ppr.find(w("numPr")) if ppr is not None else None
        if np_ is not None and wa(np_.find(w("ilvl")), "val") == "0" and wa(np_.find(w("numId")), "val") in same:
            raise SystemExit("heading_numbers: level 1 of list %s is already used" % absid)
    first = heads[0]
    tr = text_runs(first)
    look = copy.deepcopy(tr[0].find(w("rPr"))) if tr and tr[0].find(w("rPr")) is not None else None
    for tag, val in (("start", "1"), ("numFmt", "decimal"), ("lvlText", spec.get("lvlText", "Article %1"))):
        el = lvl0.find(w(tag))
        el.set(w("val"), val)
    if lvl0.find(w("suff")) is None:
        suff = etree.Element(w("suff"))
        suff.set(w("val"), "nothing")
        lvl0.find(w("lvlText")).addprevious(suff)
    for tag in ("pPr", "rPr"):
        old = lvl0.find(w(tag))
        if old is not None:
            lvl0.remove(old)
    lp = etree.SubElement(lvl0, w("pPr"))
    jc = etree.SubElement(lp, w("jc"))
    jc.set(w("val"), spec.get("jc", "center"))
    ind = etree.SubElement(lp, w("ind"))
    ind.set(w("left"), "0")
    ind.set(w("firstLine"), "0")
    if look is not None:
        lvl0.append(look)
    pkg.touch("word/numbering.xml")
    for p in heads:
        ppr = p.find(w("pPr"))
        for ch in list(p):
            if ch is not ppr:
                p.remove(ch)
        set_numpr(p, num_id, 0)
        old_ind = p.find("w:pPr/w:ind", NS)
        if old_ind is not None:
            old_ind.getparent().remove(old_ind)
    moved = 0
    for p in body_paragraphs(body):
        ppr = p.find(w("pPr"))
        np_ = ppr.find(w("numPr")) if ppr is not None else None
        if np_ is not None and wa(np_.find(w("numId")), "val") in same - {num_id}:
            np_.find(w("numId")).set(w("val"), num_id)
            moved += 1
    return {"headings": len(heads), "list": absid, "numId": num_id, "lvlText": spec.get("lvlText", "Article %1"), "clauses_moved_onto_it": moved}


BOLD_MARK = re.compile(r"\*\*(.+?)\*\*")


def compose_paragraph(model, text):
    """A new paragraph in the look of `model` (a kind's example paragraph):
    its pPr and its first text run's rPr, reading `text`. **Term** is
    written bold (a defined term), a tab as Word's tab."""
    p = etree.Element(w("p"))
    ppr = model.find(w("pPr"))
    if ppr is not None:
        ppr = copy.deepcopy(ppr)
        for x in ppr.findall(w("sectPr")) + ppr.findall(w("pPrChange")):
            ppr.remove(x)
        p.append(ppr)
    tr = text_runs(model)
    base = tr[0].find(w("rPr")) if tr else None
    if base is not None and "**" in text:
        # bold is marked: the rest of the text is not bold even where the
        # model's first run (a definition's term) is
        base = copy.deepcopy(base)
        for x in base.findall(w("b")) + base.findall(w("bCs")):
            base.remove(x)
    pos = 0
    pieces = []
    for m in BOLD_MARK.finditer(text):
        if m.start() > pos:
            pieces.append((text[pos:m.start()], False))
        pieces.append((m.group(1), True))
        pos = m.end()
    if pos < len(text):
        pieces.append((text[pos:], False))
    for chunk, bold in pieces:
        for k, seg in enumerate(chunk.split("\t")):
            if k:
                r = etree.SubElement(p, w("r"))
                if base is not None:
                    r.append(copy.deepcopy(base))
                etree.SubElement(r, w("tab"))
            if not seg:
                continue
            r = etree.SubElement(p, w("r"))
            rpr = copy.deepcopy(base) if base is not None else None
            if bold:
                if rpr is None:
                    rpr = etree.Element(w("rPr"))
                if rpr.find(w("b")) is None:
                    b = etree.Element(w("b"))
                    # w:b sits after rStyle/rFonts in the schema order
                    at = 0
                    for j, ch in enumerate(rpr):
                        if ch.tag in (w("rStyle"), w("rFonts")):
                            at = j + 1
                    rpr.insert(at, b)
                    rpr.insert(at + 1, etree.Element(w("bCs")))
            if rpr is not None:
                r.append(rpr)
            set_text(etree.SubElement(r, w("t")), seg)
    return p


def restart_num(pkg, p):
    """Put paragraph p (a list item) on a new w:num of the same list whose
    level starts again at 1, as the engine's write op does for a new
    (a)/(b) list."""
    np_ = p.find("w:pPr/w:numPr", NS)
    if np_ is None or not pkg.has("word/numbering.xml"):
        return None
    nid, ilvl = wa(np_.find(w("numId")), "val"), wa(np_.find(w("ilvl")), "val", "0")
    nroot = pkg.xml("word/numbering.xml")
    src = [n for n in nroot.findall(w("num")) if wa(n, "numId") == nid]
    if not src:
        return None
    new_id = str(max(int(wa(n, "numId")) for n in nroot.findall(w("num"))) + 1)
    num = etree.Element(w("num"))
    num.set(w("numId"), new_id)
    an = etree.SubElement(num, w("abstractNumId"))
    an.set(w("val"), wa(src[0].find(w("abstractNumId")), "val"))
    ov = etree.SubElement(num, w("lvlOverride"))
    ov.set(w("ilvl"), ilvl)
    so = etree.SubElement(ov, w("startOverride"))
    so.set(w("val"), "1")
    nroot.findall(w("num"))[-1].addnext(num)
    pkg.touch("word/numbering.xml")
    np_.find(w("numId")).set(w("val"), new_id)
    return new_id


def compose(anchors, held, log, spacer=None, pkg=None, restart=()):
    """"compose": [{"after": <block>, "blocks": [{"kind", "text"}]}]: write
    the firm's own text into the pack in its kinds, in order after the
    anchor block (a fresh standard in the firm's layout). With
    "compose_spacer" (a kind), an empty paragraph of that kind follows each
    block, as the firm's files space paragraphs with empty ones."""
    n = 0
    for anchor, blocks in anchors:
        at = anchor
        prev = None
        cur_num = {}
        for blk in blocks:
            model = held.get(blk["kind"])
            if model is None:
                raise SystemExit("compose: no kind %r in this pack" % blk["kind"])
            p = compose_paragraph(model, blk.get("text", ""))
            if blk["kind"] in restart and pkg is not None:
                # "compose_restart": each run of these list kinds starts again at (a)
                if prev != blk["kind"]:
                    cur_num[blk["kind"]] = restart_num(pkg, p)
                elif cur_num.get(blk["kind"]):
                    p.find("w:pPr/w:numPr/w:numId", NS).set(w("val"), cur_num[blk["kind"]])
            prev = blk["kind"]
            at.addnext(p)
            at = p
            n += 1
            if spacer is not None and not blk.get("no_space"):
                sp = compose_paragraph(held[spacer], "")
                at.addnext(sp)
                at = sp
    log.append(("word/document.xml", "", "%d paragraphs of the firm's own text written in the pack's kinds" % n, "composed"))
    return n


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
    # "cut": "shell" cuts a form pack like a shell (a fresh standard: the
    # firm's furniture and kinds, its text written by "compose")
    shell_cut = cfg["mode"] == "shell" or cfg.get("cut") == "shell"
    # typed clause and limb numbers become Word's own numbering (before any
    # blanking, so the typed numbers are read as the base has them)
    if cfg.get("auto_number", cfg["mode"] == "form" or cfg["mode"] == "shell"):
        blocks0 = body_blocks(body)
        skip = set()
        for i in cfg.get("delete_blocks", []):
            b = blocks0[int(i)]
            skip |= set([b] if b.tag == w("p") else b.iter(w("p")))
        for sel in cfg.get("replace_paragraphs", {}):
            skip.add(select(body, sel))
        only = None
        if shell_cut:
            # a shell keeps only its furniture and examples: convert those
            sh = cfg["shell"]
            only = set()
            for k in list(sh.get("keep", {})) + list(sh.get("examples", {})) + list(sh.get("example_tables", {})) + list(sh.get("toc", [])):
                b = blocks0[int(k)]
                only |= set([b] if b.tag == w("p") else b.iter(w("p")))
        report["auto_number"] = auto_number(pkg, only=only, skip=skip)
    else:
        report["auto_number"] = None
    if cfg.get("heading_numbers"):
        report["heading_numbers"] = number_headings(pkg, body, cfg["heading_numbers"])
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
    comp_anchors = [(select(body, c["after"]), c["blocks"]) for c in cfg.get("compose", [])]

    if shell_cut:
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
                kh = shell.get("table_headers_kept", [])
                kh = kh.get(str(i), 0) if isinstance(kh, dict) else (1 if str(i) in kh else 0)
                strip_table_to_example(b, keep_rows=shell.get("table_rows", {}).get(str(i), 2), keep_header=kh)
                if isinstance(shell.get("table_headers_kept"), dict):
                    # header rows kept as words: their facts are blanked like furniture
                    for tr in b.findall(w("tr"))[:kh]:
                        for p in tr.iter(w("p")):
                            blanker.blank_paragraph(p, (doc, "block %d header" % i))
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
        if comp_anchors:
            report["composed"] = compose(comp_anchors, held, blanker.log, spacer=cfg.get("compose_spacer"),
                                         pkg=pkg, restart=cfg.get("compose_restart", ()))
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
        # replaced paragraphs are found before any block is deleted, so both
        # lists number the blocks as the listing does
        replaced = [(sel, select(body, sel), text) for sel, text in cfg.get("replace_paragraphs", {}).items()]
        for i in sorted((int(x) for x in cfg.get("delete_blocks", [])), reverse=True):
            b = blocks[i]
            blanker.log.append((doc, "block %d" % i, para_text(b) if b.tag == w("p") else "(table)", "deal-specific paragraph removed"))
            drop(b)
        for sel, p, text in replaced:
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
    report["page_changes"] = to_a4(root, turn=cfg.get("turn_margins", True), keep_landscape=cfg.get("keep_landscape", False))
    if cfg.get("margins_twips"):
        report["page_changes"] += set_margins(root, cfg["margins_twips"])
    if cfg.get("fit_tables"):
        report["tables_fitted"] = fit_tables(root, pkg)
    # tidy
    report["notes_removed"] = prune_notes(pkg, doc)
    if shell_cut:
        for part in ("word/footnotes.xml", "word/endnotes.xml"):
            if pkg.has(part):
                n = sum(blanker.blank_paragraph(p, (part, "kept note")) for p in pkg.xml(part).iter(w("p")))
                if n:
                    pkg.touch(part)
    # a quoted defined term made the firm's form, then British spelling
    uq = list(cfg.get("unquote_terms", []))
    if cfg.get("unquote_all"):
        have = {t["term"] for t in uq}
        uq += [t for t in defined_terms_quoted(pkg, skip=set(cfg.get("keep_quoted", []))) if t["term"] not in have]
    report["terms_unquoted"] = unquote_terms(pkg, uq, blanker.log)
    sp = cfg.get("spelling", "british")
    if sp:
        if sp != "british":
            raise SystemExit("spelling: only \"british\" (or false) is known, not %r" % sp)
        speller = Speller(cfg.get("spelling_sheet", CORE_SHEET), cfg.get("spelling_keep", []), cfg.get("spelling_quotes_own", []))
        speller.run(pkg)
        report["spelling"] = speller.report()
    else:
        report["spelling"] = None
    if cfg.get("font_map") or cfg.get("size_map"):
        report["fonts_converted"] = convert_fonts(pkg, cfg.get("font_map", {}), cfg.get("size_map", {}),
                                                  extra=list(held.values()))
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
    report["kinds_run_on"] = run_on_kinds(kinds, pkg)
    if report.get("auto_number") is not None and pkg.has("word/numbering.xml"):
        # the base's own numbers that read differently by how Word shares a
        # list's counters, as they read in the finished pack (the sequence
        # check showed the conversion changed none of them)
        nb = Numbering(pkg, style_map(pkg))
        st = style_map(pkg)
        ms = {m: numbering_labels(body, st, nb, m) for m in MODELS}
        report["auto_number"]["base_ambiguous"] = [dict({"text": para_text(p)[:60]}, **{m: ms[m].get(p) for m in MODELS})
                                                   for p in body_paragraphs(body) if p in ms["own"] and len({ms[m].get(p) for m in MODELS}) > 1]
    kj = {"kinds": kinds, "tables": tables, "footnote": fn}
    if cfg.get("drop_examples"):
        # a composed pack: the example paragraphs gave the kinds their look;
        # the firm's text written by "compose" replaces them
        dropped = 0
        ex_names = set(cfg.get("shell", {}).get("examples", {}).values())
        for name, el in held.items():
            if name in ex_names and el.getparent() is not None and para_text(el).strip() == BLANK and name not in cfg.get("keep_examples", []):
                drop(el)
                dropped += 1
        report["examples_dropped"] = dropped
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
