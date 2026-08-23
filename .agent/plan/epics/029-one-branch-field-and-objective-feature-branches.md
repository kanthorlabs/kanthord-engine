# EPIC 029 — One branch field, and objective feature branches

Status: **draft**. It sits after EPIC 028 in the sequence, inside phase 1b. It amends
`docs/proposal/phase-1/git-foundation.md`, so it lands before any phase-2 epic that reads a branch
field.

## Goal

A repository is registered with one branch name. Per-objective work lives on its own `feature/*`
branch. The three-field branch model of `git-foundation.md:211-228` collapses to one field and one
naming rule.

The shape the product ships:

| Where              | Ref                            | Who names it                      |
| ------------------ | ------------------------------ | --------------------------------- |
| remote origin      | `refs/heads/<branch>`          | the human, once, at registration  |
| the bare home      | `refs/heads/<branch>`          | derived — the same name           |
| an objective clone | `refs/heads/feature/<node id>` | derived — the objective's node id |

`repository.register` therefore takes `{ name, remoteUrl, credentialId, branch, publishOnApproval,
hostFingerprint }`. `landingBranch` and `publishRef` leave the wire, the database and the domain.

## Non-goals

- **No review-branch publish.** Publishing pushes the bare home branch to the same branch on remote
  origin. Pushing a `feature/*` branch to origin for a human to review is a separate capability, and
  no epic declares it.
- **No change to clone isolation.** An objective still gets its own clone with no configured remote,
  per `git-foundation.md:230-245`. This epic adds a branch inside that clone; it does not change how
  the clone is made or asserted.
- **No change to the force rules.** `refs/heads/*` still never takes a force, and a fetch still
  writes only `refs/remotes/origin/*`. The local branch and the tracking ref remain distinct refs
  that happen to share a name.
- **No rename of the `repository` table.** One migration drops two columns. Nothing else moves.

## Decisions

- **One field, named `branch`.** It is the branch on remote origin that holds the team's work. It is
  the freshness source, the name of the bare home branch, and the publish destination. `upstreamBranch`
  is renamed to `branch` because the name no longer distinguishes it from anything.

- **The bare home branch takes the same name as the remote branch.** Seeding writes
  `refs/heads/<branch>` from `refs/remotes/origin/<branch>`. The seeding sequence of
  `git-foundation.md:30-38` is unchanged except that one name serves both lines.

- **An objective clone works on `feature/<node id>`.** The node id of the objective is a ULID, so the
  name is deterministic, collision-free across projects, and stable across a re-clone. The clone
  checks out `<branch>` and creates the feature branch from it:

  ```
  git clone --no-hardlinks --no-local --branch <branch> <home> <staging>
  git -C <staging> checkout -b feature/<node id>
  ```

  Every existing clone assertion still runs, in the order `git-foundation.md:237-242` states.

- **Integration merges the feature branch into the bare home branch.** `mr@1` reads
  `refs/heads/feature/<node id>` from the objective clone and merges it into `refs/heads/<branch>` of
  the bare home, under the compare-and-swap `phase-2/gates-and-approval.md:28-30` already requires.
  The candidate freeze, the second check against the merge commit, and the recompute rule are
  unchanged.

- **Publish pushes `refs/heads/<branch>` to `refs/heads/<branch>`.** `expected_remote_oid` stays
  advisory freshness, per `git-foundation.md:205`. `git_operation.ref` for a `publish` holds
  `refs/heads/<branch>` instead of a stored `publish_ref`.

- **`repository.landingBranch` leaves the registry.** The operation changed a configurable landing
  branch, and no such value exists after this epic. It moves from `stubbed` to absent, and
  `docs/proposal/api/repository.md:15` drops the row.

- **The repository view keeps reporting resolved refs, derived.** `repositoryView` keeps
  `landingRef`, `trackingRef` and `publishRef` as read-only derived strings, because P1-E4 and P3-E6
  assert the ref layout through this route alone (`api/repository.md:104`). They are computed from
  `branch`, not stored.

- **Migration 0009 drops `landing_branch` and `publish_ref`.** The two columns carry no value the
  `branch` column does not. A row whose `landing_branch` differs from its `upstream_branch` cannot be
  migrated, so the migration refuses and names the repository: the operator picks one branch and
  re-registers. Phase 1b ships no such row, and the refusal is what keeps the migration honest if one
  exists.

- **Six phase-2 epics are amended, and none is implemented.** `108-freshness-and-reconciliation.md`,
  `109-profile-verification.md`, `110-scheduler-leases-and-the-general-worker.md`,
  `112-objective-gate-and-mr.md`, `113-publish.md` and `114-onboarding-cli.md` each name a dropped
  field. Every one is `draft`, so each amendment is a text edit. This is why the epic belongs in phase
  1b and not after phase 2 opens.

## Stories

Author with `/author`. The sequence below is the dependency order; each story is one commit.

1. **The proposal states one branch field.** Rewrite `git-foundation.md:211-228` as one field and the
   `feature/*` rule. Amend the ref-role table at `:19-24` so the local landing row names
   `refs/heads/<branch>`. Amend `api/repository.md:58` and `:15`. Amend
   `phase-2/integration-and-publish.md:56` and `database/repository.md:90`. No code.
