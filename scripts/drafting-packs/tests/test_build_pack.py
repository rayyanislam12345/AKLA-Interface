#!/usr/bin/env python3
"""Tests for build_pack.py on a small synthetic docx built here.

Run: python3 -I scripts/drafting-packs/tests/test_build_pack.py
"""
import json
import os
import sys
import tempfile
import unittest
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import build_pack as bp  # noqa: E402
import verify_pack as vp  # noqa: E402

W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'

STYLES = DECL + f'<w:styles {W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/></w:style></w:styles>'
NUMBERING = DECL + f'<w:numbering {W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlText w:val="(%1)"/></w:lvl></w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="0"/></w:num></w:numbering>'
SETTINGS = DECL + f'<w:settings {W}><w:zoom w:percent="100"/></w:settings>'
THEME = DECL + '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="T"><a:themeElements/></a:theme>'
FONTS = DECL + f'<w:fonts {W}><w:font w:name="Arial"/></w:fonts>'
HEADER = DECL + f'<w:hdr {W}><w:p><w:pPr><w:pStyle w:val="Header"/></w:pPr><w:r><w:t>Acme Water (Private) Limited, 12 Shore Road</w:t></w:r></w:p></w:hdr>'
FOOTNOTES = DECL + f'<w:footnotes {W}><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote><w:footnote w:id="1"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Old analysis of Acme Water (Private) Limited.</w:t></w:r></w:p></w:footnote><w:footnote w:id="2"><w:p><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> Second note.</w:t></w:r></w:p></w:footnote></w:footnotes>'
COMMENTS = DECL + f'<w:comments {W}><w:comment w:id="0" w:author="X"><w:p><w:r><w:t>check</w:t></w:r></w:p></w:comment></w:comments>'


def P(text, ppr="", rpr="<w:rPr><w:b/></w:rPr>", extra=""):
    return f'<w:p>{"<w:pPr>" + ppr + "</w:pPr>" if ppr else ""}<w:r>{rpr}<w:t xml:space="preserve">{text}</w:t></w:r>{extra}</w:p>'


BODY = "".join([
    P("Ref: ACME-2026-1"),                                                                                  # 0
    P("Acme Water (Private) Limited, CNIC 42101-1234567-1, having its registered office at 12 Shore Road (the Company), agrees on March 19, 2026 to pay PKR 1,000,000/-.", rpr=""),  # 1
    '<w:p><w:r><w:t xml:space="preserve">Kept </w:t></w:r><w:ins w:id="1" w:author="A"><w:r><w:t>inserted </w:t></w:r></w:ins><w:del w:id="2" w:author="A"><w:r><w:delText>deleted </w:delText></w:r></w:del><w:commentRangeStart w:id="0"/><w:r><w:t>text.</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r></w:p>',  # 2
    P("the first limb of the old letter;", ppr='<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr><w:ind w:left="720" w:hanging="720"/>', rpr="<w:rPr><w:i/></w:rPr>"),  # 3
    P("the second limb;", ppr='<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="5"/></w:numPr>'),  # 4
    P("Body paragraph with a note", ppr='<w:ind w:firstLine="720"/>', rpr="", extra='<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>'),  # 5
    P("Another body paragraph with a second note", rpr="", extra='<w:r><w:footnoteReference w:id="2"/></w:r>'),  # 6
    '<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="5000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2500"/><w:gridCol w:w="2500"/></w:tblGrid>'
    + "".join(f'<w:tr><w:tc><w:tcPr><w:shd w:fill="{"1F3864" if i == 0 else "FFFFFF"}"/></w:tcPr>{P("R%dC1" % i)}</w:tc><w:tc>{P("R%dC2" % i)}</w:tc></w:tr>' for i in range(3))
    + '</w:tbl>',  # 7
    P("For and on behalf of"),  # 8
    '<w:p/>',  # 9
])
SECT = '<w:sectPr><w:headerReference w:type="default" r:id="rIdH"/><w:pgSz w:w="12240" w:h="20160" w:code="5"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>'
DOCUMENT = DECL + f'<w:document {W}><w:body>{BODY}{SECT}</w:body></w:document>'
CT = DECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/><Override PartName="/word/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/><Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/><Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/><Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>'
RELS = DECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'
DOCRELS = DECL + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + "".join(
    f'<Relationship Id="{i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{t}" Target="{f}"/>' for i, t, f in [
        ("rId1", "styles", "styles.xml"), ("rId2", "numbering", "numbering.xml"), ("rId3", "settings", "settings.xml"),
        ("rId4", "theme", "theme/theme1.xml"), ("rId5", "fontTable", "fontTable.xml"), ("rId6", "footnotes", "footnotes.xml"),
        ("rId7", "comments", "comments.xml"), ("rIdH", "header", "header1.xml")]) + '</Relationships>'
