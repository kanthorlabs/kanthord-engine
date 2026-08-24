# Story 7 — Authorization as registry data, under one rule

Epic: `.agents/plan/epics/015-actor-identity.md`
Depends on: Story 1 (`RegisteredActorKind`), Story 5 (`context.state.actor`), Story 8 (`actor-forbidden`).

## Change

- `src/http/contract/operation.ts:32-47`: add a **required** field to `Operation`, after `status`:

  ```ts
  allowedActors: readonly RegisteredActorKind[];
  ```

  Import the type from `../../domain/actor.ts`. Required rather than optional, so a new operation cannot omit the declaration and `npm run typecheck` names every row that does.

- Add `allowedActors` to every one of the **54** existing rows across the ten domain modules — `system.ts`, `credential.ts`, `repository.ts`, `project.ts`, `graph.ts`, `outcome.ts`, `execution.ts`, `instruction.ts`, `integration.ts`, `event.ts`. Place it immediately after `status` in each row literal.
- **The rule.** An operation admits `harness` when a harness performs it on its own work: reading the graph it executes, fetching a blob a read returned, claiming a task, or reporting an outcome. An operation admits `human` only when it changes daemon configuration, manages an actor, or takes an approval decision. **Every operation admits `human`.**
- Under that rule, exactly these **nine** rows declare `["human", "harness"]`, in the member order `human` then `harness`:

  `system.health`, `project.list`, `project.show`, `project.status`, `node.list`, `node.show`, `edge.list`, `plan.export`, `blob.show`

  Every other row of the 54 declares `["human"]`, the 27 `stubbed` rows included. `system.status` is excluded because it returns `bind`, the repository divergence set and every live lease (`src/http/contract/system.ts:39-75`). `event.list` is excluded because it carries no per-actor restriction and would disclose every human decision to a harness.

- Create `src/http/server/authorize.ts`, following the middleware shape of `src/http/server/origin.ts:1-40`.

  ```ts
  export function authorizeMiddleware(): (
    context: Context,
    next: Next,
  ) => Promise<void>;
  ```

  It reads `(context.state as RoutedState).match.operation.allowedActors` and `(context.state as AuthenticatedState).actor.kind`. When the actor kind is absent from `allowedActors`, it throws `httpError("actor-forbidden", ...)` with a message naming the operation id and the refused kind. Otherwise it calls `await next()`. It takes no dependency argument.

- `src/http/server/app.ts`: insert `authorizeMiddleware()` into the chain **after** `routeMiddleware` at `:79` and **before** `bodyParserForHandled` at `:82`. A refusal therefore precedes any body parse and any idempotency reservation, so a refused request writes nothing and reserves no key.
- Add this epic's authorization assertions to the **existing** `src/http/contract/registry.test.ts`. **Do not create `src/http/contract/authorization.test.ts`** — EPIC 020 creates that file, and two epics cannot both create one path.

  `017-per-node-graph-write.md:90` fixes this ownership twice: it states that EPIC 015 "pins the set of operations admitting `harness` by name at exactly nine members, **in `src/http/contract/registry.test.ts`**", and that "the registry-wide **total** belongs to EPIC 020 alone, which owns `src/http/contract/authorization.test.ts`". `020-wiring-and-scenarios.md:48` independently calls `authorization.test.ts` "a new" file. EPIC 015's own text names no file for the assertion (`015-actor-identity.md:62`, and hermetic lines 125-126), so `registry.test.ts` is the only reading consistent with all three epics. The one sentence that suggests otherwise — `015-actor-identity.md:39`, "the authorization inventory of `src/http/contract/authorization.test.ts`" — describes the inventory **concept** that EPIC 020 will own, and EPIC 020 does add `actor.rotate` to it there.

## Constraints

- `authorize.ts` reads registry data and branches on no domain rule. It contains no operation id literal and no `if` on a path.
- The middleware order is contract. `authorize` after `route` (it needs the matched operation) and before the body parser (a refusal must precede any parse). A stubbed route therefore answers `403` to a disallowed actor and `501` otherwise, because the `501` is raised later, in `src/http/server/dispatch.ts:17-22`.
- Do not make `allowedActors` optional and do not give it a default. A default is how a later row silently admits the wrong actor.
- `RegisteredActorKind` is the two-member vocabulary of Story 1. `daemon` is not a registrable kind and never appears in `allowedActors`.
- This story decides the rule and the rows for the operations that exist **today**. EPICs 017, 018 and 019 add their own rows and their own ids to the named assertion below.
- Add no scope, no role and no per-project grant. The actor kind is the whole permission model.

## Verify

- In `src/http/contract/registry.test.ts`, add a `describe`-level group named `allowedActors` holding these cases, each asserting over the whole registry rather than a sample:
  - Every entry declares a non-empty `allowedActors`, iterated over `registry` with the offending `operationId` in the assertion message.
  - Every entry admits `"human"`.
  - Every member of every `allowedActors` is a member of `registeredActorKinds`.
  - **The harness set by name.** Declare a module-level `export const harnessOperations = [...]` in `src/http/contract/registry.test.ts` holding the nine ids above, sorted bytewise. Assert that the sorted list of ids whose `allowedActors` includes `"harness"` deep-equals `harnessOperations`. **This constant is the extension point EPICs 017, 018 and 019 edit** — `017-per-node-graph-write.md:90` makes adding its three ids to this list that epic's stated obligation. State **no** registry-wide harness total here; the existing operation counts at `:20`, `:25` and `:34-42` are a separate concern and Story 9 updates them.
  - Every operation id outside `harnessOperations` declares exactly `["human"]`, computed as a set difference and never as a count.
  - `"system.status"` and `"event.list"` are each asserted **absent** from the harness set by name.
- Create `src/http/server/authorize.test.ts`, suite name `src/http/server/authorize.test`. Build apps through `createTestApp` from `test/helpers/app.ts`, overriding `resolveActor` to return a `harness` `ActorRow` fixture (`kind: "harness"`, a real `actor_` id) or the `BOOTSTRAP_ACTOR_FIXTURE` of Story 5.
  - `GET /v1/node` and `GET /v1/blob/<hash>` with the harness actor each answer `200`, with a bound handler supplied.
  - `GET /v1/provider`, `GET /v1/status` and `GET /v1/event` with the harness actor each answer `403` with the code `actor-forbidden`, and the message names the operation id.
  - The same three with the bootstrap human actor do **not** answer `403`.
  - **A stubbed route answers `403` to a harness and `501` to the human.** Pick one `stubbed` operation from the registry at test time rather than by literal id, and assert both answers. Assert `internalErrors()` is empty in both cases.
  - **Neither writes state.** For the stubbed route and for the refused `provider.list`, capture `tableCounts(storage)` from `test/helpers/database.ts` before and after and assert deep equality. Build the app against a real migrated storage for this case.
  - A refusal precedes the body parse: `POST /v1/actor` with a harness actor and a **malformed JSON body** answers `403 actor-forbidden`, not `400 invalid-request`. This pins the middleware position.
  - A refusal reserves no idempotency key: the same refused `POST` carrying an `Idempotency-Key` leaves the idempotency store size at 0.
- Run `node --test --test-timeout=60000 src/http/contract/registry.test.ts src/http/server/authorize.test.ts src/http/contract/coverage.test.ts src/http/contract/parity.test.ts src/http/server/app.test.ts`; each exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-015`, and Hermetic coverage lines 117, 123, 124, 125, 126, 132, and the `403` clause of 149.
