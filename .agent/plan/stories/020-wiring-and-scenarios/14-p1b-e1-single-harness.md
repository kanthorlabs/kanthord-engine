# Story 14 — `P1B-E1`, the single-harness loop and the readiness negative

Epic: `.agent/plan/epics/020-wiring-and-scenarios.md`
Depends on: Story 13.

## Change

### A new `scripts/e2e/lib/scenario/p1b-e1.ts`

Driver `local`, profile `fixture`, plan `three-objective`, mode `deterministic`. Follow the module shape of `scripts/e2e/lib/scenario/p1-e1.ts`: build the driver, build the profile, run, and export a `ScenarioDeclaration`.

```ts
const driver = await createLocalDriver(context);
const profile = await createFixtureProfile(context, driver, "three-objective");
const journey = await runJourney(context, driver, profile);
```

`runJourney` yields the project, the bound repository and the imported plan. Reuse it unchanged.

Then drive the whole external loop through the packaged binary, in this order. Every state is asserted **by node identity, never by count**. Steps 2 to 6 prove that the harness authors its own tasks, and this is the one scenario of the block that writes a node: no other scenario drives `node.create`, `node.update` or `node.delete`, so the assembled-binary proof of that capability lives here.

**Both authored nodes go under the alpha objective, and that placement is load-bearing.** Alpha is the one objective this scenario claims, attests and closes, so an authored task under alpha travels the whole loop and the attestation covers it. Beta and gamma keep every assertion they carry today. An authored task under beta would take the beta objective lease at its claim and move beta to `running`, which is the negative this scenario exists to hold.

1. `registerHarness(driver, "client", "p1b-e1-harness")` mints one harness identity.
2. **The transient node covers all three write routes.** Every write of steps 2 to 4 goes through `driver.issueAs("client", …)` with the harness token file, and never through `kanthord node create`, `node update` or `node delete`: those three leaves read `plan.revisions` (`017-per-node-graph-write.md:99`), and no request the harness token signs names that operation. Wrap each request in one local `issueOperation(operationId, request)` helper that appends the id to an ordered `authoringOperationIds` list.
   - `plan.export` returns `beforeRevision` and `beforeDocuments`.
   - `edge.list` returns `edgesBefore`, the edge identities of the project in returned order.
   - `node.create` adds one task under the **alpha objective**, title `p1b-e1-transient`, with **no `dependsOn` entry** and `fromRevision: beforeRevision`. Take `transientId` and `createRevision` from the response. Assertion names `transient-create-status` (expected `200`) and `transient-create-completeness` (expected `[]`).
   - `node.show` on `transientId` returns `revision` equal to `createRevision`. Assertion name `transient-node-revision`. The update sends that token read, never inferred.
   - `node.update` renames the node to `p1b-e1-transient-renamed`, sending `fromRevision: createRevision`, which is the **node** revision. Take `updateRevision` from the response. Assertion names `transient-update-status` (expected `200`), `transient-update-completeness` (expected `[]`) and `transient-update-title` (expected `p1b-e1-transient-renamed`, actual the `title` the next `node.show` returns).
   - `node.delete` removes the node, sending `fromRevision: updateRevision`, which is the **project** revision the update returned. Take `deleteRevision` from the response. Assertion names `transient-delete-status` (expected `200`), `transient-delete-completeness` (expected `[]`) and `transient-delete-identity` (expected `[transientId]`, actual the `deleted` array).
   - `node.show` on `transientId` answers `404 not-found`. Assertion name `transient-gone`.

   The node is created, updated and deleted before any execution row exists, which keeps `node.delete` clear of the eight blockers of `017-per-node-graph-write.md:91`.