PARTS = {"[Content_Types].xml": CT, "_rels/.rels": RELS, "word/document.xml": DOCUMENT, "word/_rels/document.xml.rels": DOCRELS,
         "word/styles.xml": STYLES, "word/numbering.xml": NUMBERING, "word/settings.xml": SETTINGS, "word/theme/theme1.xml": THEME,
         "word/fontTable.xml": FONTS, "word/footnotes.xml": FOOTNOTES, "word/comments.xml": COMMENTS, "word/header1.xml": HEADER}
CARRIED = ["word/styles.xml", "word/numbering.xml", "word/settings.xml", "word/theme/theme1.xml", "word/fontTable.xml"]


def make_docx(path):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, xml in PARTS.items():
            z.writestr(name, xml.encode("utf-8"))


def read(path):
    with zipfile.ZipFile(path) as z:
        return {n: z.read(n) for n in z.namelist()}


class PackTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = os.path.join(self.tmp.name, "base.docx")
        make_docx(self.base)

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, cfg):
        out = os.path.join(self.tmp.name, cfg["mode"])
        cfg = dict(cfg, base=self.base, name="t", kind="test")
        pack, report, kj = bp.build(cfg, out)
        with open(os.path.join(out, "kinds.json"), encoding="utf-8") as f:
            on_disk = json.load(f)
        return pack, report, on_disk, read(pack)

    def test_form_blanking(self):
        pack, report, kj, parts = self.build({"mode": "form",
                                              "literals": [{"text": "Acme Water (Private) Limited", "reason": "party name"}],
                                              "kinds": {"3": "limb_a", "5": "body"}, "tables": {"7": "table"}})
        doc = parts["word/document.xml"].decode("utf-8")
        text = "".join(bp.para_text(p) for p in bp.etree.fromstring(parts["word/document.xml"]).iter(bp.w("p")))
        for fact in ("Acme Water", "42101-1234567-1", "March 19, 2026", "1,000,000", "12 Shore Road", "ACME-2026-1"):
            self.assertNotIn(fact, text, fact)
        self.assertIn(bp.BLANK, text)
        self.assertNotIn("Acme", parts["word/header1.xml"].decode("utf-8"))
        self.assertNotIn("Acme", parts["word/footnotes.xml"].decode("utf-8"))
        reasons = {b["reason"] for b in report["blankings"]}
        self.assertTrue({"party name", "CNIC number", "date", "amount", "address"} <= reasons, reasons)
        # every blanking is listed with its original text
        self.assertTrue(all(b["text"] and b["reason"] for b in report["blankings"]))
        # revisions accepted, comments removed
        self.assertIn("Kept inserted text.", text)
        self.assertNotIn("deleted", doc)
        for tag in ("<w:ins ", "<w:del ", "commentReference", "commentRangeStart"):
            self.assertNotIn(tag, doc)
        self.assertEqual(report["revisions_left"], {})
        self.assertNotIn("word/comments.xml", parts)
        self.assertNotIn("comments.xml", parts["word/_rels/document.xml.rels"].decode())
        self.assertNotIn("comments", parts["[Content_Types].xml"].decode())
        # A4, margins kept
        self.assertIn('w:w="11906"', doc)
        self.assertIn('w:h="16838"', doc)
        self.assertIn('w:code="9"', doc)
        self.assertIn('w:left="1440"', doc)

    def test_regex_with_substitutes(self):
        pack, report, kj, parts = self.build({"mode": "form", "detectors": False,
                                              "literals": [{"regex": r"\bAcme Water\b", "with": "the Company", "reason": "neutral name"},
                                                           {"regex": r"(in)serted", "with": r"\1cluded", "reason": "word"}]})
        text = "".join(bp.para_text(p) for p in bp.etree.fromstring(parts["word/document.xml"]).iter(bp.w("p")))
        self.assertIn("the Company (Private) Limited", text)
        self.assertIn("Kept included text.", text)
        self.assertNotIn("Acme", text)
        subs = [b for b in report["blankings"] if b["reason"].startswith("neutral name")]
        self.assertTrue(subs and all(b["reason"] == "neutral name -> the Company" and b["text"] == "Acme Water" for b in subs))

    def test_carried_parts_byte_identical(self):
        for mode, cfg in (("form", {"mode": "form"}),
                          ("shell", {"mode": "shell", "shell": {"keep": {"0": "label"}, "examples": {"3": "limb_a"}}})):
            pack, report, kj, parts = self.build(cfg)
            for name in CARRIED:
                self.assertEqual(parts[name], PARTS[name].encode("utf-8"), "%s %s" % (mode, name))
                self.assertIn(name, report["carried_byte_for_byte"])
            for name in parts:
                bp.etree.fromstring(parts[name]) if name.endswith((".xml", ".rels")) else None

    def test_shell_stripping(self):
        pack, report, kj, parts = self.build({"mode": "shell",
                                              "letterhead_line": "[To be printed on [●]'s letterhead]",
                                              "shell": {"keep": {"0": "label", "8": "keep", "9": "keep"},
                                                        "examples": {"3": "limb_a", "5": "body"},
                                                        "example_tables": {"7": "table"}},
                                              "footnote_example": "5",
                                              "kinds": {"0": "ref_line"}})
        root = bp.etree.fromstring(parts["word/document.xml"])
        paras = [bp.para_text(p) for p in root.find(bp.w("body")) if p.tag == bp.w("p")]
        self.assertEqual(paras, ["Ref: " + bp.BLANK, bp.BLANK, bp.BLANK, "For and on behalf of", ""])
        tbl = root.find(".//w:tbl", bp.NS)
        self.assertEqual(len(tbl.findall(bp.w("tr"))), 2)                      # header + one body row
        self.assertTrue(all(bp.para_text(p) == bp.BLANK for p in tbl.iter(bp.w("p"))))
        self.assertIn('w:fill="1F3864"', bp.etree.tostring(tbl, encoding="unicode"))  # header look kept
        # example keeps its pPr (numbering) and first run's look; deleted paragraphs are gone
        limb = [p for p in root.iter(bp.w("p")) if p.find("w:pPr/w:numPr", bp.NS) is not None]
        self.assertEqual(len(limb), 1)
        self.assertIsNotNone(limb[0].find(".//w:r/w:rPr/w:i", bp.NS))
        doc = parts["word/document.xml"].decode()
        for gone in ("Acme", "second limb", "Another body paragraph", "R2C1"):
            self.assertNotIn(gone, doc)
        # the note of the deleted paragraph is removed; the example's note is [●]
        notes = parts["word/footnotes.xml"].decode()
        self.assertNotIn('w:id="2"', notes)
        self.assertNotIn("Old analysis", notes)
        self.assertIn(bp.BLANK, notes)
        self.assertIn('w:footnoteReference w:id="1"', doc)
        # letterhead: header carries only the bracketed line
        hdr = parts["word/header1.xml"].decode()
        self.assertIn("[To be printed on [●]'s letterhead]", hdr)
        self.assertNotIn("Acme", hdr)
        self.assertEqual(report["revisions_left"], {})

    def test_kinds_json_shape(self):
        pack, report, kj, parts = self.build({"mode": "shell",
                                              "shell": {"keep": {"0": "label"}, "examples": {"3": "limb_a", "5": "body"},
                                                        "example_tables": {"7": "table"}},
                                              "footnote_example": "5", "kinds": {"0": "ref_line"},
                                              "labels": {"limb_a": "(a) limb"}})
        self.assertEqual(vp.check_kinds_shape(kj), [])
        self.assertEqual(set(kj), {"kinds", "tables", "footnote"})
        k = kj["kinds"]["limb_a"]
        self.assertEqual(set(k), {"pPr", "rPr", "styleId", "numId", "ilvl", "label"})
        self.assertTrue(k["pPr"].startswith("<w:pPr>") and k["pPr"].endswith("</w:pPr>"))
        self.assertNotIn("xmlns", k["pPr"] + k["rPr"])
        self.assertEqual((k["styleId"], k["numId"], k["ilvl"], k["label"]), ("ListParagraph", 5, 0, "(a) limb"))
        self.assertEqual(k["rPr"], "<w:rPr><w:i/></w:rPr>")
        self.assertIn(k["pPr"], parts["word/document.xml"].decode())          # verbatim from the pack
        self.assertEqual(kj["kinds"]["ref_line"]["numId"], None)
        t = kj["tables"]["table"]
        self.assertEqual(set(t), {"tblPr", "tblGrid", "header", "body", "label"})
        self.assertEqual(set(t["header"]), {"trPr", "tcPr", "pPr", "rPr"})
        self.assertIn("1F3864", t["header"]["tcPr"])
        self.assertIn("FFFFFF", t["body"]["tcPr"])
        self.assertEqual(set(kj["footnote"]), {"pPr", "rPr", "refRPr"})
        self.assertIn("FootnoteReference", kj["footnote"]["refRPr"])
        # a wrong shape is caught
        bad = json.loads(json.dumps(kj))
        bad["kinds"]["limb_a"]["extra"] = 1
        bad["kinds"]["limb_a"]["numId"] = "5"
        self.assertEqual(len(vp.check_kinds_shape(bad)), 2)

    def test_listing_runs_after_acceptance(self):
        pkg = bp.Package(self.base)
        bp.prepare(pkg)
        out = bp.listing(pkg)
        self.assertIn("Kept inserted text.", out)
        self.assertIn("num=5/0 lowerLetter '(%1)'", out)
        self.assertIn("TABLE 3x2", out)


