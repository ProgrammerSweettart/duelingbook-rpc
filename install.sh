#!/bin/bash
# One-step installer for duelingbook-rpc.
#
#   curl -fsSL https://raw.githubusercontent.com/ProgrammerSweettart/duelingbook-rpc/main/install.sh | bash
#
# Works from a clone too (./install.sh). Needs no Homebrew, no admin password, no Node:
# if Node is missing it downloads the official build into the app folder and uses only that.
# Re-run any time to update; it is idempotent.
set -euo pipefail

REPO="ProgrammerSweettart/duelingbook-rpc"
APP="$HOME/.duelingbook-rpc"
LABEL="com.duelingbook.rpc"
NODE_FALLBACK="v22.21.0"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die()  { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ;;
  *) die "This installer handles macOS and Linux. On Windows see windows/install.ps1 in the repo." ;;
esac

say "DuelingBook → Discord Rich Presence"

# ---------------------------------------------------------------- app files
SRC=""
if [ -f "${BASH_SOURCE[0]}" ]; then
  MAYBE="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
  [ -n "$MAYBE" ] && [ -f "$MAYBE/server.js" ] && SRC="$MAYBE"
fi

if [ -n "$SRC" ] && [ "$SRC" != "$APP" ]; then
  info "installing from this folder"
  mkdir -p "$APP"
  # keep the user's config and recordings; refresh the code
  for f in server.js package.json package-lock.json lib userscripts scripts launchd systemd windows uninstall.sh install.sh README.md LICENSE; do
    [ -e "$SRC/$f" ] || continue
    rm -rf "${APP:?}/$f"          # replace outright; cp -R into an existing dir would nest it
    cp -R "$SRC/$f" "$APP/$f"
  done
  [ -f "$APP/config.json" ] || cp "$SRC/config.json" "$APP/config.json"
elif [ "$SRC" = "$APP" ]; then
  info "updating in place"
else
  info "downloading the app"
  TMP="$(mktemp -d)"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" -o "$TMP/app.tgz" || die "could not download the app. Is the internet up?"
  tar -xzf "$TMP/app.tgz" -C "$TMP"
  NEW="$(find "$TMP" -maxdepth 1 -type d -name 'duelingbook-rpc-*' | head -1)"
  mkdir -p "$APP"
  KEEP=""
  [ -f "$APP/config.json" ] && KEEP="$(cat "$APP/config.json")"
  for f in "$NEW"/*; do
    base="$(basename "$f")"
    rm -rf "${APP:?}/$base"
    cp -R "$f" "$APP/$base"
  done
  [ -n "$KEEP" ] && printf '%s' "$KEEP" > "$APP/config.json"
  rm -rf "$TMP"
fi
cd "$APP"

# ---------------------------------------------------------------- node
NODE=""
for c in "${NODE_BIN:-}" "$APP/node/bin/node" "$(command -v node 2>/dev/null || true)" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -n "$c" ] && [ -x "$c" ]; then
    MAJOR="$("$c" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    [ "$MAJOR" -ge 20 ] 2>/dev/null && NODE="$c" && break
  fi
done

if [ -z "$NODE" ]; then
  info "Node isn't installed — fetching it (no password needed)"
  case "$(uname -m)" in
    arm64|aarch64) ARCH="arm64" ;;
    x86_64|amd64)  ARCH="x64" ;;
    *) die "unsupported CPU: $(uname -m)" ;;
  esac
  PLAT="darwin"; [ "$OS" = "Linux" ] && PLAT="linux"
  VER="$(curl -fsSL https://nodejs.org/dist/index.json 2>/dev/null \
        | tr '{' '\n' | grep '"lts":"' | head -1 | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true)"
  [ -z "$VER" ] && VER="$NODE_FALLBACK"
  info "Node $VER ($PLAT-$ARCH)"
  TMPN="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/$VER/node-$VER-$PLAT-$ARCH.tar.gz" -o "$TMPN/node.tgz" \
    || die "could not download Node. Is the internet up?"
  rm -rf "$APP/node"; mkdir -p "$APP/node"
  tar -xzf "$TMPN/node.tgz" -C "$APP/node" --strip-components=1
  rm -rf "$TMPN"
  NODE="$APP/node/bin/node"
fi
info "Node $("$NODE" --version)"

# ---------------------------------------------------------------- deps
NPM_CLI="$(dirname "$NODE")/../lib/node_modules/npm/bin/npm-cli.js"
if [ ! -d "$APP/node_modules/@xhayper/discord-rpc" ]; then
  info "installing the Discord library"
  if [ -f "$NPM_CLI" ]; then
    "$NODE" "$NPM_CLI" install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null
  else
    (cd "$APP" && npm install --omit=dev --no-audit --no-fund --loglevel=error >/dev/null)
  fi
fi

# ---------------------------------------------------------------- autostart
PORT="$("$NODE" -p "require('$APP/config.json').port || 41337" 2>/dev/null || echo 41337)"
if [ "$OS" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  sed -e "s|__NODE__|$NODE|g" -e "s|__DIR__|$APP|g" -e "s|__HOME__|$HOME|g" \
    "$APP/launchd/$LABEL.plist.template" > "$PLIST"
  plutil -lint "$PLIST" >/dev/null || die "could not write the startup file"
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  # bootout is asynchronous: bootstrapping too soon fails with "Input/output error"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
    sleep 1
  done
  for try in 1 2 3 4 5; do
    if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then break; fi
    [ "$try" = 5 ] && die "could not start the background app. Try again, or reboot and re-run."
    sleep 2
  done
  launchctl kickstart -k "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
else
  mkdir -p "$HOME/.config/systemd/user"
  sed -e "s|__NODE__|$NODE|g" -e "s|__DIR__|$APP|g" \
    "$APP/systemd/duelingbook-rpc.service" > "$HOME/.config/systemd/user/duelingbook-rpc.service"
  systemctl --user daemon-reload
  systemctl --user enable --now duelingbook-rpc >/dev/null 2>&1 || true
  systemctl --user restart duelingbook-rpc >/dev/null 2>&1 || true
fi

# ---------------------------------------------------------------- verify
OK=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then OK=1; break; fi
  sleep 1
done
[ -n "$OK" ] || die "The background app didn't start. Log: ~/Library/Logs/duelingbook-rpc.log"
info "background app running on port $PORT"

# ---------------------------------------------------------------- browser
URL="http://127.0.0.1:$PORT/userscripts/db-presence.user.js"
if [ "$OS" = "Darwin" ]; then open "$URL" >/dev/null 2>&1 || true
else xdg-open "$URL" >/dev/null 2>&1 || true; fi

cat <<EOF

$(say "Almost done — 2 things left, both in your browser:")

  1. Install Tampermonkey if you don't have it:  https://www.tampermonkey.net
  2. A tab just opened with the script — click Install (or Update),
     and say YES when it asks to connect to 127.0.0.1.

Then open duelingbook.com and make sure Discord is running. That's it.

  Uninstall:  ~/.duelingbook-rpc/uninstall.sh
EOF
