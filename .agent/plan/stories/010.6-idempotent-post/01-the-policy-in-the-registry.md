# Story 1 — The policy in the registry

Epic: `.agent/plan/epics/010.6-idempotent-post.md`

## Change

### 1. `src/http/contract/operation.ts` — the policy union and the field

Add after `statusValues` / `OperationStatus` (`operation.ts:16-17`):

```ts
export const idempotencyPolicies = ["none", "memory", "durable"] as const;
export type IdempotencyPolicy = (typeof idempotencyPolicies)[number];
```

Add one **optional** member to `Operation` (`operation.ts:19-28`), after `status` and before
`successStatus`:

```ts
  idempotency?: IdempotencyPolicy;
```

The member is optional, and it stays optional. A required member breaks every synthetic
`Operation` literal in `src/http/contract/registry.test.ts` (`:207-228`, `:230-250`, `:252-270`,
`:272-294`, `:296-311`, `:313-328`, `:330-345`, `:347-362`, `:364-392`, `:394-407`) at typecheck,
and `npm run verify` fails before an assertion runs.

Add the resolver in the same file, after `Operation`:

```ts
export function idempotencyOf(entry: Operation): IdempotencyPolicy {
  return entry.idempotency ?? "none";
}
```

`idempotencyOf` is the only reader. No other file writes `entry.idempotency ?? "none"`.

### 2. `src/http/contract/registry.ts` — two faults

Import `idempotencyOf` from `./operation.ts` beside the existing `Operation` import.

Append one `for (const entry of entries)` loop **after** the existing per-entry loop that ends at
`registry.ts:231` and **before** `return faults;` (`registry.ts:234`). Emit in this exact order per
entry:

```ts
for (const entry of entries) {
  if (entry.method !== "POST" && idempotencyOf(entry) !== "none") {
    faults.push({
      operationId: entry.operationId,
      reason: "idempotency policy outside POST",
    });
  }
  if (
    idempotencyOf(entry) === "durable" &&
    entry.operationId !== "plan.import"
  ) {
    faults.push({
      operationId: entry.operationId,
      reason: "durable idempotency outside plan.import",
    });
  }
}
```

Neither fault fires on an entry that omits `idempotency`, so every existing synthetic-entry
assertion in `registry.test.ts` keeps its current result. `registry.test.ts:207-228` asserts the
exact array `["duplicate operationId"]`; that entry pair is `GET` with no `idempotency`, so it
stays a one-element array.

### 3. Declare the policy on all nineteen `POST` entries

The registry holds exactly 19 `POST` entries. `plan.import` takes `durable`. The other 18 take
`memory`. Add the member on the line after `status:` in each literal. Declare it on `stubbed`
entries too, so an entry that later becomes `routed` needs no second edit; a `501` is never
cached, so the declaration changes no behaviour today.

| file                               | operationId                | status  | policy    |
| ---------------------------------- | -------------------------- | ------- | --------- |
| `src/http/contract/graph.ts`       | `plan.import`              | routed  | `durable` |
| `src/http/contract/graph.ts`       | `plan.validate`            | routed  | `memory`  |
| `src/http/contract/project.ts`     | `project.create`           | routed  | `memory`  |
| `src/http/contract/credential.ts`  | `provider.register`        | routed  | `memory`  |
| `src/http/contract/credential.ts`  | `provider.rename`          | stubbed | `memory`  |
| `src/http/contract/repository.ts`  | `repository.inspect`       | routed  | `memory`  |
| `src/http/contract/repository.ts`  | `repository.register`      | routed  | `memory`  |
| `src/http/contract/repository.ts`  | `repository.landingBranch` | stubbed | `memory`  |
| `src/http/contract/repository.ts`  | `repository.publish`       | stubbed | `memory`  |
| `src/http/contract/repository.ts`  | `repository.reconcile`     | stubbed | `memory`  |
| `src/http/contract/execution.ts`   | `run.start`                | stubbed | `memory`  |
| `src/http/contract/execution.ts`   | `run.cancel`               | stubbed | `memory`  |
| `src/http/contract/instruction.ts` | `node.approve`             | stubbed | `memory`  |
| `src/http/contract/instruction.ts` | `node.discard`             | stubbed | `memory`  |
| `src/http/contract/instruction.ts` | `node.waive`               | stubbed | `memory`  |
| `src/http/contract/instruction.ts` | `node.unblock`             | stubbed | `memory`  |
| `src/http/contract/instruction.ts` | `node.abandon`             | stubbed | `memory`  |
| `src/http/contract/integration.ts` | `profile.instantiate`      | stubbed | `memory`  |
| `src/http/contract/integration.ts` | `profile.verify`           | stubbed | `memory`  |