# a clause list: 1. / 1.1 / (a) / (i), and typed numbers under its heading
CLAUSE_NUMBERING = DECL + f'<w:numbering {W}><w:abstractNum w:abstractNumId="0">' + "".join(
    f'<w:lvl w:ilvl="{i}"><w:start w:val="1"/><w:numFmt w:val="{f}"/><w:lvlText w:val="{t}"/><w:lvlJc w:val="left"/>'
    f'<w:pPr><w:ind w:left="{l}" w:hanging="720"/></w:pPr></w:lvl>'
    for i, f, t, l in ((0, "decimal", "%1.", 720), (1, "decimal", "%1.%2", 720), (2, "lowerLetter", "(%3)", 1440), (3, "lowerRoman", "(%4)", 2160))
) + '</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>'


def TP(prefix, runs, ind=None):
    """A paragraph whose number is typed: the prefix and a tab in a run of
    their own, then runs of (text, rPr)."""
    ppr = f'<w:pPr><w:ind w:left="{ind[0]}" w:hanging="{ind[1]}"/></w:pPr>' if ind else ""
    body = "".join(f'<w:r>{rpr}<w:t xml:space="preserve">{t}</w:t></w:r>' for t, rpr in runs)
    return f'<w:p>{ppr}<w:r><w:t>{prefix}</w:t><w:tab/></w:r>{body}</w:p>'


