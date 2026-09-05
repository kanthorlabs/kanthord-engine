# EPIC 050.6 — The process capability — stories

Epic: `.agents/plan/epics/050.6-the-process-capability.md`
Prereq: EPIC 050.5 (sequence order), implemented. This epic reads two things from it: the service
inventory literal of `src/domain/layout.test.ts:108` — `deepEqual` with `"lease"` already removed and
its case name at `:101` already reading twenty, and the `eslint.config.js` exemption list its
groundwork story extended. It consumes nothing else.

`src/services/process/` becomes the only place under `src/` that creates a process. The launcher, the
one supervised-run machine and its TERM-then-KILL cancel path live there; `src/services/git/` runs on
that machine and keeps no second copy of the timeout, the output cap, the group signal or the
launcher exit codes for a child the daemon holds a handle to.

## One story, one path

**Six stories, and none of them draws a diagram.** Every story is a `story-foundation`, so no file
here carries a `Diagrams:`, a `Baselines:` or a `Seams:` line, and this epic adds no
`test/sequence/scenarios/` file.

**The count that decides it is zero.** `.agents/plan/authoring.md` sizes an epic by the number of
commands, queries and nested commands whose seam trace moves.
`src/services/git/index.ts:159` — `scanHostKeys`, `:160` — `confirmHostKey`, `:185` — `inspectChild`
and `:186` — `stopChild` keep their exact signatures, because the runner is bound at construction in
`src/services/git/binary.ts:24` — `createBinaryGit`. No file under `src/commands/` or `src/queries/`
changes, and no `Git` fake in their tests changes. A capability extraction below the `Git` interface
is invisible at the seam a recorder wraps.

**Story 1 is the groundwork story, and `eslint.config.js` and `.trapload.mjs` are the epic's whole
locked set.** `scripts/lane-check.sh` denies each to the test-engineer and to the software-engineer
and allows each to `groundwork-engineer`. `src/domain/layout.test.ts` is **not** locked: with `is_test=yes` both engineer
conditions are false and the script reaches `scripts/lane-check.sh:99` — `exit 0`, so the
test-engineer owns it and it is refused in a `Paths:` line. The story draws nothing, its cases are
build checks, and it counts against the ten-story cap — six of ten.

## The file stems, and the epic's story numbers

The epic numbers its stories from 1; `/work` Step 4.5 dispatches the groundwork turn on the file name
`00-groundwork.md` alone. The two numberings therefore meet at an offset of one, and every
cross-reference names a stem.

| epic story | gate rows            | file stem                                        |
| ---------- | -------------------- | ------------------------------------------------ |
| 1          | 1                    | `00-groundwork`                                  |
| 2          | 2, 3, 4, 5, 6, 7     | `01-the-launcher-the-contract-and-the-pid-check` |
| 3          | 8, 9, 10, 11, 12, 13 | `02-the-one-supervised-run-machine`              |
| 4          | 14, 15, 16           | `03-the-git-runner-takes-the-runner`             |
| 5          | 17, 18, 19, 20       | `04-the-three-spawn-sites-and-the-facade`        |
| 6          | 21                   | `05-the-composition-root-and-the-harness`        |

## Dispatch order

The order is strictly serial, and it is the file order. No story depends on a later one.

Story 1 (`00-groundwork`) runs before the loop, once. `/work` Step 4.5 dispatches
`groundwork-engineer` over its `Paths:` grant, and the whole `## Change` lands in that one turn.

Story 2 (`01-the-launcher-the-contract-and-the-pid-check`) must be the very next story. The moment
story 1 lands, `src/services/git/launcher.ts:1` — `spawn` is a `no-restricted-imports` violation and
`pnpm run lint` fails; story 2's own work is what makes it green. `src/services/git/launcher.ts`
imports nothing from this repository, so no earlier story is possible, and the red window is the
shortest the harness admits.

Story 3 (`02-the-one-supervised-run-machine`) needs story 2's `src/services/process/index.ts` and its
moved launcher. Story 4 (`03-the-git-runner-takes-the-runner`) needs story 3's runner. Story 5
(`04-the-three-spawn-sites-and-the-facade`) needs story 3's runner and story 4's two
`createGitRunner` repairs inside `src/services/git/host-key.test.ts`. Story 6
(`05-the-composition-root-and-the-harness`) needs every signature stories 4 and 5 changed.

## The two windows this epic opens, and what closes each

The epic is the unit of greenness, per `.agents/plan/authoring.md`. Two build commands are red inside
it, and each story states which of its cases may run.

