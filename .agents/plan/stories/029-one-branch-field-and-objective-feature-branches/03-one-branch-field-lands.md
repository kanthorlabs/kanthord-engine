# Story 3 — One branch field lands

Epic: `.agents/plan/epics/029-one-branch-field-and-objective-feature-branches.md`
Depends on: Story 1, Story 2.

One commit. `branch` replaces `upstreamBranch`, `landingBranch` and `publishRef` in the domain, the
database, the contract, the command, the git service, the handler and the CLI.

This story merges EPIC story bullets 2, 3, 4, 5 and 7. The `repository.landingBranch` operation, its
proposal row and its path segment are Story 2. `index.md` states why the rename itself is atomic.

## Change

### 1. `src/domain/repository.ts` — one field and the ref renderers

In `repositoryRow`, replace line 17 with `branch: z.string(),` and delete lines 18 and 19
(`landingBranch` and `publishRef`). The `.refine` at 27-35 is untouched.

In `RepositoryView`, replace line 43 with `branch: string;` and delete line 44 (`landingBranch`).
**Keep lines 45, 46 and 47** — `landingRef`, `trackingRef` and `publishRef` — they are the derived
read-only strings the view still reports.

Append one implementation and three names at the end of the file, in this order:

```ts
export function headRefOf(branch: string): string {
  return `refs/heads/${branch}`;
}

export function trackingRefOf(branch: string): string {
  return `refs/remotes/origin/${branch}`;
}

export const landingRefOf = headRefOf;
export const publishRefOf = headRefOf;
```

`landingRefOf` and `publishRefOf` are two **names for one implementation**, not two
implementations. Their equality is the defining invariant of this EPIC — one field names the landing
branch and the publish destination — so it must be true by construction rather than by two function
bodies that happen to agree. Two bodies would readmit exactly the drift this EPIC removes. The two
names survive because a call site reads better for saying which question it is asking, and
`git_operation.intent` is what records the difference in the journal.

The file imports nothing new. `domain/` purity holds: these are string functions over one argument.

### 2. `src/services/storage/migration.ts` and `src/services/storage/sqlite.ts`

**No change to either file.** The refusal is expressible in pure SQL, so the `Migration` type keeps
its four members and the runner keeps its statement loop. See section 3 for the evidence.

### 3. `src/services/storage/migration-0009-one-branch.ts` — new file

The refusal is a temporary trigger whose `RAISE(ABORT, ...)` message is an expression. This was
verified against the runtime, not reasoned about:

```
node v24.17.0, sqlite 3.53.0
RAISE(ABORT, 'the repository ' || NEW.name || ' diverges')  ->  "the repository alpha diverges"
```

`RAISE` accepted a literal-only message before SQLite 3.47. This repository runs 3.53, where an
expression is legal, so no JavaScript hook is needed and `Migration` stays declarative SQL.

```ts
import type { Migration } from "./migration.ts";

export const migration0009OneBranch: Migration = {
  version: 9,
  name: "0009-one-branch",
  statements: [
    "CREATE TEMP TABLE migration_0009_guard (name TEXT NOT NULL)",
    `CREATE TEMP TRIGGER migration_0009_refuse BEFORE INSERT ON migration_0009_guard BEGIN
  SELECT RAISE(ABORT, 'the repository ' || NEW.name || ' cannot be migrated to one branch field; pick one branch and register the repository again');
END`,
    `INSERT INTO migration_0009_guard (name)
  SELECT name FROM repository
  WHERE landing_branch <> upstream_branch
     OR publish_ref <> 'refs/heads/' || upstream_branch
  ORDER BY name LIMIT 1`,
    "DROP TRIGGER migration_0009_refuse",
    "DROP TABLE migration_0009_guard",
    "ALTER TABLE repository RENAME COLUMN upstream_branch TO branch",
    "ALTER TABLE repository DROP COLUMN landing_branch",
    "ALTER TABLE repository DROP COLUMN publish_ref",
  ],
};
```

Four properties of this statement list are load-bearing:

