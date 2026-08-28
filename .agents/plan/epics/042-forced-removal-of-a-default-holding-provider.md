# EPIC 042 — Forced removal of a default-holding provider

Status: **draft**. It follows EPIC 041 by sequence order and closes Gap 1 of the dashboard handoff.

## Goal

A human removes the last `llm` provider through the API, so an account returns to zero registrations:

- `provider.remove` accepts `force`, and a forced removal overrides the `default-chain` blocker;
- a forced removal still refuses `project-binding`, `repository` and `attempt`;
- `docs/proposal/api/credential.md` states which blocker `force` overrides and why the other three
  are not overridable.

## Non-goals

- **No blanket force.** `force` overrides exactly one blocker kind. A `project-binding`,
  `repository` or `attempt` blocker refuses a forced removal exactly as it refuses an unforced one.
  `repository.credential_id` and `attempt.provider_id` are `NOT NULL REFERENCES provider(id)`, so
  overriding either would leave a registered repository pointing at a deleted credential or destroy
  the audit history the product exists to keep.
- **No `provider.clearDefault`.** The handoff withdrew it. A lifecycle operation to toggle a flag
  with no consumer outside the provider domain is not built.
- **No blocker removal.** `default-chain` stays in `ProviderRemovalBlocker` and stays first in the
  fixed blocker order. An unforced removal of a stamped provider still refuses with it, so the
  EPIC 101 Proof at `.agents/plan/epics/101-credential-registry-completion.md:61` keeps passing
  unchanged.
- **No chain repair.** A forced removal of a stamped holder leaves the `llm` default chain without a
  head and appoints no successor. A human calls `provider.setDefault` to stamp one. A forced removal
  of an unstamped provider has no chain effect at all.
- **No CLI command.** `provider.remove` has no CLI spelling today and is listed as uncovered at
  `src/cli/parity.test.ts:245`. That list is unchanged.
- **No migration and no schema change.** `set_default_at` keeps its column and its meaning.

## Decisions

- **`force` is a query parameter on the existing operation.** `provider.remove` is
  `DELETE /v1/provider/:id` and carries no body. The registry entry at
  `src/http/contract/credential.ts:390` gains `query: providerRemoveRequest`, defined as
  `z.strictObject({ force: z.enum(["true", "false"]).optional() })`. Absent and `"false"` are the
  same value. Every other string is `400 invalid-request`, and an empty value is one of them: a
  destructive override is stated, never inferred from a client that built `?force=` by
  concatenation. The schema therefore carries no `preprocess` and no `transform`. The handler parses
  `singleValued(context.query)` through that schema, which is the convention of
  `src/http/server/node/list-node.ts:19` and `src/http/server/event/list-event.ts:22`.

- **The command takes a boolean, not a string.** `RemoveProviderInput` gains `force: boolean`. The
  handler converts the parsed query value once. `src/commands/provider/remove-provider.ts` never
  sees a string, because a command holds business logic and parses no transport value.

- **`force` suppresses the blocker, it does not skip the read.** The command still selects
  `set_default_at`. When it is non-null and `force` is false, it pushes `{ kind: "default-chain" }`
  as it does today. When it is non-null and `force` is true, it pushes nothing. The three
  referential blockers are collected in the same fixed order in both cases, so a forced removal of a
  provider blocked by all four answers `409 binding-in-use` with three blockers, never four and never
  zero.

- **A forced removal appends `provider.removed` only.** It appends no `provider.defaultUnset`. The
  row is deleted in the same transaction, so the flag does not transition to a new value — the
  subject ceases to exist, and `provider.removed` is the event that records it. Adding
  `provider.defaultUnset` would require a `clock` dependency that
  `removeProvider({ storage, events }, …)` does not have, to timestamp the disappearance of a row
  the same transaction deletes. The event payload of `provider.removed` is unchanged.

