# EPIC 051.2 — The command gate — stories

Epic: `.agents/plan/epics/051.2-the-command-gate.md`
Prereq: EPIC 051.1, implemented — its Story 1 (`01-the-five-git-primitives`) is what gives
`git.checkout`, which allocates the per-command directory and returns it, and `git.removeWorktree`,
which disposes of it. EPIC 050.6, implemented — it is what puts `DEFAULT_TIMEOUT_MS` on
`src/services/process/index.ts`. The re-authored EPIC 107, implemented — it is what makes
`Verify.run` execute anything at all, and `src/services/verify/not-implemented.ts:8` —
`NotImplementedVerify` throws until it lands. Neither EPIC 050.6 nor EPIC 107 is authored into
stories yet, so no story stem of either resolves. EPIC 050.1 Story 6 (`06-the-conformance-harness`)
and Story 7 (`07-the-conformance-runner`) for the recorder, the runner and the range list.

A declared command runs against an immutable checkout of the pinned commit, one fresh checkout per
command, and any outcome that is not `passed` refuses.

## One story, one path

A story that changes a shipped path draws a pair. A path written from nothing draws the ship diagram
alone, with an empty prior set. `.agents/plan/authoring.md` is the grammar, and
`scripts/verify-epic-sequence.ts` of EPIC 050.1 Story 8 (`08-the-range-gate`) enforces it.

Three stories. **Two draw, and both prior sets are empty**: `commands.run` is written from nothing,
so no story here draws a `baseline-` diagram and no story declares `Supersedes:`. Every token of
each diagram is therefore `+`, declared once by the story that owns that path.

**Story 2 (`02-no-declared-command-runs`) draws a diagram with no step, and carries no `Seams:`
line.** That is the strongest statement the grammar has: the recorder's token list is empty, so any
call the implementation makes on an empty command list fails the comparison. It is **first** in
dispatch order and it creates the module with a body that does nothing, so it changes production
code like the other two; Story 1's loop then lands on top of the contract it sets.

**Story 3 (`03-a-declared-command-fails`) is a `story-foundation` and draws nothing.** An earlier
draft of this tree gave it a third diagram, `run-commands-refusal-command-failed`, whose token set
and order were identical to `run-commands-success-one`'s with only the terminal differing.
`.agents/plan/authoring.md` refuses that four ways, and on a passing check Story 3's trace is
byte-identical to Story 1's, so it changes no drawn path. The refusal is proven by its cases. The
epic's `## Sequence` now states this, and its gate names two diagrams.

**No story of this epic holds a groundwork edit, and there is no `00-groundwork.md`.** Every path the
three stories write is inside an engineer lane, checked with the guard rather than from memory:
`src/commands/checkpoint/run-declared-commands.ts` and `scripts/epic-sequence-range.ts` are the
software-engineer lane, and `src/commands/checkpoint/run-declared-commands.test.ts`,
`test/sequence/conformance.test.ts` and the two files under `test/sequence/scenarios/` are the
test-engineer lane. `scripts/lane-check.sh` denies nothing this epic touches to both engineers, so
manufacturing an empty groundwork story would be a slot spent on nothing.

## Dispatch order

**The dispatch order is not the numeric order.** File numbers follow the EPIC's story-entry order,
per `/author`; the order `/work` takes them is decided here.

Story 2 (`02-no-declared-command-runs`) runs **first**. It creates
`src/commands/checkpoint/run-declared-commands.ts` with its full signature and a body that does
nothing, and it appends `"051.2"` to `authoredEpics`. That append cannot follow the epic's first
scenario file: `test/sequence/conformance.test.ts:118` — `liveIds` refuses a scenario file whose id
names no live diagram of an authored epic, so a scenario added before the range names this epic makes
`pnpm test` red. Story 2 owns the first scenario file, so it owns the append.

Story 1 (`01-one-declared-command-runs`) follows. It replaces that empty body with the loop, and its
case 2 is the behavioural control Story 2's two absence cases defer to it.

