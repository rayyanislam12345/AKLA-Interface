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


if __name__ == "__main__":
    unittest.main(verbosity=2)
