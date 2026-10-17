---
node: todos.md
bindings: []
verifications:
  - node --test test/todos-pagination.test.js
  - npm ci && npm run test:todos
  - npm run test:authentication
  - npm run --if-present test:foundation && npm run --if-present test:persistence && npm run --if-present test:operations && npm run --if-present test:authentication && npm run --if-present test:todos
  - npm run lint && npm run format:check
---

# Bound and filter private TODO collections

## Requirement

Implement authenticated `GET /api/v1/todos` with keyset pagination, scoped to the authenticated owner. Order by `created_at DESC, id DESC`. Accept `limit` from 1 to 100 with default 20, an optional opaque `cursor` and optional `completed=true|false`. Reject unknown and duplicate query keys and invalid values. Decode and strictly validate the cursor structure and every cursor component. Bind cursor operands as SQL parameters. Return `{ items, next_cursor }` with null `next_cursor` at the end and without an unbounded total-count scan.

A cursor binds the completion filter. A filter mismatch returns 400. A cursor confers no access rights. Provide the `test:todos` script, which runs the three todos suites.

## Criterion

- Default limit is 20; limits outside 1 through 100, fractions and nonnumeric values return 400. `completed` accepts only literal `true` or `false`.
- Results are ordered by `created_at DESC, id DESC` and scoped to the authenticated owner.
- Empty collections return an empty items array and null cursor. The last page has `next_cursor: null`. Full traversal of stable fixtures returns each matching owner row exactly once, with no duplicate or missing record, including equal timestamps.
- Malformed and filter-mismatched cursors return 400. A cursor from another account exposes no foreign records and confers no access. Cursor operands are bound as SQL parameters.
- Unknown or repeated query parameters fail rather than being interpreted ambiguously. Invalid cursors fail without mutation.
- Insertion before the current cursor does not duplicate prior results. Document that concurrent completion edits need not yield snapshot-consistent pages.
- Authentication regressions remain green.
