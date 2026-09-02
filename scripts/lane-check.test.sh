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

allow test-engineer test/helpers/daemon.ts
allow test-engineer test/helpers/fixture.json
allow test-engineer test/fixtures/plan/objective.md
allow test-engineer test/e2e/fixtures/two-objective/plan/journey/initiative.md
deny software-engineer test/helpers/daemon.ts
deny software-engineer test/fixtures/plan/objective.md
deny reviewer-engineer test/fixtures/plan/objective.md

allow software-engineer docs/proposal/api/README.md
allow software-engineer docs/proposal/phase-1/state-machine.md
deny test-engineer docs/proposal/phase-1/state-machine.md
deny reviewer-engineer docs/proposal/phase-1/state-machine.md

allow test-engineer .agents/tdd/history/2026-08-05-006-git-primitives.md
allow test-engineer .agents/tdd/.test-engineer-response-t1.md
allow test-engineer .agents/tdd/memory/ts-gotchas.md
allow test-engineer .agents/tdd/memory/test-engineer/2026-08-05.md
allow software-engineer .agents/tdd/memory/software-engineer/2026-08-05.md
deny test-engineer .agents/tdd/memory/software-engineer/2026-08-05.md
deny software-engineer .agents/tdd/memory/test-engineer/2026-08-05.md
deny test-engineer .agents/tdd/memory/reviewer-engineer/2026-08-05.md
deny test-engineer .agents/tdd/memory/unknown/2026-08-05.md
deny test-engineer .agents/tdd/memory/software-engineer-other/2026-08-05.md
deny test-engineer .agents/tdd/memory/software-engineer

allow groundwork-engineer package.json
allow groundwork-engineer package-lock.json
allow groundwork-engineer tsconfig.json
allow groundwork-engineer tsconfig.build.json
allow groundwork-engineer eslint.config.js
allow groundwork-engineer prettier.config.mjs
allow groundwork-engineer Containerfile
allow groundwork-engineer compose.yaml
allow groundwork-engineer Makefile
allow groundwork-engineer README.md
allow groundwork-engineer .github/workflows/ci.yaml
allow groundwork-engineer .gitignore
allow groundwork-engineer docs/brainstorm.md
allow groundwork-engineer docs/diagrams/state-machine.svg
allow groundwork-engineer .agents/tdd/history/2026-08-05-006-git-primitives.md
allow groundwork-engineer .agents/tdd/memory/groundwork-engineer/2026-08-05.md
deny groundwork-engineer .agents/tdd/memory/software-engineer/2026-08-05.md
deny test-engineer .agents/tdd/memory/groundwork-engineer/2026-08-05.md
deny groundwork-engineer AGENTS.md
deny groundwork-engineer .agents/plan/stories/epic/story.md
deny groundwork-engineer .claude/skills/work/SKILL.md
deny groundwork-engineer .opencode/agents/groundwork-engineer.md
deny groundwork-engineer scripts/lane-check.sh
deny groundwork-engineer scripts/lane-check.test.sh
deny groundwork-engineer scripts/turn-snapshot.sh
deny groundwork-engineer scripts/verify-handoff.mjs
deny groundwork-engineer scripts/memory-append-only.sh
deny groundwork-engineer scripts/proof.sh
deny groundwork-engineer src/main.ts
deny groundwork-engineer src/services/git/url.ts
deny groundwork-engineer src/services/git/url.test.ts
deny groundwork-engineer src/domain/notes.md
deny groundwork-engineer smoke.test.ts
deny groundwork-engineer docs/examples/sample.spec.ts
deny groundwork-engineer test/helpers/daemon.ts
deny groundwork-engineer docs/proposal/api/README.md
deny groundwork-engineer /etc/passwd
deny groundwork-engineer ../outside.ts
deny groundwork-engineer "package.json -> package5.json"
usage groundwork-engineer ""

for role in test-engineer software-engineer; do
  deny "$role" .agents/plan/stories/epic/story.md
  deny "$role" .claude/skills/work/SKILL.md
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
  deny "$role" README.md
  deny "$role" docs/brainstorm.md
  deny "$role" docs/diagrams/state-machine.svg
  deny "$role" /etc/passwd
  deny "$role" ../outside.ts
  deny "$role" "src/old.ts -> src/new.ts"
  deny "$role" "src/a.test.ts -> src/b.ts"
  deny "$role" '"src/a b.ts"'
done

deny reviewer-engineer src/services/git/url.ts
deny reviewer-engineer src/services/git/url.test.ts
deny reviewer-engineer .agents/tdd/history/2026-08-05-006-git-primitives.md
deny reviewer-engineer .agents/tdd/memory/reviewer-engineer/2026-08-05.md

usage bogus-role src/a.ts
usage test-engineer ""

if [ "$failures" -ne 0 ]; then
  echo "lane-check.test.sh: $failures failure(s)" >&2
  exit 1
fi

echo "lane-check.test.sh: PASS"
