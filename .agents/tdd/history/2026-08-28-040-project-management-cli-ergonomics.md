---
epic: .agents/plan/epics/040-project-management-cli-ergonomics.md
opened: 2026-08-28
opener: test-engineer
base-ref: 139d0f9ec0befc2137fc7dc953b5611b8e5befed
---

# Implementation cycle — 040-project-management-cli-ergonomics

Pulled from EPIC: `.agents/plan/epics/040-project-management-cli-ergonomics.md`.

Verification gate (binding, from the EPIC's "## Verification Gate" section):

> Gates: `npm run verify`
>
> Proof:
>
> ```bash
> node --test \
>   src/cli/node/report.test.ts \
>   src/cli/node/list.test.ts \
>   src/cli/node/write-refusal.test.ts \
>   src/cli/node/create.test.ts \
>   src/cli/node/update.test.ts \
>   src/cli/node/delete.test.ts \
>   src/cli/project/repository.test.ts \
>   src/cli/options.test.ts \
>   src/cli/program.test.ts \
>   src/cli/config/index.test.ts \
>   src/cli/plan/convert-harness-plan.test.ts \
>   src/cli/plan/convert.test.ts \
>   src/cli/inventory.test.ts \
>   src/cli/parity.test.ts \
>   src/cli/reachability.test.ts \
>   test/helpers/command-recorder.test.ts \
>   src/main.test.ts \
>   && echo "PASS EPIC-040"
> ```

TDD protocol:

1. test-engineer writes the next failing test (RED) — or a GREEN-ONLY pass-through for Tasks without `Action — RED:`.
2. software-engineer makes the test green (RED flow) or implements the Task spec directly (GREEN-ONLY flow).
3. test-engineer confirms GREEN (or runs a build-only check for GREEN-ONLY), then either opens the next Task or runs the full Verification Gate and appends IMPLEMENTATION_READY_FOR_REVIEW.

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.**

- typecheck (`npm run typecheck`) → exit 0
- unit (`npm test`) → exit 0

**Proof.**

- `node --test src/cli/node/report.test.ts src/cli/node/list.test.ts src/cli/node/write-refusal.test.ts src/cli/node/create.test.ts src/cli/node/update.test.ts src/cli/node/delete.test.ts src/cli/project/repository.test.ts src/cli/options.test.ts src/cli/program.test.ts src/cli/config/index.test.ts src/cli/plan/convert-harness-plan.test.ts src/cli/plan/convert.test.ts src/cli/inventory.test.ts src/cli/parity.test.ts src/cli/reachability.test.ts test/helpers/command-recorder.test.ts src/main.test.ts && echo "PASS EPIC-040"` → exit 0; `PASS EPIC-040`

**Tasks closed.** 5 across 5 Stories.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (`node --test src/cli/node/report.test.ts src/cli/node/list.test.ts src/cli/node/write-refusal.test.ts src/cli/node/create.test.ts src/cli/node/update.test.ts src/cli/node/delete.test.ts src/cli/project/repository.test.ts src/cli/options.test.ts src/cli/program.test.ts src/cli/config/index.test.ts src/cli/plan/convert-harness-plan.test.ts src/cli/plan/convert.test.ts src/cli/inventory.test.ts src/cli/parity.test.ts src/cli/reachability.test.ts test/helpers/command-recorder.test.ts src/main.test.ts && echo "PASS EPIC-040"`) — "PASS EPIC-040"
- stories: 5/5 complete
- date: 2026-08-28
- state: local-uncommitted

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — EPIC 040 · no active implementation task

**Cycle.** No implementation turn: the latest TEST-ENGINEER turn closed all five Tasks and recorded the Verification Gate success.
**Files changed.**

- none
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: the discussion file has no newer DEBATE_GUIDELINE or review blocker, and its latest turn is `IMPLEMENTATION_READY_FOR_REVIEW`.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.**

- handoff verification (`npm run verify:handoff`) → `VERIFY: PASS — npm run typecheck is clean`
- typecheck (`npm run typecheck`) → exit 0
- unit (`npm test`) → exit 0; 5460 tests passed
- Gates (`npm run verify`) → exit 0

**Proof.**

- command: `node --test src/cli/node/report.test.ts src/cli/node/list.test.ts src/cli/node/write-refusal.test.ts src/cli/node/create.test.ts src/cli/node/update.test.ts src/cli/node/delete.test.ts src/cli/project/repository.test.ts src/cli/options.test.ts src/cli/program.test.ts src/cli/config/index.test.ts src/cli/plan/convert-harness-plan.test.ts src/cli/plan/convert.test.ts src/cli/inventory.test.ts src/cli/parity.test.ts src/cli/reachability.test.ts test/helpers/command-recorder.test.ts src/main.test.ts && echo "PASS EPIC-040"` → exit 0
- real output:
  ```text
  ℹ tests 180
  ℹ suites 18
  ℹ pass 180
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 13450.956208
  PASS EPIC-040
  ```
- exact success string: `"PASS EPIC-040"`

**Tasks closed.** 5 across 5 Stories.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (`node --test src/cli/node/report.test.ts src/cli/node/list.test.ts src/cli/node/write-refusal.test.ts src/cli/node/create.test.ts src/cli/node/update.test.ts src/cli/node/delete.test.ts src/cli/project/repository.test.ts src/cli/options.test.ts src/cli/program.test.ts src/cli/config/index.test.ts src/cli/plan/convert-harness-plan.test.ts src/cli/plan/convert.test.ts src/cli/inventory.test.ts src/cli/parity.test.ts src/cli/reachability.test.ts test/helpers/command-recorder.test.ts src/main.test.ts && echo "PASS EPIC-040"`) — "PASS EPIC-040"
- stories: 5/5 complete
- date: 2026-08-28
- state: local-uncommitted

END: TEST-ENGINEER
AUTO_REVIEW: FAIL — routing 2 action:YES finding(s) to the TDD loop; 0 action:NO finding(s) recorded for the human.
BLOCKER: Empty values break connection precedence — Normalize every candidate before applying flag, environment, token-file, and config precedence; add empty-flag regression coverage.
BLOCKER: Cancelled empty-reason coverage is missing — Add the cancelled empty-reason case with exact stderr, one failure, no exit call, and zero client calls.

## TEST-ENGINEER — review-blocker regression coverage · two BLOCKERs routed by AUTO_REVIEW: FAIL

**Cycle.** Review-blocker regression coverage for empty client candidates and cancelled empty reason.
**Test written.**

- file: `src/cli/options.test.ts` (edited) — suite: `src/cli/options.test` — methods: `empty flags are absent before environment precedence`
- file: `src/cli/node/report.test.ts` (edited) — suite: `src/cli/node/report.test` — methods: `node report refuses a cancelled outcome with an empty reason locally`
- asserts: Empty flags fall through to environment values without loading config; cancelled empty reason prints the exact local refusal, calls `fail` once, calls no exit and makes no client call.
  **RED proof.**
- command: `npm test`
- exit: non-zero — failure: `AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:`
- actual: `{ baseUrl: 'http://config.test:9100', token: 'config-token' }`
- expected: `{ baseUrl: 'http://env.test:7102', token: 'env-token' }`
- the cancelled empty-reason characterization passed because the existing branch already has the required refusal.
  **Open to Software Engineer.**
- `src/cli/options.ts`: `resolveClientOptions(input: ResolveInput): ClientOptions` must treat empty flag candidates as absent before applying per-value precedence, returning the environment values and making zero `loadConfig` calls in the test case.
- `src/cli/node/report.ts`: `registerNodeReport(input: NodeReportCliInput): void` must preserve the tested local refusal contract for a cancelled empty reason.

END: TEST-ENGINEER

## SOFTWARE-ENGINEER — EPIC 040 · empty client candidates use per-value precedence

**Review blocker addressed.** BLOCKER: Empty values break connection precedence — Normalize every candidate before applying flag, environment, token-file, and config precedence; add empty-flag regression coverage.
**Review blocker addressed.** BLOCKER: Cancelled empty-reason coverage is missing — Add the cancelled empty-reason case with exact stderr, one failure, no exit call, and zero client calls.

**Cycle.** GREEN+REFACTOR for `src/cli/options.test.ts`.
**Files changed.**

- `src/cli/options.ts` (edited) — normalized empty client candidates before applying precedence.
  **Seam (GREEN).** `resolveClientOptions` treats empty flags, environment values and token-file contents as absent before fallback resolution.
  **Refactor.** deferred: this review-blocker fix has no named Story refactor.
  **Build check.**
- typecheck: exit 0
  **Assumptions.**
- VERIFIED: cancelled empty-reason handling already satisfies the characterization, so `src/cli/node/report.ts` required no edit.

END: SOFTWARE-ENGINEER

## TEST-ENGINEER — implementation ready for review

**EPIC verification gate.**

- handoff verification (`npm run verify:handoff`) → `VERIFY: PASS — npm run typecheck is clean`
- typecheck (`npm run typecheck`) → exit 0
- unit (`npm test`) → exit 0; 5462 tests passed
- Story verification suites → exit 0 for all five Stories
- Gates (`npm run verify`) → exit 0

**Proof.**

- command: `node --test src/cli/node/report.test.ts src/cli/node/list.test.ts src/cli/node/write-refusal.test.ts src/cli/node/create.test.ts src/cli/node/update.test.ts src/cli/node/delete.test.ts src/cli/project/repository.test.ts src/cli/options.test.ts src/cli/program.test.ts src/cli/config/index.test.ts src/cli/plan/convert-harness-plan.test.ts src/cli/plan/convert.test.ts src/cli/inventory.test.ts src/cli/parity.test.ts src/cli/reachability.test.ts test/helpers/command-recorder.test.ts src/main.test.ts && echo "PASS EPIC-040"` → exit 0
- real output:
  ```text
  ℹ tests 182
  ℹ suites 18
  ℹ pass 182
  ℹ fail 0
  ℹ cancelled 0
  ℹ skipped 0
  ℹ todo 0
  ℹ duration_ms 13431.890834
  PASS EPIC-040
  ```
- exact success string: `"PASS EPIC-040"`

**Tasks closed.** 5 across 5 Stories.

IMPLEMENTATION_READY_FOR_REVIEW:

- gates: PASS
- proof: PASS (`node --test src/cli/node/report.test.ts src/cli/node/list.test.ts src/cli/node/write-refusal.test.ts src/cli/node/create.test.ts src/cli/node/update.test.ts src/cli/node/delete.test.ts src/cli/project/repository.test.ts src/cli/options.test.ts src/cli/program.test.ts src/cli/config/index.test.ts src/cli/plan/convert-harness-plan.test.ts src/cli/plan/convert.test.ts src/cli/inventory.test.ts src/cli/parity.test.ts src/cli/reachability.test.ts test/helpers/command-recorder.test.ts src/main.test.ts && echo "PASS EPIC-040"`) — "PASS EPIC-040"
- stories: 5/5 complete
- date: 2026-08-28
- state: local-uncommitted

END: TEST-ENGINEER
HUMAN_REVIEW: PASS
