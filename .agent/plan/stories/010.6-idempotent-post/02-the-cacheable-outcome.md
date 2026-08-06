# Story 2 — The cacheable outcome, declared per operation

Epic: `.agent/plan/epics/010.6-idempotent-post.md`
Depends on: Story 1.

## Change

### 1. `src/http/contract/operation.ts` — the `replayable` field

Add one **optional** member to `Operation`, immediately after `idempotency` (added by Story 1):

```ts
  replayable?: readonly number[];
```

It stays optional, for the same typecheck reason Story 1 gives.

### 2. `src/http/contract/registry.ts` — two more faults

Extend the loop Story 1 appended (the one that ends the `registryFaults` body before
`return faults;`). Append these two checks **after** the two Story 1 checks, inside the same
`for (const entry of entries)`, in this exact order:

```ts
if (entry.replayable !== undefined && idempotencyOf(entry) !== "memory") {
  faults.push({
    operationId: entry.operationId,
    reason: "replayable outcome without a memory policy",
  });
}
if (
  idempotencyOf(entry) === "memory" &&
  (entry.replayable === undefined || entry.replayable.length === 0)
) {
  faults.push({
    operationId: entry.operationId,
    reason: "memory idempotency without a replayable outcome",
  });
}
if (entry.replayable !== undefined) {
  const distinct = new Set(entry.replayable);
  const legal = entry.replayable.every(
    (status) => Number.isInteger(status) && status >= 100 && status <= 599,
  );
  if (!legal || distinct.size !== entry.replayable.length) {
    faults.push({
      operationId: entry.operationId,
      reason: "replayable outcome is not a distinct status list",
    });
  }
}
```

The fourth check exists so the field cannot drift into a value the middleware would compare against
forever without matching: a float, a `0`, a `700`, or `[200, 200]`. It fires independently of the
policy checks, so a malformed list on a `none` entry reports both faults.

Neither fires on an entry that omits both members, so every existing synthetic-entry assertion in
`registry.test.ts` keeps its current result.

### 3. Declare `replayable: [200]` on the eighteen `memory` entries

Add `replayable: [200],` on the line after `idempotency: "memory",` in each of the 18 literals
Story 1 marked `memory`. The value is the same for all eighteen, and it is written out at each
site — no shared constant, no spread.

`200` is the only success status in this API. `docs/proposal/api/README.md:88`: "Every route
answers `200` on success, a creating `POST` included. No route declares `201`." No other status is
listed anywhere: a `409`, a `404`, a `422` and a `501` are all left uncached, so the second request
runs the command again.

`plan.import` declares `durable` and therefore declares **no** `replayable`. Fault 3 of Story 2
would fire if it did.

### 4. New file `src/http/server/idempotency-record.ts` — the classifier

Pure. No koa import, no `node:` import.

```ts
export type OutcomeState = "replayable" | "indeterminate" | "uncacheable";

export type ClassifyInput = Readonly<{
  replayable: readonly number[] | undefined;
  status: number;
  internal: boolean;
}>;

export function classifyOutcome(input: ClassifyInput): OutcomeState;
```

Apply these rules in this exact order and return on the first match. The order is normative.

1. `input.internal === true` → `"indeterminate"`. This is the command that committed and then
   threw while formatting its response. Its record is stored and replayed, and the command never
   runs a second time under that key.
2. `input.replayable !== undefined && input.replayable.includes(input.status)` → `"replayable"`.
3. Otherwise → `"uncacheable"`. The record is dropped and a later duplicate runs the command
   again.

Rule 1 precedes rule 2 unconditionally. A `500` produced by a non-`HttpError` throw is never
`"replayable"`, even if a future operation were to list `500`.

`internal` is `false` for every `HttpError`, including a `500` that a handler raised deliberately
through `httpError("internal-error", …)`. Story 6 defines the flag.

## Constraints

- Do not infer a policy from a status class anywhere. `classifyOutcome` is the only place a status
  meets a policy, and it reads only the declared array.
