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
| `sync-data.sh` | Sync live player data (paths/notes/kills) VPS↔local + backups. |
| `sync-data.ps1` | Windows-native PowerShell wrapper around `sync-data.sh`. |
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

## Admin password (REQUIRED in production)

The admin console can wipe all notes/paths/kills, so in production the server
**refuses to boot unless `ADMIN_PASSWORD` is set to a strong value** (≥10 chars,
not the public default `252525`). The secret is **never committed** — it's read
from the server environment and passed through by `ecosystem.config.cjs`.

Set it once on the server, then restart so PM2 picks it up:

```bash
# On the server (root@…). Use a long random value.
echo 'ADMIN_PASSWORD=<a-long-random-passphrase>' >> /etc/environment
# Make it available to the current session + PM2 right now:
export ADMIN_PASSWORD='<the-same-value>'
cd /opt/cityleaks && pm2 restart cityleaks --update-env && pm2 save
# Verify it booted (no FATAL line):
pm2 logs cityleaks --lines 20
```

`/etc/environment` is loaded for the deploy's SSH session too, so the
`pm2 restart … --update-env` in `.github/workflows/deploy.yml` keeps the password
across deploys. **Do this BEFORE the next deploy** — otherwise the new build will
hard-refuse to boot and PM2 will crash-loop. (Tokens/lockouts are in-memory, so a
restart logs admins out and clears any login lockout — expected.)

## Data sync & backups

The live, player-generated state — the **leak paths** (`leak-grid.bin`), **sticky
notes / words** (`notes.json`), and **kill markers** (`kills.json`) — lives ONLY
on the server at `/opt/cityleaks/server/data/` (gitignored, untouched by
deploys). `sync-data.sh` copies it down for local dev / backups, and can push a
backup back up for disaster recovery. (`collision.bin` is a derived cache — never
synced; it rebuilds itself from the mask tiles.)

Run from the repo root. **PowerShell** (Windows-native): `.\deploy\sync-data.ps1 <cmd>`.
**Git Bash / Linux**: `bash deploy/sync-data.sh <cmd>`.

```powershell
.\deploy\sync-data.ps1 pull        # copy live data DOWN into server/data/ (snapshots local first)
.\deploy\sync-data.ps1 backup      # save a timestamped .tar.gz of live PROD data into backups/
.\deploy\sync-data.ps1 list        # list local backups
.\deploy\sync-data.ps1 restore .\backups\prod-YYYYMMDD-HHMMSS.tar.gz   # push a backup UP to prod (guarded)
```

- **Safe on the live server.** The server writes data atomically (temp file +
  rename, `server/src/atomicWrite.ts`), so a `pull`/`backup` never catches a
  half-written file — and a crash mid-save can't corrupt the live data either.
- **Backups** land in `backups/` (gitignored), timestamped, newest `KEEP` (=20)
  retained per kind: `prod-*` (manual), `local-prepull-*` (auto before each pull),
  `prod-prerestore-*` (auto before each restore).
- **`restore` is guarded:** it lists the archive, asks for confirmation, takes a
  fresh safety backup of prod, then `pm2 stop → push files → pm2 restart` so the
  server reloads the restored data from disk (stopping first ensures its periodic
  save doesn't overwrite the push).
- **Config via env:** `SSH_HOST`, `SSH_USER`, `SSH_KEY` (default
  `~/.ssh/cityleaks_hetzner`), `REMOTE_APP`, `PM2_NAME`, `KEEP`. Uses `ssh`/`scp`
  + `tar` (no `rsync` needed). If `ssh` complains the key is "too open", tighten
  it with `icacls`/`chmod 600`.

## Useful server commands

```bash
pm2 status                 # process state
pm2 logs cityleaks         # live logs
pm2 restart cityleaks      # manual restart
curl localhost:3000/api/status   # health + tick metrics
```