- **`pnpm run lint` is red across story 1 only.** Story 2 case 7 closes it, and gate row 1 is
  deliberately a grep rather than a lint run.
- **`pnpm run typecheck` is red across stories 4 and 5.** Story 4 deletes `systemSchedule` from
  `src/services/git/run.ts` and makes the second `createGitRunner` parameter required, which
  invalidates `src/main.ts:29`, `src/main.ts:235` and seven files under `scripts/e2e/`. Story 6 case
  3 closes it. No numbered case of stories 4 or 5 runs `pnpm run typecheck` or `pnpm run verify`, and
  every one of them names its own `node --test` file list.

`.claude/skills/work/SKILL.md:41` runs the `Gates:` command only at
`IMPLEMENTATION_READY_FOR_REVIEW`, after every case of every story is green, so the first full run of
the gate happens after story 6.

## Stories

- 1 — the lint scope moves with the launcher, at four sites in `eslint.config.js`, and the orphaned
  root benchmark `.trapload.mjs` is deleted → `00-groundwork.md` — draws nothing
- 2 — the launcher, the process contract and the pure pid check, and every specifier they invalidate
  → `01-the-launcher-the-contract-and-the-pid-check.md` — draws nothing
- 3 — the one supervised-run machine and its schedule →
  `02-the-one-supervised-run-machine.md` — draws nothing
- 4 — `createGitRunner` takes the runner and maps its outcomes to the shipped `GitError` set →
  `03-the-git-runner-takes-the-runner.md` — draws nothing
- 5 — the three remaining spawn sites and the git facade →
  `04-the-three-spawn-sites-and-the-facade.md` — draws nothing
- 6 — the composition root, the twelve harness call sites and the `"050.6"` range entry →
  `05-the-composition-root-and-the-harness.md` — draws nothing

## Facts (needed for implementation)

- **`assertSignallable` has exactly one consumer outside the launcher**, and the launcher never calls
  it: `src/services/git/child.ts:119` — `assertSignallable` and `:234` — `assertSignallable`.
  `src/services/git/launcher.ts:117` — `requireSignallable` and `:125` — `requireSignallable` call
  the other exported predicate, and `isSignallable` is named nowhere but its own file.
- **Both throw sites carry the identical string** `"a supervised pid must be greater than 1"`, at
  `src/services/git/launcher.ts:52` and `:62`, and `src/services/git/child.test.ts:362` asserts it.
- **`spawnSupervised` has exactly four production consumers**: `src/services/git/run.ts:61`,
  `src/services/git/probe.ts:137`, `src/services/git/host-key.ts:190` and
  `src/services/git/child.ts:175`. One test consumer survives the epic,
  `src/services/git/child.test.ts:23`, and gate row 7 uses it as its control.
- **Three of the four spawn sites differ in exactly one way: the signal sequence.**
  `src/services/git/run.ts:100` — `signalGroup` and `src/services/git/host-key.ts:227` —
  `signalGroup` send `SIGTERM` then `SIGKILL` after `TERMINATION_GRACE_MS`;
  `src/services/git/probe.ts:165` — `signalGroup` and `src/services/git/child.ts:199` —
  `signalGroup` send `SIGKILL` alone. Everything else — the `child.pid === undefined` guard, the
  unref'd timer, the chunk arrays, the `await child.exited`, the swallowed `ESRCH` and `EPERM`, the
  inner `clearTimeout` and the outer `rmSync` — is structurally identical.
- **`createGitRunner` has 110 call sites in 21 files**: `src/services/git/run.ts:49` is the
  definition, thirteen suites under `src/services/git/` hold 101 calls between them, `src/main.ts:235`
  holds one, and seven files under `scripts/e2e/` hold eight. `src/services/git/run.test.ts` is the
  only file that passes a second argument today.
- **Twelve files under `scripts/e2e/` call one of the four changed functions**, and seven of the
  twelve call `createGitRunner`. The remaining five call `probeTools`, `scanHostKeys` or
  `confirmHostKey` only.
- **`GitRunRequest`, `GitRunResult` and `GitRunner` do not move.**
  `src/services/git/authenticated.ts:2` and nine suites import them from `./run.ts`, and this epic
  changes none of those imports.
- **`ScanOptions.timeoutMs` is unreachable through the `Git` interface.**
  `src/services/git/host-key.ts:184` accepts it, but `src/services/git/index.ts:159` declares
  `scanHostKeys(remoteUrl: string)` and `src/services/git/binary.ts:33` forwards no options. Only
  `src/services/git/host-key.test.ts:485` sets it. This epic does not change that.
