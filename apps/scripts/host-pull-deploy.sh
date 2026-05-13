#!/usr/bin/env bash
set -euo pipefail

PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin:${PATH:-}"

REPO_DIR="${MCLAUNCHER_REPO_DIR:-$HOME/repos/mclauncher}"
BRANCH="${MCLAUNCHER_BRANCH:-main}"
STATE_DIR="${MCLAUNCHER_STATE_DIR:-$HOME/.local/state/mclauncher}"
LOCK_FILE="${MCLAUNCHER_LOCK_FILE:-$STATE_DIR/auto-update.lock}"

timestamp() {
  date -Iseconds
}

log() {
  printf '[%s] %s\n' "$(timestamp)" "$*"
}

mkdir -p "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another update is already running; exiting"
  exit 0
fi

cd "$REPO_DIR"

status_output="$(git status --porcelain)"
if [ -n "$status_output" ]; then
  log "checkout has local changes; aborting pull deploy"
  printf '%s\n' "$status_output"
  exit 1
fi

log "fetching origin/$BRANCH"
git fetch --prune origin "$BRANCH"

current_ref="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_ref" != "$BRANCH" ]; then
  log "switching from $current_ref to $BRANCH"
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git switch "$BRANCH"
  else
    git switch --track -c "$BRANCH" "origin/$BRANCH"
  fi
fi

current_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse "origin/$BRANCH")"

if [ "$current_sha" = "$remote_sha" ]; then
  log "already up to date at $current_sha"
  exit 0
fi

log "updating $BRANCH from $current_sha to $remote_sha"
git pull --ff-only origin "$BRANCH"

log "installing dependencies"
npm install

log "building applications"
npm run build

log "deploying built artifacts"
"$REPO_DIR/apps/scripts/deploy-built-artifacts.sh"

log "updated and deployed $(git rev-parse HEAD)"