- **The refusal covers both dropped columns.** `landing_branch <> upstream_branch` is not enough. A
  row with `upstream_branch` of `main`, `landing_branch` of `main` and `publish_ref` of
  `refs/heads/release` carries a publish destination that `refs/heads/<branch>` does not reproduce,
  and migrating it would silently retarget publishing. The `OR` clause refuses it. Without that
  clause the EPIC's claim that the two columns carry no value `branch` does not carry is false.
- **`ORDER BY name LIMIT 1` makes the refusal deterministic.** Two divergent rows always name the
  same repository, chosen by SQLite's default `BINARY` collation on `name`. Verified: rows inserted
  as `zulu` then `alpha` name `alpha`.
- **The temp objects are dropped on the success path and rolled back on the refusal path.** Verified:
  after a refusal, `SELECT count(*) FROM temp.sqlite_master WHERE name LIKE 'migration_0009%'` is
  `0` and `pragma_table_info('repository')` still names all three original columns. A leftover
  trigger would poison every later migration on the same connection.
- **The abort propagates as a thrown error** from `transaction.run`, so the existing catch at
  `sqlite.ts:90-97` wraps it as
  `migration 9 0009-one-branch failed: <the RAISE message>`. That is what carries the repository name
  to the operator, and the rollback is what leaves the database untouched.

**Do not set `rebuild: true`.** Not because a rebuild would break the `ALTER`s — it would not; both
were verified to succeed under `PRAGMA legacy_alter_table` ON _and_ OFF, on a STRICT table with two
`CHECK` clauses and an inbound foreign key, with the referencing value intact. Omit it because no
rebuild is _needed_: neither dropped column appears in the table's `CHECK` clause
(`migration-0001-core-entities.ts:52-56`) or in any index, so three native statements do the whole
job and the rename-copy-drop dance of migrations 0006 and 0007 would be pure ceremony.

### 4. `src/services/storage/migrations.ts` — register it

Add the import after line 9:

```ts
import { migration0009OneBranch } from "./migration-0009-one-branch.ts";
```

Add the const after `migration0008GraphIndexes` at line 19:

```ts
  migration0009OneBranch,
```

**Do not edit `migration-0001-core-entities.ts`.** A shipped migration is never rewritten. Migration
0001 keeps `upstream_branch`, `landing_branch` and `publish_ref`, and 0009 alters them.

### 5. `src/queries/repository/show-repository.ts`

- Row type: replace lines 19-21 with the single member `branch: string;`.
- `SHOW_REPOSITORY_SQL`: replace `r.upstream_branch, r.landing_branch, r.publish_ref,` at line 31
  with `r.branch,`.
- Replace lines 54 and 55 with calls to the renderers, and add the third:

```ts
const landingRef = landingRefOf(row.branch);
const trackingRef = trackingRefOf(row.branch);
const publishRef = publishRefOf(row.branch);
```

- In the returned object: replace lines 69-70 with `branch: row.branch,` and replace line 73 with
  `publishRef,`.
- Add `landingRefOf`, `publishRefOf` and `trackingRefOf` to the existing
  `../../domain/repository.ts` import.

### 6. `src/queries/repository/list-repository.ts`

The identical edit at its own lines: row type 17-19, the `COLUMNS` list at 29, the derivations at
46-47, and the returned object at 61-62 and 65.

### 7. `src/services/git/index.ts`

In `SeedHomeInput` at lines 35-41, replace lines 38 and 39 with `branch: string;`.

### 8. `src/services/git/seed.ts`

- `SeedHomeExtended` at 44-51: delete `publishRef: string;` at line 46. The publish ref is rendered
  from `branch`, so no caller supplies it.
- Line 105: `` `--initial-branch=${input.branch}`, ``
- Line 140: `ref: trackingRefOf(input.branch),`
- Line 145: `` `the branch ${input.branch} does not exist on the remote`, ``
- Line 153: `publishRef: publishRefOf(input.branch),`
- Line 160: `` `the credential may not push to ${publishRefOf(input.branch)}`, ``
- Line 167: `ref: landingRefOf(input.branch),`
- Line 175: `` `${landingRefOf(input.branch)} already exists in the new home`, ``
- Import the three renderers from `../../domain/repository.ts`. A service implementation may import
  `domain/`.

