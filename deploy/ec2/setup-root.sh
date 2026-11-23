#!/bin/bash
# One-time server setup that needs sudo. Run on the EC2 as the app user with:
#   sudo bash ~/apps/sitesforstudios/server/deploy/ec2/setup-root.sh
#
# Only ADDS things for SitesForStudios. It never removes or edits other apps:
#   - installs PostgreSQL (if missing) and creates its own role + database "sitesforstudios"
#   - creates /var/www/sitesforstudios for the web app
#   - adds a NEW nginx site for $DOMAIN (other sites are untouched; config is tested before reload)
#   - gets a Let's Encrypt certificate for $DOMAIN only (when DNS already points here)
# Safe to run again.
set -euo pipefail

DOMAIN="${DOMAIN:-api.thaaram.in}"
APP_USER="${SUDO_USER:-thaaral}"
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
BASE="$APP_HOME/apps/sitesforstudios"
SHARED="$BASE/shared"
WEB_ROOT=/var/www/sitesforstudios
SITE=/etc/nginx/sites-available/sitesforstudios

[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
echo "==> App user: $APP_USER, domain: $DOMAIN"
mkdir -p "$SHARED"
chown "$APP_USER:$APP_USER" "$BASE" "$SHARED"

# ---------------------------------------------------------------- PostgreSQL
if ! command -v psql >/dev/null; then
  echo "==> Installing PostgreSQL"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql >/dev/null
fi
systemctl enable --now postgresql >/dev/null

if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='sitesforstudios'" | grep -q 1; then
  echo "==> Creating PostgreSQL role and database 'sitesforstudios'"
  PG_PASS="$(openssl rand -hex 24)"
  sudo -u postgres psql -q -c "CREATE ROLE sitesforstudios LOGIN PASSWORD '$PG_PASS'"
  sudo -u postgres psql -q -c "CREATE DATABASE sitesforstudios OWNER sitesforstudios"
  umask 077
  printf '%s' "$PG_PASS" > "$SHARED/pg-password"
  chown "$APP_USER:$APP_USER" "$SHARED/pg-password"
  umask 022
else
  echo "==> PostgreSQL role already exists (password in $SHARED/pg-password)"
fi
# Small server: keep PostgreSQL's memory low. Only listens on localhost (Ubuntu default).
sudo -u postgres psql -q -c "ALTER SYSTEM SET shared_buffers = '64MB'" -c "ALTER SYSTEM SET max_connections = '40'" -c "ALTER SYSTEM SET work_mem = '4MB'"
systemctl restart postgresql

# ---------------------------------------------------------------- web root
mkdir -p "$WEB_ROOT"
chown "$APP_USER:$APP_USER" "$WEB_ROOT"
[ -f "$WEB_ROOT/index.html" ] || echo '<!doctype html><title>SitesForStudios</title><p>Deploying…</p>' > "$WEB_ROOT/index.html"

# ---------------------------------------------------------------- nginx site (new file only)
if [ -f "$SITE" ] && grep -q "managed-by: sitesforstudios" "$SITE" && grep -q "listen 443" "$SITE"; then
  echo "==> nginx site exists with HTTPS (left as is)"
else
  echo "==> Writing nginx site $SITE"
  cat > "$SITE" <<NGINX
# managed-by: sitesforstudios (deploy/ec2/setup-root.sh)
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    root $WEB_ROOT;
    index index.html;
    client_max_body_size 200m;   # photo and RAW uploads (local storage)

    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        proxy_request_buffering off;  # stream uploads
        proxy_buffering off;          # stream ZIP downloads
    }

    location /assets/ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        try_files \$uri =404;
    }

    location / {
        add_header Cache-Control "no-cache";
        try_files \$uri /index.html;
    }
}
NGINX
fi
ln -sf "$SITE" /etc/nginx/sites-enabled/sitesforstudios
nginx -t
systemctl reload nginx

# ---------------------------------------------------------------- HTTPS (Let's Encrypt)
SERVER_IP="$(curl -fsS -m 5 https://checkip.amazonaws.com || true)"
DNS_IP="$(getent hosts "$DOMAIN" | awk '{print $1}' | head -1)"
if [ -n "$DNS_IP" ] && [ "$DNS_IP" = "$SERVER_IP" ]; then
  if grep -q "listen 443" "$SITE"; then
    echo "==> HTTPS already configured"
  else
    echo "==> Requesting certificate for $DOMAIN"
    certbot --nginx -d "$DOMAIN" --redirect --non-interactive --agree-tos --keep-until-expiring \
      || echo "!! certbot needs an email the first time. Run: sudo certbot --nginx -d $DOMAIN --redirect"
  fi
else
  echo "!! DNS for $DOMAIN points to '${DNS_IP:-nothing}', this server is '$SERVER_IP'."
  echo "   Add an A record $DOMAIN -> $SERVER_IP, wait a few minutes, then run this script again for HTTPS."
fi

echo "==> Done. Next: run deploy/ec2/deploy.sh as $APP_USER (no sudo)."
