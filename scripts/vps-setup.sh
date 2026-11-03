#!/usr/bin/env bash
# Relayn server: one-line setup on a fresh corner of an Ubuntu VPS.
#
# Run as root on the VPS:
#   curl -fsSL https://raw.githubusercontent.com/devkijified/Relayn/main/scripts/vps-setup.sh | bash
#
# What it does, and nothing more:
#   1. Installs Docker from Ubuntu's own packages, only if Docker is absent.
#   2. Clones (or updates) the Relayn repo into /opt/relayn.
#   3. Asks for the console key and, optionally, the four R2 values, and
#      writes them to /opt/relayn/relayn.env (readable by root only).
#      Blank R2 answers mean the server keeps its records on this disk
#      instead of the Cloudflare R2 bucket.
#   4. Builds the server image from services/server/Dockerfile and runs it
#      as one container named relayn-server on port 4000, with its data in
#      the Docker volume relayn-data, set to restart unless stopped.
# It touches no other container, service, port, or file. Re-running it
# updates the code and restarts only the relayn-server container.
set -euo pipefail

if [ "$(id -u)" != "0" ]; then
  echo "Run this as root." >&2
  exit 1
fi

APP_DIR=/opt/relayn
ENV_FILE=$APP_DIR/relayn.env
PORT=4000

echo "== Relayn setup: checking Docker =="
if ! command -v docker >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io git curl
  systemctl enable --now docker
fi
docker --version

echo "== Relayn setup: getting the code =="
if [ -d "$APP_DIR/repo/.git" ]; then
  git -C "$APP_DIR/repo" pull --ff-only
else
  mkdir -p "$APP_DIR"
  git clone https://github.com/devkijified/Relayn.git "$APP_DIR/repo"
fi

if [ -f "$ENV_FILE" ]; then
  echo "== Relayn setup: keeping the existing $ENV_FILE =="
else
  echo "== Relayn setup: a few pastes =="
  echo "The console key is the long value after key= in your console link."
  read -r -p "MOVER_CONSOLE_KEY: " CONSOLE_KEY
  if [ -z "${CONSOLE_KEY}" ]; then
    echo "The console key cannot be blank." >&2
    exit 1
  fi
  echo "The four R2 values live in the old Render service settings."
  echo "Paste each one, or press Enter to skip R2 and keep records on this disk."
  read -r -p "R2_ACCOUNT_ID: " R2_ACCOUNT_ID
  read -r -p "R2_BUCKET: " R2_BUCKET
  read -r -p "R2_ACCESS_KEY_ID: " R2_ACCESS_KEY_ID
  read -r -p "R2_SECRET_ACCESS_KEY: " R2_SECRET_ACCESS_KEY
  {
    echo "TRUST_PROXY=true"
    echo "PORT=$PORT"
    echo "MOVER_DATA_DIR=/data/mover-data"
    echo "MOVER_BASE_EXE=/app/assets/relayn-mover-base.exe"
    echo "MOVER_CONSOLE_KEY=$CONSOLE_KEY"
    if [ -n "${R2_ACCOUNT_ID}" ] && [ -n "${R2_BUCKET}" ] && [ -n "${R2_ACCESS_KEY_ID}" ] && [ -n "${R2_SECRET_ACCESS_KEY}" ]; then
      echo "R2_ACCOUNT_ID=$R2_ACCOUNT_ID"
      echo "R2_BUCKET=$R2_BUCKET"
      echo "R2_ACCESS_KEY_ID=$R2_ACCESS_KEY_ID"
      echo "R2_SECRET_ACCESS_KEY=$R2_SECRET_ACCESS_KEY"
    fi
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
fi

echo "== Relayn setup: building the server image =="
docker build -t relayn-server "$APP_DIR/repo/services/server"

echo "== Relayn setup: starting the container =="
docker rm -f relayn-server >/dev/null 2>&1 || true
docker volume create relayn-data >/dev/null
docker run -d \
  --name relayn-server \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  -p "$PORT:$PORT" \
  -v relayn-data:/data \
  relayn-server

echo "== Relayn setup: checking it answers =="
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
curl -s "http://127.0.0.1:$PORT/health" || true
echo
docker ps --filter name=relayn-server
IP=$(hostname -I | awk '{print $1}')
echo "Relayn server is up on this machine."
echo "Health from outside: http://$IP:$PORT/health"
echo "If that outside address does not answer, the VPS firewall is holding port $PORT; tell Muse and do not change the firewall yet."
