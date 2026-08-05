#!/usr/bin/env bash
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
guard="$here/lane-check.sh"
failures=0

expect() {
  local want=$1 role=$2 path=$3
  local got=0
  "$guard" "$role" "$path" >/dev/null 2>&1 || got=$?
  if [ "$got" -ne "$want" ]; then
    echo "FAIL  want=$want got=$got  $role  $path" >&2
    failures=$((failures + 1))
  fi
}

allow() { expect 0 "$1" "$2"; }
deny() { expect 1 "$1" "$2"; }
usage() { expect 2 "$1" "$2"; }

allow test-engineer src/services/git/url.test.ts
allow test-engineer src/domain/plan.spec.ts
allow test-engineer ./src/domain/plan.test.ts
deny test-engineer src/services/git/url.ts
deny test-engineer src/main.ts
deny test-engineer scripts/proof.sh

allow software-engineer src/services/git/url.ts
allow software-engineer src/main.ts
allow software-engineer scripts/proof.sh
deny software-engineer src/services/git/url.test.ts
deny software-engineer src/domain/plan.spec.ts

allow test-engineer .agent/tdd/history/2026-08-05-006-git-primitives.md
allow test-engineer .agent/tdd/.test-engineer-response-t1.md
allow test-engineer .agent/tdd/memory/ts-gotchas.md
allow test-engineer .agent/tdd/memory/test-engineer/2026-08-05.md
allow software-engineer .agent/tdd/memory/software-engineer/2026-08-05.md
deny test-engineer .agent/tdd/memory/software-engineer/2026-08-05.md
deny software-engineer .agent/tdd/memory/test-engineer/2026-08-05.md
deny test-engineer .agent/tdd/memory/reviewer-engineer/2026-08-05.md
deny test-engineer .agent/tdd/memory/unknown/2026-08-05.md
deny test-engineer .agent/tdd/memory/software-engineer-other/2026-08-05.md
deny test-engineer .agent/tdd/memory/software-engineer

for role in test-engineer software-engineer; do
  deny "$role" .agent/plan/stories/epic/story.md
  deny "$role" .claude/commands/work.md
  deny "$role" .opencode/agents/software-engineer.md
  deny "$role" scripts/lane-check.sh
  deny "$role" scripts/lane-check.test.sh
  deny "$role" scripts/turn-snapshot.sh
  deny "$role" scripts/verify-handoff.mjs
  deny "$role" scripts/memory-append-only.sh
  deny "$role" package.json
  deny "$role" package-lock.json
  deny "$role" tsconfig.json
  deny "$role" tsconfig.build.json
  deny "$role" eslint.config.js
  deny "$role" prettier.config.mjs
  deny "$role" AGENTS.md
  deny "$role" Containerfile
  deny "$role" compose.yaml
  deny "$role" Makefile
  deny "$role" docs/proposal/api/README.md
  deny "$role" README.md
  deny "$role" /etc/passwd
  deny "$role" ../outside.ts
  deny "$role" "src/old.ts -> src/new.ts"
  deny "$role" "src/a.test.ts -> src/b.ts"
  deny "$role" '"src/a b.ts"'
done

deny reviewer-engineer src/services/git/url.ts
deny reviewer-engineer src/services/git/url.test.ts
deny reviewer-engineer .agent/tdd/history/2026-08-05-006-git-primitives.md
deny reviewer-engineer .agent/tdd/memory/reviewer-engineer/2026-08-05.md

usage bogus-role src/a.ts
usage test-engineer ""

if [ "$failures" -ne 0 ]; then
  echo "lane-check.test.sh: $failures failure(s)" >&2
  exit 1
fi

echo "lane-check.test.sh: PASS"