Story 3 (`03-a-declared-command-fails`) follows both. It adds the predicate, the refusal and the
precedence, and it appends `"051.2"` to `shippedEpics`, which makes both diagrams due at once, so it
cannot run before the second scenario file exists. It also carries the `await scenario()` repair,
which EPIC 051.1 Story 4 (`04-the-candidate-ref-is-deleted`) already schedules.

The serial order is **2 → 1 → 3**. No story depends on a later one.

**Every one of the three changes production source, and that is why Story 2 leads.** An earlier draft
of this tree ordered them 1 → 2 → 3 and left Story 2 with no production change: its cases were
already green once Story 1's loop existed, so the loop had nothing to open as RED and the
`story-implement` kind was a label on documentation. Creating the module in Story 2 fixes that
without adding a line that traces to nothing — an empty `commands` array iterates nothing, so Story 1
needs no guard and deletes nothing but the two `void` statements.

## Stories

- 1 — One declared command runs → `01-one-declared-command-runs.md` — `story-implement`, draws `run-commands-success-one`; dispatched **second**
- 2 — No declared command runs → `02-no-declared-command-runs.md` — `story-implement`, draws `run-commands-success-none`; dispatched **first**
- 3 — A declared command fails → `03-a-declared-command-fails.md` — `story-foundation`, draws nothing; dispatched **third**

## Facts (needed for implementation)

- **A command may not import `node:fs`.** `eslint.config.js:342` — `node:fs` restricts `src/commands/**` and `src/queries/**`, together with `node:sqlite`, `node:fs/*`, `node:http` and `node:child_process`. That single fact decides the whole shape of the unit: it can neither `mkdtemp` nor `rmSync`, so both halves of the worktree lifecycle had to move into `Git`, and EPIC 051.1 was amended for it. The unit imports no `node:` module at all.

- **`git.checkout` allocates the directory and returns it.** EPIC 051.1 Story 1 (`01-the-five-git-primitives`) declares `checkout(input: { gitDir, oid }): Promise<string>` over `git worktree add --detach <allocated> <oid>`, minting with `mkdtempSync` under `GitPaths.worktreeDirectory` and rolling that allocation back when `worktree add` fails. `mkdtemp` is atomic, so no two checkouts collide and no crash residue can occupy the next allocation. A caller-derived name such as `<runId>-<attemptNo>-<index>` was drafted and refused: it is not atomically fresh, and its freshness would have rested on replay and attempt-numbering invariants this epic does not own.

- **`git.removeWorktree` disposes of both halves in one call, and it is not idempotent.** Measured on git 2.48.1: `git worktree remove --force` against a worktree holding a modified tracked file and an untracked file returns 0, deletes the directory, and removes the `worktrees/` entry — which is what lets one invocation satisfy the epic's gate rows 6 and 7 together. A second call on the same path returns 128, so it runs exactly once per `checkout` and no caller retries it. `--force` is required, because a declared command runs arbitrary shell in that tree.

- **`git worktree prune --expire=now` does not recover a crashed checkout.** Measured on git 2.48.1: prune removes only an administrative entry whose working tree is **missing**. A crash between the checkout and the removal leaves both the directory and its entry. EPIC 051.1 records the measurement and names EPIC 051.4 as the owner of the sweeper; this epic's `## Non-goals` restates it, and no story here adds one.

- **`git worktree add` accepts an existing empty directory, which is what `mkdtemp` leaves it**, and creates nested leading directories. Measured on git 2.48.1; it returns 128 into an occupied directory, which is the failure mode the derived name would have had.

- **The `Verify` contract this epic consumes is EPIC 107's, not the shipped one.** `.agents/plan/epics/107-verify-service.md:28` rewrites `CheckRequest` to `Readonly<{ command: readonly string[]; cwd: string; timeoutMs: number; signal: AbortSignal | null }>` — no `checkName`, no `env`, no `outputLimitBytes` — and `CheckOutput` to a record whose `result` is `"passed" | "failed" | "error" | "timed-out" | "cancelled"`. The shipped `src/services/verify/index.ts:33` — `Verify` still carries the old five-field request, and `src/services/verify/not-implemented.ts:8` — `NotImplementedVerify` throws. Every citation of the request shape in these stories names the epic, not the file, because the file is rewritten before this epic dispatches.

