#!/usr/bin/env bash
# Installs the official-source download relay on the DigitalOcean droplet and
# gives the chat service's server a key that can do nothing but run it.
#
#   ./official-fetch-relay/install.sh
#
# Safe to run again: it replaces the script and the key's authorisation.
set -euo pipefail
cd "$(dirname "$0")"

RELAY_HOST="${RELAY_HOST:-root@157.245.240.172}"
RELAY_KEY="${RELAY_KEY:-$HOME/.ssh/id_ed25519}"
CHAT_HOST="${CHAT_HOST:-opc@140.245.26.184}"
CHAT_KEY="${CHAT_KEY:-$HOME/.ssh/oracle-ocr.key}"
CHAT_IP="${CHAT_IP:-140.245.26.184}"
USER_NAME=aklarelay

echo "Creating the relay's key on the chat server (kept if it exists)…"
ssh -i "$CHAT_KEY" "$CHAT_HOST" "sudo mkdir -p /opt/chat-service/.relay && sudo chown opc:opc /opt/chat-service/.relay && chmod 700 /opt/chat-service/.relay && (test -f /opt/chat-service/.relay/id_ed25519 || ssh-keygen -q -t ed25519 -N '' -C chat-service-official-fetch -f /opt/chat-service/.relay/id_ed25519)"
PUBKEY=$(ssh -i "$CHAT_KEY" "$CHAT_HOST" "cat /opt/chat-service/.relay/id_ed25519.pub")

echo "Installing the relay on the droplet…"
scp -i "$RELAY_KEY" official-fetch.py "$RELAY_HOST:/tmp/official-fetch.py"
ssh -i "$RELAY_KEY" "$RELAY_HOST" "set -e
id $USER_NAME >/dev/null 2>&1 || useradd --system --create-home --shell /bin/sh $USER_NAME
install -o root -g root -m 0755 /tmp/official-fetch.py /usr/local/bin/akla-official-fetch
rm -f /tmp/official-fetch.py
install -d -o $USER_NAME -g $USER_NAME -m 0700 /home/$USER_NAME/.ssh
printf '%s\n' 'from=\"$CHAT_IP\",command=\"/usr/local/bin/akla-official-fetch\",restrict $PUBKEY' > /home/$USER_NAME/.ssh/authorized_keys
chown $USER_NAME:$USER_NAME /home/$USER_NAME/.ssh/authorized_keys
chmod 600 /home/$USER_NAME/.ssh/authorized_keys"

echo "Trusting the droplet's host key on the chat server…"
ssh -i "$CHAT_KEY" "$CHAT_HOST" "ssh-keyscan -t ed25519 ${RELAY_HOST#*@} 2>/dev/null > /opt/chat-service/.relay/known_hosts && chmod 600 /opt/chat-service/.relay/known_hosts"

echo "Done."
