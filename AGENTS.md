# kanthord — agent contract

kanthord is one long-running daemon on **Node.js 24+ / TypeScript**, ES modules, `"type": "module"`. Node runs TypeScript directly by type stripping, so a relative import carries an explicit `.ts` extension. Tests run on the built-in **`node:test`** runner with `node:assert/strict`. There is no test framework dependency.

**The published artifact is compiled; the repository is not.** Node refuses to strip types under `node_modules`, so an installed `bin` pointing at a `.ts` file cannot run. `npm run build` emits `dist/` through `tsconfig.build.json`, `prepack` runs it, and `package.json` ships `dist` and points `bin` at `dist/main.js`. `rewriteRelativeImportExtensions` turns each `.ts` import specifier into `.js` on emit, so `src/` keeps its explicit `.ts` extensions unchanged. Development, tests and lint still run TypeScript directly. Never import from `dist/`, and never commit it.

`docs/proposal/` is the source of truth for behaviour. This file is the source of truth for structure. Where a story and this file disagree about structure, this file wins.

## Architecture

Six directories under `src/`, and the dependency direction between them is one way.

```
src/
  domain/     entities, the state machine, zod schemas. Pure.
  services/   a capability behind an interface.
  commands/   write paths. The business logic of one operation.
  queries/    read paths.
  http/       the route contract, and the koa server that serves it.
  cli/        commander programs.
  main.ts     the composition root.
```

Two of those directories split in two, because one rule does not fit both halves.

```
src/services/<capability>/index.ts   the interface. No implementation, no re-export of one.
src/services/<capability>/*.ts       an implementation of that interface.

src/http/contract/**                 operation ids, methods, paths, lifecycle, zod schemas. No koa.
src/http/server/**                   koa, the middleware, and the handlers.
```

### The import matrix

This table is normative. `eslint.config.js` encodes it, so a violation fails `npm run lint`.

| From                     | May import                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `domain/`                | `domain/`                                                                               |
| a service **interface**  | `domain/`, any service interface                                                        |
| a service implementation | `domain/`, any service interface, an implementation in the **same** capability          |
| `commands/`              | `domain/`, any service interface                                                        |
| `queries/`               | `domain/`, any service interface                                                        |
| `http/contract/`         | `domain/`, `http/contract/`                                                             |
| `http/server/`           | `domain/`, `commands/`, `queries/`, `http/contract/`, `http/server/`                    |
| `cli/`                   | `domain/`, `http/contract/`, `cli/`                                                     |
| `main.ts`                | everything                                                                              |
| a test                   | its module under test, `domain/`, service interfaces, `test/helpers/`, `node:` builtins |

Nothing imports `main.ts`. No production file imports a test or a test helper.

Five rules carry that table.

- **`domain/` is pure.** No file system, no network, no clock, no randomness. A ULID is minted by a service and passed in. Its only permitted runtime dependency is `zod`.
- **A dependency injects through an interface, and only `main.ts` names an implementation.** A cross-capability dependency is legal through the interface — the event service reaching storage is normal. An interface reaching another interface is the same rule: `services/event` and `services/lease` name the storage transaction context in their own signatures, because the transaction rule below requires it. One capability's implementation importing another capability's implementation is not legal.
- **`commands/` and `queries/` hold the business logic.** They import no vendor package at all. A handler parses a request, calls exactly one command or one query, and formats the response. A handler that branches on a domain rule is a defect.
- **`http/contract/` is the transport contract, and the CLI is its second consumer.** It holds every operation id, method, path, lifecycle status and zod schema, and it imports no koa. That is what lets `cli/` be a typed client of a daemon on another machine without importing a handler.
- **`cli/` reaches the daemon over HTTP.** It imports no command and no query. `kanthord db migrate` is the single exception in the product, and it is still not an exception here: `main.ts` constructs the storage implementation and passes the migration handler into the commander program.

### Layout

Production TypeScript exists only under the six directories or as `src/main.ts`. An unclassified file under `src/` is a lint error, so a seventh directory is a decision rather than an accident.

```
domain/<subject>.ts
services/<capability>/index.ts and its implementations
commands/<domain>/<verb-noun>.ts
queries/<domain>/<verb-noun>.ts
http/contract/<domain>.ts, http/server/<domain>/<operation>.ts
cli/<domain>/<command>.ts
test/helpers/**
```

### The shape of a command

