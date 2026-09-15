#!/usr/bin/env bash
# Roll production back to the pre-Codex-UX image.
set -euo pipefail

OLD_CONTAINER="${OLD_CONTAINER:-9router-before-codex-ux-20260915}"
NAME="${NAME:-9router}"
PORT="${PORT:-20128}"

sudo docker stop "$NAME" >/dev/null 2>&1 || true
sudo docker rm "$NAME" >/dev/null 2>&1 || true
sudo docker start "$OLD_CONTAINER" >/dev/null
sleep 5
curl -fsS "http://127.0.0.1:${PORT}/api/health"; echo " - rollback container is serving ${PORT}"