3. **The export round trip after the delete, asserted observably and naming no blob hash.** `plan.export` returns `revision` equal to `deleteRevision`, and `documents` byte-identical to `beforeDocuments`, compared through `Buffer.compare` over the canonical JSON of the document array. Assertion names `export-revision-after-delete` and `export-documents-after-delete`. The `accepted_blob` comparison of `017-per-node-graph-write.md:148` is the hermetic form of the same fact. This scenario cannot reach that hash: it lives only in `planRevisionEntry`, and no harness-signed request of this scenario is a `plan.revisions` call.
4. **The durable node then travels the whole loop.** `node.create` adds a second task under **alpha**, title `p1b-e1-durable`, again with no `dependsOn` entry, sending `fromRevision: deleteRevision`. Take `durableId` from the response. Assertion names `durable-create-status` (expected `200`) and `durable-create-completeness` (expected `[]`).
   - `edge.list` returns exactly `edgesBefore`. Neither authored node declares a dependency, so the authoring sequence writes no edge. Assertion name `authored-edges-unchanged`.
   - `node.show` on `durableId` reads `ready`, because `mutateGraph` applies readiness inside the transaction of the write (`016-readiness-applied.md:49`), so the task is claimable at once. Assertion name `durable-state-ready`.
5. `kanthord event list --subject <transientId> --actor <harnessActorId>` and `kanthord event list --subject <durableId> --actor <harnessActorId>`, each with the **configured human token**, because `event.list` declares `["human"]` per `015-actor-identity.md:62`. Read the printed records of Story 3. The transient subject shows `node.created`, `node.updated` and `node.deleted` in event id order, and the durable subject shows `node.created`. Every record names the actor kind `harness` and the actor id `registerHarness` returned. Assertion names `transient-event-types`, `transient-event-actor`, `durable-event-types`, `durable-event-actor`. **This step runs before the first claim**, so no `lease.claimed` and no `outcome.reported` record exists yet and each type list is exact.
6. `authoringOperationIds` deep-equals this exact literal, which holds no `plan.revisions`:

   ```ts
   [
     "plan.export",
     "edge.list",
     "node.create",
     "node.show",
     "node.update",
     "node.show",
     "node.delete",
     "node.show",
     "plan.export",
     "node.create",
     "edge.list",
     "node.show",
   ];
   ```

   Assertion name `authoring-operation-ids`. That is the assembled-binary proof that a harness reaches every guard token it needs. **The assertion is scoped to the harness-signed requests by design**: the human `plan import` of `runJourney` issues one `plan.revisions` call of its own (`008-project-and-plan.md:70`), so an absolute claim over the whole run would be false.

7. `node list --state ready --kind task` returns the ready frontier of EPIC 016. Assert the returned identities equal exactly alpha's first task, `durableId` and beta's first task, sorted bytewise. Assertion name `ready-frontier`. The authored task appears there because readiness promoted it in the transaction of its write, and alpha's second task does not, because it depends on alpha's first.
8. For each alpha task, in this exact order — alpha's first task, alpha's second task, then the authored task:
   - `runHarnessTask` with the label `alpha-1`, then `alpha-2`, then `alpha-authored`, and a distinct fixed object id per task, taken from `profile.expectedObjectIds`.
   - The first claim answers attempt number `1`.
   - After each report, `node show --id <task>` reads `done`. Assertion names `alpha-1-state`, `alpha-2-state` and `alpha-authored-state`.
9. `attestObjective` with the label `alpha`, the fence the objective claim returned, and one combined object id. Alpha therefore attests an objective whose task set the harness itself extended. `node show --id <alpha>` then reads `awaiting_approval`, and returns that same `attestedObjectId` and the computed `projection`, both added to `NodeView` by `019-outcome-report.md:82`. Assertion names `alpha-state-attested`, `alpha-attested-object-id`, `alpha-projection`.
10. An attest by the **human** token is `403 actor-forbidden`. Issue it through `driver.issueAs("client", …)` with the configured token, and assert the status and the code. Assertion names `attest-human-status`, `attest-human-code`.
11. `node close --id <alpha>` with the **configured human token** moves alpha to `done`. Assertion name `alpha-state-closed`.
12. **`gamma` still reads `pending`**, because beta is not done, and beta's first task still reads `ready`. Assertion names `gamma-state-pending`, `beta-first-state-ready`.