- **`DEFAULT_TIMEOUT_MS` is `120_000` and it moves.** `src/services/git/run.ts:14` — `DEFAULT_TIMEOUT_MS` is where it ships today; `.agents/plan/epics/107-verify-service.md:28` records that EPIC 050.6 exports it from `src/services/process/index.ts`. A command may import a constant from a service interface file under the import matrix of `AGENTS.md`.

- **A `finally` discards the exception it wrapped and skips everything after the block.** That is why Story 3 replaces Story 1's `try`/`finally` with one `try` per call and three ordered checks. A refusal placed either inside or after a `finally` is masked by a `git.removeWorktree` that throws, so a cleanup fault would be reported to the worker as its command's verdict.

- **A refusing command under `src/commands/` throws a typed error carrying `refusal`.** `src/commands/node/claim-node.ts:126` — `refusal` is the shape, and `test/helpers/sequence-conformance.ts:305` — `refusal` is what the recorder reads to derive `refuse:<code>`. There is no `{ ok: false, code }` result union anywhere under `src/commands/`.

- **A nested unit narrows the service interface it needs, and does not export the narrowing.** `src/commands/run/expire-runs.ts:12` — `ExecutionExpiry` is the pattern. The seam type the consumer declares is the consumer's: `src/commands/node/claim-node.ts:75` — `Expiry` declares `expiry.expireRuns` inside `claim-node.ts`, and `src/main.ts:388` closes over the inner unit's real dependencies. `commands.run`'s seam type therefore belongs to EPIC 051.4's `accept-execution.ts` and not to this epic.

- **No file under `src/commands/` may import another command module.** `src/domain/layout.test.ts:185` — `commandsDir` asserts it, with one enumerated exemption.

- **The bare repository fixture is hermetic and its oids are pinned.** `test/helpers/remote/seed.ts:124` — `seedRepositories` builds one bare repository, `test/helpers/remote/seed.ts:135` — `repositoryName` names it `fixture.git`, and `test/helpers/remote/seed.ts:26` — `fixtureObjectIds` pins `commit1` and `commit2`. `commit1`'s `README.md` is `"kanthord fixture\n"` and `commit2`'s is `"kanthord fixture second\n"`, from `test/helpers/remote/seed.ts:139` — `blob1`. `src/services/git/ref-update.test.ts:41` — `seedRepositories` is the shipped call site.

- **The conformance runner cannot run an asynchronous scenario today.** `test/sequence/conformance.test.ts:279` — `scenario` calls it without `await`, so `recorder` and `result` are `undefined`. Every shipped scenario is a synchronous command; both scenarios of this epic are asynchronous, and EPIC 051.1 Story 4 (`04-the-candidate-ref-is-deleted`) already schedules the same edit at `.agents/plan/stories/051.1-the-candidate-and-the-git-primitives/04-the-candidate-ref-is-deleted.md:85` — `scenario`.

- **`test/helpers/sequence-conformance.ts` exports exactly `recordSeams` and `assertConformance`.** `liveDiagrams`, `scenarioFilesById` and `validateScenarioFiles` are private to `test/sequence/conformance.test.ts`, and its `it` cases are not an API. Every conformance assertion a story of this epic makes therefore goes through those two exports plus a story-file path it names itself.

- **The range is two lists and the division is load-bearing.** `scripts/epic-sequence-range.ts:1` — `authoredEpics` names every epic whose stories exist and gates whether a scenario file is legal; `scripts/epic-sequence-range.ts:9` — `shippedEpics` names every epic whose code exists and gates whether a diagram is due. `test/sequence/conformance.test.ts:264` — `slice` asserts the second is a prefix of the first. EPIC 050.1 Story 7 (`07-the-conformance-runner`) defines both, and each epic of the range appends its own id.

