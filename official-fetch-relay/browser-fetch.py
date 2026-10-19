#!/usr/bin/env python3
"""Fetch one official page through a real browser, for sites that only
answer a browser.

www.secp.gov.pk sits behind a Cloudflare browser challenge: every plain
client, and a headless browser, gets "Just a moment…" and a 403. A real
Google Chrome on a virtual display passes it. The Sindh Assembly fills its
lists by script after the page loads. This script is called by
official-fetch.py (never directly by the chat service or the monitor) when a
URL is asked for in browser mode; the same source gate applies before and
after, and only the page's own text leaves here.

Usage: browser-fetch.py <url> <outfile>
  The page's bytes go to <outfile>; "FINAL <url>" and "TYPE <content-type>"
  (or "ERROR <reason>") are printed. Nothing is streamed through pipes:
  xvfb-run merges and cuts the child's streams once a pipe buffer fills.
"""
import json
import os
import re
import sys
import tempfile
from urllib.parse import urlsplit

MAX_BYTES = 20 * 1024 * 1024
CHALLENGE_WAIT = 45  # seconds to let Cloudflare's check finish


def fail(message, code=2):
    sys.stderr.write(f"ERROR {message}\n")
    sys.exit(code)


def main():
    if len(sys.argv) != 3:
        fail("Give exactly one URL and an output path")
    url, outfile = sys.argv[1], sys.argv[2]
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        fail("browser fetch is not installed on the relay")

    with sync_playwright() as p, tempfile.TemporaryDirectory() as profile:
        # A persistent context with a throwaway profile: Chrome insists on a
        # writable profile, and the relay user has no home it should be
        # writing browser state into. The profile tells Chrome to download
        # PDFs instead of showing them, so a document link (SECP's
        # "?wpdmdl=" links carry no extension) arrives as a download event.
        os.makedirs(os.path.join(profile, "Default"), exist_ok=True)
        with open(os.path.join(profile, "Default", "Preferences"), "w") as f:
            json.dump({"plugins": {"always_open_pdf_externally": True}, "download": {"prompt_for_download": False}}, f)
        ctx = p.chromium.launch_persistent_context(
            profile,
            channel="chrome",
            headless=False,  # headless Chrome is what the challenge detects
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
            locale="en-US", viewport={"width": 1366, "height": 900}, accept_downloads=True,
        )
        page = ctx.new_page()
        downloads = []
        page.on("download", lambda d: downloads.append(d))
        origin = "{0.scheme}://{0.netloc}".format(urlsplit(url))

        def cleared():
            return "Just a moment" not in page.title()

        def wait_clear():
            for _ in range(CHALLENGE_WAIT):
                if cleared():
                    return True
                page.wait_for_timeout(1000)
            return cleared()

        try:
            # Clear the site's browser check on its front page first, so a
            # document link is opened with the cookies the check issued.
            page.goto(origin + "/", wait_until="domcontentloaded", timeout=60000)
            if not wait_clear():
                fail("the site's browser check did not clear")
            started_download = False
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=60000)
            except Exception as err:  # noqa: BLE001 — "Download is starting" is the document case
                if "Download is starting" not in str(err):
                    raise
                started_download = True
            if not started_download and not wait_clear():
                fail("the site's browser check did not clear")
            if started_download or downloads:
                for _ in range(60):
                    if downloads:
                        break
                    page.wait_for_timeout(1000)
                if not downloads:
                    fail("the document did not download")
                d = downloads[0]
                path = d.path()
                if os.path.getsize(path) > MAX_BYTES:
                    fail("Source is too large")
                with open(path, "rb") as src, open(outfile, "wb") as dst:
                    dst.write(src.read())
                kind = "application/pdf" if d.suggested_filename.lower().endswith(".pdf") else "application/octet-stream"
                print(f"FINAL {d.url}\nTYPE {kind}")
            else:
                # Let scripts fill the page (lists loaded after load).
                page.wait_for_timeout(3000)
                html = page.content().encode("utf-8")
                if len(html) > MAX_BYTES:
                    fail("Source is too large")
                with open(outfile, "wb") as f:
                    f.write(html)
                print(f"FINAL {page.url}\nTYPE text/html; charset=utf-8")
            sys.stdout.flush()
        finally:
            ctx.close()


if __name__ == "__main__":
    main()
