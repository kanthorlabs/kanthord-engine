# Story 14 — The three routes and their contract entries

Epic: `.agent/plan/epics/018-claim-and-lease.md`
Depends on: Story 1, Story 5, Story 10, Story 11, Story 12. **This story closes the `src/http/contract/parity.test.ts` failure Story 1 opened.**

## Change

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
- The three responses carry, respectively: the claim result of Story 10 (`lease`, `objectiveLease`, `runId`, `objectiveRunId`, `attemptId`, `attemptNo`, `heartbeatIntervalMs`, `node`); the heartbeat result (`lease`, `objectiveLease`, `heartbeatIntervalMs`); and the release result (`node`).
- `baselineErrors` at `src/http/contract/error-baseline.ts:4-13` already carries `invalid-request` and `not-found`. The three operations therefore declare `lease-held`, `illegal-transition` and `plan-invalid` **beside** it, and no operation redeclares `invalid-request` or `not-found`.

`errorStatuses` at `src/http/contract/errors.ts:7-28` already holds `lease-held`, `illegal-transition` and `plan-invalid`. Add no error code in this story.

### `src/http/contract/error-details.ts`

Append after `invalidRequestDetails` at `:75-79`:

```ts
export const leaseHeldDetails = z.strictObject({
  subject: z.string().min(1),
  holder: z.string().min(1),
  holderKind: z.enum(leaseOwnerKinds),
  fence: z.int(),
  expiresAt: epochMillis,
  relation: z.enum(leaseRelations),
});
```

`leaseRelations` comes from `src/domain/lease-hierarchy.ts` of Story 5; `http/contract/` may import `domain/`. Add `illegalTransitionDetails` in the same file if it does not exist yet: `z.strictObject({ state: z.string().min(1), admitted: z.array(z.string().min(1)).min(1) })`, widened with an optional `ancestorId` for the cascade refusal of Story 11.

### `src/http/server/node/`

Three new handler files, `claim-node.ts`, `heartbeat-node.ts` and `release-node.ts`, in the shape of `src/http/server/node/list-node.ts`. Each one **parses, invokes exactly one command, and formats**. A handler that branches on a domain rule is a defect.

Each handler:

1. parses the body with the contract request schema; a parse failure throws `httpError("invalid-request", ...)`.
2. reads the node identity from `context.parameters` and the actor from `context.actor`, which EPIC 015 made a required member of `HandlerContext`.
3. calls its one command inside a `try`, and passes every thrown error to the shared refusal mapper.
4. returns `{ status: 200, body }`.

One new file `src/http/server/node/refusals.ts`, in the exact pattern of `src/http/server/plan/refusals.ts`. `toHttpError(error)` maps each refusal of the three commands, and rethrows anything it does not recognise:

| refusal                    | code                 |
| -------------------------- | -------------------- |
| `node-not-found`           | `not-found`          |
| `initiative-not-claimable` | `invalid-request`    |
| `plan-incomplete`          | `plan-invalid`       |
| `drive-mode-pinned`        | `illegal-transition` |
| `lease-held`               | `lease-held`         |
| `illegal-transition`       | `illegal-transition` |
| `ancestor-not-startable`   | `illegal-transition` |

`initiative-not-claimable` carries `details` `{ refusal: "initiative-not-claimable" }`.

### Authorization

**This epic adds exactly three authorization rows**, `node.claim`, `node.heartbeat` and `node.release`, each `allowedActors: ["human", "harness"]`. A harness claiming and reporting its own work is the rule `.agent/plan/epics/015-actor-identity.md:50` states.

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

- `leaseHeldDetails parses the six members and refuses a seventh` — one successful parse asserted with `assert.deepEqual`, one failing parse with an extra key, and one failing parse with a `relation` outside `leaseRelations`.

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
- Proof: `PASS EPIC-018`, through the six files above. Hermetic coverage: `.agent/plan/epics/018-claim-and-lease.md:212-214`.
