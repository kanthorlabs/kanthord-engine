# Story 2 — The CLI reaches the tail

Epic: `.agent/plan/epics/026-event-tail-read.md`
Depends on: Story 1.

## Change

### `src/cli/event/list.ts`

In `EventListOptions` (lines 15-23), add two members after `after?: string;` at line 21:

```ts
  before?: string;
  order?: string;
```

`order` is typed `string`, not a union. The daemon's request schema is the validator.

In the option list, add `--before` immediately after the `--after` option at line 63, and `--order` immediately after the `--limit` option at line 64:

```ts
    .option("--before <event-id>", "event upper bound")
    .option("--order <asc|desc>", "event order")
```

In the query object (lines 67-75), add two entries mirroring the same positions:

```ts
          before: options.before,
          order: options.order,
```

`before` goes after `after:`, `order` goes after `limit:`. The `Object.fromEntries` filter at line 75 already drops an absent value, so no other change is needed.

Change nothing else in the file. `renderPayload`, `renderJson` and the output lines at 91-100 are untouched.

## Constraints

- Validate neither flag client-side. No enum check, no id check, no numeric check.
- Do not change `--after` or `--limit`.
- Do not add the flags to any other CLI command.

## Verify

### `src/cli/event/list.test.ts`

New tests, all through the existing `harness()` fake client:

- The "sends every supplied option on the query" test gains `--before event_01HZY8QF3M4N5P6R7S8T9V0WB0` and `--order desc`, and the recorded `options.query` deep-equals:

```ts
{
  subjectKind: "node",
  subject: "task_01JQ8Z7G3HZZZZZZZZZZZZZZZX",
  type: "node.created",
  actorKind: "harness",
  actor: "actor_01JQ8Z7G3HZZZZZZZZZZZZZZZW",
  after: "event_01JQ8Z7G3HZZZZZZZZZZZZZZZY",
  before: "event_01HZY8QF3M4N5P6R7S8T9V0WB0",
  limit: "25",
  order: "desc",
}
```

- `event list --order desc --before event_01HZY8QF3M4N5P6R7S8T9V0WB0` alone records exactly one call whose `options.query` deep-equals `{ before: "event_01HZY8QF3M4N5P6R7S8T9V0WB0", order: "desc" }`, and whose `body` and `parameters` are `undefined`.
- `event list` with neither flag records `options` equal to `undefined`, so no flag leaks a key.
- `event list --order sideways` records `options.query` deep-equal to `{ order: "sideways" }` — the value passes through unvalidated.
- `event list --order sideways` against a harness whose `respond` returns `{ ok: false, status: 400, code: "invalid-request", message: "the event filters are not valid" }` writes `kanthord: invalid-request: the event filters are not valid\n` to stderr and calls `fail` exactly once. The refusal comes from the daemon result, not from a client-side check.

Every existing test in the file stays and stays passing, unmodified except the one amended above.

### Commands

```bash
node --test src/cli/event/list.test.ts
```

`npm run verify` exits 0.

Proof: `PASS EPIC-026` for `src/cli/event/list.test.ts`, plus Hermetic coverage "The event tail" bullet 10 in full — both clauses: `--order desc --before <id>` recorded as query members against the fake client, and `--order sideways` failing with the daemon's refusal rather than a client-side check.

`src/cli/event/list.test.ts` is already in the Proof block and already passes, so a printed `PASS EPIC-026` proves nothing about this story. Bullet 10 is the only discriminating evidence. The epic is complete when bullet 10 passes and Story 3 has landed.