TYPED_BODY = "".join([
    P("Definitions", ppr='<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>'),           # 0  auto 1.
    TP("1.1", [("The ", ""), ("first", "<w:rPr><w:b/></w:rPr>"), (" clause:", "")], ind=(720, 720)),  # 1
    TP("(a)", [("a limb, ", "<w:rPr><w:i/></w:rPr>"), ("in part;", "")], ind=(1440, 720)),           # 2
    TP("(i)", [("a sub-limb;", "")], ind=(2160, 720)),                                                # 3
    TP("(ii)", [("a second sub-limb;", "")], ind=(2300, 720)),                                        # 4
    TP("(b)", [("a second limb.", "")], ind=(1440, 720)),                                             # 5
    TP("1.2", [("The second clause:", "")]),                                                          # 6
    TP("(a)", [("one;", "")], ind=(1440, 720)),                                                       # 7
    TP("(b)", [("two,", "")], ind=(1440, 720)),                                                       # 8
    P("provided that:", rpr=""),                                                                      # 9
    TP("(a)", [("three.", "")], ind=(1440, 720)),                                                     # 10 a list started again
    P("12 months is a period, not a number", rpr=""),                                                 # 11 not a list number
])


class AutoNumberTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = os.path.join(self.tmp.name, "typed.docx")
        parts = dict(PARTS)
        parts["word/numbering.xml"] = CLAUSE_NUMBERING
        parts["word/document.xml"] = DECL + f'<w:document {W}><w:body>{TYPED_BODY}{SECT}</w:body></w:document>'
        with zipfile.ZipFile(self.base, "w", zipfile.ZIP_DEFLATED) as z:
            for name, xml in parts.items():
                z.writestr(name, xml.encode("utf-8"))

    def tearDown(self):
        self.tmp.cleanup()

    def test_typed_numbers_become_list_items(self):
        out = os.path.join(self.tmp.name, "out")
        pack, report, kj = bp.build({"mode": "form", "base": self.base, "name": "t", "kind": "typed",
                                     "kinds": {"1": "numbered_2", "2": "limb_a", "3": "sublimb_i"}}, out)
        parts = read(pack)
        body = bp.etree.fromstring(parts["word/document.xml"]).find(bp.w("body"))
        paras = [p for p in body if p.tag == bp.w("p")]

        def num(p):
            np_ = p.find("w:pPr/w:numPr", bp.NS)
            return None if np_ is None else (bp.wa(np_.find(bp.w("numId")), "val"), int(bp.wa(np_.find(bp.w("ilvl")), "val")))
        # the right list and level for each typed number
        self.assertEqual([num(p) for p in paras[:9]],
                         [("1", 0), ("1", 1), ("1", 2), ("1", 3), ("1", 3), ("1", 2), ("1", 1), ("1", 2), ("1", 2)])
        # the typed numbers and their tabs are gone; the words are as they were
        self.assertEqual([bp.para_text(p) for p in paras[1:9]],
                         ["The first clause:", "a limb, in part;", "a sub-limb;", "a second sub-limb;", "a second limb.",
                          "The second clause:", "one;", "two,"])
        self.assertTrue(all(p.find(".//w:tab", bp.NS) is None for p in paras[1:11]))
        # run formatting kept: "first" bold, "a limb, " italic, the rest plain
        runs = {"".join(t.text for t in r.iter(bp.w("t"))): r.find(bp.w("rPr")) for r in paras[1].iter(bp.w("r"))}
        self.assertIsNotNone(runs["first"].find(bp.w("b")))
        self.assertIsNone(runs["The "])
        r2 = [r for r in paras[2].iter(bp.w("r"))]
        self.assertEqual(bp.etree.tostring(r2[0].find(bp.w("rPr")), encoding="unicode").count("<w:i/>"), 1)
        # an indent the list level already gives is dropped; one that differs is kept
        self.assertIsNone(paras[2].find("w:pPr/w:ind", bp.NS))
        self.assertEqual(bp.wa(paras[4].find("w:pPr/w:ind", bp.NS), "left"), "2300")
        # "(a)" after "provided that" starts the list again: a num on the same list
        nid, il = num(paras[10])
        self.assertEqual(il, 2)
        self.assertNotEqual(nid, "1")
        nroot = bp.etree.fromstring(parts["word/numbering.xml"])
        new = [n for n in nroot.findall(bp.w("num")) if bp.wa(n, "numId") == nid][0]
        self.assertEqual(bp.wa(new.find(bp.w("abstractNumId")), "val"), "0")
        self.assertEqual(bp.wa(new.find("w:lvlOverride/w:startOverride", bp.NS), "val"), "1")
        self.assertEqual(bp.wa(new.find(bp.w("lvlOverride")), "ilvl"), "2")
        self.assertIsNone(num(paras[11]))
        # the numbers Word draws are the typed ones, under each reading of its counters
        pkg = bp.Package(pack)
        st = bp.style_map(pkg)
        nb = bp.Numbering(pkg, st)
        b = pkg.xml("word/document.xml").find(bp.w("body"))
        bps = [p for p in b if p.tag == bp.w("p")]
        for mode in bp.MODELS:
            labels = bp.numbering_labels(b, st, nb, mode)
            self.assertEqual([labels.get(p) for p in bps[:11]],
                             ["1.", "1.1", "(a)", "(i)", "(ii)", "(b)", "1.2", "(a)", "(b)", None, "(a)"], mode)
        an = report["auto_number"]
        self.assertEqual(len(an["converted"]), 9)
        self.assertEqual(an["sequence_check"]["mismatches"], [])
        self.assertEqual(an["left_typed"], [])
        self.assertEqual(len(an["numbering_added"]["nums"]), 1)
        # kinds point at the list each now uses; the clause kind runs on
        k = kj["kinds"]
        self.assertEqual((k["numbered_2"]["numId"], k["numbered_2"]["ilvl"], k["numbered_2"].get("restart")), (1, 1, False))
        self.assertEqual((k["limb_a"]["numId"], k["limb_a"]["ilvl"]), (1, 2))
        self.assertEqual((k["sublimb_i"]["numId"], k["sublimb_i"]["ilvl"]), (1, 3))
        self.assertNotIn("restart", k["limb_a"])
        self.assertEqual(vp.check_kinds_shape(kj), [])

    def test_auto_number_off(self):
        out = os.path.join(self.tmp.name, "off")
        pack, report, kj = bp.build({"mode": "form", "base": self.base, "name": "t", "kind": "typed", "auto_number": False}, out)
        self.assertIsNone(report["auto_number"])
        self.assertEqual(read(pack)["word/numbering.xml"], CLAUSE_NUMBERING.encode("utf-8"))
        self.assertIn("1.1\tThe first clause:", [bp.para_text(p) for p in bp.etree.fromstring(read(pack)["word/document.xml"]).iter(bp.w("p"))])


