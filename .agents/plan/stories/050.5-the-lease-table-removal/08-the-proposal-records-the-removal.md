# Story 8 — The proposal records the removal

Epic: `.agents/plan/epics/050.5-the-lease-table-removal.md`
Depends on: every prior story. Its tree assertion enumerates the result.
Kind: story-foundation

## Change

### 1 — the documents

**`docs/proposal/database/lease.md` is amended, not deleted.** The table survives this epic, empty and
unreachable from any command, until EPIC 057's migration `17` drops it. A document describing a table
that still exists is not stale; a deleted document for a table `sqlite_master` still lists is. Amend it
to state that the table has no writer and no reader after EPIC 050.5, that its `subject_kind = 'node'`
half was the worker lease the run replaced, and that migration `17` drops it. **Delete the document
in the epic that drops the table**, not here.

**`docs/proposal/database/README.md`** — two edits:

- `:98` is the disposition row `lease | keep, generalized | One mechanism for the objective lease and the repository lock`. Amend it to `lease | drop at EPIC 057 | Replaced by the run; no writer and no reader after EPIC 050.5`;
- `:99`, the `run` row, reads `One execution epoch: the resolved worker, the lease fence, the base`. The lease fence is gone from `run` since migration `12`; amend it to name the run's own fence.

The table index at `:26` and the polymorphic-column lists at `:80` and `:126` **keep their `lease`
entries**, because the table and `lease.subject_id` both still exist.

**`docs/proposal/database/run.md`** — its question line reads _"which worker ran it, under which lease
generation, from which base commit"_. The generation is the run's own fence. Amend it.

**`docs/proposal/phase-2/runs-and-exclusion.md`**, created by EPIC 050.3 Story 9 and amended by EPIC
050.4 Story 9, gains one closing section: no production code reaches a node lease, the run is the only
exclusion and the only authority, startup recovery and the read-path sweep both key on run expiry, and
the empty `lease` table is dropped by EPIC 057's migration `17`.

**`docs/proposal/phase-1/git-foundation.md`** is referenced from `lease.md` for the home lock. That
link stays: `lease.md` stays, and the home lock is `src/services/home-lock/`, a separate mechanism this
epic does not touch.

### 2 — the version and the compatibility record

`src/domain/version.ts:1` moves to `"30.0.0"`, and `package.json`'s `version` field moves with it in
the same edit — `src/domain/version.test.ts:12-14` asserts the two are equal.

**It is a major, not a patch.** Story 4 removes `leases[]` from the `system.status` response, and a
response field removal is outside the closed list of `docs/proposal/api/README.md:100-106`.

Add one row to the compatibility record EPIC 050.2 Story 8 created, **exactly as written**:

| epic       | change outside the closed list                 | capability retired | capability declared |
| ---------- | ---------------------------------------------- | ------------------ | ------------------- |
| EPIC 050.5 | `leases[]` leaves the `system.status` response | _(empty)_          | _(empty)_           |

Then add one sentence directly under the table:

> EPIC 050.5's row carries no capability because `system.status` is covered by none. The policy's
> announcement mechanism does not reach an operation outside `capabilityOperations`, and EPIC 050.5
> records that gap rather than inventing a capability to fill it.

**This story ships one shape and no branch.** The policy gap is a real open question and the epic's
index records it, but a story that offered the implementing agent two possible tables would be
undispatchable. If a human rules that `system.status` gains a capability, that ruling amends this
story before dispatch and changes both cells; until then the empty row plus the sentence is what
ships.

### 3 — the tree assertion

Place it beside the existing tree assertions rather than in a new file.

**No production file reaches the lease service.** Enumerate every non-test file under `src/` and assert
none holds an import specifier matching `services/lease` or `domain/lease-hierarchy`, and none holds
the identifier `leaseHeld`, `liveLeaseRefusal`, `LeaseError` or `LeaseRecord`.

**`leaseRow` is not in that list, and its absence is deliberate.** `src/domain/rows.ts:33` registers it
as the row schema of a table that still exists, and
`src/services/storage/schema-parity.test.ts:90` asserts the migrated table set equals
`Object.keys(rows)`. Adding `leaseRow` to the forbidden identifiers would make this assertion and that
one contradict each other. EPIC 057 adds it when migration `17` drops the table.

**Match imports and identifiers, never the substring `lease`.** A case-insensitive substring search
matches `release`, so it matches `release-node.ts`, `releaseNode`, `ReleaseRefusal` and the
`outcome: "released"` a run ends with. Such an assertion can never pass, and weakening it with an
exclusion list would hide the reference it exists to catch.

**It does not forbid `subjectKind` or `subject_kind`.** Both stay: `events.append` takes
`subjectKind: "node"`, `"repository"`, `"actor"` and `"run"`, and `subject_kind` is a column on
`event` and `check_result`, tables this epic does not touch.

## Constraints

- Amend `lease.md`; do not delete it. The table still exists, and EPIC 057 deletes the document with it.
- Amend two README rows and the `run.md` question line. Leave the table index and the polymorphic-column lists alone: `lease` and `lease.subject_id` both still exist.
- Write the compatibility row with both capability cells empty, plus the explanatory sentence. Do not invent a capability to fill them, and do not offer a second table.
- The tree assertion matches imports and identifiers. Do not match the bare substring `lease`.
- Change no production source in this story.

## Verify

```
node --test src/http/contract/parity.test.ts src/domain/version.test.ts
```

Add, each as a separate `it`:

1. `"no production file reaches the lease"` — the tree assertion, by enumeration over import specifiers and the five identifiers. Assert the offending list is empty and report the file names on failure.

1b. `"the tree assertion does not match the word release"` — run it against a fixture holding `releaseNode`, `ReleaseRefusal` and `outcome: "released"`, and assert it finds nothing. Without this case the assertion could be a substring search that happens to pass today.

2. `"docs/proposal/database/lease.md states the table has no reader and no writer"` — assert the sentence exists and assert the file is present. The document survives with the table, and this case pins both.

3. `"the database README's lease disposition row names EPIC 057"` — parse `:98` and assert the disposition cell. Assert the table index at `:26` still names `lease`: the row survives on purpose, and a test that asserted its absence would have to be reverted at EPIC 057.

4. `"the runs-and-exclusion proposal states the run is the only authority"` — assert the section exists by heading and that it names EPIC 057 as where the table goes.

5. `"KANTHORD_VERSION is 30.0.0 and package.json agrees"` — both in one case.

6. `"the compatibility record holds one row naming EPIC 050.5 with empty capability cells"` — parse the section of `docs/proposal/api/README.md`, assert the row count, the epic name, and that both capability cells are empty. Assert the explanatory sentence follows the table. The empty cells are the recorded open question, and the test pins them so a later edit cannot fill them silently.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/http/contract/parity.test.ts` in `PASS EPIC-050.5`.
