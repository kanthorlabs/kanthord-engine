---
node: todos.md
bindings: []
verifications:
  - node --test test/todos-isolation.test.js
---

# Enforce ownership and atomic conditional writes

## Requirement

Authorize every TODO operation using the authenticated user's identity: all operations derive `user_id` from authentication, and every TODO endpoint returns 401 without a valid session. Administrators have no ownership bypass and follow the same ownership rule.

Require a strong integer ETag in `If-Match` on `PATCH` and `DELETE /api/v1/todos/:id`. The value is exactly the quoted integer version, for example `"1"`. A missing header returns 428. A malformed or wildcard value returns 400. A stale version returns 412. Compare owner and version atomically in SQL. Check ownership before revealing version conflicts. An absent UUID and a foreign-owned UUID both return 404. Errors keep the shared safe JSON envelope and request identifier.

## Criterion

- A route matrix exercises all five TODO endpoints without credentials and receives 401.
- Bob and an administrator cannot list, read, update or delete Alice's TODO. Direct get/patch/delete by known UUID return 404 without disclosing its version. An absent UUID also returns 404.
- Missing `If-Match` returns 428; malformed or wildcard forms return 400; only the exact quoted integer form is accepted; stale owned-row versions return 412, with no mutation. Ownership is checked before version conflicts.
- Concurrent updates with the same ETag produce exactly one success, one 412 and one version increment. A stale delete removes nothing and preserves the row.
- User identity supplied through body, query or headers never changes ownership; SQL injection-like inputs confer no access.
- Error responses keep the shared safe JSON envelope with `request_id`.
