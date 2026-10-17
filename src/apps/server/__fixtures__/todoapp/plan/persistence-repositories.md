---
node: persistence.md
bindings: []
verifications:
  - node --test test/persistence-repositories.test.js
  - npm ci && npm run test:persistence
  - npm run test:foundation
  - npm run --if-present test:foundation && npm run --if-present test:persistence && npm run --if-present test:operations && npm run --if-present test:authentication && npm run --if-present test:todos
  - npm run lint && npm run format:check
---

# Isolate validated, owner-scoped repository operations

## Requirement

Implement account, session and TODO repositories with prepared statements and explicit results for absent rows, uniqueness conflicts and stale versions. Bind every external SQL operand. Use UUID text identities and UTC ISO-8601 timestamp strings. Represent `completed` as a domain boolean and a SQLite integer. Repositories expose domain objects with the same snake_case field names as the table columns and the API, without allowing clients to choose ownership. Keep session secrets and password hashes internal.

Trim and lowercase email before storage and comparison. A TODO starts at version 1. Define `UserRole` as the closed code enum `user | admin`. Enforce closed values in code before the write, not in SQL. Create no HTTP endpoint in this node. Provide the `test:persistence` script, which runs the three persistence suites.

## Criterion

- Duplicate normalized emails and token digests fail deterministically without duplicate rows. Email is trimmed and lowercased before storage and comparison.
- Repositories bind every external SQL operand. Injection-like email and TODO text is treated as data.
- `UserRole` accepts only `user` and `admin`. Unknown roles, invalid booleans, invalid versions and invalid value types are rejected before a write.
- Identities are UUID text and timestamps are UTC ISO-8601 strings. `completed` is a domain boolean and a SQLite integer. A new TODO has version 1.
- Owner-scoped list, get, update and delete take the authenticated owner identity as a required operand. They never return or modify another user's TODO.
- Conditional update and delete compare both owner and expected version in the write, not only in an earlier read. An update increments the version once. A conflict changes no field.
- Public projections omit `password_hash` and `token_hash`. Session lookup returns only what authentication needs.
- This node adds no HTTP endpoint.