- **`eslint.config.js` needs no `boundaries` edit.** `eslint.config.js:133` — `src/services/*` and
  `:158` — `service-interface` are generic patterns, so a new capability is a directory and not a
  config entry.
- **`test/helpers/virtual-clock.ts:17` — `createFakeSchedule` is the wrong `Schedule`.** It is typed
  over `src/http/server/idempotency-store.ts:19` — `Schedule`, whose argument order is
  `(milliseconds, callback)` and whose cancel is a bare function.
  `src/services/git/run.test.ts:80` — `createFakeSchedule` is a second, incompatible local of the
  same name, and it is the one that moves.
- **`docs/proposal/phase-1/runtime-capability-matrix.md:59` — `A subprocess boundary makes git impossible on a Worker`
  names `src/services/git/launcher.ts` by path.** It is in the software-engineer lane and EPIC 050.6
  Story 2 (`01-the-launcher-the-contract-and-the-pid-check`) repairs it, because `docs/proposal/` is
  the source of truth for behaviour per `AGENTS.md`.
- **`scripts/epic-sequence-range.ts` is an ordinary script, not a pipeline guard**, and
  `scripts/lane-check.sh software-engineer scripts/epic-sequence-range.ts` allows it. Each epic of the
  range appends its own id, per `.agents/plan/stories/051.2-the-command-gate/index.md:112`, so
  EPIC 050.6 Story 6 (`05-the-composition-root-and-the-harness`) appends `"050.6"` to `authoredEpics`
  and to the literal at `test/sequence/conformance.test.ts:255` — `assert.deepEqual`, which
  deep-equals the two. `scripts/verify-epic-sequence.ts` is in no `package.json` script, but
  `test/sequence/conformance.test.ts` is collected by `pnpm test`, so the append is what puts these
  stories under `pnpm run verify`.
- **Every citation here resolves against the tree as it stands before EPIC 050.5 lands**, and exactly
  two cited files shift when it does. The next section states the delta by value, so these stories
  arrive work-ready rather than merely re-resolvable.

## The EPIC 050.5 line shift, and how to re-validate

EPIC 050.5 changes two files this epic cites, and it changes each by a known amount.

**`eslint.config.js` gains exactly one line.** EPIC 050.5 Story 0 (`00-groundwork`) adds
`"src/commands/startup/recover-expired-runs.test.ts"` to the list at `eslint.config.js:17` —
`nodeEdgeWriteExemptions`, and its own case asserts `git diff --numstat` prints
`1	0	eslint.config.js`. **A citation at line 22 or below is unchanged; every one above it moves up by
one.**

| cited here | after EPIC 050.5 | what it anchors                         |
| ---------- | ---------------- | --------------------------------------- |
| `:17`      | `:17`            | `nodeEdgeWriteExemptions`               |
| `:133`     | `:134`           | the `src/services/*` element pattern    |
| `:158`     | `:159`           | the `service-interface` file category   |
| `:208`     | `:209`           | a service may reach `domain/`           |
| `:211`     | `:212`           | a service may reach another interface   |
| `:275`     | `:276`           | the end of the preceding block          |
| `:279`     | `:280`           | the launcher comment                    |
| `:284`     | `:285`           | the `ignores` launcher site             |
| `:298`     | `:299`           | the `src/**` launcher message           |
| `:320`     | `:321`           | the `domain/` `node:*` ban              |
| `:410`     | `:411`           | the `http/server` launcher message      |
| `:447`     | `:448`           | the launcher-and-test exemption `files` |

**`src/domain/layout.test.ts` loses exactly one line.** EPIC 050.5 Story 6
(`06-the-lease-service-is-deleted`) deletes `"lease",` at `src/domain/layout.test.ts:121` — `"lease"`,
which is a whole line, and removes `"lease", ` from the inline array at
`src/domain/layout.test.ts:152` — `"lease"`, which shortens a line rather than deleting one. Two case
names change text and nothing else. **A citation at line 120 or below is unchanged; every one above it
moves down by one.**

| cited here                         | after EPIC 050.5       |
| ---------------------------------- | ---------------------- |
| `:7`, `:57`, `:59`, `:101`, `:108` | unchanged              |
| `:151`, `:152`                     | `:150`, `:151`         |
| `:229`, `:232`                     | `:228`, `:231`         |
| `:240`, `:251`, `:253`             | `:239`, `:250`, `:252` |
| `:264`, `:281`                     | `:263`, `:280`         |
| `:430`, `:432`, `:454`             | `:429`, `:431`, `:453` |

