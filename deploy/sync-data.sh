#!/usr/bin/env bash
#
# sync-data.sh — copy CityLeaks live player data between the production VPS and
# your local machine, and keep timestamped backups.
#
# The live, player-generated state lives ONLY on the server at
# /opt/cityleaks/server/data/ (gitignored, untouched by deploys). The files that
# matter are the "leak" paths, the sticky notes (words), the kill markers, the
# admins' real-sticker photos (one webp per note id), and the per-note chats:
#
#     leak-grid.bin   notes.json   kills.json   note-images/   chats/
#
# (collision.bin is a derived cache rebuilt from the mask tiles — never synced.)
#
# Commands:
#   pull                 Copy live data DOWN into server/data/ (snapshots local first).
#   backup               Save a timestamped .tar.gz of live PROD data into backups/.
#   restore <archive>    Push a backup .tar.gz UP to prod (guarded; safety-backs-up first).
#   list                 List local backups.
#   help                 This help.
#
# All copies are safe to run against the LIVE server: the server now writes data
# atomically (temp + rename, see server/src/atomicWrite.ts), so a copy never
# catches a half-written file.
#
# Config via env (sensible defaults for the cityleaks.space box):
#   SSH_HOST   server IP/host       (default 167.233.102.255)
#   SSH_USER   ssh user             (default root)
#   SSH_KEY    private key path      (default ~/.ssh/cityleaks_hetzner)
#   REMOTE_APP app dir on server     (default /opt/cityleaks)
#   PM2_NAME   pm2 process name      (default cityleaks)
#   KEEP       backups to retain     (default 20)
#
set -euo pipefail

SSH_HOST="${SSH_HOST:-167.233.102.255}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/cityleaks_hetzner}"
REMOTE_APP="${REMOTE_APP:-/opt/cityleaks}"
PM2_NAME="${PM2_NAME:-cityleaks}"
KEEP="${KEEP:-20}"

REMOTE_DATA="$REMOTE_APP/server/data"
# Player-generated state to sync. note-images/ + chats/ are directories (one
# webp / one JSON per note id); tar handles them like the files. collision.bin is
# a derived cache — excluded.
DATA_FILES=(leak-grid.bin notes.json kills.json note-images chats)

# Repo root = parent of this script's dir, regardless of where it's invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_DATA="$REPO_ROOT/server/data"
BACKUP_DIR="$REPO_ROOT/backups"

SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15)
REMOTE="$SSH_USER@$SSH_HOST"

