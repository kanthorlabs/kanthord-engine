# Story 1 — The proposal states one branch field

Epic: `.agent/plan/epics/029-one-branch-field-and-objective-feature-branches.md`

Documentation only. No file under `src/`, `test/` or `scripts/` changes.

`docs/proposal/*` is the software-engineer lane (`scripts/lane-check.sh:99-101`). The test-engineer
writes nothing for this story.

**This story does not touch the route table.** `docs/proposal/api/repository.md:15` and the
`## repository.landingBranch` section at `:108-111` belong to Story 2, because
`src/http/contract/parity.test.ts:16` and `:25` pin the proposal row counts against the registry and
both sides must move in one commit.

## Change

### `docs/proposal/phase-1/git-foundation.md`

**Edit 1 — the ref-role table.** Replace lines 21 and 22 in full. They read today:

```
| Local landing       | `refs/heads/<landing>`    | `mr@1`, reconcile, and a safe fast-forward | `fetch`          |
| Publish destination | the remote `<publishRef>` | `publish`, against an expected object id   | —                |
```

Replace those two lines with these three:

```
| Local landing       | `refs/heads/<branch>`         | `mr@1`, reconcile, and a safe fast-forward | `fetch`          |
| Objective work      | `refs/heads/feature/<node id>` | the objective clone, which has no remote  | anything else    |
| Publish destination | the remote `refs/heads/<branch>` | `publish`, against an expected object id | —                |
```

Leave the header at lines 18-19, the remote-observation row at line 20, and the paragraph at line 24
byte-identical.

**Edit 2 — the seeding sequence.** Replace lines 35 and 36 in full. They read today:

```
U=$(git --git-dir=<staging> rev-parse refs/remotes/origin/<upstream>)
git --git-dir=<staging> update-ref refs/heads/<landing> "$U" ''
```

Replace those two lines with:

```
U=$(git --git-dir=<staging> rev-parse refs/remotes/origin/<branch>)
git --git-dir=<staging> update-ref refs/heads/<branch> "$U" ''
```

One name serves both lines. Change no other line inside the fenced block at 30-38.

**Edit 3 — the section that states the model.** Replace lines 211 through 228 in full. They read
today as `## Three branch fields`, one paragraph, two tables, and two closing paragraphs. Replace the
whole run of 18 lines with:

```
## One branch field

A repository declares one, named `branch`. It is the branch on remote origin that holds the team's
work, and one name serves every role that needs one.

| Role                | Ref                              |
| ------------------- | -------------------------------- |
| Freshness source    | `refs/remotes/origin/<branch>`   |
| Local landing       | `refs/heads/<branch>`            |
| Publish destination | remote `refs/heads/<branch>`     |

Three fields existed to express a branch mode that landed agent work on `kanthord/<name>` and left
`upstreamBranch` at `main`. That mode is gone. Per-objective work is isolated by a branch inside the
objective's own clone, which is where isolation belongs, so the bare home needs no second branch to
hold it.

**An objective clone works on `feature/<node id>`.** The node id of the objective is a ULID, so the
name is deterministic, collision-free across projects, and stable across a re-clone. The clone checks
out `<branch>` and creates the feature branch from it. `mr@1` merges that branch into
`refs/heads/<branch>` of the bare home.

Pushing a `feature/*` branch to remote origin for a human to review is a separate capability, and no
phase declares it. The feature branch never leaves the daemon machine.
```

**Edit 4 — the clone sequence.** Replace line 237 in full. It reads today:

```
git clone --no-hardlinks --no-local --branch <landing> <home> <staging>
```

Replace that one line with these two:

```
git clone --no-hardlinks --no-local --branch <branch> <home> <staging>
git -C <staging> checkout -b feature/<node id>
```

Then, immediately after the fenced block's closing line 243, before line 245 (`None of these is a
property of cloning.`), add one paragraph and one blank line on each side:

```
The `checkout -b` is the only step of this sequence that is a property of cloning, and it runs before
the rename for the same reason every other step does: a visible workspace is a finished one, so the
feature branch exists the first time anything can observe the workspace.
```

Change no other line in the file. In particular leave lines 239-242 — the three assertions — and
lines 247-252 byte-identical.

### `docs/proposal/api/repository.md`

**Edit 5.** Replace line 24 in full. It reads today:

```
The confirmation is explicit in an automated run as well. `kanthord repository register --upstream <branch>` supplies it without a prompt, and the CLI refuses to register when neither a prompt nor the flag answered. P1-E1 passes the flag, which is what keeps its `Human action: none` true while the product rule holds.
```

Replace that one line with:

```
The confirmation is explicit in an automated run as well. `kanthord repository register --branch <branch>` supplies it without a prompt, and the CLI refuses to register when neither a prompt nor the flag answered. P1-E1 passes the flag, which is what keeps its `Human action: none` true while the product rule holds.
```

**Edit 6.** Replace line 58 in full. It reads today:

```
The body holds the remote URL, a name, a `credentialId`, the three branch fields of `../phase-1/git-foundation.md` — `upstreamBranch`, `landingBranch` and `publishRef` — and, for an ssh url, the confirmed `hostFingerprint`. A missing branch field is `400`, and a missing `hostFingerprint` on an ssh url is the same `400`. The daemon never infers one here, because `repository.inspect` is where inference happens and the human already answered.
```

Replace that one line with:

```
The body holds the remote URL, a name, a `credentialId`, the one branch field of `../phase-1/git-foundation.md` — `branch` — and, for an ssh url, the confirmed `hostFingerprint`. A missing `branch` is `400`, and a missing `hostFingerprint` on an ssh url is the same `400`. The daemon never infers one here, because `repository.inspect` is where inference happens and the human already answered.
```

**Edit 7.** Replace line 101 in full. It reads today:

```
Returns the branch fields, the landing tip, the upstream tracking tip, the last fetched upstream object id, `publishOnApproval`, the bound credential — its id and its current name — the repository state, and the profile hash when one is bound.
```

Replace that one line with:

```
Returns `branch`, the three refs it renders, the landing tip, the upstream tracking tip, the last fetched upstream object id, `publishOnApproval`, the bound credential — its id and its current name — the repository state, and the profile hash when one is bound.
```

**Edit 8.** Replace line 105 in full. It reads today:

```
P1-E4 and P3-E6 assert the ref layout through this route alone, because the client cannot read the daemon file system. The response therefore names the landing branch and the tracking namespace explicitly, not as a directory listing.
```

Replace that one line with:

```
P1-E4 and P3-E6 assert the ref layout through this route alone, because the client cannot read the daemon file system. The response therefore carries `landingRef`, `trackingRef` and `publishRef` as read-only strings rendered from `branch`, not as a directory listing. They are derived on read and stored nowhere.
```

Change no other line. Leave lines 15, 108, 110 and 111 alone — Story 2 owns them.

### `docs/proposal/phase-2/integration-and-publish.md`

**Edit 9.** Replace lines 55 and 56 in full. They read today:

```
1. Take the repository lock. Assert that `refs/heads/<landing>` equals `landingOid`.
2. Push `<landingOid>` to `<publishRef>`. Never with force, so the server accepts a fast-forward and rejects anything else. `expectedRemoteOid` is advisory freshness rather than a remote compare-and-swap, and a null value means the ref must not exist yet.
```

Replace those two lines with:

```
1. Take the repository lock. Assert that `refs/heads/<branch>` equals `landingOid`.
2. Push `<landingOid>` to the remote `refs/heads/<branch>`. Never with force, so the server accepts a fast-forward and rejects anything else. `expectedRemoteOid` is advisory freshness rather than a remote compare-and-swap, and a null value means the ref must not exist yet.
```

**Edit 10.** Replace line 62 in full. It reads today:

```
Moving to a landing branch other than `main` does not by itself satisfy a branch protection rule, and it leaves work already landed on the old branch. See the branch fields in `../phase-1/git-foundation.md`.
```

Replace that one line with:

```
A branch protection rule on `<branch>` is not satisfied by landing somewhere else, because there is nowhere else to land: one field names both the landing branch and the publish destination. See the branch field in `../phase-1/git-foundation.md`.
```

Also replace line 38 in full. It reads today:

```
A completed objective integrates to the landing branch of the bare home after human confirmation.
```

Replace that one line with:

```
A completed objective integrates from its `feature/<node id>` branch to `refs/heads/<branch>` of the bare home after human confirmation.
```

Change no other line.

### `docs/proposal/database/repository.md`

**Edit 11 — the DDL.** Replace lines 12, 13 and 14 in full. They read today:

```
  upstream_branch       TEXT NOT NULL,                                                -- freshness source, observed at refs/remotes/origin/<this>
  landing_branch        TEXT NOT NULL,                                                -- refs/heads/<this>, where mr@1 accumulates approved work
  publish_ref           TEXT NOT NULL,                                                -- destination ref on remote origin that publish pushes to
```

Replace those three lines with this one:

```
  branch                TEXT NOT NULL,                                                -- the team branch; freshness source, landing branch and publish destination
```

**Edit 12.** Replace line 20 in full. It reads today:

```
  updated_at            INTEGER NOT NULL,                                             -- last branch field or state change
```

Replace that one line with:

```
  updated_at            INTEGER NOT NULL,                                             -- last branch or state change
```

**Edit 13.** Replace line 28 in full. It reads today:

```
The three branch fields are the three of [git-foundation.md](../phase-1/git-foundation.md). `publish_on_approval` lives here, because [../phase-2/integration-and-publish.md](../phase-2/integration-and-publish.md) makes the chaining default configurable per repository.
```

Replace that one line with:

```
`branch` is the one branch field of [git-foundation.md](../phase-1/git-foundation.md). `refs/remotes/origin/<branch>`, `refs/heads/<branch>` and the remote `refs/heads/<branch>` are rendered from it and stored nowhere. `publish_on_approval` lives here, because [../phase-2/integration-and-publish.md](../phase-2/integration-and-publish.md) makes the chaining default configurable per repository.
```

**Edit 14 — deferred to Story 2.** Line 34 states that changing `landing_branch` is an explicit
command. Leave it **byte-identical**. Rewriting it to say the operation is gone would contradict
`api/repository.md:15`, which still lists `repository.landingBranch` as a route until Story 2 deletes
it, and this story must not leave the source of truth self-contradictory even though every test
passes. Story 2 owns that line.

**Edit 15 — the sample row.** Replace lines 76, 77 and 78 in full. They read today:

```
upstream_branch        main
landing_branch         main
publish_ref            refs/heads/main
```

Replace those three lines with this one:

```
branch                 main
```

**Edit 16.** Replace line 90 in full. It reads today:

```
This row is the merge-into-`main` mode: one branch is the freshness source, the landing branch and the publish destination. The branch mode instead sets `landing_branch` to `kanthord/<name>` and leaves `upstream_branch` at `main`.
```

Replace that one line with:

```
One branch is the freshness source, the landing branch and the publish destination. This row therefore renders `refs/remotes/origin/main`, `refs/heads/main` and a remote `refs/heads/main`.
```

Change no other line in the file.

### `docs/proposal/phase-1/README.md`

**Edit 17.** Replace line 71 in full. It reads today:

```
  - `kanthord repository register --url <fixture-remote> --credential <name> --upstream <branch>` exits zero, and `kanthord repository show` reports one landing branch at the fixture default and one tracking namespace.
```

Replace that one line with:

```
  - `kanthord repository register --url <fixture-remote> --credential <name> --branch <branch>` exits zero, and `kanthord repository show` reports one landing branch at the fixture default and one tracking namespace.
```

The command-scanning regex at `src/cli/inventory.test.ts:193` captures command words and discards a
trailing flag, so this edit changes no captured command and `inventory.test.ts` stays green. Change
no other line in the file.

### Formatting

`lint-staged` runs `prettier --write` over `*.md`, and Edits 1, 3 and 11 change table and DDL column
widths. Run it so the committed bytes are stable:

```bash
npx prettier --write \
  docs/proposal/phase-1/git-foundation.md \
  docs/proposal/phase-1/README.md \
  docs/proposal/api/repository.md \
  docs/proposal/phase-2/integration-and-publish.md \
  docs/proposal/database/repository.md
```

## Constraints

- **Touch no route table.** `docs/proposal/api/repository.md:9-16` stays byte-identical. Story 2
  deletes the `repository.landingBranch` row, together with the registry entry and the pinned counts,
  because `src/http/contract/parity.test.ts:16` and `:25` compare the two sides in one run.
- **Amend no epic file.** `scripts/lane-check.sh:36` denies `.agent/plan/*` to every lane. The six
  phase-2 epics that name a dropped field are a human edit.
- Say nothing about a readable alias for the feature branch. The EPIC ships the ULID form and names
  the alias an open item.
- Say nothing about pushing a `feature/*` branch to origin. That capability is a declared non-goal.
- Do not change the force rules or the clone-isolation assertions in prose.
  `git-foundation.md:239-242` and `:247-252` stay byte-identical.
- `publishOnApproval` stays on the register body. Do not describe it as a branch field.
- Amend no other proposal file. The remaining `docs/proposal/**` hits for "landing branch" are prose
  about the landing branch as a concept, which stays true, and they are out of scope:
  `open-items.md:13`, `database/check_result.md:56`, `database/git_operation.md:31`,
  `phase-2/README.md:40,41,60,77,97,98`, `phase-3/README.md:40,55,71,73`,
  `phase-2/gates-and-approval.md:28,30`, `phase-3/recovery.md:98,108`,
  `phase-1/README.md:48,53,108`, `phase-1/state-machine.md:120`, `api/integration.md:43`,
  `api/README.md:143`, `api/repository.md:64,66,70,72,114`.

## Verify

```bash
node --test src/http/contract/parity.test.ts src/cli/inventory.test.ts
```

- `parity.test.ts` passes unchanged. Its row count at line 25 still reads `74` and its routed/stubbed
  count at line 16 still reads `70`, because this story deletes no route row.
- `inventory.test.ts` passes unchanged. Both P1-E1 scans at `:191` and `:223` still yield the same
  eight commands.
- `git diff --stat docs/` names exactly five files: `docs/proposal/phase-1/git-foundation.md`,
  `docs/proposal/phase-1/README.md`, `docs/proposal/api/repository.md`,
  `docs/proposal/phase-2/integration-and-publish.md`, `docs/proposal/database/repository.md`.
- `git diff docs/proposal/api/repository.md` touches no line between 9 and 16, and no line among
  108, 110 and 111.
- These four commands each report `0`:

```bash
grep -c "upstreamBranch\|landingBranch" docs/proposal/phase-1/git-foundation.md
grep -c "Three branch fields\|three branch fields" docs/proposal/phase-1/git-foundation.md
grep -c "upstream_branch\|landing_branch\|publish_ref" docs/proposal/database/repository.md
grep -c "\-\-upstream" docs/proposal/api/repository.md docs/proposal/phase-1/README.md
```

- `grep -c "feature/<node id>" docs/proposal/phase-1/git-foundation.md` reports `3` — the ref-role
  table row, the branch section, and the clone sequence.

`npm run verify` exits 0.

Proof: no line of the EPIC's `## Verification gate` is attributable to this story — the gate names no
documentation test. The epic is complete only when this story has landed, because `AGENTS.md` names
`docs/proposal/` the source of truth for behaviour and the EPIC's own Goal is stated there.