No `GET`, `PUT` or `DELETE` entry gains the member. There are 29 `GET`, 4 `PUT` and 1 `DELETE`.

## Constraints

- Do not add a registry entry, do not remove one, and do not change any `path`, `method`,
  `status`, `introducedIn`, `request` or `response`. Every count in
  `src/http/contract/registry.test.ts:15,20,29-38,40-57`, `src/http/contract/openapi.test.ts:78,115`,
  `src/http/contract/parity.test.ts:16,25`, `src/http/server/app.test.ts:92,165` and
  `src/http/server/dispatch.test.ts:185,309` must stay unchanged.
- Do not add an error code. `src/http/contract/errors.ts` is untouched by this story.
- `openapi.ts` reads only `request`, `response`, `method`, `path`, `operationId`. Do not emit
  `idempotency` into the generated document.

## Verify

`node --test src/http/contract/registry.test.ts` — extend. Add these tests to the existing
`describe("src/http/contract/registry.test", …)` block:

- **The authored registry stays fault-free.** `registry.test.ts:109-111` already asserts
  `assert.deepEqual(registryFaults(registry), [])`. It must still pass unchanged.
- **Exact policy parity.** Build
  `registry.filter((e) => idempotencyOf(e) !== "none").map((e) => e.operationId).sort(bytewise)`
  and `assert.deepEqual` it against the 19 ids of the table above, sorted bytewise. Use the
  bytewise comparator already used in this repo:
  `(a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))`.
- **Every `POST` and only a `POST` carries a policy.** For each `entry` of `registry`, assert
  `(idempotencyOf(entry) !== "none") === (entry.method === "POST")`.
- **`durable` is `plan.import` alone.** Assert
  `registry.filter((e) => idempotencyOf(e) === "durable").map((e) => e.operationId)` deep-equals
  `["plan.import"]`.
- **`memory` counts 18.** Assert
  `registry.filter((e) => idempotencyOf(e) === "memory").length === 18`.
- **`idempotencyOf` defaults.** Assert `idempotencyOf({ … no idempotency … }) === "none"` on a
  synthetic `GET` entry.
- **Fault: a `GET` declaring `memory`.** `registryFaults([{ operationId: "g.one", method: "GET",
path: [system("health")], introducedIn: "phase-1", status: "routed", idempotency: "memory" }])`
  → `assert.deepEqual(faults.map((f) => f.reason), ["idempotency policy outside POST"])`.
- **Fault: a `PUT` declaring `durable`.** Same shape with `method: "PUT"`,
  `path: [resource("project"), parameter("project")]`, `idempotency: "durable"` →
  `assert.deepEqual(faults.map((f) => f.reason), ["idempotency policy outside POST",
"durable idempotency outside plan.import"])`. This row pins the emission order.
- **Fault: `durable` on another `POST`.** `{ operationId: "project.create", method: "POST",
path: [resource("project")], introducedIn: "phase-1", status: "routed", idempotency: "durable" }`
  → `assert.deepEqual(faults.map((f) => f.reason), ["durable idempotency outside plan.import"])`.
- **No fault: a `GET` declaring `none` explicitly.** Same `GET` entry with
  `idempotency: "none"` → `assert.deepEqual(registryFaults([entry]), [])`.
- **`idempotencyPolicies` is pinned.** `assert.deepEqual(idempotencyPolicies, ["none", "memory",
"durable"])`.

`node --test src/http/contract/openapi.test.ts` — must pass unchanged. The generated document
gains no key.

`npm run verify` exits 0.

Proof: delivers the `src/http/contract/registry.test.ts` half of the EPIC Proof command, and the
Proof line "A registry entry declaring `memory` on a `GET` is a registry fault."