- **`force` is inert when nothing is stamped.** `force: true` on a provider whose `set_default_at`
  is null behaves exactly as `force: false`. There is no refusal for a force that changed nothing,
  because the client cannot know the flag before it calls.

- **The proposal records the asymmetry.** `docs/proposal/api/credential.md:42-48` lists the four
  blockers and justifies the third and the fourth as non-optional. It is amended to state that
  `force` overrides the first blocker and only the first, that the second, third and fourth stay
  mandatory for the reasons already written there, and that a forced removal leaves the `llm` chain
  empty until a human calls `provider.setDefault`.

## Stories

1. **The command admits `force` and suppresses one blocker.** Extend `RemoveProviderInput` in
   `src/commands/provider/remove-provider.ts` with `force: boolean` and guard the
   `default-chain` push at lines 68-70 with it. Extend
   `src/commands/provider/remove-provider.test.ts` with the forced and unforced cases of every
   blocker combination named in the coverage below.

2. **The contract declares the query parameter.** Add `providerRemoveRequest` to
   `src/http/contract/credential.ts`, attach it as `query` on the `provider.remove` entry, and add a
   `query` member to `providerRemoveExamples`. Extend `src/http/contract/credential.test.ts` with the
   parse cases. `ProviderRemovalBlocker` and `providerBindingInUseDetails` are unchanged.

3. **The handler parses `force` and passes a boolean.** Extend
   `src/http/server/credential/remove-provider.ts` to parse `singleValued(context.query)` through
   `providerRemoveRequest`, to answer `400 invalid-request` on a parse failure, and to call the
   command with the converted boolean. Extend
   `src/http/server/credential/remove-provider.test.ts`. `src/main.ts` changes only if the bound
   handler signature requires it.

4. **The proposal records what `force` overrides.** Amend `docs/proposal/api/credential.md` with the
   asymmetry of the Decisions above.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/commands/provider/remove-provider.test.ts \
  src/http/contract/credential.test.ts \
  src/http/contract/registry.test.ts \
  src/http/server/credential/remove-provider.test.ts \
  src/http/server/credential/refusals.test.ts \
  src/main.test.ts \
  && echo "PASS EPIC-042"
```

Hermetic coverage required beyond the Proof:

- A stamped provider with no other blocker refuses with exactly `[{ kind: "default-chain" }]` when
  `force` is absent, and the row still exists. The same provider with `force=true` answers `200`
  with `{ id }`, and the row is gone.
- A stamped provider that a `project_binding`, a `repository` and an `attempt` all name answers
  `409 binding-in-use` with `force` absent and `details.blockers` deep-equal to the four entries in
  the EPIC 101 order. With `force=true` it answers `409 binding-in-use` with the same list minus the
  `default-chain` entry, in the same relative order, and the row still exists.
- An unstamped provider with no other blocker answers `200` for both `force` absent and `force=true`,
  and the two runs produce the same response body and the same event rows.
- A forced removal of a stamped provider appends exactly one event, `provider.removed`, whose payload
  is deep-equal to `{ name, kind }`. No `provider.defaultUnset` row exists after the call.
- After a forced removal of the only stamped `llm` provider, `SELECT count(*) FROM provider WHERE
kind = 'llm' AND set_default_at IS NOT NULL` is `0`, and a subsequent `provider.register` of an
  `llm` provider stamps it, because `register-provider.ts` reads "no `llm` registration exists".
- `force=false` and `force` absent are the same request, asserted by deep-equal response bodies.
  `force=`, `force=1`, `force=yes` and `force=TRUE` each answer `400 invalid-request`, and the row
  still exists after each.
- Two `force=true` values in one query string are refused by `singleValued` before the command runs.
- The refusal construction path cannot receive a payload or a ciphertext:
  `Object.keys(error).sort()` of the `binding-in-use` error is deep-equal to
  `["blockers", "name", "refusal"]`, unchanged by this epic.
- The registry test still lists `provider.remove` as `routed`, and `src/cli/parity.test.ts` still
  lists it as uncovered.
