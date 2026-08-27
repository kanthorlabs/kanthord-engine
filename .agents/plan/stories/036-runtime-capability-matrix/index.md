# EPIC 036 — The runtime capability matrix — stories

Epic: `.agents/plan/epics/036-runtime-capability-matrix.md`
Prereq: EPIC 035 (sequence order).

One document under `docs/proposal/` states, per routed operation, whether the operation runs on the
Node daemon, on AWS Lambda and on Cloudflare Workers. One test proves the document names every
routed operation and no other.

## Dispatch order

1. `01-the-document-states-the-capability-inventory.md` — creates the file.
2. `02-the-document-states-the-operation-matrix.md` — appends the 44 rows and the aggregate.
3. `03-the-document-states-the-deployment-shapes-and-the-gate.md` — appends the shapes and the gate.
4. `04-the-proposal-links-the-document.md` — three link edits, in three other files.
5. `05-a-test-proves-the-matrix-is-complete.md` — the completeness test.

Stories 1, 2 and 3 are strictly sequential: each appends to the file the previous one left, and none
rewrites a line an earlier one wrote. Story 4 needs only Story 1, so it may land any time after it.
Story 5 needs Story 2, and it is the last story because its four failure-mode checks read the
finished document.

There is no coupled pair. Each story passes `npm run verify` on its own.

**Five stories cover the EPIC's five story bullets, one to one.** No bullet is split and none is
merged. The EPIC already partitions the work by document section, and each section is a separate
append.

**Four stories are the software-engineer lane and one is the test-engineer lane.** Stories 1 to 4
edit `docs/proposal/**` only, which `scripts/lane-check.sh:99-101` grants to the software-engineer;
the test-engineer writes nothing for them. Story 5 adds one `*.test.ts` under `src/`, which
`scripts/lane-check.sh:72-83` grants to the test-engineer and denies to the software-engineer. No
story crosses the line.

**This epic changes no production file.** The EPIC's gate requires that the epic's change set names
only files under `docs/proposal/` and the one new `*.test.ts`. The exact five paths, and the way to
compute the set in a tree that holds other agents' work, are under `## Facts` below.

## Stories

- 1 — the file, the portable-built-in rule, and one row per service capability →
  `01-the-document-states-the-capability-inventory.md`
- 2 — 44 rows, one per routed operation, nine columns, and the aggregate as counts →
  `02-the-document-states-the-operation-matrix.md`
- 3 — the four ranked deployment shapes, and the four unblocked pieces of work →
  `03-the-document-states-the-deployment-shapes-and-the-gate.md`
- 4 — a row in each of the two Files tables, and one paragraph in `transport.md` →
  `04-the-proposal-links-the-document.md`
- 5 — `src/http/contract/runtime-matrix.test.ts` compares the document against the registry in both
  directions → `05-a-test-proves-the-matrix-is-complete.md`

## Two decisions Ulrich settled, and the EPIC now carries

Both were open when these stories were written and both were settled on 2026-08-27. The EPIC was
amended the same day, so the EPIC and the stories agree and nothing here blocks dispatch. They stay
recorded because a reviewer holding an older copy of the EPIC would otherwise read the current tables
as a deviation.

- **`system.health` on a serverless root is `degraded`.** Story 2 writes
  `degraded — the one storage reporter has no driver`, and the aggregate stays
  `1 yes, 2 degraded, 41 no`. The EPIC's earlier wording named a home lock reporter and a bare home
  reporter; neither exists, and the EPIC's Open items now record the correction. A non-Node root that
  composes a different reporter set is a later decision, and it moves this cell and the aggregate
  together.

- **What `carries` means, and shape 2's count.** The EPIC says a Lambda container "carries the whole
  surface" while its own Lambda column marks 41 of 44 `no`. Story 3 resolves that by defining
  `carries` — an operation answers correctly under the shape, and a `degraded` row is not carried —
  and by stating four derived counts: `44`, `42`, `38` and `1`. Shape 2 is `42` rather than `44`
  because `event.list` holds a connection open and `plan.import` has no durable store.

The third correction needed no decision. The `18` memory count is arithmetic over the registry,
Story 2 names all eighteen, and the EPIC carries `18` as well.

## Facts (needed for implementation)