**`src/services/git/preflight.ts` is untouched.** `CanPushInput.publishRef` stays a fully-qualified
ref string that the caller renders, so `preflight.ts:16` and `:42` and every test in
`preflight.test.ts` stay byte-identical.

### 9. `src/commands/repository/register-repository.ts`

- `RegisterRepositoryInput` at 31-41: replace lines 35-37 with `branch: string;`.
- `seedHome` call at 225-234: replace lines 228, 229 and 231 with the single member
  `branch: input.branch,`.
- The `credentialRejected` event payload at 247-252: replace line 250 with
  `publishRef: publishRefOf(input.branch),`. The payload key stays `publishRef` — it names a ref,
  and the value is now rendered.
- `resolveRef` at 258-261: replace line 260 with `ref: landingRefOf(input.branch),`.
- The `INSERT INTO repository` at line 279: replace
  `upstream_branch, landing_branch, publish_ref` with `branch`, and drop two placeholders so the
  statement carries twelve `?` instead of fourteen. Replace the three bound parameters at 285-287
  with the single `input.branch,`.
- The `git_operation` insert at line 306: `landingRefOf(input.branch),`.
- The `repository.registered` payload at 318-334: replace lines 326-328 with
  `branch: input.branch,`.
- Import the two renderers from `../../domain/repository.ts`.

### 10. `src/http/contract/repository.ts`

- `repositoryRegisterRequest` at 60-76: replace lines 64-69 with `branch: branchName,`. `branchName`
  at 41-52 is unchanged and now validates the one field. The `publishRef` regex leaves the file with
  the field.
- `repositoryView` at 78-96: replace lines 83-84 with `branch: z.string(),`. **Keep** `landingRef`,
  `trackingRef` and `publishRef` at 85-87.
- `repositoryView_example` at 125-143: replace lines 130-131 with `branch: "main",`, replace line 132
  with `landingRef: "refs/heads/main",`, and replace line 133 with
  `trackingRef: "refs/remotes/origin/main",`. Line 134 stays `publishRef: "refs/heads/main",`.

  Line 133 is wrong today — it reads `refs/kanthord/upstream/main` while both handlers build
  `refs/remotes/origin/${upstream_branch}`. Once `trackingRefOf` is the single definition the example
  must equal what it renders. This is pre-existing drift, not a defect of any epic.

- `repositoryRegisterExamples.request` at 146-155: replace lines 150-152 with `branch: "main",`.

Story 2 already removed the `repository.landingBranch` operation entry, so the `operations([...])`
array needs no edit here.

### 11. `src/http/contract/event-payload.ts`

- `"repository.register.credentialRejected"` at 251-256: no change. Its `publishRef` at line 254 is a
  rendered ref string.
- `"repository.registered"` at 257-266: replace lines 259-261 with `branch: z.string(),`.

### 12. `src/http/server/repository/register-repository.ts`

Replace lines 32-34 with `branch: parsed.data.branch,`.

### 13. `src/cli/repository/register.ts`

- `RegisterOptions` at 24-33: delete `landing?: string;` at 29 and `publishRef?: string;` at 30, and
  rename `upstream?: string;` at 28 to `branch?: string;`.
- Options at 41-48: replace lines 44, 45 and 46 with one line:

```ts
    .option("--branch <branch>", "the branch on remote origin")
```

- The confirmation at 97-112: rename the local `upstream` to `branch`, set `flagName: "--branch"` at
  line 100, `flagValue: options.branch` at 101, and `question: "branch?"` at 102. `suggestion` stays
  `inspect.defaultBranch`.
- Delete lines 148 and 149 in full — the `landing` and `publishRef` defaults.
- The register call at 151-160: replace lines 155-157 with `branch,`.
- The output at 171-176: replace line 171 with
  ``input.stdout(`kanthord: branch ${view.branch}\n`);``. Lines 172-176 are unchanged — they print
  the three derived refs, which is the behaviour P1-E4 asserts.

### 14. `src/cli/repository/show.ts`

