# Story 5 — Import and export round-trip the new shape

Epic: `.agents/plan/epics/049-dual-read-plan-parsing-and-the-conversion.md`
Depends on: Story 1 (`ParsedDocument` carries `deliverable` and `verify`), Story 4 (`renderDocument` emits both keys), EPIC 047 (migration 11 adds `deliverable` and `verify_json` columns to `node`; `renderVerifyBlock` and `parseVerifyBlock` in `src/domain/verify-block.ts`)

## Change

**`src/commands/plan/import-plan.ts` — NodeWrite assembly (lines 454-467)**

At the site that builds each `NodeWrite` object (the array assembled in the loop over accepted documents), add two fields:

- `deliverable: parsedDocument.deliverable` — the string value or `null`.
- `verifyJson: parsedDocument.verify !== null ? renderVerifyBlock(parsedDocument.verify) : null` — import `renderVerifyBlock` from `"../../domain/verify-block.ts"`.

`renderVerifyBlock` is the canonical serializer from EPIC 047 (`src/domain/verify-block.ts`). It produces a JSON string with `paths` sorted and `commands` in original order.

**`src/queries/plan/export-plan.ts` — revision render path**

`exportPlan` calls `dependencies.revision.render(transaction, { nodes })` where `nodes` is `StoredNode[]`. After EPIC 047, `StoredNode` carries `deliverable: Deliverable | null` and `verifyJson: string | null`. The revision service is `src/services/revision/node-write.ts`, and it calls `renderDocumentSet` at line 93 with a bodies map built above that call. After Story 4 the bodies map value type includes `deliverable` and `verify`.

`renderDocumentSet` has four production call sites, and every one builds its own bodies map of `{ instruction, acceptance, worker, repo }`. All four must set the two new fields or the build fails:

- `src/services/revision/node-write.ts:93`
- `src/commands/plan/import-plan.ts:675`
- `src/commands/plan/import-plan.ts:745`
- `src/queries/plan/validate-plan.ts:295`

At each site set:

- `deliverable: node.deliverable ?? null`
- `verify: node.verifyJson !== null ? parseVerifyBlock(node.verifyJson) : null` — import `parseVerifyBlock` from `"../../domain/verify-block.ts"` (or the relative path from the revision service file).

Change no other field of any bodies map entry.

## Constraints

- Do not change the signature of `importPlan` or `exportPlan`.
- Do not add a new migration here. Migration 11 from EPIC 047 already adds the columns.
- `renderVerifyBlock` must be the one serializer. Do not inline `JSON.stringify`.
- A legacy document (`deliverable === null`, `verifyJson === null`) must round-trip unchanged — its `worker` field and body are unaffected.

## Verify

```
node --test src/commands/plan/import-plan.test.ts src/queries/plan/export-plan.test.ts
```

Add to `src/commands/plan/import-plan.test.ts`:

1. `"a new-shape plan imports with no finding and the deliverable is stored"` — submit one task document with `deliverable: "test"`, `verify: { paths: ["src/foo.ts"], commands: ["! node --test src/foo.test.ts"] }`. Assert `result` has no findings on the returned documents. Assert the stored node's `deliverable` equals `"test"` by reading the SQLite row directly.

2. `"a legacy plan still imports byte-identically after dual-read"` — submit one task document with `worker: "claude.swe@1"` and no `deliverable`. Assert the stored node's `deliverable` is `null`. Assert the exported content matches the submitted content byte-for-byte.

Add to `src/queries/plan/export-plan.test.ts`:

3. `"a new-shape plan exports byte-identical to the submitted document"` — import a task document with `deliverable: "implementation"`, `verify: { paths: ["src/bar.ts"], commands: ["node --test src/bar.test.ts"] }`, then export. Assert the exported document content equals the submitted document content byte-for-byte using `assert.equal(exportedContent, submittedContent)`. The submitted content is the full rendered document string — no substring match.

4. `"a legacy plan still exports byte-identically after dual-read"` — import a task document with `worker: "claude.swe@1"`, then export. Assert the exported content equals the submitted content byte-for-byte using `assert.equal(exportedContent, submittedContent)`. The test must not assert a substring (`contains worker:`) — assert the full string equality.

`pnpm run verify` exits 0.

Proof: PASS lines delivered — `src/commands/plan/import-plan.test.ts` and `src/queries/plan/export-plan.test.ts` in `PASS EPIC-049`. Hermetic coverage: new-shape round-trip; legacy round-trip unchanged.
