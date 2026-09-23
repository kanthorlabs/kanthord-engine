# Agent instructions

## Scope and project

These instructions apply to the `engine/` directory and its descendants.

Kanthord is a work orchestration system that organizes goals, executes steps,
and evaluates results. The WHAT defines goals, steps, and validation criteria.
Workers supply the HOW; agents and human participants supply the WHO.
This package provides the TypeScript engine, CLI, and server.
Read [README.md](README.md), the relevant local documentation, source, and tests
before a behavior change.

- Use Node.js `>=24.15.0 <25` and the pnpm version pinned in `package.json`.
  `.nvmrc` selects the development Node.js version.
- Use pnpm; keep `pnpm-lock.yaml` consistent with dependency changes.
- There are no deployments yet. Do not add backward-compatibility layers unless
  explicitly requested.
- Prefer platform built-ins and the installed dependencies. Change dependencies
  and pinned versions deliberately, with validation.

## Architecture and domain constraints

The design has three applications: `cli`, `server`, and `worker`.
One server process on one host contains exactly six services.
A service separates authority, not deployment. The worker application contains
worker instances and no service. A declared application need not exist in the
current implementation.

Each service owns one authority boundary:

- **Project:** resource bindings, repository policy, effective configuration,
  resource authorization, and credential custody.
- **Mission:** mission graph, criteria, evidence, assessments, outcomes, node
  states, and attempts.
- **Scheduler:** work queue, claims, execution records, leases, delivery intake,
  and observations.
- **Worker:** templates, agents, instance hosting, connectors, prompt composition,
  MCP, and external action performance.
- **Tracking:** telemetry only; no evidence, outcome, or operational decision
  authority.
- **Gateway:** REST API, caller authentication, identity forwarding, and
  machine-readable contracts; not resource authorization.

The following domain rules apply across those boundaries:

- Planning occurs outside kanthord. A human owns node and criterion writes.
  Execution authority grants no planning authority.
- Schedule initiatives and objectives, never tasks. Keep a worker template,
  worker binding, worker instance, execution, and attempt distinct.
- Execution completion, a passing assessment, and repository action completion
  do not independently establish success. Mission owns the outcome rules.
- Only a human unblocks a node. Terminal nodes never reopen; further work needs
  a new node. Preserve records from previous attempts.
- Native steps and evaluation use separate claims. The executing worker chooses
  neither its reviewer nor that reviewer's instructions.
- Project authorizes each resource operation before custody supplies its secret.
  No resource credential reaches an execution, agent, or external harness.
  A live claim proves liveness, not resource authorization.
- Telemetry is lossy and cannot determine outcomes or scheduling decisions.
  A telemetry write must not fail its producing operation. Operational logs and
  telemetry remain separate.
- The first-version worker design names `general@1` and `reviewer@1`.
  `tdd@1` remains deferred; do not impose its method on other workers.

## Project structure

This tree shows selected existing paths and the placement of future components.
`[planned]` means the path does not exist yet. `[partial]` means only part of the
component exists. Unmarked paths exist; their presence does not imply a complete
service implementation.

```text
engine/
├── AGENTS.md                    # Contributor instructions and shared constraints
├── README.md                    # Project entry point
├── package.json                 # Runtime requirements, dependencies, and commands
├── pnpm-lock.yaml               # Locked dependency graph
├── bin/
│   └── kanthord.mjs             # Runtime gate and compiled application launcher
├── src/
│   ├── main.ts                 # Fatal handlers and CLI dispatch
│   ├── apps/                   # Application entries and composition roots
│   │   ├── cli/                # Commander commands and HTTP client configuration
│   │   ├── server/             # Compose services; own startup and shutdown
│   │   └── worker/             # [planned] Remote worker app; HTTP clients, no services
│   ├── config/                 # Server configuration schema and XDG directories
│   ├── project/                # [planned] Bindings, authorization, and custody
│   ├── mission/                # [planned] Graph, criteria, evidence, and outcomes
│   ├── scheduler/              # [planned] Queue, claims, leases, and observations
│   ├── worker/                 # [partial] Worker Service, not the worker application
│   │   ├── operations.ts       # Existing worker registration operation
│   │   └── service.ts          # [planned] Worker hosting and lifecycle
│   ├── tracking/               # [planned] Telemetry ingestion, storage, and retention
│   ├── gateway/                # HTTP transport and shared invocation infrastructure
│   │   ├── service.ts          # Gateway lifecycle and transport wiring
│   │   ├── operations.ts       # Gateway-owned operation declarations and handlers
│   │   ├── migrations.ts       # Gateway-owned database migrations
│   │   └── *.test.ts           # Tests beside the source; other helpers omitted here
│   ├── context.ts              # Cancellation contract and transport bridge
│   ├── service.ts              # Shared Service lifecycle and health contracts
│   ├── health.ts               # Component health aggregation
│   ├── store.ts                # Operational SQLite connection and transactions
│   ├── log.ts                  # Operational logging, not product telemetry
│   ├── shared/                 # Cross-service utilities, not domain authority
│   └── test-support.ts         # Isolated test fixtures
├── static/                     # Packaged, generated OpenAPI assets
├── scripts/                    # Development and acceptance utilities
├── docs/                       # Internal, self-contained implementation notes
│   ├── README.md               # Audience policy and index
│   └── testing.md              # Contributor acceptance checks
├── .agents/
│   └── skills/                 # Task workflows, not implicit product specifications
└── dist/                       # Generated build output; never edit by hand
```

