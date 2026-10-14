"""Build an AKLA "Riali-style" deck from a YAML content file.

The style is the one used for RI6.1 (Riali), WP5.x (CDA SWM) and PI4.x (PIDG
Dhabeji): navy header band with a gold small-caps running header, a navy
small-caps title over a rule, a borderless two-column table of numbered items,
the AKLA logo bottom-left, akla.com.pk centred and the page number right.

The base package (tools/base/riali_base.pptx, a copy of PI4.2) supplies the
master, background and logo. Its first slide is cloned for every slide in the
YAML file, then the base slides are removed.

Usage: python3 build_deck.py content.yaml out.pptx
"""
import copy
import re
import sys
from pathlib import Path

import yaml
from lxml import etree
from pptx import Presentation
from pptx.opc.constants import RELATIONSHIP_TYPE as RT

BASE = Path(__file__).resolve().parent.parent / "assets" / "riali_base.pptx"
A = "http://schemas.openxmlformats.org/drawingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS = {"a": A, "p": "http://schemas.openxmlformats.org/presentationml/2006/main"}

NAVY = "1F3864"
GOLD = "F2A900"
FONT = ('<a:latin typeface="Arial" pitchFamily="34" charset="0" />'
        '<a:ea typeface="Arial" pitchFamily="34" charset="-122" />'
        '<a:cs typeface="Arial" pitchFamily="34" charset="-120" />')
END = ('<a:endParaRPr lang="en-US" sz="1200" dirty="0"><a:latin typeface="Arial" charset="0" />'
       '<a:ea typeface="Arial" charset="0" /><a:cs typeface="Arial" charset="0" /></a:endParaRPr>')
NO_BORDER = "".join(
    f'<a:{s} w="0" cap="flat" cmpd="sng" algn="ctr"><a:noFill /></a:{s}>' for s in ("lnL", "lnR", "lnT", "lnB"))
TCPR = f'<a:tcPr marL="0" marR="0" marT="0" marB="0">{NO_BORDER}</a:tcPr>'

# Point sizes (hundredths) used by the reference decks.
HEADER = (1050, 850)      # running header: capitals, small caps
TITLE = (2600, 2000)      # slide title
HEAD = (1800, 1500)       # item heading in the table
SUMMARY = 1700            # text after the item heading
BULLET = 1500             # sub-bullets
SPACER = 1400             # blank paragraph between items


def esc(t):
    t = t.replace("'", "\u2019")  # curly apostrophes, as in the reference decks
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def run(text, sz, col=NAVY, bold=False, extra=""):
    b = ' b="1"' if bold else ""
    return (f'<a:r><a:rPr lang="en-US" sz="{sz}"{b}{extra} dirty="0"><a:solidFill><a:srgbClr val="{col}" />'
            f'</a:solidFill>{FONT}</a:rPr><a:t xml:space="preserve">{esc(text)}</a:t></a:r>')


def small_caps(text, big, small, col=NAVY, extra=""):
    """Simulate small caps the way the reference decks do: original capitals,
    digits and punctuation at the large size; lower-case letters upper-cased at
    the small size."""
    out, cur, cls = [], "", None
    for ch in text:
        c = "s" if ch.islower() else "b"
        if cls is not None and c != cls:
            out.append(run(cur.upper(), big if cls == "b" else small, col, True, extra))
            cur = ""
        cur += ch
        cls = c
    if cur:
        out.append(run(cur.upper(), big if cls == "b" else small, col, True, extra))
    return "".join(out)


def rich(text, sz):
    """Plain text with **bold** spans."""
    parts = re.split(r"(\*\*.+?\*\*)", text)
    return "".join(run(p[2:-2], sz, bold=True) if p.startswith("**") else run(p, sz) for p in parts if p)


def para(body, algn="just", bullet=False):
    if bullet:
        ppr = (f'<a:pPr marL="411480" indent="-228600" algn="{algn}"><a:spcBef><a:spcPts val="200"/></a:spcBef>'
               '<a:buFont typeface="Arial" pitchFamily="34" charset="0"/><a:buChar char="&#8226;"/></a:pPr>')
    else:
        ppr = f'<a:pPr marL="0" indent="0" algn="{algn}"><a:buNone /></a:pPr>'
    return f"<a:p>{ppr}{body}{END}</a:p>"


