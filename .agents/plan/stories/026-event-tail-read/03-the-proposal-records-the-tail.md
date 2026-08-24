# Story 3 — The proposal records the tail

Epic: `.agents/plan/epics/026-event-tail-read.md`
Depends on: Story 1.

Documentation only. No file under `src/` or `scripts/` changes.

## Change

### `docs/proposal/api/event.md`

Replace line 18 in full. Line 18 today reads:

```
Paging is a cursor: `after` takes the **id** of the last event read, and `limit` caps the page. An offset cannot page an append-only log that grows while a human reads it.
```

Replace that one line with these three paragraphs, separated by one blank line each:

```
Paging is a cursor: `after` takes the **id** of the last event read, `before` takes an **id** upper bound, and `limit` caps the page. **Both bounds are exclusive**, so `after` and `before` together select the open range `(after, before)`. An offset cannot page an append-only log that grows while a human reads it.

`order` is `asc` or `desc`, and `asc` is the default, so a request that omits it returns the page it always returned. The limit applies after the ordering, so `order=desc` returns the newest page and nothing else. **The first id of an `order=desc` page is the newest id in the filter.** No operation returns a tail id, because `GET /v1/event?order=desc&limit=1` already answers that question.

**An empty or inverted range is a normal `200` with an empty array.** An `after` at or above `before` returns no row. The daemon does not compare the two ids and does not refuse the request.
```

Change no other line. The `wait` paragraph (line 20 before this edit) and the gap-information paragraph (line 24 before this edit) stay byte-identical. Do not touch the route table at lines 9-13.

### `docs/proposal/api/new-decisions.md`

Add exactly one bullet to `## Decided here`, immediately after the existing bullet at line 16 (`- **Cursor paging on events.** An offset cannot page an append-only log.`):

```
- **The event cursor reads both directions, and both range bounds are exclusive.** `event.list` takes `before` beside `after`, both exclusive, and `order` selects `asc` or `desc` with `asc` as the default. An audit screen therefore reads the newest events first with one request. An empty or inverted range is a normal empty `200`, never a refusal. No operation returns a tail id, because the first id of an `order=desc` page is the newest id in the filter. See [event.md](event.md).
```

Add nothing to `## Rejected here` and nothing to `## Still open`. `## Still open` keeps the value `Nothing.`

### Formatting

`lint-staged` runs `prettier --write` over `*.md`. Run it on both files so the committed bytes are stable:

```bash
npx prettier --write docs/proposal/api/event.md docs/proposal/api/new-decisions.md
```

## Constraints

- The route matrix in `docs/proposal/api/event.md` is unchanged. `src/http/contract/parity.test.ts` reads that table and must keep counting 72 rows.
- Add no route, no operation id and no status change.
- Say nothing about `wait` combined with `order=desc`. Neither epic decides it.
- Amend no other proposal file.

## Verify

The baseline comes from `HEAD`, so it needs no capture step and cannot be taken in the wrong order:

```bash
node --test src/http/contract/parity.test.ts
git status --porcelain
diff <(git show HEAD:docs/proposal/api/event.md | grep 'wait') \
     <(grep 'wait' docs/proposal/api/event.md)
```

Assertions:

- `parity.test.ts` passes with 72 proposal rows, unchanged.
- `git status --porcelain` is **unscoped** and must list exactly two modified paths, `docs/proposal/api/event.md` and `docs/proposal/api/new-decisions.md`, plus the untracked story directory. No path under `src/` or `scripts/` appears.
- The `diff` of the `HEAD` and working-tree `wait` lines is empty. Every `wait` line moved by line number only, and no `wait` line changed by one byte.
- `git diff docs/proposal/api/event.md` shows one removed line and the three added paragraphs, and no other hunk.
- `git diff docs/proposal/api/new-decisions.md` shows exactly one added line.
- The three replacement paragraphs match the Change section byte for byte after `prettier --write`. Verify with `grep -Fq` on each of these exact substrings, all three of which must be present:
  - ``**Both bounds are exclusive**, so `after` and `before` together select the open range``
  - ``**The first id of an `order=desc` page is the newest id in the filter.**``
  - `**An empty or inverted range is a normal `200` with an empty array.**`
- `grep -c 'Paging is a cursor' docs/proposal/api/event.md` is `1`.
- `grep -c 'The event cursor reads both directions' docs/proposal/api/new-decisions.md` is `1`.

`npm run verify` exits 0.

Proof: none. This story delivers no line of the `PASS EPIC-026` block — `src/http/contract/parity.test.ts` is not in it — and no Hermetic coverage bullet; every bullet of "The event tail" belongs to Story 1 or Story 2. `parity.test.ts` is covered by the Gates line, `npm run verify`, and it is the only test this story can break.

This story's evidence is the Verify assertions above, not the marker. A printed `PASS EPIC-026` is true before this story runs and stays true after it, so it cannot show the proposal was amended.
