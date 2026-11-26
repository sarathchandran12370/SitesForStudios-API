#!/bin/bash
# Deploy SitesForStudios on the EC2 as the app user (no sudo). From your Mac:
#   ssh $thaaral 'bash ~/apps/sitesforstudios/server/deploy/ec2/deploy.sh'
#
# Pulls the latest main of both repos, installs Node 24 privately (the system Node is untouched),
# writes the environment file on the first run, migrates the database, builds the web app,
# publishes it to /var/www/sitesforstudios and (re)starts the API in PM2 as "sfs-api".
set -euo pipefail

DOMAIN="${DOMAIN:-api.thaaram.in}"
BASE="$HOME/apps/sitesforstudios"
SHARED="$BASE/shared"
WEB_ROOT=/var/www/sitesforstudios
NODE_MAJOR=24
NODE_DIR="$BASE/node"
API_REPO="git@github.com:sarathchandran12370/SitesForStudios-API.git"
UI_REPO="git@github.com:sarathchandran12370/SitesForStudios-UI.git"

mkdir -p "$BASE" "$SHARED" "$SHARED/storage"
cd "$BASE"

# ---------------------------------------------------------------- Node 24 (private copy)
if [ ! -x "$NODE_DIR/bin/node" ] || ! "$NODE_DIR/bin/node" -v | grep -q "^v$NODE_MAJOR"; then
  echo "==> Installing Node $NODE_MAJOR into $NODE_DIR"
  TMP="$(mktemp -d)"
  SUMS="$(curl -fsSL "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/SHASUMS256.txt")"
  FILE="$(echo "$SUMS" | awk '/linux-x64.tar.xz$/ {print $2}')"
  curl -fsSL "https://nodejs.org/dist/latest-v$NODE_MAJOR.x/$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && echo "$SUMS" | grep " $FILE\$" | sha256sum -c - >/dev/null)
  rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
  tar -xJf "$TMP/$FILE" -C "$NODE_DIR" --strip-components=1
  rm -rf "$TMP"
fi
export PATH="$NODE_DIR/bin:$PATH"
echo "==> Node $(node -v), npm $(npm -v)"

# ---------------------------------------------------------------- code
for pair in "server:$API_REPO" "web:$UI_REPO"; do
  dir="${pair%%:*}"; repo="${pair#*:}"
  if [ -d "$BASE/$dir/.git" ]; then
    git -C "$BASE/$dir" fetch -q origin main && git -C "$BASE/$dir" reset -q --hard origin/main
  else
    git clone -q "$repo" "$BASE/$dir"
  fi
  echo "==> $dir at $(git -C "$BASE/$dir" log -1 --format='%h %s')"
done

# ---------------------------------------------------------------- environment (first run only)
ENV_FILE="$SHARED/.env"
if [ ! -f "$ENV_FILE" ]; then
  [ -f "$SHARED/pg-password" ] || { echo "!! $SHARED/pg-password missing. Run setup-root.sh with sudo first."; exit 1; }
  echo "==> Writing $ENV_FILE"
  ADMIN_PASS="$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-16)"
  umask 077
  cat > "$ENV_FILE" <<ENV
NODE_ENV=production
PORT=4000
APP_URL=https://$DOMAIN
SITES_CNAME_TARGET=$DOMAIN
DATABASE_URL=postgres://sitesforstudios:$(cat "$SHARED/pg-password")@127.0.0.1:5432/sitesforstudios
MONGO_URL=mongodb://127.0.0.1:27017/sitesforstudios
JWT_SECRET=$(openssl rand -hex 32)
MEDIA_SIGNING_SECRET=$(openssl rand -hex 32)
# Photos on this server's disk for now. For Cloudflare R2: STORAGE_DRIVER=r2, R2_ACCOUNT_ID,
# R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET (see DEPLOYMENT.md).
STORAGE_DRIVER=local
LOCAL_STORAGE_DIR=$SHARED/storage
AWS_REGION=ap-south-1
FACE_PROVIDER=none
PROCESSING_CONCURRENCY=1
EMAIL_PROVIDER=log
JOBS_CHECK_HOURS=1
SEED_ADMIN_EMAIL=admin@$DOMAIN
SEED_ADMIN_PASSWORD=$ADMIN_PASS
ENV
  printf 'Super Admin login for https://%s\nEmail: admin@%s\nPassword: %s\nChange it after the first login.\n' "$DOMAIN" "$DOMAIN" "$ADMIN_PASS" > "$SHARED/initial-admin.txt"
  umask 022
fi

# ---------------------------------------------------------------- API
cd "$BASE/server"
npm ci --omit=dev --no-audit --no-fund --loglevel=error
node --env-file="$ENV_FILE" src/db/migrate.js
node --env-file="$ENV_FILE" src/db/seed.js

# ---------------------------------------------------------------- web app
# WEB_HOSTING=s3 (set by use-cloudfront.sh): the web app is deployed to S3 + CloudFront by GitHub Actions.
WEB_HOSTING="$(grep -E '^WEB_HOSTING=' "$ENV_FILE" | cut -d= -f2 || true)"
if [ "${WEB_HOSTING:-ec2}" = "s3" ]; then
  echo "==> Web app is on S3 + CloudFront (GitHub Actions deploys it); skipping it here"
else
  cd "$BASE/web"
  npm ci --no-audit --no-fund --loglevel=error
  VITE_APP_HOSTS="$DOMAIN" npx vite build --logLevel warn
  rsync -a --delete dist/ "$WEB_ROOT/" 2>/dev/null || { rm -rf "${WEB_ROOT:?}"/*; cp -r dist/. "$WEB_ROOT/"; }
  echo "==> Web app published to $WEB_ROOT"
fi

# ---------------------------------------------------------------- start / restart in PM2
cd "$BASE/server"
if pm2 describe sfs-api >/dev/null 2>&1; then
  pm2 reload deploy/ec2/ecosystem.config.cjs --update-env >/dev/null
else
  pm2 start deploy/ec2/ecosystem.config.cjs >/dev/null
fi
pm2 save >/dev/null

echo "==> Health check"
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:4000/api/health >/dev/null; then
    echo "==> Live: https://$DOMAIN"
    [ -f "$SHARED/initial-admin.txt" ] && echo "    First Super Admin login is in $SHARED/initial-admin.txt"
    exit 0
  fi
  sleep 2
done
echo "!! API did not become healthy. Last logs:"
pm2 logs sfs-api --lines 40 --nostream
exit 1
