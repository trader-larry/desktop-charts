#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is not installed. Get the LTS version from https://nodejs.org"; read; exit 1; }
(sleep 1; open http://localhost:8787) &
node server.js
