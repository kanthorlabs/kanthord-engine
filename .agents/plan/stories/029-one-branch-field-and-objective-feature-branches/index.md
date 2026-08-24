# EPIC 029 — One branch field, and objective feature branches — stories

Epic: `.agents/plan/epics/029-one-branch-field-and-objective-feature-branches.md`
Prereq: EPIC 028 (sequence order).

A repository is registered with one branch name. Per-objective work lives on its own
`feature/<node id>` branch. `landingBranch` and `publishRef` leave the wire, the database and the
domain.

## Dispatch order

1. `01-the-proposal-states-one-branch-field.md` — documentation only, no source change.
2. `02-the-landing-branch-operation-leaves.md` — the operation, its proposal row, its path segment
   and ten pinned counts.
3. `03-one-branch-field-lands.md` — the rename, one commit.
4. `04-an-objective-clone-creates-its-feature-branch.md` — independent of Stories 2 and 3.

Each story passes `npm run verify` on its own. There is no coupled pair.

**Four stories cover the EPIC's seven story bullets.** Bullets 2, 3, 4, 5 and 7 are merged into
Story 3, because the rename is atomic across the type graph. Bullet 4's registry removal is **not**
part of that atom, so it is Story 2 on its own.

The rename is atomic:

- `RepositoryView` (`src/domain/repository.ts:38-56`) is built by
  `src/queries/repository/show-repository.ts:64-83` and `list-repository.ts:46-65`, validated by
  `repositoryView` (`src/http/contract/repository.ts:78-96`), and printed by
  `src/cli/repository/register.ts:171-176` and `show.ts:38-43`. Renaming one member fails
  `typecheck` at the other four sites in the same commit.
- Migration 0009 renaming `upstream_branch` breaks `SHOW_REPOSITORY_SQL`
  (`show-repository.ts:29-33`) the moment it applies.

Story 2 is the one part of the EPIC's bullet 4 that is **not** in that atom. Removing the
`repository.landingBranch` registry entry, its proposal row, its `path.ts` segment and ten pinned
counts touches no branch field, so it is its own commit — and keeping it separate stops ten count
edits from arriving inside a forty-file diff. The two sides of that removal must still land together:
`parity.test.ts:16` and `:25` compare the registry against rows parsed live out of
`docs/proposal/api/repository.md`, so the registry entry and the markdown row are one commit even
though they are not the rename.

Bullet 1's two `api/repository.md` edits are therefore **split**: the prose edit at `:58` is Story 1,
and the route-table row at `:15` plus the `## repository.landingBranch` section at `:108-111` are
Story 2.

Bullet 6 is Story 4 and is genuinely independent: `cloneObjective` is reachable only from the `Git`
interface and its own tests, so no command or query observes the change.

### What was not split, and why

One part of Story 3 is independently green and was still folded in: adding `headRefOf`,
`trackingRefOf` and the two aliases to `src/domain/repository.ts` before any caller uses them is
purely additive. It stays inside the rename because a renderer with no caller is dead code for the
length of one commit, and the story that adds it is the story that uses it.

Explicitly rejected: a compatibility seam that keeps the three old columns or the three old wire
fields while consumers migrate — for example a CLI that accepts `--branch` and still sends
`{ upstreamBranch, landingBranch, publishRef }`. It would buy green intermediate commits at the cost
of shipping a shape the product never wants, and `CLAUDE.md` Principle 2 forbids the speculative
scaffolding.

## Stories

- 1 — `git-foundation.md`, `api/repository.md:58`, `integration-and-publish.md:56` and
  `database/repository.md` state one branch field and the `feature/*` rule →
  `01-the-proposal-states-one-branch-field.md`
- 2 — `repository.landingBranch` leaves the registry, the proposal and the path grammar →
  `02-the-landing-branch-operation-leaves.md`
- 3 — `branch` replaces three fields in the domain, the database, the contract, the command, the
  git service, the handler and the CLI; migration 0009 drops two columns and refuses a divergent row
  → `03-one-branch-field-lands.md`
- 4 — the objective clone creates and checks out `feature/<node id>` and still proves isolation →
  `04-an-objective-clone-creates-its-feature-branch.md`

## Facts (needed for implementation)

