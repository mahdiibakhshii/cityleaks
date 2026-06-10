#!/usr/bin/env bash
# CityLeaks server bootstrap — idempotent. Safe to re-run.
# Installs swap, base packages, Node (official binary), PM2, and OS tuning.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

NODE_VER=v22.20.0

echo "[1/7] swap (2G)"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "[2/7] apt update + upgrade"
apt-get update -y
apt-get upgrade -y

echo "[3/7] base packages"
apt-get install -y ca-certificates curl gnupg git ufw nginx fail2ban build-essential xz-utils

echo "[4/7] node ${NODE_VER} (official binary)"
if [ "$(node -v 2>/dev/null || true)" != "$NODE_VER" ]; then
  cd /tmp
  curl -fsSLO "https://nodejs.org/dist/${NODE_VER}/node-${NODE_VER}-linux-x64.tar.xz"
  rm -rf /usr/local/lib/nodejs
  mkdir -p /usr/local/lib/nodejs
  tar -xf "node-${NODE_VER}-linux-x64.tar.xz" -C /usr/local/lib/nodejs --strip-components=1
  ln -sf /usr/local/lib/nodejs/bin/node /usr/local/bin/node
  ln -sf /usr/local/lib/nodejs/bin/npm  /usr/local/bin/npm
  ln -sf /usr/local/lib/nodejs/bin/npx  /usr/local/bin/npx
fi

echo "[5/7] pm2"
npm install -g pm2
ln -sf /usr/local/lib/nodejs/bin/pm2 /usr/local/bin/pm2

echo "[6/7] OS tuning for many websocket connections"
# Raise file-descriptor limits (each socket = 1 fd).
cat > /etc/security/limits.d/cityleaks.conf <<'EOF'
root soft nofile 65536
root hard nofile 65536
* soft nofile 65536
* hard nofile 65536
EOF
# Kernel network tuning.
cat > /etc/sysctl.d/99-cityleaks.conf <<'EOF'
fs.file-max = 200000
net.core.somaxconn = 4096
net.ipv4.tcp_tw_reuse = 1
EOF
sysctl --system >/dev/null

echo "[7/7] versions"
echo "node $(node -v) | npm $(npm -v) | pm2 $(pm2 -v) | $(nginx -v 2>&1)"
echo PROVISION_DONE
