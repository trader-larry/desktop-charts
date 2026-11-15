#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is not installed. Get the LTS version from https://nodejs.org"; read; exit 1; }
# Open the charts in their own app window (no tabs or address bar). Chrome and Edge remember the
# size and position of that window for next time. Set APPWINDOW=0 to open a normal browser tab instead.
APPWINDOW=1
URL=http://localhost:8787
open_charts() {
  if [ "$APPWINDOW" = 1 ]; then
    for app in "Google Chrome" "Microsoft Edge"; do
      if [ -d "/Applications/$app.app" ]; then open -na "$app" --args --app="$URL"; return; fi
    done
  fi
  open "$URL"
}
(sleep 1; open_charts) &
node server.js
