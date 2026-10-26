#!/usr/bin/env bash
# Runs ON THE VPS (as root) from /opt/tvbox after the bundle was uploaded.
# Idempotent: safe to run on every deploy.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

DOMAIN_DEFAULT="tv.nemnogovova.com"
OWNER_DEFAULT="nemnogovova@gmail.com"
GOOGLE_CLIENT_ID_DEFAULT="441211375352-vg0qtnlrg7u9i3m1l8qkfve3af8g74nt.apps.googleusercontent.com"

log() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

# An older deployment may have left a .dockerignore that hides server/dist
printf '*\n!server\n!server/**\n' > .dockerignore

# ---------------------------------------------------------------- swap (1 GB VPS)
if ! swapon --show | grep -q .; then
  log "Creating 1G swap file"
  fallocate -l 1G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=1024
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---------------------------------------------------------------- docker
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker"
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  log "Installing docker compose plugin"
  (apt-get update -y && apt-get install -y docker-compose-plugin) || true
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# ---------------------------------------------------------------- free ports 80/443
for svc in nginx apache2 httpd caddy lighttpd; do
  if systemctl is-active --quiet "$svc" 2>/dev/null; then
    log "Stopping $svc (port 80/443 is needed by TVBox)"
    systemctl disable --now "$svc" || true
  fi
done
# Containers from older TVBox deployments (other compose dirs)
for c in tvbox-backend tvbox-caddy tvbox-coturn; do
  if docker ps -a --format '{{.Names}}' | grep -qx "$c"; then
    project="$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$c" 2>/dev/null || true)"
    if [ -n "$project" ] && [ "$project" != "$APP_DIR" ]; then
      log "Removing old container $c (from $project)"
      docker rm -f "$c" >/dev/null || true
    fi
  fi
done

# ---------------------------------------------------------------- .env
touch .env
chmod 600 .env
get_env() { grep -E "^$1=" "$2" 2>/dev/null | tail -n1 | cut -d= -f2- || true; }
set_env() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" .env; then
    sed -i "s|^${key}=.*|${key}=${val}|" .env
  else
    echo "${key}=${val}" >> .env
  fi
}
default_env() {
  local key="$1" val="$2"
  local cur; cur="$(get_env "$key" .env)"
  if [ -z "$cur" ]; then set_env "$key" "$val"; fi
}

# Reuse values from a previous deployment if present
for old in /root/tvbox/.env /opt/tvbox-old/.env /root/.env $(ls -d /root/*/ 2>/dev/null | sed 's|$|.env|'); do
  [ -f "$old" ] && [ "$old" != "$APP_DIR/.env" ] || continue
  for k in GOOGLE_CLIENT_ID OWNER_EMAIL SESSION_SECRET DEVICE_TOKEN RELEASE_TOKEN; do
    v="$(get_env "$k" "$old")"
    [ -n "$v" ] && default_env "$k" "$v"
  done
done

default_env DOMAIN "$DOMAIN_DEFAULT"
DOMAIN="$(get_env DOMAIN .env)"
default_env PUBLIC_URL "https://$DOMAIN"
default_env OWNER_EMAIL "$OWNER_DEFAULT"
default_env GOOGLE_CLIENT_ID "$GOOGLE_CLIENT_ID_DEFAULT"
default_env SESSION_SECRET "$(openssl rand -hex 32)"
default_env TURN_SECRET "$(openssl rand -hex 24)"
default_env TURN_HOST "$DOMAIN"
# lets build-windows.cmd publish new app builds (deploy.ps1 saves it to .release-token on your PC)
default_env RELEASE_TOKEN "$(openssl rand -hex 24)"

# ---------------------------------------------------------------- firewall
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  log "Opening firewall ports"
  ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443 >/dev/null
  ufw allow 3478 >/dev/null; ufw allow 49160:49200/udp >/dev/null
fi

# ---------------------------------------------------------------- start
log "Building and starting containers"
docker compose build backend
docker compose up -d --remove-orphans
# always restart the backend on the freshly built image
docker compose up -d --no-deps --force-recreate backend
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -f >/dev/null 2>&1 || true

log "Waiting for the backend"
ok=0
for i in $(seq 1 40); do
  if docker exec tvbox-backend wget -qO- http://127.0.0.1:3000/api/health >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
if [ "$ok" != "1" ]; then
  docker compose logs --tail=80 backend
  echo "Backend did not become healthy" >&2
  exit 1
fi

log "Checking HTTPS"
for i in $(seq 1 30); do
  if curl -fsS "https://$DOMAIN/api/health" >/dev/null 2>&1; then
    echo "HTTPS OK: https://$DOMAIN"
    break
  fi
  sleep 3
done
docker compose ps
echo
echo "@@RELEASE_TOKEN=$(get_env RELEASE_TOKEN .env)@@"
echo "TVBox deployed: https://$DOMAIN"
