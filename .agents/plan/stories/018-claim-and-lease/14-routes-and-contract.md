# Story 14 — The three routes and their contract entries

Epic: `.agents/plan/epics/018-claim-and-lease.md`
Depends on: Story 1, Story 5, Story 10, Story 11, Story 12. **This story adds the proposal rows and the registry rows in one change, so parity never goes red.**

## Change

### `docs/proposal/api/execution.md` — the three route rows land here

Story 1 deliberately left them out, because `src/http/contract/parity.test.ts` compares the proposal set against the registry set and a row on one side alone turns `npm run verify` red. **Add both sides in this one change.**

The Routes table sits at `docs/proposal/api/execution.md:9-20`. Append three rows after the `worker.list` row at `:19`, in this exact order:

```
| `node.claim`     | `POST /v1/node/:id/claim`     | phase-1      | routed  | `013-external-drive-overview.md`, the claim |
| `node.heartbeat` | `POST /v1/node/:id/heartbeat` | phase-1      | routed  | `013-external-drive-overview.md`, the claim |
| `node.release`   | `POST /v1/node/:id/release`   | phase-1      | routed  | `013-external-drive-overview.md`, the claim |
```

`readRouteMatrix` at `test/helpers/proposal.ts:52` reads a table row only when it holds five cells and the third cell is a member of `introducedInValues`. Keep exactly five cells per row.

Add one section per route, after the objective-scope section Story 1 wrote, in the table order: `## node.claim`, `## node.heartbeat`, `## node.release`. Each states the request body, the response members and the refusal codes of the mapper table below.

### `src/http/contract/path.ts`

`actionSegments` at `src/http/contract/path.ts:36-52` is an alphabetically ordered list. Insert three members, each in its alphabetical position: `claim` after `cancel`, `heartbeat` after `export`, `release` after `reconcile`. EPIC 015 inserts `revoke` and `rotate` into the same list; take the list as it stands when this story runs and insert alphabetically.

Add nothing to `resourceSegments`: `node` is already there at `:10`.

### `src/http/contract/execution.ts`

Add three operations after the `worker.list` entry at `:58-64`, in this order:

```ts
{
  operationId: "node.claim",
  method: "POST",
  path: [resource("node"), parameter("node"), action("claim")],
  introducedIn: "phase-1",
  status: "routed",
  idempotency: "memory",
  replayable: [200],
  allowedActors: ["human", "harness"],
  request: nodeClaimRequest,
  response: nodeClaimResponse,
  errors: { ...baselineErrors, "lease-held": leaseHeldDetails, "illegal-transition": illegalTransitionDetails, "plan-invalid": planInvalidDetails },
  examples: nodeClaimExamples,
}
```

`node.heartbeat` and `node.release` take the same shape with `action("heartbeat")` and `action("release")`.

`registryFaults` at `src/http/contract/registry.ts:249-291` requires `idempotency: "memory"` and a non-empty distinct `replayable` list together, and it requires the policy to sit on a `POST`. All three satisfy it. `isLegalPath` at `:312` admits resource → parameter → action.

- `node.claim` request is `z.strictObject({})` — an **empty** strict body. The TTL is configuration and the owner is the authenticated actor.
- `node.heartbeat` and `node.release` requests are each `z.strictObject({ fence: z.int().min(1) })`.
- The three response schemas are exactly these. Declare `claimedLease` once and reuse it.

  ```ts
  const claimedLease = z.strictObject({
    subjectId: nodeIdentity,
    owner: z.string().min(1),
    ownerKind: z.literal("actor"),
    fence: z.int(),
    expiresAt: epochMillis,
  });

  export const nodeClaimResponse = z.strictObject({
    lease: claimedLease,
    objectiveLease: claimedLease,
    runId: identity("run"),
    objectiveRunId: identity("run"),
    attemptId: identity("attempt").nullable(),
    attemptNo: z.int().nullable(),
    heartbeatIntervalMs: z.int(),
    node: nodeShowResponse.shape.node,
  });

  export const nodeHeartbeatResponse = z.strictObject({
    lease: claimedLease,
    objectiveLease: claimedLease,
    heartbeatIntervalMs: z.int(),
  });

  export const nodeReleaseResponse = z.strictObject({
    node: nodeShowResponse.shape.node,
  });
  ```

  `attemptId` and `attemptNo` are nullable because an objective claim opens no attempt. `node` reuses the member `node.show` already publishes at `src/http/contract/graph.ts:347`, so the two routes cannot describe a node differently.