- Place each future service directly under `src/<service>/`, beside `gateway/`
  and `worker/`. Do not put service implementations under `src/apps/`.
- Keep a service's lifecycle, operations, private helpers, and colocated tests
  in its directory. Add `migrations.ts` only when that service owns persisted tables.
- Keep `src/apps/worker/` distinct from `src/worker/`. The application runs worker
  instances through service clients; it hosts no service.
- Add directories and files when their implementation lands. Do not create empty
  scaffolding merely to match this tree. Update the status comments as work lands.

## Commands and validation

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm start --help
pnpm test
pnpm run verify
```

- `pnpm run verify` checks formatting, types, tests, lint, and the build.
  Run it before handoff of code changes; report failures and anything not run.
- Use the acceptance criteria of the task and the relevant local documentation.
  Add coverage for the agreed contract; existing tests alone do not define it.
- For focused tests, use
  `node --test --test-timeout=30000 src/path/to/file.test.ts`.
- For JWT authentication changes, also run `pnpm run test:e2e:jwt`.
  It requires Python 3 with POSIX PTY support and creates disposable server state.
- The verification script does not check Markdown formatting. For documentation
  changes, run `pnpm exec prettier --check <changed-markdown-files>` and verify
  relative links and documented commands.

## Implementation rules

- Follow the strict TypeScript and ESM configuration. Use explicit `.ts`
  extensions for relative source imports and `import type` for type-only imports.
- Follow Prettier and ESLint rather than introducing a competing style.
- Compare fixed string and numeric values through meaningfully named enum members
  or constants, never bare literals. This covers equality, ordering, thresholds,
  switch cases, and test assertions. Reuse the owning module's declaration;
  test-owned expected fixtures also use meaningful names. Use `as const` objects
  for runtime discriminants and derive their TypeScript types from those values.
  JavaScript type checks use `src/shared/values.ts` so named values retain type
  narrowing without casts.
- Make the smallest complete change. Add no speculative feature, dependency,
  or single-use abstraction. Preserve unrelated code and formatting.
- Keep application composition in `src/apps/` and shared services outside it.
  A caller uses the target service's client contract, not its private modules
  or tables. Keep Hono types at the HTTP boundary.
- Declare operations in their owning services. Generate routes and OpenAPI from
  the registry. HTTP and direct adapters enter the same validation, idempotency,
  access-policy, and handler chain. Neither adapter bypasses that chain.
- Keep one transaction owner per operation. Pass its transaction explicitly to
  internal collaborators. Never compose two operations into an atomic unit.
- Use the operational SQLite store for operational records. Tracking owns its
  separate store when implemented. A synchronous transaction spans no `await`
  or remote effect. Published migrations are immutable; append corrections.
- Preserve completed, declared-failure, and indeterminate results. A lost answer
  proves no failure. Keep one idempotency key across retries of a logical mutation.
- Preserve the `Service` contract. Lifecycle methods return `Promise<Error | null>`;
  their failures do not reject. Concurrent starts or stops join the same work.
  A stopped instance cannot restart.
- Pass `Context` to collaborators; bridge native signals only at transport
  boundaries. Stop admission, cancel waiting work, join active work, then release
  resources in reverse order. Cancellation proves neither completion nor rollback.
  A cleanup failure must not skip later releases.
- Report only owned, implemented health components through the shared registry.
  Absent services receive no fictitious healthy entry.
- Keep server configuration in one strictly validated YAML file through `convict`.
  Environment variables and `--config` locate that file; they do not override its
  values. Client endpoint and credential precedence is a separate contract.
- Follow XDG placement: configuration in the config directory, databases in data,
  logs and session records in state, and only rebuildable artifacts in cache.
  Put each new configuration field in the schema and document its format and default.
- Server-owned files use `0600`, directories `0700`, and sockets `0600`.
  Validate types, ownership, modes, and symlinks. Repair no existing object silently.
- Keep the CLI non-interactive. Service API commands use HTTP, not the server
  database or configuration. Only declared local commands access local files.
- Human token issuance belongs to `kanthord jwt`; startup issues no token.
  Worker registration belongs to `worker.register` at `POST /api/worker/register`.
  Add no removed login/logout flow or compatibility alias.
- Preserve the terminal-output requirement for explicit token display.
  Never include secrets in diagnostics, logs, or generated documentation.
- Server-generated opaque entity identities use `<prefix>_<ulid>`.
  Each entity kind has a stable lower-case prefix and a canonical uppercase ULID.
  Protocol-defined identities and natural keys keep their declared representation.
- Server timestamps use safe-integer Unix milliseconds. JWT timestamps use Unix
  seconds. Measure durations with a monotonic clock, not wall-clock subtraction.
- Use the shared canonical JSON and digest helpers in `src/shared/json.ts`.
  Canonical JSON follows RFC 8785. Its digest uses SHA-256 over UTF-8 bytes without
  a trailing newline, rendered as lower-case hexadecimal.
- Use the shared failure envelope. New error codes use the owning namespace and
  at least three lower-case, dot-separated parts, not an ad hoc uppercase code.
- Add or update colocated `*.test.ts` tests for behavior changes. Use `node:test`,
  `node:assert/strict`, and existing fixtures. Cover relevant failure and cleanup
  paths, not just successful results.
- Keep tests isolated with temporary state and cleanup hooks; do not use real
  credentials or a developer's live configuration.
- Do not hand-edit `dist/` or generated OpenAPI YAML. Change the source and
  regenerate OpenAPI assets with
  `pnpm run build && node bin/kanthord.mjs gateway openapi`.

## Documentation rules

- `docs/` in this submodule contains implementation details only: source maps,
  ownership, invariants, lifecycle, persistence, internal integration, and tests.
  Keep [docs/README.md](docs/README.md) current. Link to existing public pages
  instead of duplicating their content in internal notes.
- Public tutorials, how-to guides, reference, and explanations follow Diátaxis in
  the kanthord repository. Do not recreate that user-facing hierarchy here.
- When a behavior change affects users, update its public contract as well as
  the relevant internal note. Check examples against source and tests.
- Label approved future design and unresolved decisions explicitly. A proposal
  or planned path is not evidence of shipped behavior.
- Keep local source and test links valid in a standalone engine checkout.
  Link to the public site, not filesystem paths outside this submodule, for
  user-facing documentation.
- Use short, direct technical sentences and consistent vocabulary. Keep
  identifiers exact. Record accepted mechanisms and constraints, not ideation
  history; new brainstorming belongs in the parent repository's discussion area.

## Project instructions and runtime prompts

Repository instructions and worker runtime prompts have separate authority.
Preserve these boundaries when implementing prompt composition:

- If the composer loads this file as a project prompt, it supplies repository
  conventions only. It grants no tool, resource, planning, or assessment authority.
- A project prompt changes no worker method, effective configuration, budget,
  repository policy, or release rule. It defines no validation criterion.
- Base and agent prompts belong to the versioned worker contract.
  Do not copy them here as a second default standard.
- Reviewer executions use the configured project prompt, never candidate-owned
  workspace agent files. Preserve that boundary in prompt-loader changes.

## Working safely

- Inspect the working tree before editing. Preserve unrelated changes and
  untracked files; do not reset, overwrite, or commit them as part of your work.
- Never expose secrets in code, documentation, logs, or acceptance evidence.
  Use placeholders for JWTs, master keys, and client secrets.
- Follow an explicitly assigned task workflow without treating it as product
  design. Do not promote legacy workflow assumptions into official engine rules
  without an explicit decision.
- At handoff, summarize the changes, validation performed, and remaining risks
  or blockers. Do not claim tests passed unless they were run successfully.
