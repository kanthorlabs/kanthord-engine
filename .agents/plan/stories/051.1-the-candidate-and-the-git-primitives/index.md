# EPIC 051.1 — The candidate and the git primitives — stories

Epic: `.agents/plan/epics/051.1-the-candidate-and-the-git-primitives.md`
Prereq: EPICs 050.2, 050.3, 050.4, 050.5 and 051, **shipped**. Story 5 appends `"051.1"` to `shippedEpics`, and `test/sequence/conformance.test.ts:267` requires that list to stay a prefix of `authoredEpics`. Story 4 appends `"051.1"` to `authoredEpics` after `"051"`, and `test/sequence/conformance.test.ts:41` throws for a listed epic whose story directory is absent, so EPIC 051's story tree exists first. It does.

A worker's candidate is a pinned ref the daemon owns. The daemon reads it, judges whether it reaches
the reported oid, deletes it, and reaps the namespace of every run that is not active. `Git` gains the
six read and write primitives the family needs, and the three acceptance verdicts exist as pure
functions with no caller. The ordered gate that calls them is EPIC 051.4.

## One story, one path

Every path here is written from nothing, so each ship diagram stands alone with an empty prior set and
no `baseline-` diagram. No path an earlier epic drew changes, so this epic supersedes nothing, and
`expiry-pass-one-due` of EPIC 050.1 is untouched.

Six stories carry a diagram: 2, 3, 4, 5, 7 and 8. Stories 1 and 6 are foundation work and draw
nothing.

The two commands each have every branch drawn. `ingestCandidate` holds three —
`ingest-candidate-missing-ref` (Story 2), `ingest-candidate-reachable` (Story 7) and
`ingest-candidate-unreachable` (Story 3). `sweepCandidates` holds two —
`sweep-candidates-no-stale-ref` (Story 8) and `sweep-candidates` (Story 5). `discardCandidate` holds
one (Story 4), because `git update-ref -d` on an absent ref exits `0` and there is no missing-ref
branch.

## Dispatch order

**1 → 6 → 4 → 2 → 7 → 3 → 8 → 5.** No story depends on a story later than itself in that order.

Story 1 is the interface fan-out. Every other story except 6 needs a method it adds, and it widens
`interface Git` and `GitPaths`, which fails type checking in eight `Git` stubs and fifteen `GitPaths`
builders until they move.

Story 6 is independent of every story of this epic. It reads no git and has no caller, so it can run
at any point.

Story 4 is the first story to add a scenario file, so it carries the three harness edits every later
scenario needs: the asynchronous scenario runner, the ref-namespace projection, and the `"051.1"`
entry in `authoredEpics`. Stories 2, 3, 5, 7 and 8 all declare it for that reason as well as for
`candidate.discard`.

Stories 2, 7 and 3 build `ingestCandidate` in three increments: the missing-ref refusal, then the
reachability check and its success path, then the deletion the failing branch performs.

Story 8 writes `sweepCandidates` whole. Story 5 wires it into startup, adds the recovery vocabulary,
and proves the reaping; it is last, because it appends this epic to `shippedEpics`, which is what makes
all six diagrams due.

## Stories

- 1 — The six git primitives → `01-the-five-git-primitives.md`
- 2 — The candidate ref is missing → `02-the-candidate-ref-is-missing.md` — draws `ingest-candidate-missing-ref`
- 3 — The candidate ref does not reach the reported oid → `03-the-candidate-ref-does-not-reach-the-reported-oid.md` — draws `ingest-candidate-unreachable`
- 4 — The candidate ref is deleted → `04-the-candidate-ref-is-deleted.md` — draws `discard-candidate`
- 5 — The reaper deletes a stale ref → `05-the-candidate-namespace-has-a-reaper.md` — draws `sweep-candidates`
- 6 — The acceptance verdicts → `06-the-acceptance-verdicts.md`
- 7 — The candidate ref reaches the reported oid → `07-the-candidate-ref-reaches-the-reported-oid.md` — draws `ingest-candidate-reachable`
- 8 — The candidate namespace is enumerated → `08-the-candidate-namespace-is-enumerated.md` — draws `sweep-candidates-no-stale-ref`

**Story 1's file stem stays `01-the-five-git-primitives` although it now carries six.** EPIC 051.2's
story tree cites it four times, and `.agents/plan/authoring.md` makes a stem an address. Stories 7 and
8 were appended rather than inserted for the same reason: `04-the-candidate-ref-is-deleted` is cited
three times, and inserting would have renumbered it.

## Decisions taken during authoring, and now recorded in the EPIC

- **The sweep calls `candidate.discard`, never `git.deleteRef` directly.** The EPIC's Goal made
  `candidate.discard` the only caller and its seam list made `candidate.sweep` a second one. The Goal
  wins, because the decision that makes `candidate.discard` a nested unit exists precisely so the token
  appears in one diagram. See `08-the-candidate-namespace-is-enumerated.md`.

- **A candidate deletion opens no journal row, and six conditions decide it.** `AGENTS.md`
  `### Rules the import matrix cannot express` carries the criterion, and both commands satisfy all
  six. Ownership and idempotence are not the criterion. See
  `08-the-candidate-namespace-is-enumerated.md`.

- **The sweep runs at startup only in this epic.** `expireRuns` runs inside `claimNode`'s transaction
  and the daemon holds no periodic driver, so the runtime pass needs `ClaimNodeResult` to carry the
  expired runs and the `node.claim` binding to become asynchronous. EPIC 051.5 owns the targeted
  post-expiry cleanup. See `05-the-candidate-namespace-has-a-reaper.md`.

