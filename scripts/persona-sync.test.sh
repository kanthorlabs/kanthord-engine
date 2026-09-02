#!/usr/bin/env bash
set -uo pipefail

root=$(cd -- "$(dirname -- "$0")/.." && pwd)
roles="test-engineer software-engineer reviewer-engineer groundwork-engineer"

failures=0
fail() {
  echo "FAIL: $1" >&2
  failures=$((failures + 1))
}

# The body of a persona is everything after the closing delimiter of its
# frontmatter. The two harnesses share one body and differ only in frontmatter,
# so a drift between them is a defect the engine repository already suffered.
# Strip ONLY the two frontmatter delimiters. An awk that skips every "---"
# line would silently drop a horizontal rule from the comparison, so a drift on
# such a line would pass unnoticed.
body() {
  awk 'BEGIN { seen = 0 }
       seen < 2 { if ($0 == "---") seen++; next }
       { print }' "$1"
}

# Prove the extractor drops nothing but the frontmatter: the body must hold every
# line after the second delimiter.
body_is_complete() {
  local file=$1 total header
  total=$(wc -l < "$file" | tr -d ' ')
  header=$(awk 'BEGIN { seen = 0 } { if ($0 == "---") seen++; if (seen == 2) { print NR; exit } }' "$file")
  [ -n "$header" ] || return 1
  [ "$(body "$file" | wc -l | tr -d ' ')" -eq "$((total - header))" ]
}

for role in $roles; do
  claude="$root/.claude/agents/$role.md"
  opencode="$root/.opencode/agents/$role.md"

  [ -f "$claude" ] || {
    fail "$claude is missing"
    continue
  }
  [ -f "$opencode" ] || {
    fail "$opencode is missing"
    continue
  }

  if ! diff -q <(body "$claude") <(body "$opencode") >/dev/null; then
    fail "the $role body differs between .claude and .opencode"
    diff <(body "$claude") <(body "$opencode") | head -20 >&2
  fi

  if [ -z "$(body "$claude")" ]; then
    fail "the $role body is empty — the frontmatter delimiters are wrong"
  fi

  for file in "$claude" "$opencode"; do
    body_is_complete "$file" ||
      fail "the extracted body of $file drops a line — the comparison is incomplete"
  done

  # each harness must declare the frontmatter its own runtime reads
  head -1 "$claude" | grep -qx -- '---' || fail "$claude does not open with frontmatter"
  head -1 "$opencode" | grep -qx -- '---' || fail "$opencode does not open with frontmatter"
  grep -q '^tools: ' "$claude" || fail "$claude declares no tools"
  grep -q '^mode: subagent$' "$opencode" || fail "$opencode declares no subagent mode"
  grep -q '^permission:$' "$opencode" || fail "$opencode declares no permission block"

  # the name in each frontmatter must be the role, or a dispatch names nothing
  grep -qx "name: $role" "$claude" || fail "$claude declares the wrong name"
  grep -qx "name: $role" "$opencode" || fail "$opencode declares the wrong name"
done

# the reviewer never gets an edit grant in either harness
grep -q '^  edit: allow$' "$root/.opencode/agents/reviewer-engineer.md" &&
  fail "the reviewer-engineer must not hold an edit grant"
grep -qE '^tools:.*(Write|Edit)' "$root/.claude/agents/reviewer-engineer.md" &&
  fail "the reviewer-engineer must not hold Write or Edit"

if [ "$failures" -eq 0 ]; then
  echo "PERSONA-SYNC TESTS: PASS"
  exit 0
fi

echo "PERSONA-SYNC TESTS: FAIL ($failures)" >&2
exit 1