2. **`domain/repository.ts` holds one branch field.** Rename `upstreamBranch` to `branch`, delete
   `landingBranch` and `publishRef`, and add the three derived ref renderers. Exact-string unit tests
   pin each rendered ref.
3. **Migration 0009 drops the two columns.** `migration-0009-one-branch.ts`, with the refusal above
   and a test that asserts the refusal names the repository.
4. **The contract takes one branch field.** `repositoryRegisterRequest` drops two fields and renames
   one. `repositoryView` keeps the three derived refs. Regenerate
   `src/http/contract/field-decisions.fixture.ts`. Add the `docs/proposal/api/new-decisions.md` row.
   Remove the `repository.landingBranch` registry entry.
5. **Registration seeds from one name.** `commands/repository/register-repository.ts` and
   `services/git` `seedHome` take one branch name. The write-advertisement preflight pushes at
   `refs/heads/<branch>`.
6. **An objective clone creates its feature branch.** The clone step creates
   `feature/<node id>` and asserts it is checked out. The existing isolation assertions are unchanged
   and still asserted.
7. **The CLI carries one flag.** `--branch` replaces `--upstream`. `--landing` and `--publish-ref`
   are removed. The registration prompt asks one question.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/domain/repository.test.ts \
  src/services/storage/migration-0009-one-branch.test.ts \
  src/services/storage/migration-0001-core-entities.test.ts \
  src/services/storage/sqlite.test.ts \
  src/services/git/seed.test.ts \
  src/services/git/preflight.test.ts \
  src/services/git/clone.test.ts \
  src/services/git/binary.test.ts \
  src/queries/repository/show-repository.test.ts \
  src/queries/repository/list-repository.test.ts \
  src/commands/repository/register-repository.test.ts \
  src/http/contract/registry.test.ts \
  src/http/contract/parity.test.ts \
  src/http/contract/coverage.test.ts \
  src/http/contract/openapi.test.ts \
  src/http/contract/example.test.ts \
  src/http/contract/path.test.ts \
  src/http/contract/event-payload.test.ts \
  src/http/server/repository/register-repository.test.ts \
  src/http/server/repository/list-repository.test.ts \
  src/http/server/repository/show-repository.test.ts \
  src/cli/repository/register.test.ts \
  src/cli/repository/show.test.ts \
  src/cli/confirm.test.ts \
  src/cli/reachability.test.ts \
  src/cli/inventory.test.ts \
  src/main.repository-branch.test.ts \
  && echo "PASS EPIC-029"
```

`npm run contract:publish -- "$(mktemp -d)"` exits 0, and no emitted example names a dropped field.
It is not in the Proof command because it writes outside the repository.

Hermetic coverage required beyond the Proof:

- **`npm run verify` is clean**: `typecheck`, the full `node:test` suite, `eslint .`, and
  `verify-db-status`.
- **A fresh database migrates 0001 through 0009**, and `PRAGMA table_info(repository)` names `branch`
  and names neither `landing_branch` nor `publish_ref`. The column list is asserted by value, not by
  absence alone.
- **The migration refuses a row it cannot migrate, and names it.** A `landing_branch` differing from
  `upstream_branch`, and a `publish_ref` differing from `refs/heads/<upstream_branch>`, are each
  refused. The refusal names one repository, chosen by `ORDER BY name`, so two divergent rows always
  produce the same message. A refusal leaves the schema and the `migration` table untouched and
  leaves no temporary object behind.
- **A registration against the loopback fixture of EPIC 005** seeds a bare home whose only local head
  is `refs/heads/<branch>`, asserted through `repository.show` in one daemon-backed test rather than
  across two unit tests that never meet.
- **The three refs are derived, never stored.** `repositoryView` reports `landingRef`, `trackingRef`
  and `publishRef` rendered from `branch`, asserted by exact string for a branch name that contains a
  slash.
- **An objective clone reports `feature/<node id>` as its checked-out branch**, asserted through
  `git symbolic-ref --quiet HEAD` against the fully-qualified ref, and the object-file link count
  still proves isolation.
- **The registry equals the proposal contract**, and `repository.landingBranch` appears in neither the
  registry, the proposal, nor the path grammar.
- **No test depends on a wall clock, a shared temporary directory, or an ambient git configuration.**
  A test that needs a remote uses the loopback fixture of EPIC 005.

## Open items

- **A readable alias for the feature branch.** `feature/<node id>` is deterministic and unreadable. A
  human reviewing the branch would prefer the objective's slug. Deciding this needs a collision rule
  for two objectives with the same slug, and the epic ships the ULID form until a human decides. It
  is a rename of one derived string.
- **`publishOnApproval` stays on the register body.** It is a publish-time setting and not a branch
  field, so this epic leaves it where it is. Whether registration should carry it at all is a
  separate question.
- **The `AGENTS.md` test-boundary TODO is not a blocker here.** That clause forbids opening another
  **phase-2** epic before it closes. This epic is phase 1b.