**No other cited file is touched by EPIC 050.5.** Its story list names `src/commands/startup/**`,
`src/commands/actor/**`, `src/queries/**`, `src/http/server/actor/**`, `src/services/lease/**`,
`src/services/plan/sqlite.ts`, `src/domain/lease*.ts`, `test/helpers/lease.ts`, `package.json` and
seven proposal documents. This epic cites none of them.

**Re-validate rather than trust the table.** After EPIC 050.5 lands and before `/work` is dispatched,
run one pass over every citation of these stories and of the epic. Each is written
``<file>:<line> — `<identifier>` ``, so the check reads the file, takes that line, and asserts it holds
that identifier. Re-run the consumer closure in the same pass — `createGitRunner`, `spawnSupervised`,
`probeTools`, `scanHostKeys`, `confirmHostKey`, `assertSignallable`, and the specifier
`./launcher.ts`. A count that moved is a story a human refreshes before dispatch, never an implementer
who guesses.

## Decisions taken during authoring, and now recorded in the EPIC

Each of these is now a bullet of `## Decisions` in
`.agents/plan/epics/050.6-the-process-capability.md`, which is the record. This list is the pointer.

- **The process contract**: nine required request fields and seven required result fields, `null` as
  the way a caller declines one, and a seven-member `ProcessOutcome`. See
  `01-the-launcher-the-contract-and-the-pid-check.md`.
- **`ProcessRunResult` carries `signal` and carries no `args`.** The signal is the only way to report
  `src/services/git/run.ts:174` — `terminated by signal`; no consumer reads an argument vector off the
  result. See `01-the-launcher-the-contract-and-the-pid-check.md`.
- **The outcome order** is `output-exceeded`, `timed-out`, `cancelled`, then the two launcher codes,
  then `exited`. The first pair is shipped precedence; `cancelled` ranking last is new. See
  `02-the-one-supervised-run-machine.md`.
- **A spawn that never starts is normalized to `not-started`** — the third caller-visible change, and
  the epic's `## Non-goals` now says four rather than two. See
  `02-the-one-supervised-run-machine.md`.
- **`createSupervisedRunner` takes a defaulted spawn seam**, which is what makes gate row 11's `EPERM`
  and third-`errno` halves provable at the runner, and what makes the truncation bytes and the
  `not-started` outcome exact rather than platform-dependent. `signalErrorIsIgnorable` is therefore
  private, not exported. See `02-the-one-supervised-run-machine.md`.
- **`createGitRunner` maps the unreachable `cancelled` outcome** to
  `GitError("unknown", \`git <verb> was cancelled\`, "")`, adding no `GitFailure`value. See`03-the-git-runner-takes-the-runner.md`.
- **`probeTools` maps `output-exceeded`** to a `ToolProbeError("tool-unreadable", …)` naming the byte
  bound, adding no `ProbeErrorCode`. See `04-the-three-spawn-sites-and-the-facade.md`.
- **Every timeout message interpolates the effective timeout** — the fourth caller-visible change.
  `src/services/git/probe.ts:188` — `PROBE_TIMEOUT_MS` and `src/services/git/host-key.ts:251` —
  `KEYSCAN_TIMEOUT_MS` interpolate the constant while their timer used the caller's override. See
  `04-the-three-spawn-sites-and-the-facade.md`.
- **The runner is the first parameter** of `probeTools`, `scanHostKeys`, `confirmHostKey` and
  `inspectChild`. See `04-the-three-spawn-sites-and-the-facade.md`.

## What is still open for a human

- **EPIC 050.5 has not landed**, so the shift table above is a prediction from that epic's own stories
  and not an observation. Re-validate before dispatch.
- **The epic numbers its stories from 1 while `/work` keys the groundwork turn on the file name
  `00-groundwork.md`**, so the two numberings meet at an offset of one. EPIC 050.5 numbers from 0 and
  has no offset. The mapping table above is what resolves it; renumbering the epic would remove the
  need for one.
- **The write-exemption count is now owned, and it moves twice more.**
  `src/domain/layout.test.ts:428` — `eighteen` and `src/domain/layout.test.ts:439` — `assert.equal`
  count the list EPIC 050.5 Story 0 (`00-groundwork`) extends. EPIC 050.5 Story 6
  (`06-the-lease-service-is-deleted`) now takes both to nineteen, and EPIC 057 takes both back to
  eighteen when it deletes the stale entry. This epic reads the file at `:101`, `:108`, `:151` and the
  three lint cases and never at the count, so it is unaffected either way; it is named here because
  it was found while authoring this epic.