- Do not add `409`, `404` or `422` to any `replayable` array.
- `src/http/server/idempotency-record.ts` imports nothing. Keep it that way so its test needs no
  fixture.

## Verify

`node --test src/http/server/idempotency-record.test.ts` — new file. Suite name
`src/http/server/idempotency-record.test`. Table-driven, asserting the exact `OutcomeState`:

| replayable  | status | internal | expected        |
| ----------- | ------ | -------- | --------------- |
| `[200]`     | `200`  | `false`  | `replayable`    |
| `[200]`     | `409`  | `false`  | `uncacheable`   |
| `[200]`     | `404`  | `false`  | `uncacheable`   |
| `[200]`     | `422`  | `false`  | `uncacheable`   |
| `[200]`     | `400`  | `false`  | `uncacheable`   |
| `[200]`     | `501`  | `false`  | `uncacheable`   |
| `[200]`     | `500`  | `false`  | `uncacheable`   |
| `[200]`     | `500`  | `true`   | `indeterminate` |
| `[200]`     | `200`  | `true`   | `indeterminate` |
| `undefined` | `200`  | `false`  | `uncacheable`   |
| `undefined` | `500`  | `true`   | `indeterminate` |
| `[]`        | `200`  | `false`  | `uncacheable`   |

The `[200] / 200 / true` row is the rule-order row: rule 1 wins over rule 2. Do not drop it.

`node --test src/http/contract/registry.test.ts` — extend, on top of Story 1:

- **The authored registry stays fault-free**: `registryFaults(registry)` deep-equals `[]`.
- **Every `memory` entry declares `[200]`.** For each `entry` of `registry` with
  `idempotencyOf(entry) === "memory"`, assert `assert.deepEqual(entry.replayable, [200])`.
- **`plan.import` declares no `replayable`.** Assert
  `findOperation("plan.import")?.replayable === undefined`.
- **No non-`memory` entry declares `replayable`.** For each `entry` of `registry`, assert
  `(entry.replayable !== undefined) === (idempotencyOf(entry) === "memory")`.
- **Fault: `replayable` on a `none` entry.** `{ operationId: "g.one", method: "GET",
path: [system("health")], introducedIn: "phase-1", status: "routed", replayable: [200] }` →
  `assert.deepEqual(faults.map((f) => f.reason), ["replayable outcome without a memory policy"])`.
- **Fault: `memory` with no `replayable`.** `{ operationId: "p.one", method: "POST",
path: [resource("project")], introducedIn: "phase-1", status: "routed", idempotency: "memory" }`
  → `assert.deepEqual(faults.map((f) => f.reason), ["memory idempotency without a replayable
outcome"])`.
- **Fault: `memory` with an empty `replayable`.** Same entry with `replayable: []` → the same
  one-element array.
- **Fault: a malformed status list.** With a `POST` entry declaring `idempotency: "memory"`, each of
  `replayable: [200.5]`, `[0]`, `[99]`, `[600]`, `[200, 200]` →
  `assert.deepEqual(faults.map((f) => f.reason), ["replayable outcome is not a distinct status
list"])`.
- **Fault: a malformed list on a `none` entry reports both.** A `GET` entry with
  `replayable: [200, 200]` → `assert.deepEqual(faults.map((f) => f.reason), ["replayable outcome
without a memory policy", "replayable outcome is not a distinct status list"])`. This row pins the
  emission order of the four Story 2 checks.
- **Fault: `durable` carrying `replayable`.** `{ operationId: "plan.import", method: "POST",
path: [resource("project"), parameter("project"), sub("plan"), action("import")],
introducedIn: "phase-1", status: "routed", idempotency: "durable", replayable: [200] }` →
  `assert.deepEqual(faults.map((f) => f.reason), ["replayable outcome without a memory policy"])`.
  This row pins that `durable` never declares a replayable outcome.

`npm run verify` exits 0.

Proof: delivers the `src/http/contract/registry.test.ts` half of the EPIC Proof command, and the
classifier the Proof lines "A `409 lease-held` is not cached" and "marks the key indeterminate"
depend on.