Replace line 38 with ``input.stdout(`kanthord: branch ${view.branch}\n`);``. Lines 39-43 are
unchanged.

### 15. `src/http/contract/field-decisions.fixture.ts`

Regenerate, never hand-edit:

```bash
node scripts/field-decisions-probe.mjs --write
```

The diff must touch only `repository.*` rows: the `landingBranch`, `publishRef` and `upstreamBranch`
rows at 572, 577, 583, 586, 589, 591, 599, 604, 610, 618, 623 and 629 are replaced by one `branch`
row per schema, and the `landingRef`/`trackingRef`/`publishRef` view rows stay. `b` sorts before `c`,
so each new `branch` row lands **before** the `credential` row of its schema. If any non-`repository`
row moves, stop — something else changed.

## Constraints

- **Never edit a shipped migration.** `migration-0001-core-entities.ts` keeps all three columns.
- **Do not change the `Migration` type and do not touch `sqlite.ts`.** The refusal is SQL. Adding a
  callback hook, a `down`, or a precondition list to the migration abstraction is out of scope and was
  considered and rejected: it turns declarative SQL into arbitrary behaviour for no gain.
- **The refusal covers `publish_ref` as well as `landing_branch`.** Do not narrow the `WHERE` clause
  to one column.
- **`domain/` stays pure.** The renderers import nothing.
- **Do not rename `CanPushInput.publishRef`** or touch `src/services/git/preflight.ts`.
- **The `repository.register.credentialRejected` payload keeps its `publishRef` key.** Only the
  `repository.registered` payload changes shape.
- **`publishOnApproval` and `hostFingerprint` stay on the register body**, unchanged.
- **Add no `z.enum(...)`.** `coverage.test.ts:145-215` requires every enum argument to be an
  identifier imported from `domain/`.
- **Add no operation and change no other operation's lifecycle.** `repository.reconcile` stays
  `stubbed`.
- `credentialFailures` and `repositoryStates` in `src/domain/repository.ts` are untouched.

## Verify

### The migration

New file `src/services/storage/migration-0009-one-branch.test.ts`, modelled on
`src/services/storage/migration-0008-graph-indexes.test.ts`, using `createTemporaryDatabase` from
`test/helpers/database.ts`. It asserts:

- `migrations` deep-equals `[coreEntities, graphAndPlan, executionAndJournal,
migration0004EventIndexes, migration0005Actor, migration0006RevisionOrigin,
migration0007ExternalExecution, migration0008GraphIndexes, migration0009OneBranch]` — nine
  entries, `migration0009OneBranch` last.
- A database migrated through the full chain reports
  `status().applied.map((m) => m.version)` deep-equal to `[1,2,3,4,5,6,7,8,9]` and
  `status().pending` empty.
- After the full chain, `PRAGMA table_info(repository)` yields column names deep-equal to
  `["id","name","remote_url","credential_id","home_path","branch","publish_on_approval","state","diverged_landing_oid","diverged_upstream_oid","fetched_upstream_oid","updated_at"]`
  — `branch` sits where `upstream_branch` sat, and neither `landing_branch` nor `publish_ref` is
  present.
- **A divergent `landing_branch` is refused, and the refusal names the repository.** Build a storage
  through migration 0008 only, insert two rows whose `landing_branch` differs from `upstream_branch`
  — names `"zulu"` then `"alpha"`, in that insertion order — then apply the full chain and assert:
  - it throws a `StorageError` with code `storage-migration-failed`;
  - the message contains `migration 9 0009-one-branch failed:`;
  - the message contains
    `the repository alpha cannot be migrated to one branch field` — **`alpha`, not `zulu`**, which is
    what pins `ORDER BY name`;
  - `status().applied.map((m) => m.version)` still deep-equals `[1,2,3,4,5,6,7,8]`, and
    `PRAGMA table_info(repository)` still names `landing_branch` and `publish_ref`. The refusal
    changed nothing.
- **A divergent `publish_ref` is refused too.** One row with `upstream_branch` and `landing_branch`
  both `"main"` and `publish_ref` of `"refs/heads/release"` is refused by name. This is the case that
  proves the two dropped columns carry no value `branch` does not carry; without it the migration
  would silently retarget publishing from `refs/heads/release` to `refs/heads/main`.
