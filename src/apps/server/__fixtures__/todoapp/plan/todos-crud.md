---
node: todos.md
bindings: []
verifications:
  - node --test test/todos-crud.test.js
---

# Provide validated TODO lifecycle operations

## Requirement

Implement authenticated `POST /api/v1/todos`, `GET /api/v1/todos/:id`, `PATCH /api/v1/todos/:id` and `DELETE /api/v1/todos/:id` using routers, strict Zod schemas, services and SQLite repositories. Expose owner-scoped creation, retrieval, partial update and hard deletion. Use the domain's exact snake_case field names in HTTP and repository objects. Set server-owned IDs, ownership, version and UTC timestamps internally.

A TODO representation contains `id`, `user_id`, `title`, `description`, `completed`, `version`, `created_at`, `updated_at`. Trim titles; a title is nonblank and has at most 200 characters. A description has at most 5000 characters and defaults to an empty string. Creation accepts only `title`, optional `description` and optional boolean `completed` that defaults to false. Creation returns 201 with a `Location` header and the representation. Get and patch return 200. Delete returns 204 without a body and physically removes the row.

Create, get and patch responses return a strong `ETag` that contains the quoted integer version, for example `"1"`. Patch accepts a nonempty subset of `title`, `description` and `completed` only. Even a value-equal successful patch increments the version once. A malformed UUID returns 400. Create `src/modules/todos` with this code.

## Criterion

- The todo routes call services, and the services call repositories.
- Tests assert create 201 with Location and ETag, get 200 with ETag, patch 200 with ETag and one version increment, and delete 204 with no response body. The ETag is the quoted integer version, for example `"1"`.
- The full create, read, update, complete and delete lifecycle works with the documented status codes, headers and representations, and persists across reopen.
- A representation contains exactly `id`, `user_id`, `title`, `description`, `completed`, `version`, `created_at`, `updated_at`.
- Defaults are `description: ""`, `completed: false`, `version: 1`; only title is required on create. Titles are trimmed.
- Strict body schemas reject unknown properties, ownership overrides and server-owned fields, invalid types, invalid booleans, whitespace-only titles, titles over 200 characters, descriptions over 5000 characters and empty patches. Rejected requests do not mutate data.
- Patch accepts only `title`, `description` and `completed`. A value-equal successful patch still increments the version once.
- Completing and reopening a TODO toggles only permitted content plus server-maintained version/time fields.
- A delete physically removes the row; a current delete leaves no recoverable row. Deleted rows cannot be retrieved. Malformed UUIDs yield 400 and valid absent UUIDs yield 404. Failures preserve prior data.
