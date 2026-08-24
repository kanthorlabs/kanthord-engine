# Story 5 — `setNodeState` validates the pair and the trigger

Epic: `.agents/plan/epics/016-readiness-applied.md`
Depends on: Story 4. **Both belong to the atomic unit 04 + 05 + 07 + 08 + 10**; see Story 4.

## Change

### `src/services/plan/sqlite.ts`

Add these imports:

```ts
import { triggerTransition } from "../../domain/node-trigger.ts";
import { canTransition } from "../../domain/transition.ts";
```

Add three guards to `SqlitePlanStore`, at the positions Story 4 numbers. The order is **matrix, then declaration, then level.**

**Step 2 — the matrix check.** `before.kind` comes from `readNode`.

```ts
if (!canTransition(before.kind, input.from, input.to)) {
  throw new Error(
    `${before.kind} ${input.from} -> ${input.to} is not in the transition matrix`,
  );
}
```

**Step 3 — the declaration check.**

```ts
const declared = triggerTransition(input.trigger);
if (declared.from !== input.from || declared.to !== input.to) {
  throw new Error(
    `trigger ${input.trigger} declares ${declared.from} -> ${declared.to}, the write names ${input.from} -> ${input.to}`,
  );
}
```

**Step 4 — the level check.**

```ts
if (!declared.levels.includes(before.kind)) {
  throw new Error(
    `trigger ${input.trigger} declares levels ${declared.levels.join(",")}, the node is a ${before.kind}`,
  );
}
```

The three messages are exact. A test asserts each one.

The matrix check comes first so that it is reachable and observable. Every row of both trigger tables names a legal cell — `src/domain/node-trigger.test.ts` asserts it — so a declaration check placed first would make `canTransition` dead code that only a source scan could "prove".

Each guard throws a plain `Error`. `src/services/plan/index.ts` declares no error class, and `src/commands/startup/recover-expired-leases.ts:143` already throws a plain `Error` for the same premise. A declaration that disagrees with its write is a programmer defect and reaches no HTTP refusal, so it needs no code union.

## Constraints

- Do not add a hand-listed pair set. `canTransition` at `src/domain/transition.ts:468` is the only matrix oracle, and `src/domain/transition.test.ts:106-120` already asserts it against `allowedPairs`.
- Do not add a `PlanError` class and do not add a `PlanErrorCode` union.
- Do not validate inside `mutateGraph`. `mutateGraph` writes only the readiness pairs its own `deriveReadiness` stamped, and `src/domain/node-trigger.test.ts` already asserts every internal row names a legal cell at every level of its `levels` list.
- Keep the `AND state = ?` guard on both update statements.
- Add no validation to `insertNode`, `addEdge` or `removeEdge`.

## Verify

Add to `src/services/plan/sqlite.test.ts`.

The four expected messages, exactly. Copy them from this block, never from a bullet below:

```
M1  task pending -> running is not in the transition matrix
M2  trigger readiness-promoted declares pending -> ready, the write names blocked -> pending
M3  trigger readiness-promoted declares pending -> ready, the write names pending -> blocked
M4  trigger claim-taken declares levels objective,task, the node is a initiative
```

Each case below reaches exactly one guard, because the guard before it passes. That is why the pairs differ.

