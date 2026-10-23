#!/bin/bash
# Stops and removes the background app. Add --all to delete the app folder too.
set -uo pipefail
LABEL="com.duelingbook.rpc"
APP="$HOME/.duelingbook-rpc"
if [ "$(uname -s)" = "Darwin" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "stopped" || echo "was not running"
  rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" && echo "autostart removed"
else
  systemctl --user disable --now duelingbook-rpc 2>/dev/null && echo "stopped" || echo "was not running"
  rm -f "$HOME/.config/systemd/user/duelingbook-rpc.service"; systemctl --user daemon-reload 2>/dev/null
fi
if [ "${1:-}" = "--all" ]; then
  rm -rf "$APP" && echo "deleted $APP"
else
  echo "app files kept in $APP (use --all to delete them)"
fi
echo "Remove the userscript yourself in Tampermonkey's dashboard."
exit 0
