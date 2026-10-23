---
intent: implement
commit_type: feat
depends_on: []
bindings:
  - todoapp-repo
verifications:
  - npm ci && npm run test:foundation
  - npm run lint && npm run format:check
---

# Establish the Express API foundation

## Requirement

Create a JavaScript ESM application on Node.js 24.x using Express 5.x. Separate the side-effect-free app factory from the process entrypoint. Organize `src/config`, `src/http` and `src/db`. Create a directory only when it holds code, and add no `.gitkeep` placeholder. Later nodes create `src/modules/auth`, `src/modules/todos` and `src/modules/admin` with their code. Routes delegate to services and services to repositories. Inject database, clock and logger dependencies rather than relying on mutable global state.

Use npm with a committed lockfile, ESLint, Prettier, Node's test runner and Supertest. Provide `test:foundation`, `lint` and `format:check` scripts, with substantive tests in the three task-named files. Later nodes add their suites. Do not pre-create passing placeholder suites.

Establish HTTP conventions now: JSON responses, snake_case property names shared by domain objects and HTTP payloads, and errors shaped `{ error: { code, message, request_id, details } }`. `details` is a safe list, empty when not applicable. The error middleware is last; no error response leaks stack traces or SQL. Expose public `GET /health/live` with 200 and `{ status: "ok" }`.

## Criterion

- A clean Node 24 checkout installs with `npm ci`; other Node major versions fail the documented runtime check.
- Importing the app factory neither opens a listener nor creates a database. The entrypoint alone owns process startup.
- Configuration validates `NODE_ENV`, `HOST`, `PORT`, `DATABASE_PATH`, `CORS_ORIGINS`, `TRUST_PROXY`, `LOG_LEVEL` and `SESSION_TTL_SECONDS` at startup. Defaults include port 3000, no trusted proxy, no cross-origin access and session TTL 86400 seconds. Unsafe or invalid production configuration fails startup.
- `express.json` accepts only JSON object request bodies where a route expects JSON, with a 32 KiB limit. Malformed JSON returns 400, oversized bodies 413, and unsupported request media types 415 on JSON write routes.
- Unknown routes return JSON 404; asynchronous route failures reach the central error handler. Application errors distinguish safe client messages from internal diagnostics.
- Tests, lint and formatting are real checks with nonzero failure status. Source, configuration examples and tests contain no credentials.
