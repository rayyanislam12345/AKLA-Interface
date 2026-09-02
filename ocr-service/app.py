"""OCR fallback service for the AKLA Matter Hub's document pipeline.

extractText.ts (the shared function process-document uses) can only read a
PDF's real text layer — scanned/photographed signed copies have none, and
come back essentially empty. Running real Tesseract OCR isn't viable inside
a Supabase Edge Function (150-256MB memory, 2s CPU time per request — OCR
blows through both), so this is a small dedicated service on its own VM that
extractText.ts calls as a fallback when normal extraction yields ~nothing.

Poppler rasterizes the whole PDF to page image files on disk in one pass
(confirmed the hard way: doing this per-page instead re-parses the entire
source PDF from scratch on every single page — 54x redundant work for a
54-page document, enough to blow past a 2-minute timeout on its own before
Tesseract even starts). Tesseract then runs over those files one at a time,
deleting each as it goes — memory and disk both stay flat regardless of
document length.
"""

import os
import tempfile

from flask import Flask, request, jsonify
from pdf2image import convert_from_path
from pdf2image.pdf2image import pdfinfo_from_path
from PIL import Image
import pytesseract

app = Flask(__name__)

OCR_SHARED_SECRET = os.environ["OCR_SHARED_SECRET"]
OCR_DPI = 150  # enough for typed contract text; keeps per-page size modest

# Cheap safety valve — an unbounded page count would just tie up the service
# for minutes on end; anything this long is unusual for a contract and worth
# a human's attention rather than a silent multi-minute hang.
MAX_PAGES = 200


def _check_auth():
    auth = request.headers.get("Authorization", "")
    return auth == f"Bearer {OCR_SHARED_SECRET}"


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True})


@app.route("/ocr/pdf", methods=["POST"])
def ocr_pdf():
    if not _check_auth():
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_data()
    if not data:
        return jsonify({"error": "No file body provided"}), 400

    with tempfile.TemporaryDirectory() as tmpdir:
        pdf_path = os.path.join(tmpdir, "input.pdf")
        with open(pdf_path, "wb") as f:
            f.write(data)

        try:
            page_count = pdfinfo_from_path(pdf_path)["Pages"]
        except Exception as err:
            return jsonify({"error": f"Could not read PDF: {err}"}), 400

        if page_count > MAX_PAGES:
            return jsonify({"error": f"PDF has {page_count} pages, over the {MAX_PAGES}-page OCR limit"}), 413

        image_paths = convert_from_path(
            pdf_path, dpi=OCR_DPI, output_folder=tmpdir, paths_only=True, fmt="ppm"
        )

        texts = []
        for image_path in sorted(image_paths):
            with Image.open(image_path) as img:
                texts.append(pytesseract.image_to_string(img))
            os.remove(image_path)

    return jsonify({"text": "\n\n".join(texts), "pages": page_count})


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=8090)
