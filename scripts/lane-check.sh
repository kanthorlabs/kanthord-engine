#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: scripts/lane-check.sh <test-engineer|software-engineer|reviewer-engineer|groundwork-engineer> <path>" >&2
  exit 2
}

[ "$#" -eq 2 ] || usage

role=$1
path=$2

case $role in
test-engineer | software-engineer | reviewer-engineer | groundwork-engineer) ;;
*) usage ;;
esac

[ -n "$path" ] || usage

path=${path#./}

deny() {
  echo "lane violation: $role changed $path ($1)" >&2
  exit 1
}

case $path in
/*) deny "path is not repo-relative" ;;
../* | */../*) deny "path escapes the repo root" ;;
*" -> "*) deny "a porcelain rename record — the caller must pass each side alone" ;;
'"'*) deny "a quoted porcelain path — the caller must unquote it" ;;
esac

case $path in
.agents/plan/*) deny "the plan tree is locked" ;;
.claude/* | .opencode/*) deny "the pipeline definition is locked" ;;
scripts/lane-check.sh | scripts/turn-snapshot.sh | scripts/verify-handoff.mjs | scripts/memory-append-only.sh | scripts/*.test.sh)
  deny "the pipeline guards are locked"
  ;;
AGENTS.md) deny "the architecture contract is locked" ;;
esac

if [ "$role" != groundwork-engineer ]; then
  case $path in
  package.json | package-lock.json) deny "the toolchain manifest is locked" ;;
  tsconfig*.json) deny "the toolchain config is locked" ;;
  Containerfile | compose.yaml | Makefile) deny "the build definition is locked" ;;
  esac

  case ${path##*/} in
  *.config.*) deny "the toolchain config is locked" ;;
  esac
fi

if [ "$role" = reviewer-engineer ]; then
  deny "the reviewer-engineer edits nothing"
fi

case $path in
.agents/tdd/memory/*)
  rest=${path#.agents/tdd/memory/}
  case $rest in
  test-engineer/* | software-engineer/* | reviewer-engineer/* | groundwork-engineer/*)
    [ "${rest%%/*}" = "$role" ] || deny "another role's journal"
    ;;
  test-engineer | software-engineer | reviewer-engineer | groundwork-engineer)
    deny "a role journal name is a directory, not a file"
    ;;
  */*) deny "an unknown journal namespace" ;;
  esac
  exit 0
  ;;
.agents/tdd/*) exit 0 ;;
esac

if [ "$role" = groundwork-engineer ]; then
  case $path in
  src/* | test/* | docs/proposal/*) deny "the implementation tree is not the groundwork lane" ;;
  scripts/*) deny "ordinary scripts are the software-engineer lane" ;;
  *.test.ts | *.spec.ts) deny "a test file is not the groundwork lane" ;;
  esac
  exit 0
fi

is_test=no
case $path in
*.test.ts | *.spec.ts) is_test=yes ;;
esac

case $path in
src/*.ts)
  if [ "$role" = test-engineer ] && [ "$is_test" = no ]; then
    deny "production source is not the test-engineer lane"
  fi
  if [ "$role" = software-engineer ] && [ "$is_test" = yes ]; then
    deny "a test file is not the software-engineer lane"
  fi
  exit 0
  ;;
scripts/*)
  if [ "$is_test" = yes ]; then
    [ "$role" = test-engineer ] || deny "a test file is not the software-engineer lane"
  else
    [ "$role" = software-engineer ] || deny "scripts are the software-engineer lane"
  fi
  exit 0
  ;;
test/*)
  [ "$role" = test-engineer ] || deny "the test tree is the test-engineer lane"
  exit 0
  ;;
docs/proposal/*)
  [ "$role" = software-engineer ] || deny "the proposal is the software-engineer lane"
  exit 0
  ;;
esac

deny "outside every lane"
