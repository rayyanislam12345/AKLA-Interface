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
    url = official(raw)
    opener = urllib.request.build_opener(CheckedRedirects())
    request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (AKLA law library)"})
    try:
        with opener.open(request, timeout=TIMEOUT) as response:
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
