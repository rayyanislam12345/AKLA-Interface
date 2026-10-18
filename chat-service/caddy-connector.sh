#!/usr/bin/env bash
# Point Caddy on the VM at the claude.ai connector: /mcp, /oauth/* and the two
# .well-known discovery paths on aklachat.duckdns.org go to 127.0.0.1:8095;
# everything else keeps going to chat-service on 8092. Keeps a dated backup of
# /etc/caddy/Caddyfile, validates, then reloads Caddy. Run once from your own
# terminal (it needs sudo on the box):  bash chat-service/caddy-connector.sh
# Safe to re-run: it does nothing if the route is already there.
set -euo pipefail
HOST="${CHAT_HOST:-opc@140.245.26.184}"
KEY="${CHAT_KEY:-$HOME/.ssh/oracle-ocr.key}"

ssh -i "$KEY" "$HOST" 'set -e
if grep -q "127.0.0.1:8095" /etc/caddy/Caddyfile; then echo "Caddy already routes to the connector; nothing to do"; exit 0; fi
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.bak-$(date +%Y%m%d%H%M%S)
sudo python3 - <<"PY"
import re
p = "/etc/caddy/Caddyfile"
s = open(p).read()
new = """aklachat.duckdns.org {
\t@connector path /mcp /mcp/* /oauth /oauth/* /.well-known/oauth-authorization-server /.well-known/oauth-authorization-server/* /.well-known/oauth-protected-resource /.well-known/oauth-protected-resource/*
\treverse_proxy @connector 127.0.0.1:8095
\treverse_proxy 127.0.0.1:8092
}"""
s2, n = re.subn(r"aklachat\.duckdns\.org \{\n\s*reverse_proxy 127\.0\.0\.1:8092\n\}", new, s)
if n != 1:
    raise SystemExit(f"expected exactly one plain aklachat block, found {n}; edit /etc/caddy/Caddyfile by hand (see chat-service/Caddyfile)")
open(p, "w").write(s2)
print("aklachat block updated")
PY
sudo caddy validate --config /etc/caddy/Caddyfile >/dev/null && echo "Caddyfile valid"
sudo systemctl reload caddy && echo "Caddy reloaded"'

echo "--- public checks"
echo "chat:  $(curl -s -m 10 https://aklachat.duckdns.org/health | cut -c1-60)"
echo "oauth: $(curl -s -m 10 https://aklachat.duckdns.org/.well-known/oauth-authorization-server | cut -c1-90)"
code=$(curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST https://aklachat.duckdns.org/mcp -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')
echo "mcp:   HTTP $code (401 is right: it asks claude.ai to sign in)"