- Each operation declares `examples`. Write `nodeClaimExamples`, `nodeHeartbeatExamples` and `nodeReleaseExamples` as literal objects with a `request`, a `success` and an `error` member, in the shape the sibling entries of `src/http/contract/graph.ts` use. Every value is a fixed literal: the ULID identities of the existing examples, `fence: 1`, `expiresAt: 1722800300000`, `heartbeatIntervalMs: 100000`, `attemptNo: 1`. `npm run verify` validates the generated document against these schemas, so a placeholder that does not parse fails the gate.
- `baselineErrors` at `src/http/contract/error-baseline.ts:4-13` already carries `invalid-request` and `not-found`. The three operations therefore declare `lease-held`, `illegal-transition` and `plan-invalid` **beside** it, and no operation redeclares `invalid-request` or `not-found`.

`errorStatuses` at `src/http/contract/errors.ts:7-28` already holds `lease-held`, `illegal-transition` and `plan-invalid`. Add no error code in this story.

### `src/http/contract/error-details.ts`

Append two schemas after `invalidRequestDetails` at `:75-79`, `leaseHeldDetails` then `illegalTransitionDetails`. Both are discriminated unions, declared once each and defined below.

`leaseRelations` comes from `src/domain/lease-hierarchy.ts` of Story 5 and `leaseOwnerKinds` from `src/domain/lease.ts`; `http/contract/` may import `domain/`. `epochMillis` and `nodeIdentity` come from `src/domain/column.ts` and `src/domain/identity.ts`, `nodeStates` from `src/domain/state.ts`, and `runDrivers` from `src/domain/run.ts`.

**`illegal-transition` carries three different facts, so its schema is an explicit discriminated union and not one loose object.** The three refusals that map to that code emit different shapes, and a single `strictObject` cannot hold all three without making every member optional, which asserts nothing. Discriminate on a required `refusal` member:

```ts
export const illegalTransitionDetails = z.discriminatedUnion("refusal", [
  z.strictObject({
    refusal: z.literal("node-state"),
    state: z.enum(nodeStates),
    admitted: z.array(z.enum(nodeStates)).min(1),
  }),
  z.strictObject({
    refusal: z.literal("ancestor-not-startable"),
    ancestorId: nodeIdentity,
    state: z.enum(nodeStates),
    admitted: z.array(z.enum(nodeStates)).min(1),
  }),
  z.strictObject({
    refusal: z.literal("drive-mode-pinned"),
    pinnedDriver: z.enum(runDrivers),
    claimDriver: z.enum(runDrivers),
  }),
]);
```

The refusal mapper below sets `refusal` from the command's own refusal: `illegal-transition` becomes `node-state`, `ancestor-not-startable` and `drive-mode-pinned` keep their names.

**`lease-held` likewise carries two shapes.** A hierarchy refusal names a holder; a stale-fence refusal from `renew`, `release` or `assertHeld` has no holder to name, and may face a row that is absent or already free. One union covers both:

```ts
export const leaseHeldDetails = z.discriminatedUnion("refusal", [
  z.strictObject({
    refusal: z.literal("held-by-other"),
    subject: nodeIdentity,
    holder: z.string().min(1),
    holderKind: z.enum(leaseOwnerKinds),
    fence: z.int(),
    expiresAt: epochMillis,
    relation: z.enum(leaseRelations),
  }),
  z.strictObject({
    refusal: z.literal("stale-fence"),
    subject: nodeIdentity,
    presentedFence: z.int(),
  }),
]);
```

`held-by-other` is built from the `refusal` property `Lease` puts on its error, which Story 5 and Story 7 make carry every member including `fence`. `stale-fence` carries only what the caller presented, because a refused conditional write reads no row and the command must not run a second read to describe a row it was refused. It names no current fence deliberately: disclosing the live fence to a caller that failed the fence check would hand it the value it needs to overwrite the live holding.

### `src/http/server/node/`

Three new handler files, `claim-node.ts`, `heartbeat-node.ts` and `release-node.ts`, in the shape of `src/http/server/node/list-node.ts`. Each one **parses, invokes exactly one command, and formats**. A handler that branches on a domain rule is a defect.

Each handler:

1. parses the body with the contract request schema; a parse failure throws `httpError("invalid-request", ...)`.
2. reads the node identity from `context.parameters` and the actor from `context.actor`, which EPIC 015 made a required member of `HandlerContext`.
3. calls its one command inside a `try`, and passes every thrown error to the shared refusal mapper.
4. returns `{ status: 200, body }`.