- **A refusal leaves no temporary object behind.** After the refusal,
  `SELECT count(*) FROM temp.sqlite_master WHERE name LIKE 'migration_0009%'` is `0`. A leftover
  trigger would poison every later migration on the same connection, and the rollback is what removes
  it.
- **A clean row migrates, and its dependent rows survive.** Seed one repository whose three columns
  agree — `"main"`, `"main"`, `"refs/heads/main"` — **plus at least one `node` row and one
  `project_repository` row that reference it by foreign key**. After the chain, `branch` equals
  `"main"` and every referencing row still names the same repository id. Native `DROP COLUMN` rewrites
  the table internally, so relationship preservation is asserted rather than assumed.
- Re-applying the full chain to an already-migrated database is a no-op: `status().pending` is empty,
  and the guard statements do not run a second time, so the absent `landing_branch` column cannot
  raise a syntax error.
- `migration0009OneBranch.rebuild` is `undefined`, asserted by value. Both `ALTER`s were verified to
  work under `legacy_alter_table` either way, so this assertion pins the _intent_ — no rebuild is
  needed here — rather than guarding against a failure.

### The domain

In `src/domain/repository.test.ts`:

- Replace the three fixture lines 16-18 of `validRow` with `branch: "main",`.
- Add exact-string tests for each renderer:
  - `headRefOf("main")` equals `"refs/heads/main"`.
  - `headRefOf("kanthord/landing")` equals `"refs/heads/kanthord/landing"`.
  - `trackingRefOf("main")` equals `"refs/remotes/origin/main"`.
  - `trackingRefOf("kanthord/landing")` equals `"refs/remotes/origin/kanthord/landing"`.
  - `assert.equal(landingRefOf, publishRefOf)` and `assert.equal(landingRefOf, headRefOf)` — identity
    of the function references, not of one rendered value. This is the assertion that makes the
    one-branch invariant true by construction: it cannot pass if someone later gives either name its
    own body.
- `repositoryRow` is `z.object` (`src/domain/repository.ts:10-11`), which **strips** an unknown key
  rather than throwing, so assert the key list and not a throw:
  `assert.deepEqual(Object.keys(repositoryRow.parse({ ...validRow, landingBranch: "main", publishRef: "refs/heads/main" })).sort(), Object.keys(repositoryRow.parse(validRow)).sort())`
  — the two dropped names survive neither parse.
- The "rejects missing required keys" loop at 35-45 needs no edit; it walks
  `Object.keys(validRow)` and now covers `branch`.

### The contract

Story 2 moved every pinned registry, parity, coverage and openapi count. This story changes no count
— it changes schema shape only, so the counts it inherits must still hold.

- `src/http/contract/registry.test.ts`: no edit. `:112-181`, the with-request and with-response
  arrays, still name `repository.register` and the three read operations, and this story changes no
  operation's schema presence. Confirm it passes.
- `src/http/contract/parity.test.ts`: no edit. This story touches no route table. Confirm it passes.
- `src/http/contract/openapi.test.ts`: no count edit. The schema-component list at `:338-350` is
  byte-identical, because renaming a property inside `repository.register.request` does not rename the
  component. Confirm it passes.
- `src/http/contract/example.test.ts`: no edit. Confirm the register example and the view example
  still parse against their renamed schemas.
- `src/http/contract/coverage.test.ts`: no count edit. `:314` compares `fieldDecisions` against the
  freshly walked registry, so it passes only after the fixture is regenerated in section 15.
- `src/http/contract/event-payload.test.ts`: update the `repository.registered` fixtures and
  assertions at `:275`, `:282-284`, `:517` and `:525` to the one `branch` key.

### The handler

