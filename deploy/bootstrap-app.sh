#!/usr/bin/env bash
# First-time app bring-up on the server. Idempotent — safe to re-run.
# (Routine updates afterwards are handled by .github/workflows/deploy.yml.)
set -euo pipefail

REPO=https://github.com/mahdiibakhshii/cityleaks.git
APP=/opt/cityleaks

echo "[1/7] clone / update repo"
if [ -d "$APP/.git" ]; then
  cd "$APP"
  git fetch --depth=1 origin main
  git reset --hard origin/main
else
  git clone --depth=1 "$REPO" "$APP"
fi
mkdir -p "$APP/server/data"   # persistent leak grid + notes live here

echo "[2/7] server dependencies"
cd "$APP/server" && npm ci --omit=dev

echo "[3/7] build client"
cd "$APP/client" && npm ci && npm run build

echo "[4/7] start under PM2"
cd "$APP"
pm2 start deploy/ecosystem.config.cjs --update-env || pm2 restart cityleaks --update-env
pm2 save

echo "[5/7] enable PM2 on boot"
env PATH="$PATH:/usr/local/bin" pm2 startup systemd -u root --hp /root | tail -1 | bash || true
pm2 save

echo "[6/7] nginx reverse proxy"
cp deploy/nginx-cityleaks.conf /etc/nginx/sites-available/cityleaks
ln -sf /etc/nginx/sites-available/cityleaks /etc/nginx/sites-enabled/cityleaks
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx

echo "[7/7] firewall"
ufw allow OpenSSH >/dev/null 2>&1 || ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo BOOTSTRAP_DONE
