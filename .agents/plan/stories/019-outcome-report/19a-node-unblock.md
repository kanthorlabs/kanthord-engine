# Story 19a — `node.unblock`, the one exit from `attempt-limit`

Epic: `.agents/plan/epics/019-outcome-report.md`
Depends on: Story 3 (the spend clause makes the state reachable), Story 18 (the error-details pattern and the field-decision fixture) and Story 19 (the handler map and the CLI registration pattern).

This story runs after Story 19 and before Story 20, so the Proof block of Story 20 finds every path.

## Change

### 1. A new `src/commands/node/unblock-node.ts`

```ts
export type UnblockNodeDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  events: EventLog;
  clock: Clock;
}>;

export type UnblockNodeInput = Readonly<{
  nodeId: string;
  actorId: string;
  actorKind: "human" | "harness";
}>;

export function unblockNode(
  dependencies: UnblockNodeDependencies,
  input: UnblockNodeInput,
): UnblockNodeResult;
```

The dependency set holds four members and no more. It names no `Execution`, no `Lease`, no `Git` and no `WorkspaceStore`, because the command reads no run, no lease and no working tree. Declare `UnblockNodeError` with the refusals `not-found`, `node-kind-invalid`, `not-blocked` and `block-reason-not-clearable`, plus `actor-forbidden`.

It opens one transaction through `storage.transact` and captures one `now` from `clock.now()`. The body runs in this exact order.

1. `input.actorKind === "harness"` throws `actor-forbidden`. The registry gate of EPIC 015 already refuses it before the handler; the command repeats the check because an operation that admits one kind must raise the same code from the command.
2. Read the node through `plan.readNode`. An absent node throws `not-found`.
3. A `kind` of `objective` or `initiative` throws `node-kind-invalid`. Only a task reaches `attempt-limit`.
4. A `state` other than `blocked` throws `not-blocked` with `details: { state }`.
5. A `block_reason` other than `attempt-limit` throws `block-reason-not-clearable` with `details: { blockReason }`. The literal `"attempt-limit"` is compared directly. `unblockableReasons` belongs to EPIC 111, and this command holds no tuple of its own, so the rule lives in one place per epic.
6. `plan.setNodeState(transaction, { id: node.id, from: "blocked", to: "pending", trigger: "manual-unblock", blockReason: null, at: now, cause: { revision: node.revision, importId: null } })`. The returned `readonly ReadinessTransition[]` is the readiness result, and the command reads it to fill the response state.
7. Append one event:

```ts
dependencies.events.append(transaction, {
  subjectKind: "node",
  subjectId: node.id,
  type: "node.unblocked",
  actorKind: "human",
  actorId: input.actorId,
  payload: {
    from: "blocked",
    to: "pending",
    clearedReason: "attempt-limit",
  },
});
```

Steps 6 and 7 sit in the one transaction of this command. A state transition and its event append never sit in two transactions.

`UnblockNodeResult` is `Readonly<{ node: NodeView }>`. The `state` it carries is `ready` when the readiness pass promoted the node inside step 6, and `pending` when it did not. `setNodeState` calls `readiness.apply` in the same transaction, per `.agents/plan/stories/016-readiness-applied/04-closed-mutation-api.md`, so this command needs no scheduler, no timer and no second write.

### 2. `src/http/contract/outcome.ts` — the lifecycle flip

Set `status: "routed"` on the existing `node.unblock` entry. Change no other member of that entry: the method, the path, `introducedIn`, `idempotency` and `replayable` stay as they are. Add `allowedActors: ["human"]`. The operation takes no request body and no query. Declare `errors` holding `not-found`, `invalid-request` and `illegal-transition` beside `baselineErrors`, declare `response: nodeUnblockResponse`, and declare one example set, because `src/http/contract/coverage.test.ts` requires a response schema, `errors` and examples of every routed operation and exempts `blob.show` alone.

```ts
export const nodeUnblockResponse = z.strictObject({ node: nodeShowResponse });
```

`src/http/contract/error-details.ts` gains:

```ts
export const nodeUnblockDetails = z.strictObject({
  refusal: z.enum([
    "node-kind-invalid",
    "not-blocked",
    "block-reason-not-clearable",
  ]),
  blockReason: z.enum(blockReasons).nullable(),
});
```

EPIC 111 renames that schema to `nodeControlDetails` and widens its enum when it routes `node.abandon`. This story authors the three-member enum and nothing wider.

`src/http/contract/parity.test.ts:16,25` counts do **not** change for this operation: the `node.unblock` row already exists in the proposal table and in the registry, so only its status cell moves. `src/http/contract/field-decisions.fixture.ts` does grow, because a routed operation declares a response schema; take the derived rows from the `coverage.test.ts` assertion diff, never by hand.

### 3. The proposal row

`docs/proposal/api/outcome.md` — the `node.unblock` row of the Routes table at `:9-14` changes from `stubbed` to `routed` and from phase 2 to `phase-1`. The file gains one `node.unblock` section stating the one clearable reason, the three refused reasons, the human-only actor, and that the route resets no workspace and reads no lease. No `sql` fence of that file moves, so `test/helpers/proposal.ts` compares the same bytes.

### 4. The handler

A new `src/http/server/node/unblock-node.ts`, in the shape of `src/http/server/node/show-node.ts`: parse the path parameter, call `unblockNode` once, format the response. It branches on no domain rule. The refusal mapping beside it, in the pattern of `src/http/server/plan/refusals.ts`, maps `not-found` to `404 not-found`, `node-kind-invalid` to `400 invalid-request`, and `not-blocked` and `block-reason-not-clearable` to `409 illegal-transition` with `nodeUnblockDetails`. `actor-forbidden` maps to `403 actor-forbidden`, with the code EPIC 015 declares.

