#!/usr/bin/env bash
set -uo pipefail

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
git -C "$work" config user.email guard@test
git -C "$work" config user.name guard
mkdir -p "$work/src"
printf 'committed\n' >"$work/src/tracked.ts"
git -C "$work" add -A
git -C "$work" commit -qm base

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
