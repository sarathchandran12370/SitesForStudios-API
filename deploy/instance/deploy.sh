#!/bin/bash
# Installs one API release on the EC2 instance. Run as root (GitHub Actions calls it through SSM).
#   deploy.sh /tmp/sfs-release.tgz
# Steps: unpack -> npm ci -> write env from Secrets Manager -> migrate + seed -> switch symlink
# -> restart -> health check -> roll back to the previous release if the health check fails.
set -euo pipefail

ARCHIVE="$1"
APP_DIR=/opt/sitesforstudios
CONF_DIR=/etc/sitesforstudios
NODE=/usr/local/bin/node
NPM=/usr/local/bin/npm
export PATH=/usr/local/bin:$PATH
export HOME=/root  # SSM runs without HOME; npm needs it

# shellcheck disable=SC1091
source "$CONF_DIR/stack.env"

secret() { aws secretsmanager get-secret-value --region "$AWS_REGION" --secret-id "$1" --query SecretString --output text; }

echo "==> Writing $CONF_DIR/app.env"
DB_JSON=$(secret "$DB_SECRET_ARN")
EXT_JSON=$(secret "$EXTERNAL_SECRET_ARN")
DB_USER=$(jq -r .username <<<"$DB_JSON")
DB_PASS=$(jq -r '.password | @uri' <<<"$DB_JSON")
umask 077
cat > "$CONF_DIR/app.env.new" <<ENV
NODE_ENV='production'
PORT='4000'
APP_URL='$APP_URL'
SITES_CNAME_TARGET='$SITES_CNAME_TARGET'
DATABASE_URL='postgres://$DB_USER:$DB_PASS@$DB_HOST:$DB_PORT/$DB_NAME'
DATABASE_SSL_CA='$CONF_DIR/rds-ca.pem'
MONGO_URL='$(jq -r .mongoUrl <<<"$EXT_JSON")'
JWT_SECRET='$(secret "$JWT_SECRET_ARN")'
MEDIA_SIGNING_SECRET='$(secret "$MEDIA_SECRET_ARN")'
ORIGIN_VERIFY_SECRET='$(secret "$ORIGIN_SECRET_ARN")'
STORAGE_DRIVER='s3'
AWS_REGION='$AWS_REGION'
S3_BUCKET=$S3_BUCKET
FACE_PROVIDER='$FACE_PROVIDER'
RAZORPAY_KEY_ID='$(jq -r .razorpayKeyId <<<"$EXT_JSON")'
RAZORPAY_KEY_SECRET='$(jq -r .razorpayKeySecret <<<"$EXT_JSON")'
RAZORPAY_WEBHOOK_SECRET='$(jq -r .razorpayWebhookSecret <<<"$EXT_JSON")'
SEED_ADMIN_EMAIL='$ADMIN_EMAIL'
SEED_ADMIN_PASSWORD='$(secret "$ADMIN_PASSWORD_SECRET_ARN")'
ENV
chown root:sfs "$CONF_DIR/app.env.new"
chmod 640 "$CONF_DIR/app.env.new"
mv "$CONF_DIR/app.env.new" "$CONF_DIR/app.env"
umask 022

echo "==> Unpacking release"
RELEASE="$APP_DIR/releases/$(date +%Y%m%d%H%M%S)"
mkdir -p "$RELEASE"
tar -xzf "$ARCHIVE" -C "$RELEASE"
cd "$RELEASE"
"$NPM" ci --omit=dev --no-audit --no-fund

echo "==> Migrating and seeding (idempotent)"
"$NODE" --env-file="$CONF_DIR/app.env" src/db/migrate.js
"$NODE" --env-file="$CONF_DIR/app.env" src/db/seed.js
chown -R sfs:sfs "$RELEASE"

echo "==> Installing systemd service"
cat > /etc/systemd/system/sitesforstudios.service <<UNIT
[Unit]
Description=SitesForStudios API
After=network-online.target
Wants=network-online.target

[Service]
User=sfs
WorkingDirectory=$APP_DIR/current
EnvironmentFile=$CONF_DIR/app.env
ExecStart=$NODE src/index.js
Restart=always
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable sitesforstudios >/dev/null

PREVIOUS=$(readlink -f "$APP_DIR/current" || true)
ln -sfn "$RELEASE" "$APP_DIR/current.new"
mv -T "$APP_DIR/current.new" "$APP_DIR/current"
systemctl restart sitesforstudios

echo "==> Health check"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4000/api/health >/dev/null; then
    echo "Release $(basename "$RELEASE") is live"
    ls -1dt "$APP_DIR"/releases/* | tail -n +6 | xargs -r rm -rf
    exit 0
  fi
  sleep 2
done

echo "!! Health check failed. Recent logs:"
journalctl -u sitesforstudios -n 40 --no-pager || true
if [ -n "$PREVIOUS" ] && [ -d "$PREVIOUS" ] && [ "$PREVIOUS" != "$RELEASE" ]; then
  echo "==> Rolling back to $(basename "$PREVIOUS")"
  ln -sfn "$PREVIOUS" "$APP_DIR/current.new"
  mv -T "$APP_DIR/current.new" "$APP_DIR/current"
  systemctl restart sitesforstudios
fi
exit 1