- `src/http/server/repository/register-repository.test.ts`: update the fixture at `:17-18,21` and
  `:40-41,44` and the `validBody` at `:59-61` to one `branch`. Then rewrite the four negative tests:
  - `:157-164` becomes `a branch escaping the tree answers 400`, sending `branch: "../etc"`.
  - `:166-173` becomes `a branch with a leading dash answers 400`, sending `branch: "-x"`.
  - `:175-182` becomes `a branch ending in .lock answers 400`, sending `branch: "main.lock"`.
  - `:184-191` is **deleted**. `publishRef` is no longer a request field, so "not fully qualified" has
    nothing to refuse. Add in its place a test that an unknown key is refused:
    `{ ...validBody, publishRef: "refs/heads/main" }` answers `400 invalid-request`, because
    `repositoryRegisterRequest` is `z.strictObject`. That is the assertion which proves the field left
    the wire.
- `src/http/server/repository/list-repository.test.ts`: update the view fixture at `:18-19,22`. The
  501 test that named the landing-branch route was deleted by Story 2.
- `src/http/server/repository/show-repository.test.ts`: update the view fixture at `:17-18,21`.

### The command and the git service

- `src/commands/repository/register-repository.test.ts`: `RecordedSeed` at `:56-65`,
  `RepositoryRowReadback` at `:67-82`, `MockView` at `:114-132`, `baseInput` at `:159-169`, the
  `seedHome` recorder at `:255-288`, and `readRepository` at `:362-372` all collapse to one `branch`.
  Then:
  - `:510-512` becomes one assertion, `assert.equal(row.branch, "main")`.
  - `:530` stays `assert.equal(gitOp.ref, "refs/heads/main")` — now a rendered value.
  - `:551-559` — the `repository.registered` payload — becomes `branch: "main"` in place of the three
    keys.
  - `:564-573` — the recorded seed — asserts `seed.branch` equals `"main"` and that
    `"publishRef" in seed` is `false`, which is what proves `SeedHomeExtended` lost the field.
  - `:946-958` — the `credentialRejected` payload — is unchanged. Its sorted key list stays
    `["credentialId", "failure", "name", "publishRef"]` and `publishRef` stays `"refs/heads/main"`,
    now rendered from `branch`.
- `src/services/git/seed.test.ts`:
  - `seedInput` at `:115-141`: the overrides type and the defaults collapse to one `branch`, default
    `"main"`. Delete the `publishRef` override and default at `:122` and `:133`.
  - `:194` — `const publishRef = "refs/heads/kanthord/preflight";` — becomes
    `const publishRef = "refs/heads/main";`, and the recorded refspec assertion at `:252` follows it.
    The preflight now pushes at the rendered publish ref, so the fixture value is no longer free.
  - **Delete the test at `:404-434`**, `a branch mode writes one landing branch under another name`.
    The branch mode is gone with the field, and the test cannot be restated: it asserted that
    `refs/heads/main` does _not_ exist while `refs/heads/kanthord/main` does, which one field cannot
    express.
  - Add in its place `a non-default branch names both the tracking ref and the only local head`:
    seed with `branch: "kanthord/main"` against a fixture whose remote carries that branch, and
    assert `forEachRef(runner, gitDir, "refs/heads")` deep-equals `["refs/heads/kanthord/main"]` and
    `forEachRef(runner, gitDir, "refs/remotes/origin")` includes
    `"refs/remotes/origin/kanthord/main"`. If the loopback fixture serves only `main`, seed with
    `branch: "main"` and assert both refs from the one name instead — do not invent a second fixture
    branch.
  - `:526` — `upstreamBranch: "does-not-exist"` — becomes `branch: "does-not-exist"`. The assertion at
    `:531-535` that the message names the branch is unchanged.
  - `:390-391` and `:692-693` — `assert.deepEqual(heads, ["refs/heads/main"])` — are unchanged and are
    the EPIC gate's "only local head" check.
- `src/services/git/binary.test.ts:209`: `publishRef: "refs/heads/main",` leaves the `seedHome`
  input.

### The queries

- `src/queries/repository/show-repository.test.ts`: the expected key list at `:20-31` drops
  `"landingBranch"` and `"upstreamBranch"` and gains `"branch"` in bytewise position; `:138-139`
  becomes `assert.equal(view.branch, "main")`; `:142` stays
  `assert.equal(view.publishRef, "refs/heads/main")` and is now a derived value. The `UPDATE` at
  `:165` becomes `"UPDATE repository SET branch = ? WHERE id = ?"` with one bound value.
