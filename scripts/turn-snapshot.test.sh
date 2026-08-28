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
snapshot="$here/turn-snapshot.sh"
failures=0

fail() {
  echo "FAIL  $1" >&2
  failures=$((failures + 1))
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
work=$tmp/repo
mkdir -p "$work"

git -C "$work" init -q
mkdir -p "$work/src"
printf 'committed\n' >"$work/src/tracked.ts"
git -C "$work" add -A
git -C "$work" -c user.email=guard@test -c user.name=guard commit -qm base

turn_files() {
  LC_ALL=C comm -3 "$tmp/before" "$tmp/after" | sed 's/^\t//' | cut -f2- | LC_ALL=C sort -u
}

printf 'committed\ndirty before the turn\n' >"$work/src/tracked.ts"
"$snapshot" "$work" >"$tmp/before"
printf 'committed\ndirty before the turn\nedited by the turn\n' >"$work/src/tracked.ts"
"$snapshot" "$work" >"$tmp/after"
[ "$(turn_files)" = "src/tracked.ts" ] ||
  fail "an already-dirty file re-modified by the turn must be reported, got: $(turn_files)"

"$snapshot" "$work" >"$tmp/before"
"$snapshot" "$work" >"$tmp/after"
[ -z "$(turn_files)" ] ||
  fail "an unchanged dirty file must not be reported, got: $(turn_files)"

"$snapshot" "$work" >"$tmp/before"
printf 'new\n' >"$work/src/added.ts"
"$snapshot" "$work" >"$tmp/after"
[ "$(turn_files)" = "src/added.ts" ] ||
  fail "a new untracked file must be reported, got: $(turn_files)"

"$snapshot" "$work" >"$tmp/before"
printf 'committed\n' >"$work/src/tracked.ts"
"$snapshot" "$work" >"$tmp/after"
[ "$(turn_files)" = "src/tracked.ts" ] ||
  fail "a file reverted to HEAD must be reported, got: $(turn_files)"

"$snapshot" "$work" >"$tmp/before"
rm "$work/src/tracked.ts"
"$snapshot" "$work" >"$tmp/after"
[ "$(turn_files)" = "src/tracked.ts" ] ||
  fail "a deleted file must be reported, got: $(turn_files)"

git -C "$work" checkout -q -- src/tracked.ts
git -C "$work" mv src/tracked.ts src/renamed.ts
"$snapshot" "$work" | cut -f2- | LC_ALL=C sort >"$tmp/renames"
printf 'src/renamed.ts\nsrc/tracked.ts\n' >"$tmp/renames-want"
if ! diff -q <(grep -E 'tracked|renamed' "$tmp/renames") "$tmp/renames-want" >/dev/null; then
  fail "a rename must appear as two plain paths, got: $(tr '\n' ' ' <"$tmp/renames")"
fi

if [ "$failures" -ne 0 ]; then
  echo "turn-snapshot.test.sh: $failures failure(s)" >&2
  exit 1
fi

echo "turn-snapshot.test.sh: PASS"
