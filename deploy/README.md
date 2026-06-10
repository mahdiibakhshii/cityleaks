# Deployment

CityLeaks runs on a Hetzner VPS (Ubuntu) behind nginx, managed by PM2, with
GitHub Actions auto-deploying on every push to `main`.

## Architecture

```
players ──HTTP/WS──▶ nginx :80 ──proxy──▶ Node/Socket.IO :3000  (PM2: "cityleaks")
                                              └─ serves client/dist + /api + /socket.io
GitHub push to main ─▶ Actions: build client ─▶ rsync dist + git pull on server ─▶ pm2 restart
```

## Files

| File | Purpose |
|------|---------|
| `provision.sh` | One-time server bootstrap: swap, Node, PM2, nginx, OS tuning. |
| `bootstrap-app.sh` | First app bring-up: clone, build, PM2 start, nginx site, firewall. |
| `ecosystem.config.cjs` | PM2 process definition (runs `node --import tsx src/index.ts`). |
| `nginx-cityleaks.conf` | Reverse proxy `:80 → :3000` with WebSocket upgrade headers. |
| `../.github/workflows/deploy.yml` | CI/CD: build + deploy on push to `main`. |

## First-time setup (already done once)

```bash
# On the server, as root:
bash provision.sh          # system packages + runtime
bash bootstrap-app.sh      # clone + build + run
```

## Domain + HTTPS

Live at **https://cityleaks.space** (and `www.`). DNS: Namecheap A records `@` and
`www` → the server IP. TLS is a Let's Encrypt cert managed by certbot, which
edited the live nginx config to add the `:443` block + HTTP→HTTPS redirect and
**auto-renews** via a systemd timer.

First-time HTTPS on a fresh server (after `bootstrap-app.sh`):

```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d cityleaks.space -d www.cityleaks.space \
  --non-interactive --agree-tos -m mhdi.bakhshii@gmail.com --redirect
```

After that, re-running `bootstrap-app.sh` re-applies TLS automatically (it detects
the existing cert and runs `certbot install`). Renewal is automatic; test it with
`certbot renew --dry-run`.

## Required GitHub Actions secrets

Set under repo → Settings → Secrets and variables → Actions:

| Secret | Value |
|--------|-------|
| `SSH_HOST` | server IPv4 |
| `SSH_USER` | `root` |
| `SSH_PRIVATE_KEY` | private half of the deploy keypair (public half is in the server's `~/.ssh/authorized_keys`) |

## Useful server commands

```bash
pm2 status                 # process state
pm2 logs cityleaks         # live logs
pm2 restart cityleaks      # manual restart
curl localhost:3000/api/status   # health + tick metrics
```
