# EPIC 028 — Event tail read

Status: **draft**. It sits after EPIC 027 in the sequence. It shares one file with
`026-event-long-poll.md`; see Open items.

Source: the `kanthord-apps` contract asks, item P3, answered at `e2ff3cf`. The answer was decided
before this epic existed, so this file is its first record in the repository. The client holds the same
decision and builds against it.

**This epic was split out of a draft that also carried the plan choice values.** `027-plan-choice-values.md`
owns that half. The two share no schema, no command and no service; the only overlap was the
field-decisions fixture and one `new-decisions.md` row. The split costs one extra release-bound publish
and it is accepted.

## Goal

An audit screen reads the newest events first. `event.list` gains `before` and `order`, so one request
reads the tail of an append-only log that a client previously had to drain from the beginning, and a
poller that restarts with no stored cursor costs one request rather than one hundred.

## Non-goals

- **No `wait` parameter.** `026-event-long-poll.md` owns it and lands before this epic. This epic adds no held request and no wake-up path.
- **No tail operation.** See D3.
- **No dense sequence and no gap detection.** `docs/proposal/api/event.md:24` refuses it, and reading a log backwards does not change that.
- **No second index on `event`.** `migration-0004-event-indexes.ts` is unchanged. See D2's last paragraph.
- **No paging on any other route.** `cursorRequest` has exactly one consumer. See D1.
- **No change to the response shape.** `eventListResponse` and `eventView` at `src/http/contract/event.ts:19-32` are untouched; only the order of the array changes.
- **Nothing about `plan.validate`.** `027-plan-choice-values.md` owns the choice branch values.

## Decisions

### D1 — `event.list` gains `before` and `order`, and `cursorRequest` has exactly one consumer

`src/http/contract/cursor.ts:3-6` declares `after` and `limit`. `src/services/event/sqlite.ts:88-97`
turns `after` into `id > ?` and hard-codes `ORDER BY id ASC`. So the log reads oldest-first only, and a
client with no stored cursor drains it from the beginning.

```ts
export const cursorRequest = z.strictObject({
  after: z.string().min(1).optional(),
  before: z.string().min(1).optional(),
  order: z.enum(["asc", "desc"]).default("asc"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
```

`before` is an exclusive **upper** bound and becomes `id < ?`. `order` selects `ORDER BY id ASC` or
`ORDER BY id DESC`. `LIMIT` is applied after the ordering, so `order=desc` with a limit returns the
newest page and nothing else. `EventFilter` at `src/services/event/index.ts:26-33` gains
`before?: string` and `order?: "asc" | "desc"`, and an absent `order` reads `ASC`.

**The shared-schema claim in the reply to the client is false, and this decision states the correction.**
`grep` for `cursorRequest` over `src/` finds two production references and both are the schema and its
example: `src/http/contract/event.ts:9,11` extends it, and nothing else imports it. `node.list` uses
`nodeListQuery` (`src/http/contract/graph.ts:130-136`) and takes no cursor at all. So **`event.list` is
the only paged route in the product**, this epic changes one route's query, and "every paged route
gains the three parameters" was wrong. The schema stays in `cursor.ts` because it is the cursor
vocabulary a second paged route will extend, not because a second one exists.

### D2 — `asc` stays the default, and a range is half-open

`order` carries `.default("asc")`, so **every request a client sends today parses to the same value and
returns the same page.** That is the whole compatibility argument, and it is checkable: `limit` already
carries a default and emits `required=false` in the published document
(`src/http/contract/field-decisions.fixture.ts:49`), so `order` emits the same and no client that omits
it fails to send a valid request.

`after` and `before` are independent and combinable, and together they select the half-open range
`(after, before)`. Both bounds are exclusive, in that one word, so no reader has to remember which end
is inclusive.

**An empty or inverted range is `200` with an empty array, never a refusal.** `after` at or above
`before` returns no row, and the daemon does not compare the two ids to refuse the request. A refusal
would require the daemon to assert that both strings are ULIDs of the same log, which it does not
assert for `after` today, and an empty page is already the answer a caller must handle at the end of
the log.

**No index is added.** `event` has a primary key on `id`, and every clause this decision touches is a
range over that key with an `ORDER BY` on the same key, in one direction or the other. So both
directions are an index-ordered scan and neither needs a sort step or a new index. The epic asserts
that structural fact and not a measured cost; `migration-0004-event-indexes.ts` is unchanged and the
epic adds no migration.

### D3 — no tail operation

The client offered "an operation that returns the newest id" as its second acceptable shape. It is
refused. `GET /v1/event?order=desc&limit=1` answers it with the operation that already exists, and the
first id of any `order=desc` page is the newest id in that filter, so a separate operation would add a
67th operation, a handler, a query, a CLI command and a proposal row to return a value the changed
route already returns. It also answers a narrower question: a tail id alone does not let a client walk
backwards, so the client would still need `order=desc`.

### D4 — the CLI reaches both parameters

`src/cli/event/list.ts:57-64` exposes `--after` and `--limit` and forwards them as query members. It
gains `--before <event-id>` and `--order <asc|desc>`, in the same shape, forwarded the same way. The
CLI is the contract's second consumer per AGENTS.md, and a parameter no CLI flag reaches is a
parameter the daemon publishes and the product cannot use.

