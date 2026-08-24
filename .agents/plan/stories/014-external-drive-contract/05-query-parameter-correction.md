# Story 5 — The stale query-parameter correction

Epic: `.agents/plan/epics/014-external-drive-contract.md`
Depends on: EPIC 013 (sequence order). Independent of Stories 1 to 4.

Document-only story. It writes no TypeScript.

## Change

### `docs/proposal/api/graph.md:102`

The paragraph reads today:

```
**Phase 1 returns every node, ordered by identity, and takes no filter.** A filter is a query parameter, and this API has no query-parameter mechanism: an operation declares a tuple of typed path segments and a body schema, and nothing else. Adding one reaches the registry, the router, the generated document and the CLI client at once, so it is a transport decision rather than a property of this route. `repository.list` is unfiltered for the same reason. A human filters client-side until then.
```

Replace it with exactly:

```
**Phase 1 returns every node, ordered by identity, and takes no filter.** The claim that this API has no query-parameter mechanism was false, and it is corrected here. The mechanism exists: `src/http/contract/operation.ts:41` declares an optional `query` schema on every operation, and `event.list` binds `query: eventListRequest` at `src/http/contract/event.ts:69` over the schema declared at `src/http/contract/event.ts:11-17`. `node.list` takes no filter in phase 1 because no epic had declared one, not because the transport cannot carry one. EPIC 018 declares them. `repository.list` is unfiltered by choice rather than by mechanism, and a human filters it client-side.
```

### `docs/proposal/api/graph.md:104`

Unchanged, word for word. It keeps the recorded filter set as the shape EPIC 018 implements:

```text
The filters this route will take are `project`, `kind`, `state`, `blockReason` and `repository`. They are recorded here so the shape is fixed when the mechanism arrives.
```

## Constraints

- Change no other line of `docs/proposal/api/graph.md`. Story 4 owns line 7.
- Change no route table row. `test/helpers/proposal.ts:54` `readRouteMatrix` parses the five-column route table of this file, and `src/http/contract/parity.test.ts` compares it against the registry.
- Change no file under `src/`. This story declares no filter and no schema. EPIC 018 adds the `node.list` filters.
- Keep the `repository.list` sentence as its own claim. Do not delete it and do not extend it to `node.list`.

## Verify

- `npm run verify` exits 0.
- `node --test src/http/contract/parity.test.ts` exits 0 with no edit, proving the route table of `graph.md` is byte-equivalent to the registry.
- `grep -c "no query-parameter mechanism: an operation declares" docs/proposal/api/graph.md` returns `0`.
- `grep -n "src/http/contract/operation.ts:41" docs/proposal/api/graph.md` and `grep -n "src/http/contract/event.ts:69" docs/proposal/api/graph.md` each return line 102.
- `grep -n "blockReason" docs/proposal/api/graph.md` still returns line 104, so the recorded filter set survived.
- Proof: `PASS EPIC-014` through the unchanged `src/domain/*.test.ts` glob.
