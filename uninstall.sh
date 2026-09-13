#!/bin/bash
# Stops and removes the launchd agent. Leaves the project folder and logs alone.
set -uo pipefail
LABEL="com.duelingbook.rpc"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "agent stopped" || echo "agent was not loaded"
[ -f "$PLIST" ] && rm -f "$PLIST" && echo "removed $PLIST"
exit 0