One operation per file, verb first, exported as a function that takes its dependencies first and its input second. No class, no service locator, no module-level singleton, no mutable container.

```ts
export type ImportPlanDependencies = Readonly<{
  storage: Storage;
  graph: Graph;
  ids: IdGenerator;
}>;

export async function importPlan(
  dependencies: ImportPlanDependencies,
  input: ImportPlanInput,
): Promise<ImportPlanResult>;
```

A query takes the same shape. `main.ts` binds the dependencies once and passes callable handlers to the server and to the program.

### Naming

- A service is capability-named: `services/git`, not `services/isomorphic-git`. Its implementation is vendor-named: `IsomorphicGit`.
- No `I` prefix on an interface, and no `Impl` suffix on an implementation.
- A file that exports one thing is named after it.

### Two rules the import matrix cannot express

- **The transaction belongs to storage.** `services/storage` owns the transaction context. A write command opens one transaction, and every service that persists inside that write accepts the context through its interface. A state transition and its event append never sit in two transactions. `docs/proposal/phase-1/domain.md` requires them to be one.
- **Route lifecycle is registry data, not a branch in a handler.** Every declared operation appears exactly once in `http/contract/`. A `routed` entry binds to exactly one command or query. A `stubbed` entry binds to the one shared `501` handler and names no command. A `post-mvp` row has no entry at all.
- **A path is a typed segment tuple, never a string.** An operation declares resource, subresource, action, system and parameter segments from closed sets, and one renderer builds the path. Every resource segment is singular. `docs/proposal/api/README.md` holds the grammar. A route edit therefore cannot introduce a plural or a free-form segment.
- **OpenAPI documents are generated and not committed.** The master and each `features/*.yaml` slice are self-contained with internal references only. `npm run verify` emits and validates the master in a temporary directory. `npm run contract:publish -- <output-directory>` emits the master, feature slices and examples for a consumer. Never commit generated documents, and never hand-edit them.

## Tests

- **Co-located.** `src/foo/bar.ts` is covered by `src/foo/bar.test.ts`. The suite name is the module path, and a test name describes user-observable behaviour. Shared helpers live in `test/helpers/`.
- **Hermetic.** No network, no shared temporary directory, no ambient `git` configuration, no wall-clock dependency. A test that needs a remote uses the loopback fixture of EPIC 005. A test that needs a home uses its own `mktemp` directory and removes it.
- **Real SQLite, faked everything else.** `node:sqlite` on a temporary file is fast, and it is the thing under test for much of phase 1. A fake for git, agent and clock is a small hand-written object implementing the interface.
- **Fake against Mock.** A **Fake** returns a generic safe default. A **Mock** returns the deterministic value the story names. A story that names a value gets a Mock.
- Boundaries are **not** disabled for tests. A test imports its module under test, `domain/`, service interfaces, `test/helpers/` and `node:` builtins. It reaches an implementation only in the capability it covers.

## Determinism

The same input produces the same output, the same order and the same bytes. Two product guarantees depend on it: a plan document round-trips byte-identically, and a task order is reproducible.

- Ordering is explicit. A topological walk breaks a tie by ULID; a document set sorts by canonical path, compared bytewise.
- Serialization is canonical, per `docs/proposal/phase-1/plan-format.md`.
- A test asserts a value, never "some value". A timestamp in a snapshot is a defect.
- **A story that cannot be made deterministic is a planning defect.** Fix the story. Never push the decision onto the implementing agent.

## What is enforced, and by what

A rule with no mechanism is a rule a reviewer applies inconsistently. Each of these has one.

| Rule                                             | Mechanism                                                         |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| the import matrix                                | `eslint-plugin-boundaries`                                        |
| `domain/` purity, and vendor packages by layer   | `no-restricted-imports` per glob                                  |
| an unclassified `src/` file                      | an eslint file-pattern rule                                       |
| registry equals the proposal contract            | a test in `npm run verify`                                        |
| a `stubbed` route answers 501 and writes nothing | an integration test that compares database state before and after |
| canonical serialization                          | exact-byte unit tests                                             |
| bytewise ordering                                | a test with non-ASCII paths, asserted through `Buffer.compare`    |
| topological tie-break by ULID                    | an exact-order graph test                                         |
| a constant-time token compare                    | `timingSafeEqual`, asserted by construction                       |
| no domain branching in a handler                 | the handler signature admits only parse, invoke and format        |
