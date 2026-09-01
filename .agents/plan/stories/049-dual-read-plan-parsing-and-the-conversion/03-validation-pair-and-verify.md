# Story 3 — Validation applies pair and verify block

Epic: `.agents/plan/epics/049-dual-read-plan-parsing-and-the-conversion.md`
Depends on: Story 1 (`ParsedDocument` carries `deliverable` and `verify`), Story 2 (`pair-illegal` and `verify-invalid` are valid `FindingCode` values), EPIC 047 Story 2 (`nodePairLegality` from `src/domain/node-pair.ts`), EPIC 047 Story 5 (`StoredNode.deliverable` and `CandidateNode.deliverable` exist after that story extends `nodeRow` and `StoredNode`)

## Change

**`src/domain/plan-validate.ts` — after frontmatter parsing**

Inside `validateDocuments` (exported function, lines 34-352), after each document's frontmatter is parsed into a `ParsedDocument`, add two checks. The site is inside the loop over `input.submitted` that calls `readFrontmatter` and then constructs the resolved node — search for the block that assigns `parsedDoc.worker` or `parsedDoc.kind` before pushing into the resolved nodes array. Add after that block:

Check 1 — pair legality. If `parsed.deliverable !== null`: call `nodePairLegality(parsed.kind, parsed.deliverable)` (import `nodePairLegality` from `"./node-pair.ts"`). If the result is `{ legal: false }`: push one `Finding` with `code: "pair-illegal"`, `path: parsed.path`, `id: null`.

`plan-validate.ts` adds the pair check only. It emits no `verify-invalid`. `planFrontmatter` embeds `verifyBlock` (Story 1), so a document whose verify block fails the schema raises `frontmatter-invalid` at parse and never reaches a `ParsedDocument`. A `verify-invalid` check here would be unreachable code.

**`src/domain/plan-candidate.ts` — inside `validateCandidate`**

After the existing structural checks that produce findings for each `CandidateNode`, add two checks for every node whose `deliverable` is not null:

Check 1 — pair legality. Call `nodePairLegality(node.kind, node.deliverable)`. If `{ legal: false }`: push one `Finding` with `code: "pair-illegal"`, `path: null`, `id: node.id`.

Check 2 — verify path validity. `CandidateNode` carries `verifyJson: string | null` (after EPIC 047 Story 6 extends `StoredNode`). If `node.verifyJson === null`: push `Finding` with `code: "verify-invalid"`, `path: null`, `id: node.id` and continue (a node with `deliverable !== null` and `verifyJson === null` is structurally invalid). Otherwise call `decodeVerifyBlock(node.verifyJson)` (import `decodeVerifyBlock` from `"./verify-block.ts"`). If `decodeVerifyBlock` returns `{ ok: false }`: push one `Finding` with `code: "verify-invalid"`, `path: null`, `id: node.id`. Do not call `parseVerifyBlock`, which throws `VerifyBlockError`, and do not call `verifyBlock.safeParse` directly; `validateCandidate` returns findings and raises no exception, and `decodeVerifyBlock` is the shared non-throwing entry point. An absolute path is legal after the EPIC 047 grammar decision, so it produces no finding.

The candidate check is a defense-in-depth guard. The plan-validate check is the primary guard that fires during import.

## Constraints

- Do not add findings for a legacy document (`deliverable === null`). A legacy node raises neither `pair-illegal` nor `verify-invalid`.
- Do not change the signatures of `validateDocuments`, `buildCandidate`, `validateCandidate`, `validateCandidateStructural`, or `validateCandidateCompleteness`.
- `pair-illegal` and `verify-invalid` are `"structural"` scope (confirmed in Story 2); `validateCandidateStructural` will include them without any filter change.

## Verify

```
node --test src/domain/plan-validate.test.ts src/domain/plan-candidate.test.ts
```

Add to `src/domain/plan-validate.test.ts`:

1. `"a task with deliverable expansion raises exactly one pair-illegal finding"` — submit one document with `kind: "task"`, `deliverable: "expansion"`, `verify: { paths: [], commands: [] }`. Assert `findings.filter(f => f.code === "pair-illegal").length === 1`. Assert no `verify-invalid` finding.

2. `"an initiative with deliverable implementation raises exactly one pair-illegal finding"` — submit one document with `kind: "initiative"`, `deliverable: "implementation"`, `verify: { paths: [], commands: [] }`. Assert `findings.filter(f => f.code === "pair-illegal").length === 1`.

3. `"a verify block with an absolute path raises no finding"` — submit one document with `kind: "task"`, `deliverable: "test"`, `verify: { paths: ["/abs/path"], commands: [] }`. Assert zero `verify-invalid` findings and zero `pair-illegal` findings. An absolute path is legal per the EPIC 047 grammar decision.

4. `"a legacy document with worker only raises neither pair-illegal nor verify-invalid"` — submit one document with `kind: "task"`, `worker: "claude.swe@1"` (no `deliverable`, no `verify`). Assert zero `pair-illegal` findings and zero `verify-invalid` findings.

Add to `src/domain/plan-candidate.test.ts`:

5. `"validateCandidate raises pair-illegal for a task node with deliverable expansion"` — build a candidate with one task node that has `deliverable: "expansion"`. Assert exactly one `pair-illegal` finding.

6. `"validateCandidate raises verify-invalid for a stored node whose verify_json fails the schema"` — build a candidate with one task node that has `deliverable: "test"` and `verifyJson: '{"paths":["a/../b"],"commands":[]}'`. Assert exactly one `verify-invalid` finding, and that its `id` equals the node id. Add a second case with `verifyJson: "{"` asserting exactly one `verify-invalid` finding and no thrown exception.

7. `"validateCandidate raises no verify-invalid for a stored node whose verify_json holds an absolute path"` — `verifyJson: '{"paths":["/abs/src/foo.ts"],"commands":[]}'`. Assert zero `verify-invalid` findings.

8. `"validateCandidate raises pair-illegal for an initiative node with deliverable test"` — build a candidate with one initiative node that has `deliverable: "test"`. Assert exactly one `pair-illegal` finding.

The following three cases use real SQLite (`node:sqlite` on a temporary file, created and removed per test). They prove distinct boundaries that a schema check or a lint rule cannot cover.

9. `"a verify_json value valid for json_valid but invalid for verifyBlock raises verify-invalid"` — open a real SQLite database and run all migrations through migration 11. Insert a node row directly with `deliverable = 'test'` and `verify_json = '{"paths":["a/../b"],"commands":[]}'` (valid JSON, so migration 11's `CHECK (verify_json IS NULL OR json_valid(verify_json))` admits it). Assert the INSERT succeeds. Then call `validateCandidate` on a candidate built from that database. Assert exactly one `verify-invalid` finding, and that its `id` equals the inserted node's id. This proves the SQL `CHECK` and the schema guard (`decodeVerifyBlock`) cover different things and neither is redundant.

10. `"a stored node with non-null deliverable and null verify_json raises verify-invalid"` — open a real SQLite database and insert a node row with `deliverable = 'test'` and `verify_json = NULL`. Call `validateCandidate`. Assert exactly one `verify-invalid` finding, asserted by code `"verify-invalid"` and by the node id. This is a cross-column invariant (non-null `deliverable` requires non-null `verify_json`) and not a grammar question.

11. `"two bad rows in one candidate produce a finding count of two"` — open a real SQLite database and insert two node rows, both with `deliverable = 'test'` and `verify_json = '{"paths":["a/../b"],"commands":[]}'`. Call `validateCandidate`. Assert the count of `verify-invalid` findings equals two. This proves `validateCandidate` collects all findings and does not abort at the first bad row.

`pnpm run verify` exits 0.

Proof: PASS lines delivered — `src/domain/plan-validate.test.ts` and `src/domain/plan-candidate.test.ts` in `PASS EPIC-049`.