### The declaration and the manifest land here

Record the assertion names in exactly the emission order above. In the same change:

- Add the `P1B-E1` entry to `scenarios` at `scripts/e2e/lib/scenario/index.ts:21`: mode `deterministic`, driver `local`, profile `fixture`, plan `three-objective`.
- Add the `P1B-E1` entry to `expectedAssertions` in `scripts/e2e/lib/scenario/assertions.ts`, composed as `[...fixtureProfileAssertionNames, ...journeyAssertionNames, ...<the names above, as a literal>]`.

Story 12 landed the axis, the ids and the floor mechanism and deliberately declared no scenario, so this story is the first that registers one.

### A new `scripts/e2e/lib/scenario/p1b-e1.test.ts`

Suite name `"scripts/e2e/lib/scenario/p1b-e1.test"`. Drive `run` over a fake driver and a recording context, in the shape `scripts/e2e/lib/scenario/p1-e4.test.ts` uses. Cases:

- `it("calls runJourney exactly once before it registers a harness", ...)`.
- `it("records its assertion names in the declared order", ...)` — assert the recorded names deep-equal the `P1B-E1` entry of `expectedAssertions`.
- `it("claims alpha's first task, alpha's second task and the authored task in that order", ...)` — assert the recorded claim argv order over the three identities.
- `it("authors both nodes under alpha before any claim", ...)` — assert the recorded `authoringOperationIds` deep-equal the literal of step 6, assert the recorded `parent` of each create is the alpha identity, and assert every authoring request precedes the first `node.claim` request of the fake driver.
- `it("signs no plan.revisions request with the harness token", ...)` — assert that no request the fake driver received under the harness token file resolves to `plan.revisions`.
- `it("sends the node revision on the update and the project revision on the delete", ...)` — assert the recorded `fromRevision` of the update equals the `revision` the create response returned, and the recorded `fromRevision` of the delete equals the `revision` the update response returned.
- `it("reads the authored task as ready before it claims it", ...)` — assert the recorded `node.show` on the durable identity precedes its claim, and that the recorded expected value is that identity with the state `ready`.
- `it("reads the ready frontier as three identities, the authored task included", ...)` — assert the recorded expected value of `ready-frontier` holds alpha's first task, the durable identity and beta's first task.
- `it("asserts gamma pending by identity and never by count", ...)` — assert the recorded expected value is the node identity and its state.
- `it("builds the fixture profile on the three-objective axis", ...)`.

## Constraints

- **The scenario drives the CLI and direct HTTP only.** It opens no database, imports no `src/` service and calls no internal function.
- It asserts no fact `P1B-E2` establishes, and combines none.
- It runs one client. It names no second role.
- Every object id and every node id it sends is derived from a command's own output or from `profile.expectedObjectIds`. It mints none.
- **Every authored node and every edge is asserted by the identity a response returned, never by title and never by a node count.** A title is an input to a write and the expected value of one field assertion, and it identifies nothing.
- **Every authored node goes under alpha.** Beta stays unclaimed and gamma stays `pending`, so step 12 keeps both negatives exactly as written.
- **The scenario exercises no stale revision and asserts none.** Its writes are sequential and each one carries the token the previous response returned, so no `409 stale-revision` arises. The concurrent revision race is proved hermetically by the concurrency assertions of `017-per-node-graph-write.md`, and `P1B-E3` races a lease rather than a revision.
- No assertion restates a `node:test` case. Each one names a rule against the packaged binary and a running daemon.

## Verify

- `node --test scripts/e2e/lib/scenario/p1b-e1.test.ts` exits 0.
- `node scripts/e2e/run.mjs P1B-E1` exits 0, and the bundle records `pass` with the assertion names of the declaration.
- `npm run verify` exits 0.
- Proof: `scripts/e2e/lib/scenario/p1b-e1.test.ts`, and `node scripts/e2e/run.mjs P1B-E1`. Hermetic coverage: `020-wiring-and-scenarios.md:180`, `:181`.