- Add to the same file: a view whose `branch` is `"kanthord/landing"` reports
  `landingRef` `"refs/heads/kanthord/landing"`, `trackingRef`
  `"refs/remotes/origin/kanthord/landing"` and `publishRef` `"refs/heads/kanthord/landing"`. This is
  the test that pins the three derived strings through the route the EPIC gate names.
- `src/queries/repository/list-repository.test.ts`: the `INSERT` at `:99` collapses to one column.

### The CLI

- `src/cli/repository/register.test.ts`: replace every `"--upstream"` argv literal at `:157, 195,
219, 253, 320, 344, 391, 462, 485, 510, 530, 551, 585, 615, 648` with `"--branch"`; delete the
  `"--publish-ref"` argv pairs at `:159` and `:275`; update the fixture at `:41-45` and the body
  assertion at `:175-177` to one `branch`; `:259` and `:441` read
  `(registerCall(h)?.body as { branch: string }).branch`.
  - `:235` becomes `it("--branch wins over the prompt")`.
  - `:264` becomes `it("no --branch and no terminal refuses and names the flag without calling
register")`, and `:282` expects
    `"kanthord: confirmation-required: --branch is required when there is no terminal to confirm
on\n"`.
  - **Delete the tests at `:451-473` and `:474-497`** — `--landing` defaults to the confirmed
    upstream, and an explicit `--landing` overrides only the landing. Both flags are gone.
  - Add `the register body carries branch and neither landingBranch nor publishRef`: assert
    `Object.keys(registerCall(h)!.body as object).sort()` deep-equals
    `["branch", "credentialId", "hostFingerprint", "name", "publishOnApproval", "remoteUrl"]`.
  - `:404` — `the prompt suggests the inspected default branch` — is unchanged in meaning; the
    recorded question becomes `"branch? [trunk]"`.
- `src/cli/confirm.test.ts`: replace `flagName: "--upstream"` at `:21, 40, 91, 130, 150, 165`, the
  assertion at `:48`, and `question: "upstream branch?"` at `:23, 42, 93, 132, 152, 167` with
  `"--branch"` and `"branch?"`. `:98` becomes `assert.equal(questions[0], "branch? [trunk]")`.
- `src/cli/repository/show.test.ts`: the fixture at `:14-15,18` collapses to one `branch`.
- `src/cli/project/repository.test.ts`: the fixture at `:26-27,30` collapses to one `branch`.
- `src/cli/reachability.test.ts`: the fixture at `:60-61,64` collapses to one `branch`, and
  `"--upstream"` at `:502` becomes `"--branch"`.

### The row fixtures

Every `INSERT INTO repository` outside migration 0001's own test runs against the full chain, so each
drops two columns and two bound values. The complete list:

- `test/helpers/rows.ts:54` and `:428` — the two shared fixtures, which shield most files.
- `test/helpers/recovery.ts` and `test/helpers/recovery-home.ts` — one each.
- `src/commands/provider/remove-provider.test.ts:127` and `:175`.
- `src/commands/node/update-node.test.ts:297` and `:780`.
- `src/commands/node/create-node.test.ts:476`.
- `src/commands/plan/import-plan.test.ts:535`.
- `src/commands/project/replace-project-repositories.test.ts:92`.
- `src/commands/startup/recover-expired-leases.test.ts:176`.
- `src/http/server/project/replace-project-repositories.test.ts:98`.
- `src/queries/system/read-status.test.ts:129`.
- `src/services/plan/sqlite.test.ts:1946`.
- `src/services/git/journal.test.ts:48`.
- `src/main.claim.test.ts:197`.
- `src/main.test.ts:113-115` — a `RepositoryView` fixture, not an insert; collapse to one `branch`.

**`src/services/storage/migration-0001-core-entities.test.ts` stays byte-identical.** It builds with
`migrations: [coreEntities]` at `:49`, so its `repositoryColumns` constant at `:27-28` and its insert
at `:92` describe migration 0001's own table and must keep all three columns.

