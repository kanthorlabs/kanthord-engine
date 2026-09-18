#!/usr/bin/env bash
set -uo pipefail

# A git hook exports GIT_DIR, GIT_INDEX_FILE and friends. Those variables
# override "git -C", so every git call below would resolve to the caller's
# repository instead of the temporary one, and would corrupt it. Clear them
# before the first git call.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_QUARANTINE_PATH \
  GIT_PREFIX GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM

here=$(cd "$(dirname "$0")" && pwd)
guard="$here/history-append-only.sh"
failures=0

fail() {
  echo "FAIL  $1" >&2
  failures=$((failures + 1))
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

git -C "$work" init -q
mkdir -p "$work/.agents/tdd/history"
channel="$work/.agents/tdd/history/2026-08-05-006-git-primitives.md"
printf '# channel\nEND: TEST-ENGINEER\n' >"$channel"
git -C "$work" add -A
git -C "$work" -c user.email=guard@test -c user.name=guard commit -qm base

expect() {
  local want=$1 what=$2
  local got=0
  "$guard" "$work" >/dev/null 2>&1 || got=$?
  [ "$got" -eq "$want" ] || fail "$what — want exit $want, got $got"
}

expect 0 "a clean tree passes"

printf 'appended turn\n' >>"$channel"
expect 0 "a pure append passes"

printf '# channel\nEND: TEST-ENGINEER REWRITTEN\nappended turn\n' >"$channel"
expect 1 "an in-place edit of committed content fails"

git -C "$work" checkout -q -- .agents
printf 'appended turn\n' >>"$channel"
head -1 "$channel" >"$channel.trimmed" && mv "$channel.trimmed" "$channel"
expect 1 "a truncation fails"

git -C "$work" checkout -q -- .agents
rm "$channel"
expect 1 "a deleted channel file fails"

git -C "$work" checkout -q -- .agents
printf 'untracked draft\n' >"$work/.agents/tdd/history/2026-08-06-007-draft.md"
expect 0 "a new untracked channel file passes"

if [ "$failures" -ne 0 ]; then
  echo "history-append-only.test.sh: $failures failure(s)" >&2
  exit 1
fi

echo "history-append-only.test.sh: PASS"
