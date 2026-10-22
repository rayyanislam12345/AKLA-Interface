"""Shrink oversized scanned PDFs under the 50 MB upload cap, keeping their text.

Each original is downloaded, compressed with Ghostscript into data/compressed/,
checked for a surviving text layer, and handed back to the cloud.
Writes data/approved_compressed.json for ingest_sp.py.
"""
import json, os, subprocess

import pdfplumber

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "data", "compressed")
os.makedirs(OUT, exist_ok=True)
done = []
for a in json.load(open(os.path.join(HERE, "data", "approved_oversized.json"))):
    dst = os.path.join(OUT, a["filename"])
    for setting in ("/ebook", "/screen"):
        subprocess.run(["gs", "-q", "-dNOPAUSE", "-dBATCH", "-sDEVICE=pdfwrite", f"-dPDFSETTINGS={setting}",
                        f"-sOutputFile={dst}", a["path"]], check=True)
        if os.path.getsize(dst) < 48_000_000:
            break
    subprocess.run([os.path.join(HERE, "evict"), a["path"]], capture_output=True)
    with pdfplumber.open(dst) as pdf:
        text = "".join((p.extract_text() or "") for p in pdf.pages[:3])
    size = os.path.getsize(dst)
    print(f"{a['filename'][:60]}: {a['size'] // 1_000_000} MB -> {size // 1_000_000} MB, text kept: {len(text.strip()) > 200}", flush=True)
    if size < 48_000_000:
        done.append(dict(a, path=dst, source_path=a["path"], size=size))
json.dump(done, open(os.path.join(HERE, "data", "approved_compressed.json"), "w"), indent=1)