def R(text, rpr=""):
    return f'<w:r>{rpr}<w:t xml:space="preserve">{text}</w:t></w:r>'


SPELL_BODY = "".join([
    # 0: words split across runs, each run with its own look
    '<w:p>' + R("The ORGANI", "<w:rPr><w:b/></w:rPr>") + R("ZATION is autho") + R("rized; Recognize the colo", "<w:rPr><w:i/></w:rPr>") + R("r and the Program.") + '</w:p>',
    # 1: exceptions the style sheet keeps
    P("The size of the prize; a citizen may seize it; the World Health Organization; a computer program.", rpr=""),
    # 2: a term quoted from another instrument stays; the firm's own quoted term changes
    P("the “Authorized Representative” and the “Utilization Plan”; analyze it.", rpr=""),
    # 3: a quoted defined term put in the firm's form
    '<w:p>' + R("located at [●] (the ") + R("“") + R("Concessionaire") + R("”, which expression shall ...)") + '</w:p>',
])
SPELL_DOCUMENT = DECL + f'<w:document {W}><w:body>{SPELL_BODY}{SECT}</w:body></w:document>'
SPELL_HEADER = DECL + f'<w:hdr {W}><w:p><w:r><w:t>Finalized draft</w:t></w:r></w:p></w:hdr>'


class SpellingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = os.path.join(self.tmp.name, "spell.docx")
        parts = dict(PARTS, **{"word/document.xml": SPELL_DOCUMENT, "word/header1.xml": SPELL_HEADER})
        with zipfile.ZipFile(self.base, "w", zipfile.ZIP_DEFLATED) as z:
            for name, xml in parts.items():
                z.writestr(name, xml.encode("utf-8"))

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, **extra):
        cfg = dict({"mode": "form", "detectors": False, "base": self.base, "name": "t", "kind": "spell"}, **extra)
        pack, report, kj = bp.build(cfg, os.path.join(self.tmp.name, "out-%d" % len(extra)))
        parts = read(pack)
        root = bp.etree.fromstring(parts["word/document.xml"])
        return report, parts, root, [bp.para_text(p) for p in root.iter(bp.w("p"))]

    def test_british_case_kept_across_runs(self):
        report, parts, root, texts = self.build()
        self.assertEqual(texts[0], "The ORGANISATION is authorised; Recognise the colour and the Programme.")
        # each letter keeps its run: the bold run still ends ORGANI, the next run carries the S
        runs = [r for r in root.iter(bp.w("r"))][:4]
        self.assertEqual([r.find(bp.w("t")).text for r in runs], ["The ORGANI", "SATION is autho", "rised; Recognise the colou", "r and the Programme."])
        self.assertIsNotNone(runs[0].find("w:rPr/w:b", bp.NS))
        self.assertIsNotNone(runs[2].find("w:rPr/w:i", bp.NS))
        # headers too
        self.assertIn("Finalised draft", parts["word/header1.xml"].decode("utf-8"))
        ch = {(c["from"], c["to"]): c["count"] for c in report["spelling"]["changes"]}
        for pair in (("ORGANIZATION", "ORGANISATION"), ("authorized", "authorised"), ("Recognize", "Recognise"), ("color", "colour"),
                     ("Program", "Programme"), ("Finalized", "Finalised"), ("analyze", "analyse")):
            self.assertEqual(ch.get(pair), 1, pair)
        self.assertEqual(report["spelling"]["changed"], sum(ch.values()))

    def test_exceptions_kept(self):
        report, parts, root, texts = self.build()
        self.assertEqual(texts[1], "The size of the prize; a citizen may seize it; the World Health Organization; a computer program.")
        self.assertIn("“Authorized Representative” and the “Utilization Plan”; analyse it.", texts[2])
        kept = {k["word"]: k["why"] for k in report["spelling"]["kept"]}
        self.assertIn("proper name", kept["Organization"])
        self.assertIn("computer", kept["program"])
        self.assertIn("quotation marks", kept["Authorized"])
        # the firm's own quoted term is converted when the config says so; a listed phrase is kept
        report, parts, root, texts = self.build(spelling_quotes_own=["Utilization Plan"], spelling_keep=["Program."])
        self.assertIn("“Authorized Representative” and the “Utilisation Plan”", texts[2])
        self.assertTrue(texts[0].endswith("the Program."))

    def test_spelling_off(self):
        report, parts, root, texts = self.build(spelling=False)
        self.assertIsNone(report["spelling"])
        self.assertIn("autho", texts[0])
        self.assertIn("ORGANIZATION", texts[0])
        self.assertEqual(parts["word/header1.xml"], SPELL_HEADER.encode("utf-8"))

    def test_unquote_term(self):
        report, parts, root, texts = self.build(unquote_terms=[{"term": "Concessionaire", "reason": "quoted defined term"}])
        self.assertEqual(texts[3], "located at [●] (the Concessionaire, which expression shall ...)")
        bold = [r.find(bp.w("t")).text for r in root.iter(bp.w("r")) if r.find("w:rPr/w:b", bp.NS) is not None and r.find(bp.w("t")) is not None]
        self.assertIn("Concessionaire", bold)
        self.assertEqual(report["terms_unquoted"], 1)
        self.assertTrue(any("Concessionaire" in b["reason"] for b in report["blankings"]))