- **`scripts/verify-epic-sequence.ts` is not in `pnpm run verify`.** The `verify` script runs `prettier`, `typecheck`, `pnpm test`, `lint`, `verify-db-status.ts`, `verify-schema-writers.ts` and `verify:guards`, and names the range gate nowhere. `test/sequence/conformance.test.ts` reaches these stories through `pnpm test` alone, which is why Story 2's `authoredEpics` append changes what runs and Story 3's `shippedEpics` append changes what is asserted.

- **`worker.md` section 2 is the one sentence that states both rules of this epic.** The daemon runs each entry of `commands` against the pinned commit, a command exits zero or the node fails, and an empty `commands` list asserts nothing. Section 8 step 5 adds that the commands run against an immutable checkout.

## Decisions taken during authoring, and now recorded in the EPICs

Each was reported as an open item, ruled by Ulrich, and applied. The epic files carry them.

- **The worktree lifecycle belongs to `Git`, both halves of it.** EPIC 051.1 Story 1 (`01-the-five-git-primitives`) now declares **six** primitives: `checkout` becomes `({ gitDir, oid }): Promise<string>` with its own `mkdtempSync` allocation and a rollback, and `removeWorktree` is added over `git worktree remove --force`. `GitPaths` gains `worktreeDirectory` and `buildGitPaths` creates it at mode `0o700`. The stem stays `01-the-five-git-primitives`, because it is an address this tree cites. Applied to that epic and that story.

- **Every non-passing outcome refuses `command-failed`, and the mapping is total.** `!== "passed"` covers all four non-passing members of `CheckOutcome` and every `errorReason` — including the `error` with `errorReason` **null** that `.agents/plan/epics/107-verify-service.md:31` produces for exit `126` and `127`, which a reason-based split would leave undefined. **A throw-for-daemon-faults split was drafted and rejected**: it was not exhaustive, and it would have decided retry and attempt-accounting semantics that belong to EPIC 051.4 and EPIC 054. A seventh refusal code separating a daemon fault from a command failure is a real product question, recorded in the epic's `## Non-goals` with its owner.

- **The precedence of two simultaneous failures is declared.** A `verify.run` throw wins, then `command-failed`, then a removal failure — which therefore surfaces only when the check passed. Story 3 gives each call its own `try`, because a `finally` masks a refusal both from inside and from after the block.

- **The refusal is not drawn.** `run-commands-refusal-command-failed` is deleted from the epic and Story 3 is a `story-foundation`. Gate row 14 names two diagrams.

- **Gate ownership is corrected.** Row 8 states what Story 1 can prove — the daemon inspects no character of the command string — and row 8b, owned by Story 3, states the acceptance a predicate is needed for. Row 14 moves to Story 3, which appends `shippedEpics`. Rows 15 and 16 are separate, because `authoredEpics` lands in Story 2 and `shippedEpics` in Story 3 and they enforce different invariants.

- **`verify.run` carries no command-string projection**, and Story 1 states it now that Story 3 draws nothing. `command` is an array whose rendering holds commas, which the `Seams:` token grammar forbids; a declared command string holds spaces and colons, which the token grammar splits on; `cwd` is a `mkdtemp` path, so it is not a fixed token at all; and `timeoutMs` and `signal` separate nothing. `test/helpers/sequence-conformance.ts:50` — `projections` gains no entry.

- **`signal: null` on every call.** `.agents/plan/epics/107-verify-service.md:28` makes the field required with no default, and this epic decides no cancellation.

- **The `authoredEpics` append is Story 2's and the `shippedEpics` append is Story 3's.** One list gates whether a scenario file is legal and the other gates whether a diagram is due, so they cannot land together: the first must precede the epic's first scenario file — which Story 2 adds, being first in dispatch order — and the second must follow the last one. Neither append may reorder an existing element, so a range list whose last element sorts after `051.2` is a defect of the epic that inserted it, reported rather than repaired here.
