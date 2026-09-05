# Story 9 — The proposal records one authority

Epic: `.agents/plan/epics/050.4-the-node-lease-removal.md`
Depends on: every prior story of EPIC 050.4. Both tree assertions enumerate the result.
Kind: story-foundation

## Change

### 1 — the documents

**`docs/proposal/api/execution.md`** describes `node.claim`, `node.renew` and `node.release`. Remove
the `lease` and `objectiveLease` response objects from the claim and renew tables, remove the `fence`
request field from the renew and release tables, and remove the `lease-held` row from each operation's
error list. State in one sentence that a worker presents `runId` and `runFence` and nothing else.

**`docs/proposal/api/outcome.md`** describes `node.report`. Remove the `fence` request field from the
five members that carry it and remove the `lease-held` row.

**`docs/proposal/phase-2/agents-and-workers.md`** names the worker verbs. Replace every sentence that
says a worker holds a lease with one that says a worker holds a run, and name `runId` and `runFence`
as the pair it presents. `src/http/contract/proposal-amendment-execution.test.ts` asserts proposal
sentences verbatim, so check that file for a sentence this edit invalidates.

**`docs/proposal/phase-2/runs-and-exclusion.md`**, created by EPIC 050 Story 7
(`07-the-proposal-records-the-run-model`) and extended by EPIC 050.3 Story 9, gains one section: the
run is the only proof of a worker's authority, the node lease is gone from every worker operation,
and every surviving exclusion rule reads a run. Name the three that survive — `subtreeExclusion`,
`objectiveBusy` and the `drive-mode-pinned` driver pin — because this epic deletes none of them.
Its terminal-event sentence widens back to the unconditional rule: every run that moves from `active`
to `ended` appends exactly one of `run.ended` or `run.expired`, never both and never neither.

**`docs/proposal/database/lease.md`** is **not** edited here. The table still exists after this epic
with its node rows in place, and `system.status` still reports it. EPIC 050.5 owns the document with
the migration that drops the table, and the `system.status` projection with it.

### 2 — the two tree assertions

Both live in `src/lease-absence.test.ts`, the tree-assertion file Story 8 creates beside the shipped
`src/koa-absence.test.ts`.

**No run command imports the lease.** Enumerate every non-test file under `src/commands/node/`,
`src/commands/run/` and `src/commands/outcome/`, and assert none holds an import specifier matching
`services/lease/` or `domain/lease-hierarchy`, and none holds a member expression on a `lease`
dependency key — `.lease.` followed by an identifier. The set is the assertion, not a grep of one
file: a stale path survives in the file nobody re-read.

**Match imports and member access, never the substring `lease`.** A case-insensitive substring search
matches `release`, so it matches `release-node.ts`, `releaseTask`, `releaseObjective`, `ReleaseRefusal`
and `execution.endRun`'s `"released"` outcome. Such an assertion can never pass, and weakening it with
an exclusion list would hide the reference it exists to catch. The import graph and the dependency-key
member access are the two ways a command can reach a lease, and both are decidable.

**The `Lease` service keeps exactly three importers outside itself.** Enumerate every non-test file
under `src/` that is **not** inside `src/services/lease/` and that imports from `src/services/lease/`,
and assert the set deep-equals
`["src/commands/actor/revoke-actor.ts", "src/commands/startup/recover-expired-leases.ts", "src/main.ts"]`,
by value. Two are commands and the third is the composition root, which still constructs the
implementation. A caller this epic missed then fails rather than compiles, and EPIC 050.5 inherits a
set it can check against its own deletion list.

**The service's own files are excluded, and that exclusion is stated rather than implied.**
`src/services/lease/sqlite.ts` and `src/services/lease/not-implemented.ts` both import `./index.ts`,
so an enumeration that admits them can never equal the three-name literal. What the assertion proves
is that no consumer outside the capability reaches it, which is what "the four worker operations left
the set" means.

## Constraints

- Edit four documents. Do not edit `docs/proposal/database/lease.md`: EPIC 050.5 owns it.
- The second assertion names three files by value. Do not write it as a count, and do not exclude `src/main.ts` — the composition root still constructs the implementation and that is the fact being pinned.
- Exclude `src/services/lease/**` from the second assertion. The capability's two implementations import their own interface, and admitting them makes the three-name literal unreachable.
- Both assertions enumerate a directory. Do not write either as a single `grep` of a known file.
- Do not match the bare substring `lease`. It matches `release` and the assertion cannot pass.
- Change no production source in this story.

## Verify

```
node --test src/lease-absence.test.ts src/http/contract/proposal-amendment-execution.test.ts src/http/contract/parity.test.ts
```

Add, each as a separate `it`:

1. `"no file under commands/node, commands/run or commands/outcome imports or calls the lease"` — the tree assertion, by enumeration over import specifiers and `.lease.<member>` access. Assert the offending list is empty and report the file names on failure.

2. `"the tree assertion does not match the word release"` — run it against a fixture holding `releaseNode`, `ReleaseRefusal` and `outcome: "released"`, and assert it finds nothing. Without this case the assertion could be a substring search that happens to pass today.

3. `"the Lease service has exactly three importers"` — deep-equal against the three-name literal above.

4. `"the execution proposal names runId and runFence and not a lease"` — assert the document holds `runFence` and holds no `lease-held`.

5. `"the outcome proposal declares no fence request field"`.

6. `"the runs-and-exclusion proposal states the run is the only authority"` — assert the section exists by heading.

7. `"docs/proposal/database/lease.md is unchanged by this epic"` — assert the file still describes both subject kinds. The interval where the table outlives its writers is deliberate, and this assertion is what makes it visible.

8. `"system.status still projects the lease table"` — assert `systemStatusResponse` still holds its `leases` key. The projection is truthful while the table exists, and EPIC 050.5 removes both together.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/http/contract/parity.test.ts` in `PASS EPIC-050.4`.