- **The EPIC's gate is a `Gates:` line plus a runnable `Proof:` block**, and each story names which
  gate bullets it delivers. The Proof names 27 test files, two of which this epic creates:
  `src/services/storage/migration-0009-one-branch.test.ts` and
  `src/main.repository-branch.test.ts`, both Story 3's.

- **A story may edit `docs/proposal/`, and nothing else outside `.ts` and `.js`.** `CLAUDE.md` now
  says that explicitly, and its deny list is `scripts/lane-check.sh`'s: a configuration file, a
  manifest, `.claude/**` and `.agents/plan/**` are Ulrich's edits, while `docs/proposal/**` is the
  software-engineer lane (`scripts/lane-check.sh:99-101`). Story 1 and Story 2's sections 3 and 4 are
  therefore legal as written, and the test-engineer touches neither.

- **The seven phase-2 epics that named a dropped field are already amended**, by hand and outside any
  story, because `scripts/lane-check.sh:36` denies `.agents/plan/*` to every agent lane:
  `108-freshness-and-reconciliation.md`, `109-profile-verification.md`,
  `110-scheduler-leases-and-the-general-worker.md`, `112-objective-gate-and-mr.md`,
  `113-publish.md`, `114-onboarding-cli.md` and `115-phase-2-end-to-end-scenarios.md`. Nothing is
  outstanding, so no story carries a prerequisite on it.

- **EPIC 006 and EPIC 007 still name `refs/heads/<landing>`, and that is deliberate.** Both landed. A
  landed epic records what was built at the time, so rewriting it would falsify the record rather
  than fix anything. A reviewer must not report either as a defect of this epic.

- **The derived renderers live in `src/domain/repository.ts` and are named with an `Of` suffix**,
  matching the existing `objectiveScopeOf` convention. Story 4 adds `featureBranchOf` and
  `featureRefOf` to the same file. The domain stays pure: these are string functions over one
  argument.

- **`landingRefOf` and `publishRefOf` are two names bound to one implementation,** `headRefOf`. Their
  equality — both render `refs/heads/<branch>` — is the defining invariant of this EPIC, so it is true
  by construction rather than by two bodies that agree. Two separate bodies would readmit the drift
  this EPIC removes; the two names survive only because a call site reads better for saying which
  question it asks.

- **Ref rendering is duplicated at five runtime sites today** and Story 3 replaces every one:
  `show-repository.ts:54-55`, `list-repository.ts:46-47`,
  `register-repository.ts:260` and `:307`, `seed.ts:140` and `:167`, and the CLI default at
  `cli/repository/register.ts:149`.

- **`publishRef` is a stored column today, not a derived string.** `show-repository.ts:73` and
  `list-repository.ts:65` pass `row.publish_ref` straight through. After Story 3 it is rendered from
  `branch`, and the column is gone.

- **The example for `trackingRef` is wrong today and Story 3 fixes it.**
  `src/http/contract/repository.ts:133` reads `trackingRef: "refs/kanthord/upstream/main"`; the two
  handlers build `refs/remotes/origin/${upstream_branch}`. This is pre-existing drift, not a defect
  of any epic. Once `trackingRefOf` is the single definition, the example must equal what it renders.

- **The migration refusal is pure SQL, and the `Migration` type does not change.** `RAISE(ABORT, ...)`
  accepts an **expression** message from SQLite 3.47 onward, and this repository runs **3.53.0** on
  **Node 24.17.0** — verified by running it, not inferred. A temporary trigger therefore names the
  offending repository:

  ```
  RAISE(ABORT, 'the repository ' || NEW.name || ' diverges')  ->  "the repository alpha diverges"
  ```

  So `Migration` keeps its four members (`src/services/storage/migration.ts:1-6`) and
  `src/services/storage/sqlite.ts` is untouched. An earlier draft of this plan added a
  `guard?: (transaction) => void` hook on the false premise that `RAISE` takes only a literal; that
  hook is gone, because it turned declarative SQL into arbitrary behaviour for no gain.

- **The refusal must test both dropped columns, not one.** `landing_branch <> upstream_branch` alone
  lets a row with `publish_ref` of `refs/heads/release` migrate and silently retarget publishing to
  `refs/heads/main`. Migration 0009 also refuses
  `publish_ref <> 'refs/heads/' || upstream_branch`. Without that clause the EPIC's premise — that the
  two columns carry no value `branch` does not carry — is false.