One new file `src/http/server/node/refusals.ts`, in the exact pattern of `src/http/server/plan/refusals.ts`. `toHttpError(error)` maps each refusal of the three commands, and rethrows anything it does not recognise:

| refusal                    | code                 | `details`                                                                |
| -------------------------- | -------------------- | ------------------------------------------------------------------------ |
| `node-not-found`           | `not-found`          | none                                                                     |
| `initiative-not-claimable` | `invalid-request`    | `{ refusal: "initiative-not-claimable" }`                                |
| `plan-incomplete`          | `plan-invalid`       | `{ findings }`                                                           |
| `drive-mode-pinned`        | `illegal-transition` | `{ refusal: "drive-mode-pinned", pinnedDriver, claimDriver }`            |
| `illegal-transition`       | `illegal-transition` | `{ refusal: "node-state", state, admitted }`                             |
| `ancestor-not-startable`   | `illegal-transition` | `{ refusal: "ancestor-not-startable", ancestorId, state, admitted }`     |
| `lease-held`               | `lease-held`         | `{ refusal: "held-by-other", ... }` or `{ refusal: "stale-fence", ... }` |
| `no-active-run`            | `illegal-transition` | `{ refusal: "node-state", state, admitted }`                             |
| `no-open-attempt`          | `illegal-transition` | `{ refusal: "node-state", state, admitted }`                             |

The mapper chooses the `lease-held` variant by whether the error carries a `refusal` property from `Lease`: present means `held-by-other` and is copied member for member; absent means `stale-fence`, built from the node identity and the fence the caller presented.

`no-active-run` and `no-open-attempt` of Story 12 map to `illegal-transition` with the `node-state` variant, because both mean the node is not in a releasable condition. Neither introduces an error code.

### Authorization

**This epic adds exactly three authorization rows**, `node.claim`, `node.heartbeat` and `node.release`, each `allowedActors: ["human", "harness"]`. A harness claiming and reporting its own work is the rule `.agents/plan/epics/015-actor-identity.md:50` states.

Add the three operation ids to the named assertion EPIC 015 wrote in `src/http/contract/registry.test.ts`, and assert each of the three admits `harness`. **State no registry-wide total**: a copied count is order-dependent and goes stale on the next epic. EPIC 015 owns the mechanism and its own read list, and EPIC 020 owns the one registry test that asserts the complete named set.

### `src/http/contract/parity.test.ts`

Raise the two count literals at `src/http/contract/parity.test.ts:16` and `:25` to **exact absolute values**, not to a relative delta.

The derivation is closed, because only three epics between the current tree and this one add a route row:

| epic                     | rows added                                                                       | `comparable.length` (`:16`) | `proposalRows.length` (`:25`) |
| ------------------------ | -------------------------------------------------------------------------------- | --------------------------- | ----------------------------- |
| the tree as of authoring | —                                                                                | 54                          | 58                            |
| EPIC 014                 | 0 — it amends vocabulary and adds no route                                       | 54                          | 58                            |
| EPIC 015                 | 5 — `actor.register`, `actor.list`, `actor.show`, `actor.revoke`, `actor.rotate` | 59                          | 63                            |
| EPIC 016                 | 0 — it changes no contract entry                                                 | 59                          | 63                            |
| EPIC 017                 | 3 — `node.create`, `node.update`, `node.delete`                                  | 62                          | 66                            |
| **EPIC 018, this epic**  | **3** — `node.claim`, `node.heartbeat`, `node.release`                           | **65**                      | **69**                        |

Write `65` at `:16` and `69` at `:25`.

**Guard the precondition, do not absorb a surprise.** Before editing, read both literals. When they are not `62` and `66`, a sibling epic changed its route count and this derivation is stale: **stop and report it to the human** rather than adding three to whatever is there. Adding a relative delta to an unverified base hides a sibling's contract change behind a green test.

The four `deferred` rows at `src/http/contract/parity.test.ts:26-34` are unchanged, and `69 - 65 = 4` still holds, so that difference is a second check on both numbers.

The `it` title at `src/http/contract/parity.test.ts:24` reads `reads fifty-seven rows and pins the four deferred ones` while the assertion below it reads `58`. The title is already one behind the literal, and this story is what moves the literal to `69`. **Rewrite the title to name no count**: `pins the four deferred rows`. A spelled-out number in a test name is a second copy of a scalar that no assertion reads, and it has already drifted once.

