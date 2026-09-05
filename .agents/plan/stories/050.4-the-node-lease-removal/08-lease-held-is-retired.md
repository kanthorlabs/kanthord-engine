# Story 8 — `lease-held` is retired and the capability is swapped

Epic: `.agents/plan/epics/050.4-the-node-lease-removal.md`
Depends on: EPIC 050.4 Stories 1 (`01-the-claim-of-a-task-drops-the-lease`), 4 (`04-the-renew-drops-the-lease`), 5 (`05-the-release-drops-the-lease`), 6 (`06-the-report-drops-the-lease`) and 7 (`07-the-objective-attestation-drops-the-lease`) — every one of them removes `lease-held` from one operation's `errors` record, and this story cannot delete the code until no operation declares it. EPIC 050.4 Story 0 (`00-groundwork`) moved the `package.json` half of the version pair this story closes.
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

Delete `"lease-held"` from `errorStatuses` at `src/http/contract/errors.ts:19` and from `exitCodes` at
`src/cli/exit-code.ts:25`. Both are ordered records and both have a test pinning the exact key array.

Delete `leaseHeldDetails` at `src/http/contract/error-details.ts:120-135` whole, and with it the two
imports it is the only consumer of: `leaseOwnerKinds` at `:5`, used only at `:125`, and
`leaseRelations` at `:6`, used only at `:128`. The second is the contract package's only reference to
`src/domain/lease-hierarchy.ts`, and removing it is what lets EPIC 050.5 delete the file. `epochMillis`
at `:3` and `nodeIdentity` at `:4` stay: EPIC 050.1 Story 1's `objective-busy` and `subtree-busy`
details carry `expiresAt` and node ids in the same file.

### 1b — the refusal helper that raised it

`errorStatuses` is what types `ErrorCode`, and `httpError` at `src/http/contract/errors.ts:95-111`
takes an `ErrorCode`. So deleting the key breaks every remaining `httpError("lease-held", ...)` call,
and `src/http/server/node/refusals.ts` holds two, at `:242` and `:253`, inside `function leaseHeld` at
`:231-259`. Delete that function. Stories 1, 4, 5, 6 and 7 delete its five call sites with their
`case "lease-held":` branches, so it has none left.

`presented` exists only to feed it. Delete the parameter from `toHttpError` at `:14`, the four
arguments that thread it at `:37`, `:40`, `:43` and `:46`, and the parameter of each sub-refusal
function that took it — `:69`, `:90`, `:183` and `:199`. Stories 4, 5 and 6 delete the three handler
sites that build it.

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

`src/domain/version.ts:1` — `KANTHORD_VERSION` moves to `"29.0.0"`.
`src/domain/version.test.ts:13` — `assert.equal` asserts it equals the `version` field of
`package.json`, and **EPIC 050.4 Story 0 (`00-groundwork`) already moved that field**. `package.json`
is denied to both engineers by `scripts/lane-check.sh`, so the pair cannot land in one turn; this
story writes the constant, and the assertion goes green here. Do not edit `package.json`: it is
outside this role's lane, and Story 0 applied it before the loop opened.

Add one row to the compatibility record EPIC 050.2 Story 8 created in `docs/proposal/api/README.md`:

| epic       | change outside the closed list                                                                                                                  | capability retired | capability declared |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------- |
| EPIC 050.4 | `lease` and `objectiveLease` leave two responses; `objectiveRunId` stays; the node-lease `fence` leaves three requests; `lease-held` is retired | `worker-model`     | `worker-run`        |

## Constraints

- Land last of the contract work. Every per-operation field and `errors` entry belongs to its command's story.
- Delete `leaseHeldDetails`. Do not keep it exported for a future caller.
- Delete `leaseHeld` and the `presented` channel here, not in a per-operation story. Five stories share the helper, and the last of them to run is the only one that can remove it.
- Do not touch `src/domain/lease-hierarchy.ts` or `src/services/lease/**`. EPIC 050.5 owns both, and this story only removes the contract package's import of the first.
- The registry total stays 73 and the routed total stays 50. No operation is added or removed.
- Do not touch `system.status`. Its `leases[]` projection is EPIC 050.5's, with the table it reports.

## Verify

```
node --test src/http/contract/errors.test.ts src/http/contract/error-details.test.ts src/http/contract/capability.test.ts src/http/contract/coverage.test.ts src/http/contract/example.test.ts src/http/contract/schema-reachability.test.ts src/http/contract/parity.test.ts src/lease-absence.test.ts src/domain/version.test.ts src/cli/exit-code.test.ts
```

Add, each as a separate `it`:

1. `"lease-held is absent from errorStatuses and from exitCodes"` — assert by key set on both, in one case, so the two tables cannot drift apart.

2. `"no operation declares lease-held"` — walk the whole operation registry and assert no `errors` record holds the key. The registry walk is the assertion, not four named operations, and it is what proves Stories 1, 4, 5 and 6 each removed their own.

3. `"leaseHeldDetails is not exported"` — assert the module's export names do not hold it.

4. `"error-details imports nothing from lease-hierarchy and nothing from domain/lease"` — read the source of `src/http/contract/error-details.ts` and assert it holds neither a `lease-hierarchy` nor a `domain/lease.ts` import specifier. Two assertions, one case: the first is the fact EPIC 050.5 depends on, the second is the import that would otherwise be left orphaned.

5. `"no server file raises lease-held"` — create `src/lease-absence.test.ts`, modelled on the shipped tree assertion at `src/koa-absence.test.ts`. Read every non-test file under `src/http/server/` and assert none holds the literal `"lease-held"`. `leaseHeld` and the `presented` channel are gone, so this is decidable by construction and does not depend on an unused-code check that this repository does not run. Story 9 adds its two tree assertions to the same file.

6. `"declaredCapabilities is event-wait, per-node-write, project-graph and worker-run"` — asserted by value, and assert `worker-model` is absent. This is the assertion that the breaking change was announced.

7. `"KANTHORD_VERSION is 29.0.0 and package.json agrees"` — both in one case.

8. `"the compatibility record holds one row naming EPIC 050.4"` — parse the section of `docs/proposal/api/README.md` and assert the row count and the epic name.

9. `"every example parses against its schema"` — the shipped `example.test.ts` harness, run unchanged. The four error literals Stories 1, 4, 5 and 6 replaced are what it now checks.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/http/contract/errors.test.ts` in `PASS EPIC-050.4`.
