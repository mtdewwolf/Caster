#!/usr/bin/env bash
set -euo pipefail

# Keep generated Android output and local SQLite/runtime data out of every
# commit, including files added with git add --force.
artifact_pattern='(^|/)(\.gradle|build)(/|$)|(^|/)[^/]+\.(db|db-wal|db-shm|sqlite|sqlite3|sqlite-wal|sqlite-shm|sqlite-journal|apk|aab|aar|apks|hprof|dex|class)$'

violations="$(git ls-files | grep -E "$artifact_pattern" || true)"
if [[ -n "$violations" ]]; then
  echo "Tracked generated or local-data artifacts are forbidden:" >&2
  printf '%s\n' "$violations" >&2
  exit 1
fi

echo "No forbidden generated or local-data artifacts are tracked."