### 5. The composition root and the CLI

`src/main.ts` — the handler map gains `node.unblock`, so `unimplementedFor(handlers)` at `:338` holds it no longer. The binding passes `storage`, `plan`, `events` and `clock`, all of which `main.ts` already constructs.

A new `src/cli/node/unblock.ts` exports `registerNodeUnblock`. The leaf is `kanthord node unblock --id <id>` and it takes no other option, because the route takes no body. It prints `kanthord: node <id> <state>`, where `<state>` is the state the response returned. A refusal prints `kanthord: <code>: <message>` with a non-zero exit through `src/cli/exit-code.ts`.

`src/cli/program.ts` calls `registerNodeUnblock` beside the three registrations of Story 19. `src/cli/inventory.ts:6` gains `["node", "unblock"]` with `["node.unblock"]`.

## Constraints

- The dependency set holds exactly `storage`, `plan`, `events` and `clock`. A fifth member is a defect.
- The command clears `attempt-limit` and no other reason. It declares no reason tuple.
- The transition and the event append sit in one transaction.
- `allowedActors` is `["human"]`, so the harness-admitting set of EPIC 020 is unchanged at sixteen names.
- The trigger is `manual-unblock`, declared by EPIC 014 as an internal trigger. `externalTriggerConsumer` gains no entry, because an internal trigger needs none.
- Every refusal asserts a byte-identical database, zero recorded `EventLog.append` calls and zero recorded `setNodeState` calls.
- Import no vendor package and no other command.

## Verify

Create `src/commands/node/unblock-node.test.ts`, suite name `"src/commands/node/unblock-node.test"`.

- `it("an unblock of an attempt-limit task returns it to the pool", ...)` — the node is `pending` with a null `block_reason`, and exactly one `node.unblocked` event names it with `actorKind` of `"human"`, the input actor id, and `Object.keys(payload)` deep-equal to `["from", "to", "clearedReason"]`.
- `it("readiness promotes a satisfied task in the same transaction", ...)` — the fixture holds no unsatisfied dependency; the response state is `ready`, the stored state is `ready`, and one `node.ready` event carries `actorKind: "daemon"`.
- `it("an unsatisfied task stays pending", ...)` — the fixture holds one unsatisfied dependency; the response state is `pending`, and zero `node.ready` events exist.
- `it("the unblock and its event commit together", ...)` — an event append that throws leaves the node `blocked` with its reason, and a state write that throws leaves zero `node.unblocked` events. Assert both directions.
- `it("a harness actor is actor-forbidden", ...)` — byte-identical before and after.
- `it("an absent node is not-found", ...)` — byte-identical before and after.
- `it("an objective and an initiative are node-kind-invalid", ...)` — one case each, byte-identical before and after.
- `it("a task that is not blocked is not-blocked", ...)` — drive `pending`, `ready`, `running`, `awaiting_approval`, `done`, `partial` and `discarded`; all seven write nothing, and `details.state` names the current state.
- `it("a block reason other than attempt-limit is block-reason-not-clearable", ...)` — drive `dependency-discarded`, `dirty-recovery`, `stale-base` and `abandoned`; each writes nothing and `details.blockReason` names the stored reason.
- `it("the trigger is manual-unblock", ...)` — over a recording `PlanStore` fake, the one call names `manual-unblock`, and no other trigger appears.
- `it("the command reads no run, no lease and no workspace", ...)` — asserted **against the dependency type** in the pattern of `111-inspection-and-manual-controls.md`: declare `type Assert<T extends true> = T` and assert that none of `"execution"`, `"lease"`, `"git"` or `"workspaces"` is a key of `UnblockNodeDependencies`.

Create `src/http/server/node/unblock-node.test.ts` and `src/cli/node/unblock.test.ts`.

- `it("each refusal maps to its declared status", ...)` — `404`, `400` and the two `409 illegal-transition` cases, each with `details.refusal` and `details.blockReason` asserted.
- `it("the handler parses, invokes once and formats", ...)` — a recording command counts exactly one call.
- `it("node unblock prints the returned state", ...)` — `ready` and `pending` each print, and the recorded operation ids are exactly `["node.unblock"]`.

Registry and inventory:

- `src/http/contract/registry.test.ts` finds `node.unblock` with `status: "routed"` and `allowedActors: ["human"]`, and finds the harness-admitting set unchanged.
- `src/http/contract/coverage.test.ts` exits 0, which requires the response schema, the `errors` list and the example set.
- `src/cli/parity.test.ts` reports no difference with `["node", "unblock"]` in `declaredCommands`.
- `unimplementedFor(handlers)` built from the production handler map of `src/main.ts` does not contain `node.unblock`.

Route level, in `src/main.report.test.ts` of Story 20:

- A task left `blocked` with reason `attempt-limit` is unblocked by the **configured human token**, answers `200`, reads `ready`, is then claimed by the same harness under a **new** run id asserted not equal to the ended run id and with attempt number 1, is reported `accepted`, and its objective then attests and closes to `done`.
- The same request under a harness token is `403 actor-forbidden` with a byte-identical database.

- `node --test src/commands/node/unblock-node.test.ts src/http/server/node/unblock-node.test.ts src/cli/node/unblock.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `src/commands/node/unblock-node.test.ts`, `src/http/server/node/unblock-node.test.ts`, `src/cli/node/unblock.test.ts`. Hermetic coverage: the four `node.unblock` assertions of `019-outcome-report.md` and the unblock clause of its `013-external-drive-overview.md` capability row.
