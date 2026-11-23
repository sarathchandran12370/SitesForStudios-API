#!/bin/bash
# Switch the EC2 to API-only, with the web app on S3 + CloudFront. Run on the EC2:
#   sudo APP_DOMAIN=app.thaaram.in bash ~/apps/sitesforstudios/server/deploy/ec2/use-cloudfront.sh
#
# - Rewrites ONLY the SitesForStudios nginx site: /api/ is proxied to the API, everything else
#   redirects to https://$APP_DOMAIN (CloudFront). Keeps the Let's Encrypt HTTPS setup if there is one.
#   Other nginx sites are untouched. Tested before reload (the previous file is restored on error).
# - Updates ~/apps/sitesforstudios/shared/.env: APP_URL, TRUST_PROXY_HOPS=2 (CloudFront -> nginx),
#   WEB_HOSTING=s3 (deploy.sh then skips building the web app on this server).
# Afterwards run deploy.sh (no sudo) to restart the API with the new settings.
set -euo pipefail

API_DOMAIN="${API_DOMAIN:-api.thaaram.in}"
APP_DOMAIN="${APP_DOMAIN:?set APP_DOMAIN, e.g. APP_DOMAIN=app.thaaram.in}"
APP_USER="${SUDO_USER:-thaaral}"
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
ENV_FILE="$APP_HOME/apps/sitesforstudios/shared/.env"
SITE=/etc/nginx/sites-available/sitesforstudios

[ "$(id -u)" = 0 ] || { echo "Run with sudo"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "No $ENV_FILE yet. Run deploy.sh first."; exit 1; }

cp "$SITE" "$SITE.bak.$(date +%Y%m%d%H%M%S)" 2>/dev/null || true
CERT_DIR="/etc/letsencrypt/live/$API_DOMAIN"

# The API part, shared by the HTTP and HTTPS servers. Everything that is not /api goes to the app.
API_LOCATIONS="
    client_max_body_size 200m;

    location /api/ {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
        proxy_request_buffering off;
        proxy_buffering off;
    }

    location / {
        return 301 https://$APP_DOMAIN\$request_uri;
    }
"

if [ -f "$CERT_DIR/fullchain.pem" ]; then
  # Keep HTTPS (certbot certificate). HTTP only answers Let's Encrypt renewals and redirects to HTTPS.
  cat > "$SITE" <<NGINX
# managed-by: sitesforstudios (deploy/ec2/use-cloudfront.sh): API only, web app on CloudFront
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $API_DOMAIN;
    ssl_certificate $CERT_DIR/fullchain.pem;
    ssl_certificate_key $CERT_DIR/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
$API_LOCATIONS
}
server {
    listen 80;
    listen [::]:80;
    server_name $API_DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\$host\$request_uri; }
}
NGINX
else
  cat > "$SITE" <<NGINX
# managed-by: sitesforstudios (deploy/ec2/use-cloudfront.sh): API only, web app on CloudFront
server {
    listen 80;
    listen [::]:80;
    server_name $API_DOMAIN;
$API_LOCATIONS
}
NGINX
fi
if ! nginx -t; then
  echo "!! nginx config test failed; restoring the previous site"
  cp "$(ls -t "$SITE".bak.* | head -1)" "$SITE"
  exit 1
fi
systemctl reload nginx

set_env() {
  if grep -q "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else echo "$1=$2" >> "$ENV_FILE"; fi
}
set_env APP_URL "https://$APP_DOMAIN"
set_env TRUST_PROXY_HOPS 2
set_env WEB_HOSTING s3
chown "$APP_USER:$APP_USER" "$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "==> nginx now serves only /api for $API_DOMAIN; other paths redirect to https://$APP_DOMAIN"
echo "==> Next (no sudo): bash ~/apps/sitesforstudios/server/deploy/ec2/deploy.sh"
