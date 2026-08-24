# Story 13 — The idempotency record key carries the actor

Epic: `.agents/plan/epics/015-actor-identity.md`
Depends on: Story 5 (`context.state.actor`).

## Change

- `src/http/server/idempotency-key.ts:60-64`: add a **required** `actorId: string` field to `RecordKeyInput`, after `parameters`.
- `src/http/server/idempotency-key.ts:66-73`: `recordKey` renders four segments — `operationId`, the rendered parameters, `actorId`, then `key`:

  ```ts
  return `${input.operationId}�${rendered}�${input.actorId}�${input.key}`;
  ```

  **The separator is `�`, U+FFFD REPLACEMENT CHARACTER — the character the file already uses.** It is not U+241F. Read the existing bytes before editing and reuse that exact separator; changing it would break every pinned string in `src/http/server/idempotency-key.test.ts:261-316`.

- The actor id sits in **its own segment, before the client key**, so no parameter value and no key value can forge a segment boundary.
- `src/http/server/idempotency.ts`: in the `memory` path, read the resolved actor from `(context.state as AuthenticatedState).actor` and pass its `id` to `recordKey`. `authMiddleware` runs at `src/http/server/app.ts:78` and the idempotency middleware at `:82-88`, so authentication has resolved the actor before the key is built.
- **`plan.import` is not scoped by actor.** The `durable` branch at `src/http/server/idempotency.ts:61-77` returns before `recordKey` runs, so it takes no `actorId` and needs no edit. An `importId` names one import of one plan, not one caller's attempt, so two actors that submit the same `importId` must collapse to one import. Actor scoping would admit a second import row for the same identity and break that invariant.

## Constraints

- The field is required, not optional with a default. A default is how a caller silently shares a namespace.
- The bootstrap human actor supplies the fixed `bootstrapActorId`, so a phase-1 deployment with one configured token keeps **one** namespace and every phase-1 behaviour is preserved. Actor scoping narrows the key namespace only; it removes no replay.
- The memory idempotency cache stays process-local and in-memory. A daemon restart empties it and a retried `POST` re-executes, which is what `docs/proposal/api/README.md:134` already documents. Do not persist it.
- Do not change the segment order. `actorId` before `key` is what makes a client-supplied key unable to spoof an actor segment.
- Do not touch the `durable` branch.

## Verify

- `src/http/server/idempotency-key.test.ts` — every existing `recordKey({ ... })` call literal must gain `actorId`, or `npm run typecheck` fails. Update the pinned expected strings accordingly, and add cases asserting:
  - `recordKey` with `operationId: "project.create"`, empty `parameters`, `actorId: "actor_A"` and `key: "k"` renders exactly the following. Read the separator from the existing source; it is U+FFFD, written here as an escape so no formatter can rewrite it:

    ```
    project.create��actor_A�k
    ```

  - **Two actors whose ids differ by one character produce different keys**, asserted for two real `actor_` ids differing in the final character.
  - **A key value containing the separator cannot forge a boundary.** With `actorId: "actor_A"` and the key below, the rendered value differs from the value rendered for `actorId: "actor_B"` with `key: "x"`. Assert the two strings are not equal.

    ```
    �actor_B�x
    ```

  - A parameter value containing the separator likewise cannot collide with a different actor id.
  - The same actor and the same key render the identical string across two calls.
- `src/http/server/idempotency.test.ts` — update every affected fixture and add:
  - **Two registered harnesses send the same `Idempotency-Key` on the same `memory` operation.** The second request does not join the first, does not answer `409 idempotency-mismatch`, and receives its own answer from its own execution. Assert this for **both** shapes: when the two handler bodies are byte-identical, and when they differ. Drive the two actors by overriding `resolveActor` per request.
  - **A slow first request does not make the second answer `503 service-unavailable`.** Hold the first handler on a test-controlled promise, issue the second under a different actor, and assert it answers from its own execution while the first is still in flight.
  - **A replay of the same key by the same actor still returns the stored answer**, so scoping removes no replay.
  - The store holds two records for the two-actor case and one for the replay case, asserted through `store.size()`.
  - **`plan.import` under two actors with the same `importId` reaches the command once.** Issue the same `importId` from two different actors and assert the bound command recorded exactly one call, and that `store.size()` stays `0` because the durable path reserves nothing.
- Run `node --test --test-timeout=60000 src/http/server/idempotency-key.test.ts src/http/server/idempotency.test.ts src/http/server/idempotency-store.test.ts src/http/server/idempotency-record.test.ts src/http/server/idempotency-response.test.ts`; each exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-015`, and Hermetic coverage lines 152, 153, 154 and 155.
