# Story 12 — The application binding

Epic: `.agents/plan/epics/015-actor-identity.md`
Depends on: Story 5, Story 10.

## Change

- `src/main.ts`: construct `const secret = new NodeCryptoSecret();` beside the existing `crypto` construction, and bind the resolver once:

  ```ts
  const resolveActorFor = (presented: string) =>
    resolveActor(
      { storage, secret, configuredToken: settings.http.token },
      { presented },
    );
  ```

  This is the **only** identity binding. Story 4's step 0 serves the empty-configured-token mode from inside the query, so there is no second `bootstrapActor` dependency to bind.

- `src/main.ts`: build the five actor handlers and add them to the `handlers` map at `:213-337`, keyed by their operation ids — `actor.register`, `actor.list`, `actor.show`, `actor.revoke`, `actor.rotate`. Each handler takes its command or query bound to `{ storage, secret, ids, events, clock }` as the command needs, and `register-actor` additionally takes `configuredToken: settings.http.token`. After this edit `unimplementedFor(handlers)` at `:338` contains **none** of the five ids.
- `src/main.ts:342`: pass `resolveActor: resolveActorFor` into `createApp`, alongside the existing `settings` block. `AppDependencies` gained that field in Story 5.
- Verify that `bindingOffenders` at `src/http/server/app.ts:129-156` reports an empty array for the assembled application. A routed operation that is neither bound nor declared unimplemented is an offender, and so is one that is both.

## Constraints

- A registry row is not proof of a bound handler. `src/http/server/app.ts:120-127` derives `unimplemented` from the routed set minus the bound set, and `src/http/server/dispatch.ts:26-31` answers `501` for an unbound routed operation. This story is what makes the Goal true.
- Bind the five actor handlers only. This is not the composition-root completeness sweep; EPIC 020 owns that.
- `main.ts` is the only file that names an implementation. `NodeCryptoSecret` appears here and in its own test, nowhere else.
- Construct `secret` once and share it. A second instance would be harmless but is not the pattern.

## Verify

- **The application-level registration test.** Create `src/http/server/actor/registration.test.ts`, suite name `src/http/server/actor/registration.test`. Build a real app through `test/helpers/app.ts` with all five actor handlers bound against a real migrated storage, a real `NodeCryptoSecret`, and a real `resolveActor` wired to that storage — not a fake resolver, because the point is the round trip.
  - Call `POST /v1/actor` with the configured token and the body `{ name: "harness-1" }`. Assert `200` and capture the returned `token`.
  - Call `GET /v1/node` with that captured token as the bearer. Assert `200`, and assert the bound `node.list` handler **received an actor** whose `id` equals the registered row id and whose `kind` equals `"harness"`. Record the received `HandlerContext.actor` in the test handler to assert it.
  - Assert `unimplementedFor(handlers)` contains none of `actor.register`, `actor.list`, `actor.show`, `actor.revoke`, `actor.rotate`. **Without this assertion a routed row that answers `501` passes**, because `src/http/server/app.ts:129-156` admits an unbound routed operation.
  - Assert `bindingOffenders` for the same handler map is an empty array.
  - **A revoked harness token is `401 unauthenticated`.** Revoke the registered actor through `POST /v1/actor/<id>/revoke` with the configured token, then repeat `GET /v1/node` with the harness token and assert `401`.
  - **The linearization rule.** Issue a `GET /v1/node` whose bound handler blocks on a promise the test controls. While it is in flight, revoke the actor through a second request and let it commit. Release the first handler and assert it still completes with `200`. Then assert a third request with the same token is `401`. The exposure window is one in-flight request.
  - **`actor.rotate` end to end.** Register a second harness, assert `GET /v1/node` is `200`, rotate through `POST /v1/actor/<id>/rotate` with the configured token, assert the new token differs from the old, assert the **old** token is now `401`, and assert the **new** token is `200` on `GET /v1/node`.
- `src/main.test.ts`: extend the `fixtures` map with one entry per new routed operation — `actor.register`, `actor.list`, `actor.show`, `actor.revoke`, `actor.rotate` — each naming an expected status, and keep `pending` as `[] as const`. No fixture takes an "any-but-501" status. The two existing cases at `:181` and `:219` then cover the five ids against the daemon `launchDaemon` starts from `src/main.ts`.
- Run `node --test --test-timeout=60000 src/http/server/actor/registration.test.ts src/main.test.ts src/http/server/app.test.ts`; each exits 0.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-015`, and Hermetic coverage lines 105, 113 (the application half) and 120.
