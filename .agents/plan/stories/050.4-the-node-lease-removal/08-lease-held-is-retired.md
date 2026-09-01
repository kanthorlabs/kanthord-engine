# Story 8 — `lease-held` is retired and the capability is swapped

Epic: `.agents/plan/epics/050.4-the-node-lease-removal.md`
Depends on: Stories 1, 4, 5, 6 and 7 — every one of them removes `lease-held` from one operation's `errors` record, and this story cannot delete the code until no operation declares it.
Kind: story-foundation

This story changes no path. It is the cross-cutting half of the contract change, and it lands **last**
of the contract work.

**Why it is last, and not first.** A required request field and an error code cannot leave the schema
before the command stops reading and raising them: the handler would not compile, and `pnpm run verify`
would be red for the length of the epic. Each per-operation field and `errors` entry therefore dies in
the story that changes that operation's command — Story 1 for `node.claim`, Story 4 for `node.renew`,
Story 5 for `node.release`, Story 6 for `node.report`. What is left here is the cross-cutting residue,
which is legal to remove only once every raiser and every declaration is gone.

## Change

### 1 — the error code

Delete `"lease-held"` from `errorStatuses` at `src/http/contract/errors.ts:16` and from `exitCodes` at
`src/cli/exit-code.ts:25`. Both are ordered records and both have a test pinning the exact key array.

Delete `leaseHeldDetails` at `src/http/contract/error-details.ts:120-135` whole, and with it the
`leaseRelations` import at `:6`. That import is the contract package's only reference to
`src/domain/lease-hierarchy.ts`, and removing it is what lets EPIC 050.5 delete the file.

**Delete `leaseHeldDetails` rather than leave it exported.**
`src/http/contract/schema-reachability.test.ts` walks the operation registry and refuses a schema no
operation reaches. An orphan would fail that harness, and silencing it with an exclusion would hide
the next real orphan.

Remove the matching row from the error-code table in `docs/proposal/api/README.md` (section
`## Errors`). `src/http/contract/errors.test.ts:16-26` compares the key set and the status of every
code against that table, so the code list and the document must agree.

### 2 — the capability swap

`src/http/contract/capability.ts` binds `worker-model` to the four operations, declared by EPIC 050.2
Story 8. Retire it and declare `worker-run` in its place:

```ts
export const capabilityOperations = {
  "event-wait": ["event.list"],
  "per-node-write": ["node.create", "node.update", "node.delete"],
  "project-graph": ["project.nodes", "project.graph"],
  "worker-run": ["node.claim", "node.renew", "node.release", "node.report"],
} as const satisfies Readonly<Record<string, readonly string[]>>;
```

The keys are bytewise sorted and `worker-run` sorts where `worker-model` sat, so no other key moves.
`src/http/contract/capability.test.ts:34-40` asserts `capabilityName.options` equals
`Object.keys(capabilityOperations)` and is bytewise sorted.

Update the hand-written `capabilities` literal in `systemHealthExamples` at
`src/http/contract/system.ts:84`.

**The capability swap is the announcement, not the version number.** A client reads
`system.health.capabilities` before it calls, so `worker-model` disappearing is what stops it calling
a shape that no longer exists. The version records the build.

**The swap lands after the fields, and that interval is stated.** Between Story 1 and this story a
client reading `worker-model` sees a shape that has already moved. There are no deployments, so no
client exists in that interval; the alternative — swapping the capability first — would announce a
shape the daemon does not yet serve, which is the worse of the two.

### 3 — the version and the compatibility record

`src/domain/version.ts:1` moves to `"29.0.0"`, and `package.json`'s `version` field moves with it in
the same edit — `src/domain/version.test.ts:12-14` asserts the two are equal.

Add one row to the compatibility record EPIC 050.2 Story 8 created in `docs/proposal/api/README.md`:

| epic       | change outside the closed list                                                                                                            | capability retired | capability declared |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------- |
| EPIC 050.4 | `lease`, `objectiveLease` and `objectiveRunId` leave two responses; the node-lease `fence` leaves three requests; `lease-held` is retired | `worker-model`     | `worker-run`        |

## Constraints

- Land last of the contract work. Every per-operation field and `errors` entry belongs to its command's story.
- Delete `leaseHeldDetails`. Do not keep it exported for a future caller.
- Do not touch `src/domain/lease-hierarchy.ts` or `src/services/lease/**`. EPIC 050.5 owns both, and this story only removes the contract package's import of the first.
- The registry total stays 73 and the routed total stays 48. No operation is added or removed.
- Do not touch `system.status`. Its `leases[]` projection is EPIC 050.5's, with the table it reports.

## Verify

```
node --test src/http/contract/errors.test.ts src/http/contract/error-details.test.ts src/http/contract/capability.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/schema-reachability.test.ts src/http/contract/parity.test.ts src/domain/version.test.ts src/cli/exit-code.test.ts
```

Add, each as a separate `it`:

1. `"lease-held is absent from errorStatuses and from exitCodes"` — assert by key set on both, in one case, so the two tables cannot drift apart.

2. `"no operation declares lease-held"` — walk the whole operation registry and assert no `errors` record holds the key. The registry walk is the assertion, not four named operations, and it is what proves Stories 1, 4, 5 and 6 each removed their own.

3. `"leaseHeldDetails is not exported"` — assert the module's export names do not hold it.

4. `"error-details imports nothing from lease-hierarchy"` — read the source of `src/http/contract/error-details.ts` and assert it holds no `lease-hierarchy` substring. This is the fact EPIC 050.5 depends on.

5. `"declaredCapabilities is event-wait, per-node-write, project-graph and worker-run"` — asserted by value, and assert `worker-model` is absent. This is the assertion that the breaking change was announced.

6. `"KANTHORD_VERSION is 29.0.0 and package.json agrees"` — both in one case.

7. `"the compatibility record holds one row naming EPIC 050.4"` — parse the section of `docs/proposal/api/README.md` and assert the row count and the epic name.

8. `"every example parses against its schema"` — the shipped `example.test.ts` harness, run unchanged. The four error literals Stories 1, 4, 5 and 6 replaced are what it now checks.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/http/contract/errors.test.ts` in `PASS EPIC-050.4`.
