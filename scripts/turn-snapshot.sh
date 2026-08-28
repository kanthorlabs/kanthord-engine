#!/usr/bin/env bash
set -euo pipefail

# A git hook exports GIT_DIR, GIT_INDEX_FILE and friends. Those variables
# override "git -C", so every git call below would resolve to the caller's
# repository instead of the temporary one, and would corrupt it. Clear them
# before the first git call.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_QUARANTINE_PATH \
  GIT_PREFIX GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM

if [ "$#" -ne 1 ]; then
  echo "usage: scripts/turn-snapshot.sh <root>" >&2
  exit 2
fi

root=$1

git -C "$root" status --porcelain -z -uall --no-renames |
  while IFS= read -r -d '' entry; do
    path=${entry:3}
    if [ -f "$root/$path" ]; then
      printf '%s\t%s\n' "$(git -C "$root" hash-object -- "$root/$path")" "$path"
    else
      printf 'ABSENT\t%s\n' "$path"
    fi
  done |
  LC_ALL=C sort