class WaveTwoOptionTests(unittest.TestCase):
    """The options wave 2 added; each runs only when its config key is set."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = os.path.join(self.tmp.name, "base.docx")
        make_docx(self.base)

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, cfg, parts=None):
        if parts:
            with zipfile.ZipFile(self.base, "w", zipfile.ZIP_DEFLATED) as z:
                for name, xml in dict(PARTS, **parts).items():
                    z.writestr(name, xml.encode("utf-8"))
        out = os.path.join(self.tmp.name, "out")
        cfg = dict(cfg, base=self.base, name="t", kind="test")
        pack, report, kj = bp.build(cfg, out)
        return report, kj, read(pack)

    def test_font_and_size_map(self):
        body = P("Times text", rpr='<w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman"/><w:sz w:val="25"/></w:rPr>')
        doc = DECL + f'<w:document {W}><w:body>{body}{SECT}</w:body></w:document>'
        report, kj, parts = self.build({"mode": "form", "detectors": False, "font_map": {"Times New Roman": "Arial"}, "size_map": {"25": "22"}},
                                       {"word/document.xml": doc})
        d = parts["word/document.xml"].decode()
        self.assertNotIn("Times New Roman", d)
        self.assertIn('w:ascii="Arial"', d)
        self.assertIn('w:sz w:val="22"', d)
        self.assertEqual(report["fonts_converted"]["Times New Roman -> Arial"], 2)

    def test_margins_and_landscape(self):
        land = SECT.replace('w:w="12240" w:h="20160" w:code="5"', 'w:w="20160" w:h="12240" w:orient="landscape"')
        doc = DECL + f'<w:document {W}><w:body>{P("x", rpr="")}{land}</w:body></w:document>'
        report, kj, parts = self.build({"mode": "form", "detectors": False, "keep_landscape": True}, {"word/document.xml": doc})
        d = parts["word/document.xml"].decode()
        self.assertIn('w:w="16838"', d)
        self.assertIn('w:h="11906"', d)
        report, kj, parts = self.build({"mode": "form", "detectors": False, "turn_margins": False,
                                        "margins_twips": {"top": 1944, "left": 1152}}, {"word/document.xml": doc})
        d = parts["word/document.xml"].decode()
        self.assertIn('w:w="11906"', d)
        self.assertIn('w:top="1944"', d)
        self.assertIn('w:left="1152"', d)

    def test_compose_writes_in_a_kind_and_drops_examples(self):
        report, kj, parts = self.build({"mode": "form", "cut": "shell", "detectors": False,
                                        "shell": {"keep": {"0": "keep", "8": "keep"}, "examples": {"3": "limb_a", "5": "body"}},
                                        "compose": [{"after": "0", "blocks": [{"kind": "body", "text": "The **Company** shall pay."},
                                                                             {"kind": "limb_a", "text": "first limb;"}]}],
                                        "compose_spacer": None, "drop_examples": True})
        root = bp.etree.fromstring(parts["word/document.xml"])
        texts = [bp.para_text(p) for p in root.iter(bp.w("p")) if bp.para_text(p).strip()]
        self.assertEqual(texts[1:3], ["The Company shall pay.", "first limb;"])
        self.assertNotIn(bp.BLANK, texts)          # the examples are gone
        bold = [r.find(bp.w("t")).text for r in root.iter(bp.w("r")) if r.find("w:rPr/w:b", bp.NS) is not None and r.find(bp.w("t")) is not None]
        self.assertIn("Company", bold)
        self.assertNotIn("The ", bold)
        limb = [p for p in root.iter(bp.w("p")) if bp.para_text(p) == "first limb;"][0]
        self.assertIsNotNone(limb.find("w:pPr/w:numPr", bp.NS))   # takes the kind's numbering
        self.assertEqual(set(kj["kinds"]), {"limb_a", "body"})
        self.assertEqual(report["composed"], 2)

    def test_heading_numbers(self):
        num = DECL + f'<w:numbering {W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1"/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1.%2"/></w:lvl></w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="0"/></w:num></w:numbering>'
        lvl1 = '<w:numPr><w:ilvl w:val="1"/><w:numId w:val="5"/></w:numPr>'
        body = (P("Article 1", rpr="<w:rPr><w:b/></w:rPr>") + P("first clause", ppr=lvl1, rpr="") +
                P("Article 2", rpr="<w:rPr><w:b/></w:rPr>") + P("2.1\tsecond clause", rpr=""))
        doc = DECL + f'<w:document {W}><w:body>{body}{SECT}</w:body></w:document>'
        report, kj, parts = self.build({"mode": "form", "detectors": False, "heading_numbers": {"pattern": "^Article \\d+$", "numId": "5"}},
                                       {"word/document.xml": doc, "word/numbering.xml": num})
        self.assertEqual(report["heading_numbers"]["headings"], 2)
        root = bp.etree.fromstring(parts["word/document.xml"])
        ps = [p for p in root.iter(bp.w("p"))]
        nums = [(bp.wa(p.find("w:pPr/w:numPr/w:numId", bp.NS), "val"), bp.wa(p.find("w:pPr/w:numPr/w:ilvl", bp.NS), "val")) for p in ps[:4]]
        self.assertEqual(nums, [("5", "0"), ("5", "1"), ("5", "0"), ("5", "1")])
        self.assertEqual(bp.para_text(ps[0]), "")
        self.assertIn('w:lvlText w:val="Article %1"', parts["word/numbering.xml"].decode())
        nb = bp.Numbering(bp.Package(os.path.join(self.tmp.name, "out", "test-pack.docx")), {})
        labels = bp.numbering_labels(root.find(bp.w("body")), {}, nb, "own")
        self.assertEqual([labels.get(p) for p in ps[:4]], ["Article 1", "1.1", "Article 2", "2.1"])

    def test_without_wave_two_keys_nothing_changes(self):
        # the wave-1 path: no wave-2 report keys appear
        report, kj, parts = self.build({"mode": "form"})
        for key in ("fonts_converted", "tables_fitted", "composed", "heading_numbers", "examples_dropped"):
            self.assertNotIn(key, report)


if __name__ == "__main__":
    unittest.main(verbosity=2)