- **Two of the EPIC's stated numbers are wrong against the tree, and the stories write the tree's
  numbers.** Both were verified by parsing `src/http/contract/*.ts` and by reading `src/main.ts`.

  - The EPIC says `16` routed operations declare `idempotency: "memory"`. It is **18**. Twenty-eight
    operations declare `memory`; ten of those are `stubbed` and enter no row. The eighteen are
    `actor.register`, `actor.revoke`, `actor.rotate`, `node.claim`, `node.create`, `node.delete`,
    `node.heartbeat`, `node.release`, `node.report`, `node.unblock`, `node.update`, `plan.validate`,
    `project.create`, `provider.inspect`, `provider.register`, `provider.rename`,
    `repository.inspect`, `repository.register`. Story 2 pins all eighteen by name.
  - The EPIC gives `system.health` the degradation `no home lock reporter and no bare home reporter`.
    Neither reporter exists. `src/main.ts:337-345` composes exactly one reporter, named `storage`,
    whose probe calls `storage.ping()` (`src/services/storage/index.ts:37`,
    `src/services/storage/sqlite.ts:131`). Story 2 writes
    `degraded — the one storage reporter has no driver`. The verdict stays `degraded`, which is what
    the EPIC's aggregate of `1 yes, 2 degraded, 41 no` requires.

- **Every other fact the EPIC asserts was checked and holds.** The routed count is `44` and the
  stubbed count is `25`. The registry is sorted bytewise by `operationId` at `registry.ts:37-39`, so
  the routed subsequence is in that order. The EPIC's eight operation classes partition the 44 rows
  exactly, with no overlap and no gap. The per-capability built-in sets are exact as the EPIC states
  them, including `blob`, `crypto` and `secret` importing `node:crypto` and nothing else, and the
  other thirteen importing no Node built-in.

- **`registry` is `readonly Operation[]`, exported at `src/http/contract/registry.ts:25`.** `status`
  is typed `"routed" | "stubbed"` at `src/http/contract/operation.ts:38`. No exported helper returns
  the routed ids — `declaredCapabilities` (`src/http/contract/capability.ts:23-41`) uses the status
  as a gate and returns capability names, not operation ids. `registry.test.ts:66` builds the filter
  inline, and Story 5 does the same.

- **The three no-storage rows were confirmed at the query, not inferred from the class table.**
  `provider.catalog` reaches `src/queries/provider/read-catalog.ts`, which imports
  `services/model-catalog` alone. `provider.inspect` reaches
  `src/queries/provider/inspect-provider.ts`, same single import. `system.health` reaches
  `src/queries/system/read-health.ts`, which imports `domain/health.ts` and takes its reporters as an
  injected dependency. Every other routed operation reaches `services/storage` or `services/blob`.

- **All four git rows reach storage as well as git**, so their `Storage` cell is `sqlite` and their
  `Git` cell is `git`: `src/commands/repository/register-repository.ts:4,13`,
  `src/queries/repository/show-repository.ts:1-2`, `list-repository.ts:1-2`,
  `inspect-repository.ts:2,9`.

- **`blob.show` reaches `services/blob` and not `services/storage` directly.**
  `src/queries/blob/show-blob.ts:1` imports `BlobStore`. `src/services/blob/sqlite.ts:1` imports
  `node:crypto` only and persists through the storage transaction. That is why the capability row for
  `blob` is `yes` on both targets while the operation row is `no` — Story 1 states the distinction so
  a reader does not read it as a contradiction.

- **`event.list` is the one operation that reaches the wait registry.**
  `src/http/server/event/list-event.ts:10,45` imports and calls `WaitRegistry` from
  `./wait.ts`, and `src/http/server/event/wait.ts:3` sets `POLL_INTERVAL_MS = 250`.

- **`src/http/server/idempotency-store.ts:11-16` holds the settings the document quotes**:
  `ttlSeconds: 300`, `joinTimeoutSeconds: 30`, `maxEntries: 256`, `maxBytes: 8388608`. Neither that
  file nor `event/wait.ts` imports a `node:` builtin; the portability problem is per-process state,
  not a Node API.

- **EPIC 035 does not move either file.** It relocates the listener and the timer schedule into
  `src/http/server/runtime/node/`, and its own Proof still names
  `src/http/server/idempotency-store.test.ts` in place. The paths the document cites stay valid.

- **The line numbers in Story 4 are today's**, and EPICs 030 to 035 land first. Each edit therefore
  quotes the line it anchors to verbatim. Find the quoted line, not the number, if the two disagree.
  `docs/proposal/README.md` Files table: lines 124-141, three columns, transport row at 128.
  `docs/proposal/phase-1/README.md` Files table: lines 17-24, **two** columns, transport row at 21.
  `docs/proposal/phase-1/transport.md`: 98 lines, the section opens at 5 and its last line is 10.

- **The reviewer line convention is line 3, plain prose, opening with the literal `Reviewer: `.**
  `transport.md:3`, `domain.md:3` and `plan-format.md:3` all take that shape.