- **Migration 0009 needs no rebuild, and `rebuild: true` would not have broken it.** Verified: on a
  STRICT table with two `CHECK` clauses and an inbound foreign key, `ALTER TABLE ... RENAME COLUMN`
  plus two `DROP COLUMN` succeed under `PRAGMA legacy_alter_table` **both ON and OFF**, with the
  referencing value intact. Omit `rebuild` because three native statements do the job, not because a
  rebuild is unsafe. Neither dropped column appears in the table's `CHECK` clause
  (`migration-0001-core-entities.ts:52-56`) or in any index.

- **`landing-branch` leaves the closed segment set.** `subresourceSegments` is a closed grammar, so a
  segment no operation uses is dead vocabulary that permits the path's reintroduction without editing
  the grammar. Story 2 deletes it from `src/http/contract/path.ts:28`, moves
  `path.test.ts:39` from 17 to 16, and replaces the ordering assertion at `:153-162` — which names the
  removed segment — with the same assertion over two live adjacent segments.

- **Two shared row fixtures carry the three columns** — `test/helpers/rows.ts:54` and `:428` — and
  they shield most test files. Sixteen files still hold their own `INSERT INTO repository`; Story 3
  enumerates all of them.

- **The ten pinned counts that move when `repository.landingBranch` leaves the registry**, all of
  them Story 2's:
  `registry.test.ts:49` (70), its stubbed count at `:63-72` (26), its phase-2 count at `:75-90` (28),
  its POST-policy array at `:628-668` (which names the operation at `:654`) and the memory-policy
  count at `:679-684` (29); `coverage.test.ts:445` (26); `parity.test.ts:16` (70) and `:25` (74);
  `openapi.test.ts:115` (70). `coverage.test.ts:416` (38) does **not** move — the operation is
  phase-2.

- **`openapi.test.ts:360-384` drives the `landing-branch` path by name** to prove a stubbed
  operation's default response refs `Error` — one arbitrary exemplar. Story 2 **generalises** it into a
  loop over every `status === "stubbed"` registry entry, rather than deleting the assertion or
  retargeting it at a second exemplar that the next epic would have to retarget again.

- **`src/http/server/repository/list-repository.test.ts:81-88` asserts the landing-branch route
  answers 501 and writes nothing.** With no registry entry there is no route, so Story 2 deletes that
  test. It does not change it to expect 404 — the path is simply not declared.

- **There is no `src/http/contract/repository.test.ts`.** Contract coverage for repository lives in
  `registry.test.ts`, `parity.test.ts`, `coverage.test.ts`, `example.test.ts` and `openapi.test.ts`.
  Neither Story 2 nor Story 3 creates a new contract test file.

- **The field-decisions fixture is regenerated, never hand-edited.** Run
  `node scripts/field-decisions-probe.mjs --write`, then read the diff.
  `src/http/contract/coverage.test.ts:314` asserts `fieldDecisions` equals the freshly walked
  registry.

- **`cloneObjective` reaches no command.** Every call site is
  `src/services/git/clone.ts:9`, `src/services/git/binary.ts:4,31`, `clone.test.ts` and
  `binary.test.ts:175`. Story 4 therefore changes a service interface and its tests only.

- **A clone test learns its checked-out branch through the file-local `workspaceGit` helper** at
  `src/services/git/clone.test.ts:86-92`. It uses `rev-parse --abbrev-ref HEAD` today, at `:159-165`;
  Story 4 replaces that with `symbolic-ref --quiet HEAD`, which compares the exact fully-qualified ref
  and fails loudly on a detached HEAD instead of reporting the literal string `HEAD`. No shared helper
  exists and Story 4 adds none.

- **An objective node id is `objective_<ULID>`**, minted by `UlidIdGenerator.mint("objective")`
  (`src/services/ids/ulid.ts:9-13`). Nothing turns a node id into a git name today.

- **The daemon-backed acceptance path is the loopback fixture of EPIC 005.**
  `createHttpRemote()` / `createSshRemote()` from `test/helpers/remote/index.ts:65-117`.
  `src/services/git/seed.test.ts:373-397` is the template for a registration that asserts the bare
  home's refs.
