# Story 2 — The landingBranch operation leaves

Epic: `.agent/plan/epics/029-one-branch-field-and-objective-feature-branches.md`
Depends on: Story 1.

`repository.landingBranch` is removed from the registry, from the proposal and from the path grammar.
The operation changed a configurable landing branch, and after this epic no such value exists.

This story touches no branch field. It is separable from the rename of Story 3, and it is separate
because it moves ten pinned counts that would otherwise arrive inside a forty-file commit.

## Change

### 1. `src/http/contract/repository.ts`

Delete the `repository.landingBranch` operation entry in full, lines 240-253, so
`repository.reconcile` follows `repository.show` directly in the `operations([...])` array. Place the
comma so the array stays valid.

Change nothing else in the file. `repositoryRegisterRequest`, `repositoryView` and every example are
Story 3's, and the entry being deleted carries no `request`, no `response` and no `examples`.

### 2. `src/http/contract/path.ts` — the segment leaves the grammar

Delete `"landing-branch"` from `subresourceSegments` at line 28.

`subresourceSegments` is a closed grammar, and a segment no operation uses is dead contract
vocabulary that lets the path be reintroduced without editing the grammar. Removing the operation and
leaving its segment behind is half the change. `docs/proposal/api/README.md` holds the grammar and
`AGENTS.md` makes the closed set the mechanism, so the set shrinks with the route.

### 3. `docs/proposal/api/repository.md`

- Delete line 15 in full — the `repository.landingBranch` route row.
- Delete lines 108 through 111 in full — the `## repository.landingBranch` heading, its blank line,
  its one paragraph, and the blank line that follows, so `## repository.reconcile` follows
  `## repository.show`'s last paragraph with exactly one blank line between them.

### 4. `docs/proposal/database/repository.md`

Replace line 34 in full. Story 1 deliberately left it byte-identical, because until the route row
above is gone this sentence is still true. It reads today:

```
A change to `landing_branch` is an explicit command, not an update of this row alone. It names the object id the new branch starts at, it writes an event, and it reports the work already landed on the old branch.
```

Replace that one line with:

```
A registered repository does not change its branch. The operation that changed a configurable landing branch is gone, and an operator who picked the wrong branch registers the repository again.
```

The sentence says nothing about the column names, so it stays true through Story 3 as well.

### Formatting

```bash
npx prettier --write docs/proposal/api/repository.md docs/proposal/database/repository.md
```

Deleting a table row changes the column widths of the route table, so the reflow is required for the
committed bytes to be stable.

## Constraints

- **Touch no branch field.** No file mentions `upstreamBranch`, `landingBranch`, `publishRef` or their
  columns as a result of this story. Story 3 owns all of that.
- **Do not regenerate `src/http/contract/field-decisions.fixture.ts`.** A `stubbed` operation carries
  no schema, so it contributes no fixture row (`coverage.test.ts:443-473` excludes it) and the fixture
  is byte-identical after this story. If the probe produces a diff, something else changed — stop.
- **Change no other operation's lifecycle.** `repository.reconcile` stays `stubbed`, `phase-2`.
- **Delete no schema component.** `openapi.test.ts:338-350` lists every registered schema component
  and none of them belongs to the removed operation, so that list is byte-identical.
- Add no operation and no path segment.

## Verify

### The pinned counts

Every count below is pinned in a test and moves by exactly one, because exactly one `stubbed`
`phase-2` operation left the registry.

- `src/http/contract/registry.test.ts`
  - `:49` — `registry.length` becomes `69`.
  - `:63-72` — routed stays `44`, stubbed becomes `25`.
  - `:75-90` — phase-1 stays `39`, phase-2 becomes `27`, phase-3 stays `3`, post-mvp stays `0`.
  - `:628-668` — the POST-policy array. Remove `"repository.landingBranch"` at `:654`, and change the
    count in both the test name and its assertion from thirty to twenty-nine.
  - `:679-684` — the memory-policy count becomes `28`.
  - `:112-181` — the with-request and with-response arrays need **no** edit. A stubbed operation
    carries no schema, so it was in neither.
- `src/http/contract/parity.test.ts`
  - `:16` — the routed+stubbed count becomes `69`.
  - `:25` — the total proposal-row count becomes `73`.
  - `:17-21` — the `deepEqual` still reports three empty arrays. That is the assertion which proves
    the registry and the proposal moved together; a change to only one side fails here.
- `src/http/contract/coverage.test.ts`
  - `:445` — the stubbed count becomes `25`.
  - `:416` — stays `38`. It counts phase-1 routed minus `blob.show`, and the removed operation is
    phase-2.
- `src/http/contract/openapi.test.ts`
  - `:115` — the operation-id count becomes `69`.
  - **`:360-384` is generalised, not retargeted.** It names
    `paths["/v1/repository/{id}/landing-branch"]` at `:377` as one arbitrary exemplar of "a stubbed
    operation's default response refs the generic `Error` component". Replace that half of the test
    with a loop over `registry.filter((entry) => entry.status === "stubbed")` that renders each
    entry's path through the path renderer and asserts its default response refs `Error`. The
    invariant then holds for all 25 stubbed operations and never needs retargeting when one
    representative disappears. Leave the `plan.import` half — its own error component — unchanged.

### The path grammar

`src/http/contract/path.test.ts`

- `:39` — `subresourceSegments.length` becomes `16`.
- `:153-162` — this test reads the index of `"graph"`, `"edge"` and `"landing-branch"` and asserts
  `graph` sorts before `landing-branch`. It names a segment that no longer exists. Replace it with the
  same shape of assertion over two segments that remain in the set, chosen so the pair is adjacent
  after the deletion, so bytewise order is still pinned by an explicit index comparison.
- `:90` — the generic sortedness loop over `resourceSegments` and `subresourceSegments` needs no edit,
  and it is what proves the set stayed sorted after the deletion.

### The route is gone, not stubbed

`src/http/server/repository/list-repository.test.ts`

**Delete the test at `:81-88`.** It asserts that `POST /v1/repository/<id>/landing-branch` answers
`501` and writes nothing. With no registry entry there is no route at all. Do **not** rewrite it to
expect `404`: the path is simply not declared, and asserting a 404 would test the router's fallback
rather than this epic.

Leave the view fixture at `:18-19,22` alone — it names branch fields and belongs to Story 3.

### Commands

```bash
node --test \
  src/http/contract/registry.test.ts \
  src/http/contract/parity.test.ts \
  src/http/contract/coverage.test.ts \
  src/http/contract/openapi.test.ts \
  src/http/contract/path.test.ts \
  src/http/contract/example.test.ts \
  src/http/server/repository/list-repository.test.ts
```

These three commands report `0`, `0` and no diff:

```bash
grep -rl "repository\.landingBranch" src docs | wc -l
grep -rl "landing-branch" src docs | wc -l
git diff --stat src/http/contract/field-decisions.fixture.ts
```

`npm run verify` exits 0.

Proof — the EPIC's `## Verification gate`, its fifth check: _the registry equals the proposal
contract, and `repository.landingBranch` appears in neither._ `parity.test.ts:17-21` delivers the
equality and the first grep delivers the absence.