### The composed acceptance path

The EPIC gate asks for _a registration against the loopback fixture of EPIC 005 that seeds a bare home
whose only local head is `refs/heads/<branch>`, asserted through `repository.show`._ The seed-service
test and the query test each prove one half against a fake, and neither proves the composed path. Add
one daemon-backed test, `src/main.repository-branch.test.ts`, modelled on
`src/main.capability.test.ts`:

- `createTemporaryHome()`, `home.writeConfig({ http: { port, allowedHosts } })`,
  `runCli(["db","migrate","--home", home.path])`, `launchDaemon({ configPath })`, `daemon.ready()`,
  torn down with `daemon.kill("SIGTERM")` and `await daemon.exited()`.
- `createHttpRemote()` supplies the remote and the `writer` credential.
- Register a credential, then `POST /v1/repository` with a body carrying `branch` and no
  `landingBranch` and no `publishRef`.
- `GET /v1/repository/:id` and assert by value: `branch` equals the fixture branch; `landingRef`
  equals `refs/heads/<branch>`; `trackingRef` equals `refs/remotes/origin/<branch>`; `publishRef`
  equals `refs/heads/<branch>`; and the response carries no `upstreamBranch` and no `landingBranch`
  key.
- Open the seeded bare home directly with `git --git-dir=<home>/repos/<name>.git for-each-ref
refs/heads` and assert the result deep-equals `["refs/heads/<branch>"]` — the "only local head"
  clause, proved against the real seed rather than a fake.

This is the test that closes the third gate check. Without it the gate is asserted by two unit tests
that never meet.

### Commands

```bash
node --test \
  src/main.repository-branch.test.ts \
  src/domain/repository.test.ts \
  src/services/storage/migration-0009-one-branch.test.ts \
  src/services/storage/migration-0001-core-entities.test.ts \
  src/services/storage/sqlite.test.ts \
  src/services/git/seed.test.ts \
  src/services/git/preflight.test.ts \
  src/queries/repository/show-repository.test.ts \
  src/queries/repository/list-repository.test.ts \
  src/commands/repository/register-repository.test.ts \
  src/http/contract/registry.test.ts \
  src/http/contract/parity.test.ts \
  src/http/contract/coverage.test.ts \
  src/http/contract/openapi.test.ts \
  src/http/contract/example.test.ts \
  src/http/contract/event-payload.test.ts \
  src/http/server/repository/register-repository.test.ts \
  src/http/server/repository/list-repository.test.ts \
  src/cli/repository/register.test.ts \
  src/cli/confirm.test.ts \
  src/cli/reachability.test.ts \
  src/cli/inventory.test.ts
```

Then, as the EPIC gate's own two commands:

```bash
npm run verify
npm run contract:publish -- "$(mktemp -d)"
```

And these two commands each report `0`:

```bash
# no camel-case survivor anywhere
grep -rl "upstreamBranch\|landingBranch" src test | wc -l

# no snake-case survivor, except the four files that legitimately name the old columns:
# migration 0001 and its test declare them, and migration 0009 and its test migrate them
grep -rl "upstream_branch\|landing_branch\|publish_ref" src test \
  | grep -v "migration-0001-core-entities" \
  | grep -v "migration-0009-one-branch" | wc -l
```

The second exclusion list is load-bearing: `migration-0009-one-branch.ts` and its test **must**
contain all three old column names, because migrating them is what they do. A grep that demanded zero
occurrences repo-wide could never pass.

Proof — the EPIC's `## Verification gate`, four of its six checks:

- `npm run verify` is clean.
- A fresh database migrates 0001 through 0009 and `repository` holds no `landing_branch` and no
  `publish_ref` — the `PRAGMA table_info` assertion above.
- A registration against the loopback fixture seeds a bare home whose only local head is
  `refs/heads/<branch>`, asserted through `repository.show` — `src/main.repository-branch.test.ts`.
- `npm run contract:publish` emits a master document that validates and no example names a dropped
  field.

The fifth check — the registry equals the proposal contract — is Story 2. The sixth — an objective
clone reports `feature/<node id>` — is Story 4.
