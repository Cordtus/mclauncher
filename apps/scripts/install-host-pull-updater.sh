#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${MCLAUNCHER_REPO_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
SCHEDULE="${MCLAUNCHER_AUTO_UPDATE_SCHEDULE:-17 */6 * * *}"
LOG_DIR="${MCLAUNCHER_LOG_DIR:-$HOME/.local/state/mclauncher}"
LOG_FILE="$LOG_DIR/auto-update.log"
UPDATER="$REPO_DIR/apps/scripts/host-pull-deploy.sh"

if [ ! -x "$UPDATER" ]; then
  chmod +x "$UPDATER"
fi
chmod +x "$REPO_DIR/apps/scripts/deploy-built-artifacts.sh"

mkdir -p "$LOG_DIR"

TMP_CRON="$(mktemp)"
trap 'rm -f "$TMP_CRON"' EXIT

{
  crontab -l 2>/dev/null | sed '/# mclauncher-auto-update/,+1d'
  printf '%s\n' '# mclauncher-auto-update'
  printf '%s MCLAUNCHER_REPO_DIR=%q %q >> %q 2>&1\n' "$SCHEDULE" "$REPO_DIR" "$UPDATER" "$LOG_FILE"
} > "$TMP_CRON"

crontab "$TMP_CRON"

echo "Installed mclauncher pull updater:"
echo "  Schedule: $SCHEDULE"
echo "  Repo: $REPO_DIR"
echo "  Log: $LOG_FILE"
