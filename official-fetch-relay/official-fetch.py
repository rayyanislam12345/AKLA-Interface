#!/usr/bin/env python3
"""Download one official Pakistani legal source for the AKLA chat service.

The chat service's server is in India, and pakistancode.gov.pk, na.gov.pk and
other government sites do not answer it. This server does. It runs as the
forced command of a restricted SSH key: the chat service connects, passes one
URL, and gets the file back on stdout. Nothing else is possible with the key.

The same source gate as chat-service/sourcePolicy.js applies here, on this
side too: HTTPS only, an approved authority domain, every redirect checked
before it is followed, a size limit and a timeout.

stdout: the file's bytes.   stderr: "FINAL <url>" and "TYPE <content-type>",
or one line starting "ERROR " and a non-zero exit.
"""
import os
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request

# Keep in step with OFFICIAL_DOMAINS in chat-service/sourcePolicy.js.
OFFICIAL_DOMAINS = ["gov.pk", "sbp.org.pk", "nepra.org.pk", "ogra.org.pk", "ppra.org.pk", "na.gov.pk", "senate.gov.pk"]
MAX_BYTES = 20 * 1024 * 1024
TIMEOUT = 45

# Government sites publish IPv6 addresses they do not answer on. Python tries
# them first and waits out each timeout (47 seconds for one statute, against
# 2 seconds for curl), so IPv4 addresses are tried first.
_getaddrinfo = socket.getaddrinfo


def _ipv4_first(*args, **kwargs):
    return sorted(_getaddrinfo(*args, **kwargs), key=lambda info: info[0] != socket.AF_INET)


socket.getaddrinfo = _ipv4_first


def fail(message, code=2):
    sys.stderr.write(f"ERROR {message}\n")
    sys.exit(code)


def official(url):
    parts = urllib.parse.urlsplit(url)
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or parts.username or parts.password or (parts.port not in (None, 443)):
        fail("Source must be an HTTPS document on an approved Pakistani authority domain")
    if not any(host == d or host.endswith("." + d) for d in OFFICIAL_DOMAINS):
        fail("Source must be an HTTPS document on an approved Pakistani authority domain")
    return url


class CheckedRedirects(urllib.request.HTTPRedirectHandler):
    max_redirections = 5

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        official(urllib.parse.urljoin(req.full_url, newurl))
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def main():
    raw = (os.environ.get("SSH_ORIGINAL_COMMAND") or " ".join(sys.argv[1:])).strip()
    if not raw or any(c.isspace() for c in raw) or len(raw) > 2048:
        fail("Give exactly one URL")
    # "browser:https://…" asks for the page through a real browser (see
    # browser-fetch.py): for sites behind a browser check or that fill
    # their lists by script. The same domain gate applies.
    if raw.startswith("browser:"):
        url = official(raw[len("browser:"):])
        import subprocess
        import tempfile
        env = dict(os.environ)
        env.update({"HOME": os.environ.get("HOME") or "/tmp", "PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"})
        env.pop("SSH_ORIGINAL_COMMAND", None)
        with tempfile.TemporaryDirectory(prefix="akla-browser-") as tmp:
            outfile = os.path.join(tmp, "page")
            try:
                proc = subprocess.run(
                    ["/usr/bin/xvfb-run", "-a", "/opt/browser-fetch/bin/python", "/usr/local/bin/akla-browser-fetch", url, outfile],
                    stdin=subprocess.DEVNULL, capture_output=True, timeout=150, env=env,
                )
            except subprocess.TimeoutExpired:
                fail("Source did not respond in time")
            # xvfb-run merges the child's streams; look for the marker lines in both.
            lines = [l.strip() for l in (proc.stdout + b"\n" + proc.stderr).decode("utf-8", "replace").split("\n") if l.strip()]
            error = next((l[6:] for l in lines if l.startswith("ERROR ")), None)
            if error or proc.returncode != 0 or not os.path.exists(outfile):
                fail(error or f"browser fetch failed (exit {proc.returncode}): {lines[-1][:200] if lines else 'no output'}")
            final = next((l[6:].strip() for l in lines if l.startswith("FINAL ")), url)
            ctype = next((l[5:].strip() for l in lines if l.startswith("TYPE ")), "")
            official(final)
            size = os.path.getsize(outfile)
            if size > MAX_BYTES:
                fail("Source is too large")
            sys.stderr.write(f"FINAL {final}\nTYPE {ctype}\n")
            with open(outfile, "rb") as f:
                while True:
                    chunk = f.read(65536)
                    if not chunk:
                        break
                    sys.stdout.buffer.write(chunk)
            sys.stdout.flush()
        return
    url = official(raw)
    opener = urllib.request.build_opener(CheckedRedirects())
    # senate.gov.pk resets about one connection in five, whatever the client;
    # a second try a moment later goes through. A browser-shaped User-Agent
    # is accepted everywhere a plain one is, and by a few sites that drop
    # anything else.
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 AKLA-law-library",
            "Accept": "text/html,application/xhtml+xml,application/pdf,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        },
    )
    try:
        response = None
        for attempt in range(3):
            try:
                response = opener.open(request, timeout=TIMEOUT)
                break
            except urllib.error.HTTPError:
                raise
            except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as err:
                if attempt == 2:
                    raise err
                import time
                time.sleep(2 + attempt * 2)
        with response:
            if int(response.headers.get("Content-Length") or 0) > MAX_BYTES:
                fail("Source is too large")
            size = 0
            out = sys.stdout.buffer
            final = response.geturl()
            official(final)
            sys.stderr.write(f"FINAL {final}\nTYPE {response.headers.get('Content-Type', '')}\n")
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                size += len(chunk)
                if size > MAX_BYTES:
                    fail("Source is too large")
                out.write(chunk)
            out.flush()
    except urllib.error.HTTPError as err:
        fail(f"Source download failed ({err.code})")
    except urllib.error.URLError as err:
        fail(f"Source could not be reached ({err.reason})")
    except TimeoutError:
        fail("Source did not respond in time")


if __name__ == "__main__":
    main()
