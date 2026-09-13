#!/bin/bash
# Installs (or reinstalls) the launchd user agent that keeps server.js running.
# Idempotent: re-run after moving the folder or changing node.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="com.duelingbook.rpc"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

NODE="${NODE_BIN:-}"
if [ -z "$NODE" ]; then
  for c in "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
    [ -n "$c" ] && [ -x "$c" ] && NODE="$c" && break
  done
fi
if [ -z "$NODE" ]; then
  echo "node not found. Install it (brew install node) or run: NODE_BIN=/path/to/node ./install.sh" >&2
  exit 1
fi
echo "node:    $NODE ($("$NODE" --version))"
echo "project: $DIR"

if [ ! -d "$DIR/node_modules/@xhayper/discord-rpc" ]; then
  echo "installing dependencies…"
  (cd "$DIR" && "$(dirname "$NODE")/npm" install --omit=dev --no-audit --no-fund)
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
sed -e "s|__NODE__|$NODE|g" -e "s|__DIR__|$DIR|g" -e "s|__HOME__|$HOME|g" \
  "$DIR/launchd/$LABEL.plist.template" > "$PLIST"
plutil -lint "$PLIST" >/dev/null

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"
sleep 1.5

if launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -q 'state = running'; then
  echo "agent:   running ($(launchctl print "$DOMAIN/$LABEL" | grep -E '^\s*pid = ' | tr -d '\t '))"
else
  echo "agent:   NOT running — see $HOME/Library/Logs/duelingbook-rpc.log" >&2
  exit 1
fi
echo "log:     tail -f ~/Library/Logs/duelingbook-rpc.log"
echo "status:  curl -s http://127.0.0.1:$(python3 -c 'import json;print(json.load(open("'"$DIR"'/config.json")).get("port",41337))' 2>/dev/null || echo 41337)/"
