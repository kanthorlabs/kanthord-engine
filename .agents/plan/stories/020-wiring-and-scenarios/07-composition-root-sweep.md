# Story 7 — The composition root, asserted complete over the block

Epic: `.agents/plan/epics/020-wiring-and-scenarios.md`
Depends on: Story 2.

EPIC 009 already holds the two cases. This story extends the fixture map so they cover the block, against a daemon started from the real composition root.

## Change

### `src/main.test.ts`

The two cases are `"every routed operation answers and none resolves to the shared 501 handler"` at `:182` and `"no routed operation is left unbound"` at `:220`, both against `pending` at `:18`. Change neither case body. **`pending` stays `[] as const`.**

Add one entry to the `fixtures` map for each of the **twelve** new `routed` operations of the block. Twelve, not eleven: `015-actor-identity.md:66` declares five actor rows, `actor.rotate` included, and `015-actor-identity.md:39` instructs this epic to carry twelve.

```text
actor.register    actor.list     actor.show      actor.revoke   actor.rotate
node.create       node.update    node.delete
node.claim        node.heartbeat node.release
node.report
```

Each entry follows the existing `Fixture` shape at `src/main.test.ts:33-37` — `parameters`, `body` and `expect`. Rules for every entry:

- **Each fixture names an expected numeric status. No fixture takes `"any-but-501"`**, because a route that answers `500` proves nothing was constructed.
- A fixture that targets a node or an actor uses the `missing(...)` helper the file already uses for an absent id, and expects `404`.
- A fixture whose body is deliberately incomplete expects `400`.
- `actor.list` takes no parameter and expects `200`.

Every one of the twelve admits `human`, and the test calls with the configured token `"test-token"` at `src/main.test.ts:140`, which resolves to the bootstrap `human` actor of EPIC 015. No fixture needs a harness identity.

## Constraints

- **Use no injected handler map at any step.** The daemon under test is the one `launchDaemon` starts from `src/main.ts`. A `routed` operation with no entry in the handler map of `src/main.ts:213-337` sits in `unimplementedFor(handlers)` at `:338`, and `src/http/server/dispatch.ts:26-31` answers `501` while an injected test app answers `200`. That gap is the exact defect this case exists to catch.
- **A `501` here is a defect returned to the owning epic.** Bind no handler in `src/main.ts` from this story.
- Change no case body, no `pending` value and no launch configuration.

## Verify

- `node --test src/main.test.ts` exits 0.
- Deleting one handler binding from the map in `src/main.ts` makes the sweep report `501` for that operation, and the failure message names the operation id. Restore the binding.
- Removing one of the twelve fixtures makes the second case report the id in `residue`. Restore it.
- `npm run verify` exits 0.
- Proof: `src/main.test.ts`. Hermetic coverage: `020-wiring-and-scenarios.md:155`, `:156`.