- **The sweep's active-run guarantee is snapshot-scoped.** It reads the active set, then lists refs, so
  a run that becomes active between the two would lose its ref. Startup is quiescent, so the window
  does not exist there; EPIC 051.5 closes it for the runtime call site. See
  `08-the-candidate-namespace-is-enumerated.md`.

- **`Execution` gains `activeRunIds`.** Every shipped run read is by node —
  `src/services/execution/index.ts:101` and `:102` — and the sweep knows a run id and no node.

- **`ingestCandidate` refuses by returning a verdict, not by throwing.** EPIC 051.4 composes it into an
  ordered gate where the first failure names itself. `resultTerminal` at
  `test/helpers/sequence-conformance.ts:310` reads `ok === false`, so the returned shape renders
  `refuse:candidate-unreachable` with no harness change.

- **`candidate` is a dependency key holding an object with a `discard` method.**
  `test/helpers/sequence-conformance.ts:113` returns a function dependency unwrapped, so a
  function-valued key would record no token.

- **The ref namespace is projected through one table, seeded with the candidate prefix and
  `refs/heads/`.** A projection names a value the call receives, and the received value is a full ref.
  One table answers this epic and EPIC 051's `git.resolveRef:branch`. See
  `04-the-candidate-ref-is-deleted.md`.

- **`declaredPathVerdict` receives absolute declared paths and repository-relative changed paths, and
  compares `` `/${changed}` `` by exact string equality.** `verifyPath` at
  `src/domain/verify-block.ts:5` refuses a relative entry and `git diff --name-status` emits a
  repository-relative path, so without a stated normalisation the two never match.

- **`checkout` allocates its own directory and `removeWorktree` disposes of it.** Every caller is a
  command under `src/commands/`, where `eslint.config.js` bans `node:fs`, so a caller can neither
  allocate nor remove. See `01-the-five-git-primitives.md`.

## Facts (needed for implementation)

### The conformance harness cannot run an asynchronous scenario today

`test/sequence/conformance.test.ts:282` is `const { recorder, result } = scenario();` — no `await` —
and the cast at `:275` declares a synchronous return. Every command of this epic is asynchronous.
Story 4 changes both.

### The range lists

`scripts/epic-sequence-range.ts:1` holds `authoredEpics`, `:9` holds `shippedEpics`, and both are
pinned by value at `test/sequence/conformance.test.ts:255`.

### `sweepHome` runs no git today

`src/services/git/sweep.ts:1` imports `node:fs` alone, `:68` takes no `GitRunner`, and
`src/services/git/binary.ts:45` binds it without one. Story 1 changes the signature and the binding.
The `Git.sweepHome` declaration at `src/services/git/index.ts:191` and the caller at
`src/commands/startup/sweep-remnants.ts:58` do not change.

### `git worktree prune` reclaims less than it sounds like

It removes only an administrative entry whose working tree is **missing**. A crash that left the
directory in place keeps both, and the prune does not reach them. Story 1 case 22 is the control that
pins the limit, and the EPIC states the residue as a non-goal owned by EPIC 051.4.

### The two consumer sets Story 1 must move

Eight hand-written `Git` stubs gain six members each, and fifteen hand-written `GitPaths` builders gain
`worktreeDirectory`. Both lists are enumerated in `01-the-five-git-primitives.md`. Two further sites
spread an existing `GitPaths` and need no edit.

### The expiry pass is demand-side, not periodic

There is no scheduler and no timer. `expireRuns` runs inside one command,
`src/commands/node/claim-node.ts:147`, bound at `src/main.ts:388` and passed to the `node.claim`
handler at `src/main.ts:564`.

### `git.changedPaths` has no shipped fixture

`test/helpers/remote/seed.ts` seeds one linear history over one path named `README.md` (`:149`,
`:167`). It produces no rename, no addition and no deletion. Story 1 builds a work repository in the
test with the `execFileSync` idiom of `src/services/git/worktree.test.ts:62`.

### `run_base` cardinality is an application guarantee

`src/services/storage/migration-0012-run-model.ts:36` gives `run_base` the primary key
`(run_id, repository_id)`, which forbids a duplicate pair and permits two repositories. `runRow` at
`src/domain/run.ts:13` is imported only into `src/domain/rows.ts:43` and two tests, and no production
file parses it, so Story 6's refine is documentation and no fixture moves.

### Verify

`pnpm run verify` is `prettier --check && typecheck && test && lint && verify-db-status && verify-schema-writers && verify:guards`.

## Still open

Two items, and neither is a defect in this tree.

- **EPIC 051.5 does not exist.** The EPIC names it as the owner of the targeted post-expiry candidate
  cleanup, and no such file is written. `/plan` writes it. Until it exists, the epic ships less than
  its original Goal stated, which the Non-goals now say plainly.
- **The dispatch prerequisite is ordering, not design.** EPICs 050.2, 050.3, 050.4, 050.5 and 051 ship
  before Story 5's `shippedEpics` append is legal.

Everything else raised during authoring is applied: the Goal/seam contradiction, the journal
exemption in `AGENTS.md`, the corrected `Proof` block, the two undrawn branches, the sibling
amendments to EPIC 050.5 and EPIC 054, and the `RECOVERY_STEP_ORDER` forward note.
