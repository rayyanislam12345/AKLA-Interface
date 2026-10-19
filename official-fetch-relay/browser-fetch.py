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
import re
import sys
import tempfile
import time
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
        # A persistent context with a throwaway profile directory: Chrome
        # insists on a writable profile, and the relay user has no home it
        # should be writing browser state into.
        ctx = p.chromium.launch_persistent_context(
            profile,
            channel="chrome",
            headless=False,  # headless Chrome is what the challenge detects
            args=["--disable-blink-features=AutomationControlled", "--no-sandbox", "--disable-dev-shm-usage"],
            locale="en-US", viewport={"width": 1366, "height": 900}, accept_downloads=False,
        )
        browser = ctx
        page = ctx.new_page()
        origin = "{0.scheme}://{0.netloc}".format(urlsplit(url))

        def cleared():
            return "Just a moment" not in page.title()

        try:
            is_document = bool(re.search(r"\.(pdf|docx?|xlsx?)(\?|$)", url, re.I))
            # A document cannot be rendered as a page. Clear the challenge on
            # the site's front page first, then fetch the document with the
            # same cookies.
            page.goto(origin + "/" if is_document else url, wait_until="domcontentloaded", timeout=60000)
            for _ in range(CHALLENGE_WAIT):
                if cleared():
                    break
                page.wait_for_timeout(1000)
            if not cleared():
                fail("the site's browser check did not clear")
            if is_document:
                # Fetched from inside the cleared page: the browser's own
                # HTTP stack and cookies are what the challenge trusts; a
                # separate request context is refused again.
                result = page.evaluate(
                    """async (u) => {
                        const r = await fetch(u, {credentials: 'include'});
                        const buf = await r.arrayBuffer();
                        let bin = '';
                        const bytes = new Uint8Array(buf);
                        for (let i = 0; i < bytes.length; i += 0x8000) {
                            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
                        }
                        return {status: r.status, url: r.url, type: r.headers.get('content-type') || '', b64: btoa(bin)};
                    }""",
                    url,
                )
                if result["status"] >= 400:
                    fail(f"Source download failed ({result['status']})")
                import base64
                body = base64.b64decode(result["b64"])
                if len(body) > MAX_BYTES:
                    fail("Source is too large")
                with open(outfile, "wb") as f:
                    f.write(body)
                print(f"FINAL {result['url']}\nTYPE {result['type']}")
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
            browser.close()


if __name__ == "__main__":
    main()