- **Two live tests read the files Story 4 edits.** `test/helpers/remote/index.test.ts:130-184` parses
  the `deterministic` mode description out of `docs/proposal/README.md` and pins its transport
  vocabulary to `["git", "HTTP", "ssh", "sshd"]`. `src/cli/inventory.test.ts:20` scans
  `docs/proposal/phase-1/README.md` for CLI commands. Neither reads a Files table, and Story 4's rows
  name no command, so both stay green.

- **A contract test may import `node:fs`, `node:path` and `node:url`.** The
  `no-restricted-imports` block for `src/http/contract/**/*.ts` at `eslint.config.js:309-334` carries
  `ignores: ["src/**/*.test.ts"]`. The only rule that reaches a contract test is
  `eslint.config.js:365-380`, which bans the three git wrapper libraries. `coverage.test.ts:3`
  already imports `node:fs`.

- **The proposal-reading idiom in `src/http/contract/` is `import.meta.dirname`**, not
  `fileURLToPath(new URL(...))`: `proposal-amendment.test.ts:6`,
  `proposal-amendment-outcome.test.ts:6`, `proposal-amendment-execution.test.ts:8` all use
  `resolve(import.meta.dirname, "../../../docs/proposal")`. Story 5 follows it.

- **The extraction pattern must be anchored, and it must admit a capital and a second dot.** The
  document carries backticked operation ids in prose — `blob.show`, `event.list`, `plan.import`,
  `provider.catalog` — so an unanchored pattern invents rows. And two `stubbed` ids would evade a
  `[a-z]+\.[A-Za-z]+` pattern: `gitOperation.list` has a capital inside its first part, and
  `binding.worker.project` has two dots. Story 5 pins
  ``/^\| `([A-Za-z]+(?:\.[A-Za-z]+)+)` +\|/gm``. Run against the document the stories prescribe, it
  extracts exactly the 44 routed ids, in registry order, with no duplicate and no phantom.

- **The epic-wide scope check is not one command, and no single story can run it.** Each story
  checks its own contribution, which is necessary and not sufficient. Run the aggregate once, after
  Story 5, and run it the way `/review-epic` already does.

  **Resolve the base from the discussion file, never from `main`.** `/work` writes
  `base-ref: $(git rev-parse HEAD)` into the cycle's discussion file under `.agents/tdd/history/`
  when it opens the cycle. `/review-epic` Step 2 resolves the base as `--base <ref>`, else that
  header, else `git merge-base HEAD main`. **The third fallback is wrong for this epic.** Branch
  `feat/gh-29-planning-epic-034-039` carries EPIC 034 and EPIC 035 as well, so a diff from the
  merge-base with `main` sweeps their files into this epic's change set and the check fails for work
  that is not this epic's. Use EPIC 036's own `base-ref:`.

  **Take the union of four sources, not one diff.** `/review-epic` Step 2 states why: the tree holds
  other agents' concurrent work, and any one source alone is incomplete. A committed-only diff also
  misses the two files this epic creates while they are still untracked.

  ```bash
  git diff --name-only "$BASE_REF...HEAD"      # committed since the base
  git diff --cached --name-only                # staged
  git diff --name-only                         # unstaged
  git ls-files --others --exclude-standard     # untracked
  ```

  **The union must equal exactly these five paths, and no other.** Sorted with `LC_ALL=C`:

  ```
  docs/proposal/README.md
  docs/proposal/phase-1/README.md
  docs/proposal/phase-1/runtime-capability-matrix.md
  docs/proposal/phase-1/transport.md
  src/http/contract/runtime-matrix.test.ts
  ```

  Two are new — the matrix document and the test. The other three are the Story 4 link edits. A sixth
  path is a defect of this epic whatever it is, and a missing path means a story did not land.

- **`npm run format` will not widen the change set, as of 2026-08-27.** `npm run verify` runs
  `prettier --write src test scripts docs eslint.config.js` (`package.json:25,28`), so an
  already-unformatted file anywhere in those trees would be rewritten and would join the change set
  through no fault of this epic. `prettier --check` over exactly those paths reports
  `All matched files use Prettier code style!` today. Re-check it if EPIC 034 or EPIC 035 lands an
  unformatted file before this epic starts.

- **A Lambda container image starts a subprocess.** Story 1's built-in table marks
  `node:child_process` `yes` on Lambda and `no` on Workers, and capability `git` follows it. The
  EPIC's subprocess decision names a Worker only, and it is right to: an isolate starts no
  subprocess, a container image does. This is why shape 2 carries the four repository operations and
  shape 3 does not.

- **`npm run verify` is `format && typecheck && test && lint && verify-db-status`**
  (`package.json:28`). `format` is `prettier --write src test scripts docs eslint.config.js`
  (`package.json:25`), so it rewrites the markdown column widths of every table these stories add.
  Each documentation story runs prettier itself so the committed bytes are stable.
