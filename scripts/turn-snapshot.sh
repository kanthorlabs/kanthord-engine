#!/usr/bin/env bash
set -euo pipefail

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
