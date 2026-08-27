# Story 1 — Delete the unused payload union

Epic: `.agents/plan/epics/037-component-publication-catalogue-or-reachable.md`

Lane: software-engineer. `src/http/contract/event-payload.ts` is a production
`.ts` file, so `scripts/lane-check.sh:78-85` grants it to that lane. This story
deletes no test and writes no test, because no test covers the deleted export.

This story removes dead code before story 2 adds the catalogue extension. It
changes no emitted document, because `eventPayload` reaches none.

## Change

### Edit 1 — delete the union block

`src/http/contract/event-payload.ts` is 273 lines. Delete lines 266 to 273,
which is the blank line at 266 and the whole export:

```ts
export const eventPayload = z.union(
  eventTypes.map((type) => eventPayloads[type]!) as [
    ZodType,
    ZodType,
    ...ZodType[],
  ],
);
```

Line 265 is `};`, which closes `eventPayloads`. After the deletion, line 265 is
the last line of the file and it keeps its trailing newline.

### Edit 2 — narrow the orphaned import

The deletion orphans the value import `eventTypes`. It is used at line 268 only.
The type `EventType` survives, because line 71 uses it in
`export const eventPayloads: Readonly<Record<EventType, ZodType>>`.

Line 5 today:

```ts
import { eventTypes, type EventType } from "../../domain/event-type.ts";
```

Becomes:

```ts
import type { EventType } from "../../domain/event-type.ts";
```

### Do not touch the `ZodType` import

Line 2 is `import type { ZodType } from "zod";`. Keep it. `ZodType` is used at
line 71 as well as in the deleted block, so the deletion does not orphan it.

### Formatting

```bash
npx prettier --write src/http/contract/event-payload.ts
```

## Constraints

- **Delete only the union.** `eventPayloads` at line 71 is the catalogue the
  builder reads at `src/http/contract/openapi.ts:57`. It stays whole, all 37
  entries.
- **No test changes.** `src/http/contract/event-payload.test.ts` has 14 tests and
  none names `eventPayload`. Leave the file untouched.
- **No new export.** This story adds nothing.

## Verify

```bash
npm run typecheck
npx eslint .
node --test src/http/contract/event-payload.test.ts
if git grep -n -w eventPayload -- '*.ts' '*.js'; then exit 1; fi
```

- `npm run typecheck` exits 0, which proves no consumer of `eventPayload`
  remains and proves the narrowed import still satisfies line 71.
- `npx eslint .` exits 0, which proves the import narrowing left no unused
  binding.
- `node --test src/http/contract/event-payload.test.ts` passes all 14 tests
  unmodified.
- The `git grep` finds nothing and the guard exits 0. `-w` matches
  `eventPayload` as a whole word, so it does not match `eventPayloads`, the
  plural that stays. `git grep` covers every tracked file, so this is a
  repository search and not a search of three directories.

  The `if` wrapper is required. `grep` exits 1 when it finds nothing, which is
  the success case here, so a bare `grep` line in a `&&` chain or under `set -e`
  reports a false failure. The wrapper inverts it: a hit exits 1 and no hit
  continues.

  This is the gate item "`eventPayload` is gone:
  `src/http/contract/event-payload.ts` exports no `eventPayload`, and a
  repository search finds no importer."

Proof: this story delivers the `event-payload.test.ts` line of the EPIC Proof
command and the gate item "`eventPayload` is gone".