def item_row(n, item, last):
    num = para(run(f"{n}.", HEAD[0], bold=True), algn="l")
    paras = [para(small_caps(item["heading"], *HEAD) + run(":", HEAD[0], bold=True)
                  + rich(" " + item["summary"], SUMMARY))]
    for b in item.get("bullets", []):
        paras.append(para(run(b["label"] + ": ", BULLET, bold=True) + rich(b["text"], BULLET), bullet=True))
    if not last:
        paras.append(para(run(" ", SPACER, col="000000")))
    cell = lambda ps: f'<a:tc><a:txBody><a:bodyPr /><a:lstStyle />{ps}</a:txBody>{TCPR}</a:tc>'
    return f'<a:tr h="0" xmlns:a="{A}">{cell(num)}{cell("".join(paras))}</a:tr>'


def set_text(sp, xml_runs, sz_end):
    p = sp.find(".//a:p", NS)
    for r in p.findall("a:r", NS):
        p.remove(r)
    end = p.find("a:endParaRPr", NS)
    frag = etree.fromstring(f'<x xmlns:a="{A}">{xml_runs}</x>')
    for i, r in enumerate(frag):
        end.addprevious(r) if end is not None else p.append(r)


def build(content_path, out_path):
    spec = yaml.safe_load(Path(content_path).read_text())
    prs = Presentation(str(BASE))
    tmpl = prs.slides[0]
    n_base = len(prs.slides)
    counter = 0
    for k, sd in enumerate(spec["slides"], 1):
        s = prs.slides.add_slide(tmpl.slide_layout)
        # copy background + shapes, re-pointing image relationships
        rid_map = {}
        for rel in tmpl.part.rels.values():
            if rel.reltype == RT.IMAGE:
                rid_map[rel.rId] = s.part.relate_to(rel.target_part, RT.IMAGE)
        new_csld = copy.deepcopy(tmpl._element.find("p:cSld", NS))
        for el in new_csld.iter():
            v = el.get(f"{{{R}}}embed")
            if v in rid_map:
                el.set(f"{{{R}}}embed", rid_map[v])
        s._element.replace(s._element.find("p:cSld", NS), new_csld)
        shapes = {sp.find(".//p:cNvPr", NS).get("name"): sp for sp in new_csld.find("p:spTree", NS)
                  if sp.find(".//p:cNvPr", NS) is not None}
        set_text(shapes["Text 1"], small_caps(spec["header"], *HEADER, col=GOLD, extra=' kern="0" spc="100"'), 0)
        set_text(shapes["Text 2"], small_caps(sd["title"], *TITLE), 0)
        set_text(shapes["Text 5"], run(str(k), 1100), 0)
        tbl = shapes["Table 0"].find(".//a:tbl", NS)
        for tr in tbl.findall("a:tr", NS):
            tbl.remove(tr)
        for i, it in enumerate(sd["items"]):
            counter += 1
            tbl.append(etree.fromstring(item_row(counter, it, i == len(sd["items"]) - 1)))
        if sd.get("notes"):
            # the base notes master has no body placeholder, so take the
            # template slide's notes layout and write into its body
            ns = s.notes_slide
            ns._element.replace(ns._element.find("p:cSld", NS),
                                copy.deepcopy(tmpl.notes_slide._element.find("p:cSld", NS)))
            ns.notes_text_frame.text = " ".join(sd["notes"].split())
    # drop the base slides
    sld_ids = prs.slides._sldIdLst
    for sid in list(sld_ids)[:n_base]:
        prs.part.drop_rel(sid.get(f"{{{R}}}id"))
        sld_ids.remove(sid)
    prs.save(out_path)
    print(f"built {out_path}: {len(spec['slides'])} slides, {counter} items")


if __name__ == "__main__":
    build(sys.argv[1], sys.argv[2])
