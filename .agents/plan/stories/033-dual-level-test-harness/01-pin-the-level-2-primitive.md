# Story 1 — Pin the level-2 primitive

Epic: `.agents/plan/epics/033-dual-level-test-harness.md`
Depends on: EPIC 032.

## Change

- Edit `test/helpers/agent.test.ts:describe("test/helpers/agent.test")`.
- Keep the four existing case names and assertions unchanged.
- Add one fifth case named `reports an assigned ephemeral port`.
- Construct a fresh `Koa`, then call `await loopbackServer(app)`.
- Read `server.address()` once into `address`.
- Assert that `typeof address` is `"object"` and that `address` is not `null`.
- Assert that `typeof address.port` is `"number"` after narrowing the address object.
- Assert that `address.port > 0` is `true`. Do not assert an exact port.
- Do not edit `test/helpers/agent.ts:loopbackServer` or `test/helpers/agent.ts:loopbackAgent`.

## Constraints

- Add exactly one `it` case. The file total becomes five.
- Keep `listen(0, "127.0.0.1")`, `server.unref()`, and the `WeakMap` behavior unchanged.
- Use no timer, fixed port, external network, temporary directory, or ambient configuration.

## Verify

- Run `node --test test/helpers/agent.test.ts`.
- The command passes five cases and fails zero cases.
- The new case proves that the assigned port is numeric and above zero.
- Run `npm run verify`; it exits 0.
- Proof: delivers the `test/helpers/agent.test.ts` line for ephemeral-port resolution.
- Proof: delivers the gate bullet **"Ephemeral-port resolution is proved"**.
- Proof: the repository pass count rises by exactly one from the EPIC 033 baseline.
