# EPIC 026 — Event tail read — stories

Epic: `.agent/plan/epics/026-event-tail-read.md`
Prereq: EPIC 025 (sequence order).

`event.list` gains `before` and `order`, so one request reads the newest page of the append-only log.

## Dispatch order

1. `01-event-list-reads-the-tail.md`
2. `02-the-cli-reaches-the-tail.md` — depends on Story 1 (the daemon must accept the parameters the flags send).
3. `03-the-proposal-records-the-tail.md` — documentation only, no source change.

Stories 1 and 2 are not a coupled pair: each passes the full gate alone, because Story 2's tests drive a fake client and never reach the daemon. The dependency is product-level — the flags Story 2 adds are refused by a daemon without Story 1.

## Stories

- 1 — `before` and `order` reach the contract, the query and the SQLite log → `01-event-list-reads-the-tail.md`
- 2 — `--before` and `--order` reach `kanthord event list` → `02-the-cli-reaches-the-tail.md`
- 3 — `docs/proposal/api/event.md` and `new-decisions.md` record the range and the direction → `03-the-proposal-records-the-tail.md`

## Facts (needed for implementation)

- **These stories are written against the tree at authoring time, where `wait` does not exist.** `wait` is in neither `src/http/contract/cursor.ts` nor `eventListRequest`. Therefore `src/http/contract/event.test.ts:17` ("rejects wait") and `src/http/server/event/list-event.test.ts:137` are true and stay unchanged.
- **The long poll lands after this epic, and the numbering now says so.** `028-event-long-poll.md` adds `wait`. The epics were renumbered for this: the tail read is EPIC 026 and the long poll is EPIC 028, so the sequence rule and the landing order agree and no story carries an exception.
- **The long poll edits `cursorRequest` in no way.** `.agent/plan/epics/028-event-long-poll.md` D1 adds `wait` to `eventListRequest` in `src/http/contract/event.ts:11-17`, and names `cursor.ts` only to cite `limit` as the `z.coerce` precedent. So no story here has to reserve anything in `cursor.ts` for it, and `wait` cannot appear in `cursorRequest`. If it ever does, the epic changed and Story 1 is stale.
- `cursorRequest` has exactly one importer: `src/http/contract/event.ts:9`. No other query schema derives from it.
- The field-decisions fixture is regenerated, never hand-edited: `node scripts/field-decisions-probe.mjs --write` rewrites `src/http/contract/field-decisions.fixture.ts` from the live registry, sorted bytewise. `src/http/contract/coverage.test.ts:314` asserts fixture equals the walk.
- `src/http/contract/coverage.test.ts:528-545` asserts `^\s*after:` and `^\s*limit:` appear in `cursor.ts` only. Story 1 adds `order: "asc"` to `src/http/contract/event.ts`, so **do not extend that test to `order`** — `order:` will legitimately appear in two contract files.
- `src/http/contract/coverage.test.ts:546-575` compares each `cursorRequest`-derived property against `cursorRequest`'s own JSON Schema for the names `after` and `limit` only. Leave the name list unchanged.
- `test/helpers/ids.ts` `createMockIdGenerator({ ulids })` mints in array order and throws `ids-exhausted` past the end. Passing unsorted ULIDs makes insert order differ from id order.
- `src/queries/event/list-event.ts:32` forwards the input object to `EventLog.list` unchanged. `src/http/server/event/list-event.ts:22` forwards `parsed.data` whole. Neither needs a new branch.
- `openApiFeatures` groups by the `operationId` prefix (`src/http/contract/openapi.ts:18-42`), so the published slice is `features/event.yaml`.
- `src/http/contract/parity.test.ts` reads only the proposal route matrix table. A prose edit in `docs/proposal/api/event.md` cannot break it.
