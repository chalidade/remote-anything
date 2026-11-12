#!/usr/bin/env sh
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js belum terpasang. Unduh di https://nodejs.org"; exit 1; }
( sleep 1; (open http://localhost:8080/backup.html || xdg-open http://localhost:8080/backup.html) >/dev/null 2>&1 ) &
exec node server.js