## Constraints

- Add exactly three operations. Add no `stubbed` row and change no existing row.
- `run.start` stays `stubbed`. No internal driver behaviour ships.
- Every declared operation appears exactly once in `src/http/contract/`.
- Every path segment comes from a closed set, and `node` stays singular.
- No handler branches on a domain rule, reads a database or opens a transaction.
- `http/server/` imports `commands/`, `queries/`, `http/contract/`, `http/server/` and `domain/`. It imports no service implementation.
- `registryFaults(registry)` must stay empty.

## Verify

`src/http/contract/error-details.test.ts` — add one describe block:

- `leaseHeldDetails parses the held-by-other variant` — a successful parse asserted with `assert.deepEqual` over all seven members, one failing parse with an extra key, and one failing parse with a `relation` outside `leaseRelations`.
- `leaseHeldDetails parses the stale-fence variant` — a successful parse, and a failing parse that omits `presentedFence`.
- `leaseHeldDetails refuses a variant with no refusal member` — the discriminator is required.
- `leaseHeldDetails refuses a held-by-other object that omits fence` — the member Story 5 added exists for this schema, so its absence must fail.
- `illegalTransitionDetails parses all three variants and refuses a fourth refusal literal` — one successful parse per variant asserted with `assert.deepEqual`, plus a failing parse with `refusal: "something-else"`.
- `illegalTransitionDetails refuses an ancestor variant with no ancestorId` and `refuses a node-state variant that carries an ancestorId` — the two variants are not interchangeable.
- `every refusal of the three commands has a details variant` — a table-driven assertion listing the nine refusal names of the mapper table and asserting each one's declared `details` object parses against the schema the operation declares for its code.

`src/http/contract/registry.test.ts`:

- `node.claim, node.heartbeat and node.release each declare memory idempotency and replayable [200]` — asserted by operation id.
- `each of the three admits human and harness` — asserted by operation id against the exact list `["human", "harness"]`.
- `a harness token calling actor.register is still refused` — the existing EPIC 015 assertion, unchanged, so the widening reached these three operations only.
- `registryFaults(registry) is empty` — the existing assertion.
- `the three new paths render as expected` — assert `renderPath` gives `/v1/node/:id/claim`, `/v1/node/:id/heartbeat` and `/v1/node/:id/release`.

`src/http/contract/parity.test.ts`:

- `comparable.length` is `65` and `proposalRows.length` is `69`, both asserted as absolutes, and `compareRouteSets` reports empty `missingFromRegistry`, `missingFromProposal` and `mismatched`.
- the four `deferred` operation ids are unchanged, and the `it` title names no count.

New handler test files `src/http/server/node/claim-node.test.ts`, `heartbeat-node.test.ts` and `release-node.test.ts`, each through `createTestApp` of `test/helpers/app.ts` with an injected handler map. Per file:

- `a successful call answers 200 with the contract response shape` — parse the body through the contract response schema.
- `each refusal maps to its declared code` — one case per row of the mapping table above, asserted through a command stub that throws that refusal, and asserted on both the status and the `error.code` of the envelope.
- `a body with an unknown key is 400 invalid-request` — the strict object refuses it.
- `node.claim with any body member is 400 invalid-request` — the empty strict object refuses it.
- `node.heartbeat and node.release with no fence are 400 invalid-request`.
- `the handler calls its command exactly once` — a counting stub.
- `the handler passes the authenticated actor and never a body actor` — assert the stub received `context.actor`, and assert a body carrying an `actorId` is refused by the strict object.
- `a replayed node.heartbeat under a repeated Idempotency-Key returns the captured expiresAt and writes nothing` — drive two requests with the same key against a counting command stub; assert the second response equals the first byte for byte and the stub was called once. This is the exact hazard the fresh-key rule of Story 12 exists for.

Run:

- `node --test src/http/contract/error-details.test.ts src/http/contract/registry.test.ts src/http/contract/parity.test.ts src/http/server/node/claim-node.test.ts src/http/server/node/heartbeat-node.test.ts src/http/server/node/release-node.test.ts` exits 0.
- `npm run verify` exits 0 at the close of this story.
- Proof: `PASS EPIC-018`, through the six files above. Hermetic coverage: `.agents/plan/epics/018-claim-and-lease.md:212-214`.
