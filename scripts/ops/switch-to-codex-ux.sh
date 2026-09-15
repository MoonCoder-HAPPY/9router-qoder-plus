#!/usr/bin/env bash
# Switch production 9router to the Codex UX release, with automatic rollback
# if the new container does not become healthy within 60 seconds.
#
#   sudo ./switch-to-codex-ux.sh
#
# The environment of the running container (JWT secret, providers, feature flags)
# is captured first and re-applied verbatim, so no secret is ever typed by hand.
set -euo pipefail

NEW_IMAGE="${NEW_IMAGE:-9router:qoder-plus-codex-ux-v40}"
OLD_CONTAINER="${OLD_CONTAINER:-9router-before-codex-ux-20260915}"
NAME="${NAME:-9router}"
PORT="${PORT:-20128}"
DATA_DIR="${DATA_DIR:-/home/ubuntu/.9router}"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"

echo "==> capturing environment from ${NAME}"
mapfile -t ENVS < <(sudo docker inspect "$NAME" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -v '^PATH=' | sed '/^$/d')
echo "    ${#ENVS[@]} variables captured"

echo "==> stopping ${NAME}"
sudo docker stop "$NAME" >/dev/null
sudo docker rm "$NAME" >/dev/null

env_args=()
for e in "${ENVS[@]}"; do env_args+=(-e "$e"); done

echo "==> starting ${NEW_IMAGE}"
sudo docker run -d --name "$NAME" --restart unless-stopped -p "${PORT}:${PORT}" \
  -v "${DATA_DIR}:/app/data" "${env_args[@]}" "$NEW_IMAGE" >/dev/null

echo "==> waiting for health (up to 60s)"
healthy=""
for _ in $(seq 1 60); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then healthy=yes; break; fi
  sleep 1
done

if [ -z "$healthy" ]; then
  echo "!! ${NAME} did not become healthy - rolling back to ${OLD_CONTAINER}"
  sudo docker stop "$NAME" >/dev/null 2>&1 || true
  sudo docker rm "$NAME" >/dev/null 2>&1 || true
  sudo docker start "$OLD_CONTAINER" >/dev/null
  sleep 5
  curl -fsS "$HEALTH_URL" && echo " - rolled back, production healthy again"
  exit 1
fi

curl -fsS "$HEALTH_URL"; echo " - ${NEW_IMAGE} is live"
echo
echo "rollback at any time with: sudo docker stop ${NAME} && sudo docker rm ${NAME} && sudo docker start ${OLD_CONTAINER}"
echo "watch Codex signals:      sudo docker logs -f ${NAME} | grep --line-buffered '\\[CODEX\\]'"