- `it("setNodeState refuses pending to running through the matrix", ...)` — seed a `pending` task and call `setNodeState` with `from: "pending"`, `to: "running"`, `trigger: "readiness-promoted"`. `docs/proposal/phase-1/state-machine.md:64` marks the pair invalid at all three levels, so the matrix check refuses it. Assert `assert.throws` against **M1**, and assert the node row is byte-identical before and after. This is `canTransition` as an observable branch, not a source scan.
- `it("setNodeState throws when the declared from disagrees", ...)` — `trigger: "readiness-promoted"`, `from: "blocked"`, `to: "pending"`, on a `blocked` task. `blocked → pending` is legal at all three levels, so the matrix check passes and the declaration check refuses. Assert `assert.throws` against **M2**.
- `it("setNodeState throws when the declared to disagrees", ...)` — `trigger: "readiness-promoted"`, `from: "pending"`, `to: "blocked"`, `blockReason: "attempt-limit"`, on a `pending` task. `pending → blocked` is legal at all three levels, so the declaration check refuses. Assert `assert.throws` against **M3**.
- `it("setNodeState throws when the node kind is outside the declared levels", ...)` — `trigger: "claim-taken"` declares `levels: ["objective", "task"]` and `ready → running`. Seed an **initiative** in `ready` and call with `from: "ready"`, `to: "running"`. `ready → running` is legal at all three levels and the declared pair matches, so the level check refuses. Assert `assert.throws` against **M4**.
- **`it("every trigger id writes only its declared pair, at only its declared levels", ...)`** — this replaces the deleted source scan of `.agents/plan/stories/014-external-drive-contract/15-trigger-consumer-map.md:31`. Import `internalTriggerIds` and `triggerTransition` from `src/domain/node-trigger.ts`, `externalTriggerIds` from `src/domain/external-transition.ts`, `nodeStates` and `nodeKinds` from `src/domain/state.ts`, and `canTransition` from `src/domain/transition.ts`. Loop over all twenty-one ids.

  **Isolation.** Build a **fresh migrated database per trigger id** through `build()`, and dispose it at the end of that iteration. One iteration never observes another's rows. Do not accumulate cases in one database.

  **The subject and its parents.** Seed exactly one subject node per case. Where the subject kind needs a parent, seed the chain — a `task` needs an `objective` parent and an `objective` needs an `initiative` parent, per `seedGraph` at `test/helpers/rows.ts:79`. **Seed every parent in state `done`.** A `done` node is never a readiness subject, so no parent is promoted or demoted, and no incidental readiness event appears. Seeding a parent as `pending` makes each successful write append an extra `node.ready` event and breaks any event assertion in the loop.

  **Eligibility, pinned by the declared `to`.** `setNodeState` applies readiness after its own write, so the stored state after the call is not always `declared.to`. Pin the subject's dependencies so readiness leaves it alone:
  - `declared.to === "pending"` — give the subject **one unwaived dependency in `pending`**. Without it, readiness immediately promotes the subject back to `ready` and the assertion fails. `readiness-demoted` is the trigger this rule exists for.
  - `declared.to === "ready"` — give the subject **no dependency edge**. A subject left `ready` with an unsatisfied dependency is demoted back to `pending`. This rule covers `readiness-promoted`, `recovery-requeued`, `run-cancelled-requeued` and `attempt-rejected`.
  - every other `declared.to` — give the subject no dependency edge. `running`, `blocked`, `awaiting_approval`, `done`, `partial` and `discarded` are never readiness subjects, so eligibility cannot move the node.

  Seed each dependency node as a sibling `task` in `pending` under the same parent, with its own identity.

  **`blockReason`.** Pass `blockReason: "attempt-limit"` when `declared.to === "blocked"`, and `blockReason: null` for every other `to`. The `node` table couples `blocked` to a non-null `block_reason`.

  **The four assertions per trigger id.**
  1. **Positive, per declared level.** For each `level` of `declared.levels`: seed the subject of that kind in `declared.from` under the rules above, call `setNodeState` with `{ from: declared.from, to: declared.to, trigger: id, blockReason }`, and assert the stored state equals `declared.to`.
  2. **A `from` other than the declared one throws.** Choose the **first** member of `nodeStates`, in `nodeStates` order, that differs from `declared.from` and for which `canTransition(level, thatState, declared.to)` is `true`. Seed the subject in that state and assert the declaration message. When no such state exists, skip this assertion for that trigger and assert nothing.
  3. **A `to` other than the declared one throws.** Choose the **first** member of `nodeStates` that differs from both `declared.to` and `declared.from` and for which `canTransition(level, declared.from, thatState)` is `true`. Assert the declaration message. When no such state exists, skip this assertion for that trigger.
  4. **A kind outside the declared levels throws.** For each member of `nodeKinds` **not** in `declared.levels`, seed the subject of that kind in `declared.from` and assert a throw. Which message fires is decided by one computed predicate, not by the implementer:
     - when `canTransition(kind, declared.from, declared.to)` is `false`, assert the **matrix** message;
     - otherwise assert the **level** message.

     Skip the case when the `node` table `CHECK` refuses `declared.from` at that kind. Today that is exactly one condition: `declared.from === "awaiting_approval" && kind !== "objective"`, which skips the negative level cases of `human-close` and `human-close-partial`. Write it as that explicit condition, never as a `try`/`catch`. No trigger of either table declares `from: "partial"` or `from: "done"`, so no further skip exists.

     A trigger whose `levels` holds all three kinds contributes no case here.

- `it("setNodeState writes no row and appends no event when the from state does not match the stored state", ...)` — as Story 4 states. It returns `[]` and throws nothing.
- `it("setNodeState returns an empty list for an unknown node id", ...)` — no throw, no write.
- `node --test src/services/plan/sqlite.test.ts src/domain/node-trigger.test.ts src/domain/transition.test.ts` exits 0.
- **A `setNodeState` input with no `trigger` member fails `npm run typecheck`.** Prove it at the type level, not by source text. Add a module-scope fixture to `src/services/plan/sqlite.test.ts`:

  ```ts
  // @ts-expect-error trigger is required on SetNodeStateInput
  const stateInputWithoutTrigger: SetNodeStateInput = {
    id: "task_a",
    from: "pending",
    to: "ready",
    blockReason: null,
    at: 1,
    cause: { revision: "revision_a", importId: null },
  };
  ```

  The missing required member fails the assignment today, so `@ts-expect-error` is satisfied. Making `trigger` optional turns the directive into an unused-directive error and `npm run typecheck` fails. Add one runtime assertion (`assert.ok(stateInputWithoutTrigger)`) so the binding is used. `tsconfig.json` compiles `src/**/*.test.ts`, so the directive is checked by the same command the gate runs.

- `npm run typecheck` exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-016`, through `src/services/plan/sqlite.test.ts` and `src/domain/layout.test.ts`. Hermetic coverage: `.agents/plan/epics/016-readiness-applied.md:98`, `:99`, `:100` and `:101`.
