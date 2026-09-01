#!/usr/bin/env python3
"""One-off: manually add Acts whose direct PDF URLs are already known
(found via web search since the site's own search failed to surface them —
same situation as Companies Act 2017 and PPP Authority Act 2017 earlier),
bypassing search_act(). Downloads, extracts, and writes pending_ingest
manifest entries — same shape scan() produces, so --confirm picks them up
normally.
"""
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from scrape import DOWNLOADS_DIR, MANIFEST_PATH, MIN_TEXT_LENGTH, _get, extract_pdf_text, save_manifest

ENTRIES = [
    # (manifest key = the name used in TARGET_ACTS / prior not_found entries, site title, page_url, pdf_url)
    ("Corporate Rehabilitation Act, 2018", "Corporate Rehabilitation Act, 2018",
     "https://www.pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2NobJk=-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administratorbefe5f3901653d6a3e03a4cda1ba713c.pdf"),
    ("Financial Institutions (Recovery of Finances) Ordinance, 2001", "Financial Institutions (Recovery of Finances) Ordinance, 2001",
     "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2Npa5lk-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administratorcf20efcd7f792c08850503359c31ce76.pdf"),
    ("Recognition and Enforcement (Arbitration Agreements and Foreign Arbitral Awards) Act, 2011", "Recognition and Enforcement (Arbitration Agreement and Foreign Arbitral) Act, 2011",
     "https://www.pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2FsaJg=-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administrator1b1941b93a9c3b995b38b93cdca874fe.pdf"),
    ("Qanun-e-Shahadat Order, 1984", "Qanun-e-Shahadat Order, 1984 (QSO)",
     "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2Npa5plaw==-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administrator01031a2c8cddc523d08a0df0ec37d7d0.pdf"),
    ("Sales Tax Act, 1990", "Sales Tax Act, 1990 (Same as on the official website of FBR dated 30-06-2025)",
     "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2JxaJw=-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administratorf6d20932403661e059756ab223d8542b.pdf"),
    ("Copyright Ordinance, 1962", "Copyright Ordinance, 1962",
     "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2Npa5pibA==-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administrator5d255d1f44b50b65d6a3e87a2e0d3fee.pdf"),
    ("Public Private Partnership Authority Act, 2017", "Public Private Partnership Authority Act, 2017.",
     "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2NpapZn-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administrator152d5a4c9444aa4096394afe07108350.pdf"),
    ("Regulation of Generation, Transmission and Distribution of Electric Power Act, 1997", "Regulation of Generation Transmission and Distribution of Electric Power Act, 1997",
     "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2Npa5tm-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administrator43841507be454e13e49d1fe0ebf5c3b9.pdf"),
    ("Foreign Exchange Regulation Act, 1947", "Foreign Exchange Regulation Act, 1947",
     "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2Npaplm-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administrator4ef414a2433e9cd3ebe6b05800627920.pdf"),
    ("Insurance Ordinance, 2000", "Insurance Ordinance, 2000",
     "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2Npa5pkaA==-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administrator2e9004888e460668894a34ec4e35d875.pdf"),
    ("Anti-Money Laundering Act, 2010", "Anti-Money Laundering (AML) Act, 2010",
     "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2Npaplq-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administrator47c7a5354061a54634a6246d2046ddcf.pdf"),
    ("Alternative Dispute Resolution Act, 2017", "Alternative Dispute Resolution Act, 2017",
     "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2NoaJc=-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administratord6aea558b86186e8b71dd65ad16d2f3d.pdf"),
    ("Customs Act, 1969", "Customs Act, 1969 (Same as on the official website of FBR dated 30-06-2025)",
     "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2Npa5lrbw==-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administrator6d344e569c576550c200d66afb7b28f6.pdf"),
    ("Federal Excise Act, 2005", "Federal Excise Act, 2005 (Same as on the official website of FBR dated 30-06-2025)",
     "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2Npa5lrbg==-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administrator06f0200ef997b50983df81ea052e8011.pdf"),
    ("Trusts Act, 1882", "Trust Act, 1882",
     "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-bpg=-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administrator097759e0f2a16527881669c6e1435919.pdf"),
    ("Limited Liability Partnership Act, 2017", "Limited Liability Partnership Act, 2017",
     "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2Npappp-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administrator81272ed8b97eeaada3d76b4575e1d49f.pdf"),
    ("Special Economic Zones Act, 2012", "Special Economic Zones Act, 2012",
     "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2Fpapc=-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administrator7e37c324f9824083835cd0079ba3e12a.pdf"),
    ("Benami Transactions (Prohibition) Act, 2017", "Benami Transactions (Prohibition) Act, 2017",
     "https://www.pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2NoaJg=-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administratorc3159176d17a29e713613851233c2845.pdf"),
    ("National Tariff Commission Act, 2015", "National Tariff Commission Act, 2015",
     "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2JwZ5s=-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administratorc497ae1825e3a92bb86ced7327f0209b.pdf"),
    ("Import and Export (Control) Act, 1950", "Imports and Exports (Control) Act, 1950",
     "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-ap+WYw==-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administrator084fe1e8bb9f566b2f0023574816a68f.pdf"),
    ("Arbitration (International Investment Disputes) Act, 2011", "Arbitration (International Investment Disputes) Act, 2011",
     "https://pakistancode.gov.pk/english/UY2FqaJw1-apaUY2Fqa-apaUY2FsaJs=-sg-jjjjjjjjjjjjj",
     "https://pakistancode.gov.pk/pdffiles/administrator8b9fe2715cfed1b257d1ecdbfe04b1ea.pdf"),
]


def main():
    manifest = json.loads(MANIFEST_PATH.read_text()) if MANIFEST_PATH.exists() else {}
    DOWNLOADS_DIR.mkdir(exist_ok=True)

    for name, title, page_url, pdf_url in ENTRIES:
        if manifest.get(name, {}).get("outcome") in ("pending_ingest", "ingested"):
            print(f"Already resolved, skipping: {name}")
            continue

        print(f"Fetching: {name} ({title})")
        pdf_path = DOWNLOADS_DIR / (re.sub(r"[^a-zA-Z0-9 ._-]", "_", title)[:150] + ".pdf")
        try:
            resp = _get(pdf_url)
            pdf_path.write_bytes(resp.content)
        except Exception as err:
            manifest[name] = {"outcome": "failed", "error": f"Download failed: {err}"}
            print(f"  FAILED (download): {err}", file=sys.stderr)
            save_manifest(manifest)
            continue

        text = extract_pdf_text(pdf_path)
        needs_ocr = len(text.strip()) < MIN_TEXT_LENGTH

        manifest[name] = {
            "outcome": "pending_ingest",
            "title": title,
            "page_url": page_url,
            "pdf_url": pdf_url,
            "pdf_path": str(pdf_path),
            "needs_ocr": needs_ocr,
            "text_length": len(text) if not needs_ocr else None,
        }
        print(f"  {'needs OCR' if needs_ocr else f'{len(text)} chars extracted'}")
        save_manifest(manifest)

    print("\nDone. Review manifest.json, then run: python3 scrape.py --confirm")


if __name__ == "__main__":
    main()
