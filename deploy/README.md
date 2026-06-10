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