`--order` passes its value through unvalidated, exactly as `--limit` does: the daemon's request schema
is the validator, and a client-side enum check would duplicate it and drift. `kanthord event list
--order sideways` therefore fails with the daemon's `400 invalid-request`.

## Stories

Run them in this order. Each passes the full gate on its own.

- **`event.list` reads the tail** — add `before` and `order` to `src/http/contract/cursor.ts` per D1. Add `before?: string` and `order?: "asc" | "desc"` to `EventFilter` at `src/services/event/index.ts:26-33` and to `ListEventInput` at `src/queries/event/list-event.ts:12`. In `src/services/event/sqlite.ts`, push `id < ?` for `before` beside the `id > ?` of line 89, and select the `ORDER BY` direction from `order` at line 97, defaulting to `ASC`. Add `order: "asc"` to `eventListExamples.query` at `src/http/contract/event.ts:35-42`, so the published example names the parameter. Change the handler at `src/http/server/event/list-event.ts` in no way: it already forwards `parsed.data` whole. Regenerate the field-decisions fixture; two rows appear beside `event.list.query#/properties/after` at line 48, `before` with `required=false nullable=false enum=-` and `order` with `required=false nullable=false enum=asc,desc`.
- **The CLI reaches the tail** — add `--before <event-id>` and `--order <asc|desc>` to `src/cli/event/list.ts` per D4, in the option list at lines 57-64 and in the query object at lines 66-77. Validate neither client-side.
- **The proposal records the tail** — amend `docs/proposal/api/event.md:18`, which says paging is `after` plus `limit`. It states the half-open exclusive range, both directions, that `asc` is the default, and that the first id of an `order=desc` page is the newest id, so no tail operation exists. `docs/proposal/api/new-decisions.md` gains one row. Line 20's `wait` paragraph and line 24's gap refusal are unchanged.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test src/http/contract/cursor.test.ts \
  src/http/contract/event.test.ts \
  src/http/contract/coverage.test.ts \
  src/http/contract/example.test.ts \
  src/http/contract/openapi.test.ts \
  src/services/event/sqlite.test.ts \
  src/queries/event/list-event.test.ts \
  src/http/server/event/list-event.test.ts \
  src/cli/event/list.test.ts && echo "PASS EPIC-028"
```

Hermetic coverage required beyond the Proof:

**The event tail**

- `event.list` with no `order` returns exactly the page it returns on the pre-epic tree, for a log of ten events and a `limit` of three: the three oldest, in ascending id order. This is the D2 compatibility claim and it is the assertion that must pass unchanged.
- `order=desc` with `limit=3` over the same ten events returns the three **newest**, in descending id order. The first id equals the newest id in the log, which is what D3 relies on.
- `before=<the fifth id>` with the default order returns the four oldest and not the fifth. Exclusive, asserted by the absence of the boundary row.
- `after=<the third id>&before=<the seventh id>` returns exactly the fourth, fifth and sixth. Both bounds exclusive, in one assertion.
- `after=<the seventh id>&before=<the third id>` returns `200` with an empty array, and so does `after` equal to `before`. No refusal, per D2.
- `order=desc` combined with `subjectKind`, `subject`, `type`, `actorKind` and `actor` returns the newest matching rows only, so the direction composes with every filter rather than replacing them.
- `order=sideways` is `400 invalid-request` through the real app, and the body carries no `details`.
- `cursorRequest.parse({})` returns `{ order: "asc", limit: 100 }`, and the emitted `event.list.query` carries `order` with `required=false` and `enum=asc,desc`. The default is in the schema, not in the query layer.
- `SqliteEventLog.list` with `order` absent emits `ORDER BY id ASC`, asserted through the returned order over a log whose insert order and id order differ.
- `kanthord event list --order desc --before <id>` sends both as query members, asserted against the recorded request of the CLI's fake client, and `--order sideways` fails with the daemon's refusal and not with a client-side check.
- A publish into a temporary directory carries `before` and `order` in `features/event.yaml`:

```bash
node scripts/publish-contract.ts "$(mktemp -d)"
```

## Open items

- **One correction is owed to the client, and it falsifies something the reply at `e2ff3cf` asserted.** The reply said the three cursor parameters reach "every paged route". D1 proves there is one paged route: only `src/http/contract/event.ts:9,11` imports `cursorRequest`. Send it before the client plans a shared pager.
- **`026-event-long-poll.md` edits the same file, and whichever lands second inherits the merge.** Its D1 adds `wait` to `src/http/contract/cursor.ts`, and this epic adds `before` and `order` there. The two additions do not conflict semantically — a `wait` on a `desc` page is a legal request that returns the newest page immediately — but the file, the fixture rows and the `cursorRequest.parse({})` default assertion are touched by both. EPIC 026 is sequenced first, so this epic reads `wait` as present; if the order inverts, EPIC 026 inherits the same merge and neither decision changes.
- **`wait` combined with `order=desc` is not specified by either epic.** A long poll waits for an event _after_ a cursor, which is an ascending idea. `wait` with `order=desc` and no `before` would return the newest page at once and never wait. That is defensible and it is not decided. The condition to open it: the client asks to long-poll a descending page. Until then, EPIC 026 owns `wait` and this epic owns direction, and neither claims the combination.
- The published artifact changes shape, so `npm run contract:publish -- ../kanthord-apps/docs/api/contract` runs from a clean tree after this epic lands. Under `024-release-bound-contract-publish.md` that publish also requires the release tag.
