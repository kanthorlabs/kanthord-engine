---
node: foundation.md
bindings: []
verifications:
  - node --test test/foundation-runtime.test.js
  - npm ci && npm run test:foundation
  - npm run lint && npm run format:check
---

# Provide a reproducible Node 24 runtime

## Requirement

Keep an ESM package on Node.js 24.x with Express 5.x, a Node 24 version declaration, a committed npm lockfile, a documented runtime guard and a side-effect-free Express app factory. The process entrypoint alone owns process startup. Provide development and start commands.

Use ESLint, Prettier, Node's test runner and Supertest. Provide the `lint`, `format:check` and `test:foundation` scripts. Put substantive tests in the three foundation task-named test files. Do not pre-create passing placeholder suites for later nodes.

Organize `src/config`, `src/http` and `src/db`. Create a directory only when it holds code, and add no `.gitkeep` placeholder. Later nodes create `src/modules/auth`, `src/modules/todos` and `src/modules/admin` with their code. Routes delegate to services and services to repositories. Inject database, clock and logger dependencies rather than relying on mutable global state. Keep source modules small.

## Criterion

- A clean Node 24 checkout installs with `npm ci`; other Node major versions fail the documented runtime check.
- Tests prove constructing and importing the app factory does not listen on a port and does not open or create a database. The entrypoint alone owns process startup.
- The runtime check accepts major 24 and rejects another major using a testable version input.
- The source tree contains `src/config`, `src/http` and `src/db`, each with code. It contains no empty directory and no `.gitkeep` file.
- The app factory receives database, clock and logger as injected dependencies, not mutable global state.
- The package lock matches the manifest. Tests, lint and formatting are real checks that return nonzero status on failure. A clean install and static checks succeed without disabling lint rules to hide defects.
- Later nodes add their own suites; no placeholder suite passes without real assertions.
- Source, configuration examples and tests contain no credentials.
- `test/foundation-runtime.test.js` contains behavioral assertions and closes every resource it opens.
