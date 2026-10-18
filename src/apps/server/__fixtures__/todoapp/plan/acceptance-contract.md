---
node: acceptance.md
bindings: []
verifications:
  - node --test test/acceptance-contract.test.js
---

# Publish and verify the complete REST contract

## Requirement

Write OpenAPI 3.1 for every public, private and admin route: public `GET /health/live` and `GET /health/ready`; public `POST /api/v1/auth/register` and `POST /api/v1/auth/login`; private `GET /api/v1/auth/me` and `POST /api/v1/auth/logout`; admin `GET /api/v1/admin/stats`; and owner-only `POST /api/v1/todos`, `GET /api/v1/todos`, `GET /api/v1/todos/:id`, `PATCH /api/v1/todos/:id` and `DELETE /api/v1/todos/:id`.

Define schemas, bearer security, validation bounds, owner-only access, pagination, error codes and statuses, strong ETag preconditions, CORS and rate limits. Keep HTTP fields identical to the domain's exact snake_case fields and exclude internal password and session-digest fields. The admin role grants no ownership bypass for TODOs.

## Criterion

- Tests validate the OpenAPI 3.1 document and compare documented method/path coverage to the application's route inventory without adding a public route-list endpoint. The check fails for undocumented routes and for mismatched response fields or statuses.
- The document covers all routes in the requirement, with bearer security, exact snake_case fields, validation bounds, pagination, error codes and statuses, conditional ETags, CORS and rate limits.
- Real HTTP examples validate against response schemas for success and representative errors, including 401 versus 403 versus owner-hiding 404, stale 412 and missing-precondition 428. Tests exercise the documentation examples rather than accept them by visual inspection.
- Public operations explicitly require no authentication. Every private operation declares bearer authentication; admin stats additionally documents the admin policy.
- The contract documents JSON size limits, strict input fields, 429/503 retry headers, response ETag/Location and the error request_id.
- Examples contain no usable credentials or tokens. The admin role grants no cross-owner TODO access, and no example implies it.
