#!/usr/bin/env bash
set -euo pipefail

root=.
if [ "$#" -gt 1 ]; then
  echo "usage: scripts/memory-append-only.sh [<root>]" >&2
  exit 2
fi
if [ "$#" -eq 1 ]; then
  root=$1
fi

status=0

check() {
  local path=$1

  if ! git -C "$root" cat-file -e "HEAD:$path" 2>/dev/null; then
    return 0
  fi

  if [ ! -f "$root/$path" ]; then
    echo "append-only violation: $path — the file was deleted" >&2
    status=1
    return 0
  fi

  local size
  size=$(git -C "$root" cat-file -s "HEAD:$path")
  if [ "$size" -eq 0 ]; then
    return 0
  fi

  if ! cmp -s -n "$size" \
    <(git -C "$root" show "HEAD:$path") \
    "$root/$path"; then
    echo "append-only violation: $path — the committed content is no longer its prefix" >&2
    status=1
  fi
}

while IFS= read -r -d '' path; do
  check "$path"
done < <(git -C "$root" ls-files -z -- '.agent/tdd/history' '.agent/tdd/memory')

if [ "$status" -eq 0 ]; then
  echo "APPEND-ONLY: PASS"
else
  echo "APPEND-ONLY: FAIL"
fi

exit "$status"
