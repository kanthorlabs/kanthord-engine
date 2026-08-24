#!/usr/bin/env bash
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
guard="$here/memory-append-only.sh"
failures=0

fail() {
  echo "FAIL  $1" >&2
  failures=$((failures + 1))
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git -C "$work" init -q
git -C "$work" config user.email guard@test
git -C "$work" config user.name guard
mkdir -p "$work/.agents/tdd/history" "$work/.agents/tdd/memory/test-engineer"
journal="$work/.agents/tdd/memory/test-engineer/2026-08-05.md"
channel="$work/.agents/tdd/history/2026-08-05-006-git-primitives.md"
printf '# journal\nfirst entry\n' >"$journal"
printf '# channel\nEND: TEST-ENGINEER\n' >"$channel"
git -C "$work" add -A
git -C "$work" commit -qm base

expect() {
  local want=$1 what=$2
  local got=0
  "$guard" "$work" >/dev/null 2>&1 || got=$?
  [ "$got" -eq "$want" ] || fail "$what — want exit $want, got $got"
}

expect 0 "a clean tree passes"

printf 'appended entry\n' >>"$journal"
printf 'appended turn\n' >>"$channel"
expect 0 "a pure append passes"

printf '# journal\nfirst entry REWRITTEN\nappended entry\n' >"$journal"
expect 1 "an in-place edit of committed content fails"

git -C "$work" checkout -q -- .agents
printf 'appended entry\n' >>"$journal"
head -1 "$journal" >"$journal.trimmed" && mv "$journal.trimmed" "$journal"
expect 1 "a truncation fails"

git -C "$work" checkout -q -- .agents
rm "$channel"
expect 1 "a deleted channel file fails"

git -C "$work" checkout -q -- .agents
printf 'untracked draft\n' >"$work/.agents/tdd/memory/test-engineer/2026-08-06.md"
expect 0 "a new untracked journal file passes"

if [ "$failures" -ne 0 ]; then
  echo "memory-append-only.test.sh: $failures failure(s)" >&2
  exit 1
fi

echo "memory-append-only.test.sh: PASS"