ts()   { date +%Y%m%d-%H%M%S; }
log()  { printf '\033[36m›\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

remote() { ssh "${SSH_OPTS[@]}" "$REMOTE" "$@"; }

# Keep only the newest $KEEP files matching a glob; delete the rest.
prune() {
  local glob="$1" extra
  # shellcheck disable=SC2206
  local files=( $glob )
  [ -e "${files[0]:-}" ] || return 0
  local count=${#files[@]}
  (( count <= KEEP )) && return 0
  # Sorted oldest-first by name (timestamps sort lexically); drop the head.
  mapfile -t sorted < <(printf '%s\n' "${files[@]}" | sort)
  local remove=$(( count - KEEP ))
  for ((i = 0; i < remove; i++)); do rm -f "${sorted[$i]}"; done
  log "Pruned $remove old backup(s) (kept newest $KEEP)."
}

require_key() {
  [ -f "$SSH_KEY" ] || die "SSH key not found: $SSH_KEY (set SSH_KEY=...)"
}

# Stream the live PROD data files into a local .tar.gz. GNU tar on the server
# ignores any file that doesn't exist yet (--ignore-failed-read).
backup_prod_to() {
  local out="$1"
  mkdir -p "$(dirname "$out")"
  log "Backing up live data → $(basename "$out")"
  remote "tar -C '$REMOTE_DATA' -czf - --ignore-failed-read ${DATA_FILES[*]}" > "$out"
  ok "Saved $(du -h "$out" | cut -f1) → $out"
}

# Snapshot whatever local data files currently exist into a .tar.gz.
backup_local_to() {
  local out="$1" present=()
  for f in "${DATA_FILES[@]}"; do [ -e "$LOCAL_DATA/$f" ] && present+=("$f"); done
  [ ${#present[@]} -eq 0 ] && { log "No local data to snapshot — skipping."; return 0; }
  mkdir -p "$(dirname "$out")"
  tar -C "$LOCAL_DATA" -czf "$out" "${present[@]}"
  ok "Snapshotted local data → $out"
}

cmd_pull() {
  require_key
  mkdir -p "$LOCAL_DATA" "$BACKUP_DIR"
  log "Pulling live data from $REMOTE:$REMOTE_DATA"
  backup_local_to "$BACKUP_DIR/local-prepull-$(ts).tar.gz"
  prune "$BACKUP_DIR/local-prepull-*.tar.gz"
  # One connection: stream a tar of the remote files and extract into local data.
  remote "tar -C '$REMOTE_DATA' -czf - --ignore-failed-read ${DATA_FILES[*]}" | tar -C "$LOCAL_DATA" -xzf -
  ok "Pulled into $LOCAL_DATA:"
  for f in "${DATA_FILES[@]}"; do
    [ -e "$LOCAL_DATA/$f" ] && printf '    %s  (%s)\n' "$f" "$(du -sh "$LOCAL_DATA/$f" | cut -f1)"
  done
}

cmd_backup() {
  require_key
  mkdir -p "$BACKUP_DIR"
  backup_prod_to "$BACKUP_DIR/prod-$(ts).tar.gz"
  prune "$BACKUP_DIR/prod-*.tar.gz"
}

cmd_restore() {
  require_key
  local archive="${1:-}" assume_yes=0
  [ "${2:-}" = "--yes" ] && assume_yes=1
  [ "$archive" = "--yes" ] && die "Usage: restore <archive.tar.gz> [--yes]"
  [ -n "$archive" ] || die "Usage: restore <archive.tar.gz> [--yes]"
  [ -f "$archive" ] || die "Archive not found: $archive"

  log "Archive contents:"
  tar -tzf "$archive" | sed 's/^/    /'

  if [ "$assume_yes" -ne 1 ]; then
    printf '\033[33mThis OVERWRITES live player data on %s. Continue? [y/N] \033[0m' "$SSH_HOST"
    read -r reply </dev/tty || true
    case "$reply" in y|Y|yes|YES) ;; *) die "Aborted." ;; esac
  fi

  backup_prod_to "$BACKUP_DIR/prod-prerestore-$(ts).tar.gz"
  prune "$BACKUP_DIR/prod-prerestore-*.tar.gz"

  # Stop the server first so (a) it isn't periodically overwriting disk from
  # memory and (b) its graceful shutdown save finishes BEFORE we push files.
  log "Stopping pm2 process '$PM2_NAME'…"
  remote "pm2 stop '$PM2_NAME'"
  log "Pushing data to $REMOTE_DATA…"
  remote "mkdir -p '$REMOTE_DATA'"
  cat "$archive" | remote "tar -C '$REMOTE_DATA' -xzf -"
  log "Restarting pm2 process '$PM2_NAME'…"
  remote "pm2 restart '$PM2_NAME'"
  ok "Restored $archive → prod (server reloaded from disk)."
}

cmd_list() {
  mkdir -p "$BACKUP_DIR"
  if compgen -G "$BACKUP_DIR/*.tar.gz" > /dev/null; then
    ( cd "$BACKUP_DIR" && ls -lh *.tar.gz )
  else
    log "No backups yet in $BACKUP_DIR"
  fi
}

usage() { sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

case "${1:-help}" in
  pull)    cmd_pull ;;
  backup)  cmd_backup ;;
  restore) shift; cmd_restore "$@" ;;
  list)    cmd_list ;;
  help|-h|--help) usage ;;
  *) die "Unknown command: $1 (try: pull | backup | restore | list | help)" ;;
esac
