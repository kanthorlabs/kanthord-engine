# Story 6 — `provider.defaultUnset`

Epic: `.agents/plan/epics/021-provider-contract-and-default-transfer.md`
Depends on: Story 5. Coupled with Stories 5 and 7; run no full gate between them.

## Change

- Inside the clearing loop Story 5 adds to `src/commands/provider/set-default-provider.ts`, append one event per cleared row, immediately after that row's `UPDATE`, through `dependencies.events.append(transaction, …)` with exactly

```ts
{
  subjectKind: "provider",
  subjectId: other.id,
  type: "provider.defaultUnset",
  actorKind: "human",
  actorId: input.actor,
  payload: {
    name: other.name,
    kind: other.kind,
    unsetAt: stampedAt,
  },
}
```

- `stampedAt` is the single `clock.now()` value of the transaction, so an unset and the following set carry the same instant.
- The payload key order is `name`, `kind`, `unsetAt`, which mirrors the `provider.defaultSet` payload at `src/commands/provider/set-default-provider.ts:109-113`.

## Constraints

- Append one event per cleared row. A single `provider.defaultTransferred` event covering two subjects is refused: an event carries one subject, and `event.list?subject=<id>` is how one registration's history is read.
- Append every event inside the same transaction as the writes.
- Change no schema. `src/domain/event.ts` declares `type: z.string()`, and `src/http/contract/event.ts` declares `payload: z.unknown()`, so a new type is a new literal at its append site and nothing else.
- Amend no proposal file for the event name. The proposal names no provider event.
- Add no event-type registry, no enum and no constant module. Every event type in the tree is a literal at its append site.
- Change `provider.defaultSet` in no way, in this command or in `src/commands/provider/register-provider.ts:82-99`.

## Verify

- Add to `src/commands/provider/set-default-provider.test.ts` a test named `"the transfer events carry the exact envelopes and payloads"`. Register llm A, register llm B, transfer to B, then read the two appended events by `id` and assert, for the `provider.defaultUnset` event: `subject_kind === "provider"`, `subject_id === A`, `type === "provider.defaultUnset"`, `actor_kind === "human"`, `actor_id` equal to the input actor, and `payload_json` exactly `'{"name":"<A name>","kind":"llm","unsetAt":<stampedAt>}'`. Assert for the `provider.defaultSet` event: `subject_id === B` and `payload_json` exactly `'{"name":"<B name>","kind":"llm","setDefaultAt":<stampedAt>}'`. The two `stampedAt` values are the same number.
- Read the events through the `readEvents` helper **after** Story 5 adds `ORDER BY id ASC` to it and pins an ascending mock ULID list. `readEvents` queries the `event` table directly and never calls `SqliteEventLog.list`, so the production `ORDER BY id` of that method proves nothing about this test; the helper's own ordering and the seeded id list are what make the order deterministic here. Do not cite `SqliteEventLog.list` as the guarantee.
- Run `node --test --test-timeout=60000 src/commands/provider/set-default-provider.test.ts` during the coupled batch.
- After Story 7, run `npm run verify`; it exits 0.
- Proof: `PASS EPIC-021` for `src/commands/provider/*.test.ts`, plus Hermetic coverage "The transfer" bullet 2.
