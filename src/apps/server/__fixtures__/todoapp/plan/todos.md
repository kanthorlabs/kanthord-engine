---
intent: implement
commit_type: feat
depends_on:
  - authentication.md
bindings:
  - todoapp-repo
verifications:
  - npm ci && npm run test:todos
  - npm run --if-present test:foundation && npm run --if-present test:persistence && npm run --if-present test:operations && npm run --if-present test:authentication && npm run --if-present test:todos
  - npm run lint && npm run format:check
---

# Deliver owner-scoped TODO REST endpoints

## Requirement

Implement authenticated `POST /api/v1/todos`, `GET /api/v1/todos`, `GET /api/v1/todos/:id`, `PATCH /api/v1/todos/:id` and `DELETE /api/v1/todos/:id` using routers, strict Zod schemas, services and SQLite repositories. All operations derive `user_id` from authentication. Administrators have no ownership bypass.

A TODO representation contains `id`, `user_id`, `title`, `description`, `completed`, `version`, `created_at`, `updated_at`. Titles are trimmed, nonblank and at most 200 characters. Descriptions are at most 5000 characters and default to an empty string. Creation accepts only `title`, optional `description`, optional boolean `completed` defaulting false. Creation returns 201 with a Location header and the representation. Get and patch return 200. Delete returns 204 without a body and physically removes the row.

List accepts `limit` from 1 to 100, default 20; an optional opaque `cursor`; and optional `completed=true|false`. Reject unknown/duplicate query keys and invalid values. Return `{ items, next_cursor }`, ordered by `created_at DESC, id DESC`, with keyset pagination and null at the end. Decode and strictly validate cursor structure, bind cursor operands as SQL parameters and scope every page to the authenticated owner. Cursors bind the completion filter; a filter mismatch returns 400. Cursors confer no access rights.

Single-resource create/get/patch responses return a strong ETag containing the quoted integer version, for example `"1"`. Patch/delete require exactly that form in `If-Match`; missing is 428, malformed or wildcard is 400, and a stale version is 412. Patch accepts a nonempty subset of `title`, `description`, `completed` only. Even a value-equal successful patch increments version once. Check ownership before revealing version conflicts; absent and foreign-owned UUIDs both return 404. Malformed UUIDs return 400. Create `src/modules/todos` with this code. Add `test:todos`.

## Criterion

- The complete create/list/read/update/complete/delete lifecycle works with the documented status codes, headers and representations, and persists across reopen.
- Every TODO endpoint returns 401 without a valid session. A second user and an administrator cannot list, read, update or delete the owner's TODO.
- Unknown properties, ownership overrides, invalid booleans, blank titles, oversize fields, empty patches and invalid cursors fail without mutation.
- Two writes with the same ETag yield exactly one success and one 412. A stale delete removes nothing; a current delete leaves no recoverable row.
- Stable-data pagination returns each matching owner row exactly once, including timestamp ties; inserts ahead of a cursor cause no duplicate earlier row. This is not a snapshot pagination guarantee during concurrent edits.
- Authentication regressions remain green; errors retain the shared safe JSON envelope and request identifier.
