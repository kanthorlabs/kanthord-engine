# Agent instructions

The design pages and implementation siblings in the kanthord repository under
`docs/brainstorm/` hold the rules. This file explains where things are and how to
do routine contributor tasks.

## Project structure

```text
engine/
├── AGENTS.md                    # Project map and routine contributor tasks
├── README.md                    # Project entry point
├── package.json                 # Runtime requirements, dependencies, and commands
├── pnpm-lock.yaml               # Locked dependency graph
├── eslint.config.js             # Import boundaries and source checks
├── bin/                         # Executable launchers
│   └── kanthord.mjs             # Runtime gate and compiled application launcher
├── src/                         # TypeScript source and colocated tests
│   ├── main.ts                 # Fatal handlers and CLI dispatch
│   ├── config/                 # Whole configuration assembly and file loading
│   │   ├── global.ts           # Global schema, types, log destination, and key size
│   │   └── index.ts            # Compose fragments; locate, load, initialize, and show YAML
│   ├── kernel/                 # Transport-neutral runtime and shared vocabulary
│   │   ├── service.ts          # Service lifecycle and component health contracts
│   │   ├── context.ts          # Cancellation contexts and native signal bridge
│   │   ├── store.ts            # Operational SQLite connection and migration runner
│   │   ├── health.ts           # Component probe registry and aggregation
│   │   ├── log.ts              # Operational logging and fatal handlers
│   │   ├── errors.ts           # Coded errors and transport-neutral failure envelope
│   │   ├── operation.ts        # Operations, structural registry, callers, and client results
│   │   ├── caller.ts           # Identity types, provenance, and predicates
│   │   ├── caller-mint.ts      # Identity minting entry reserved for Gateway
│   │   ├── json.ts             # Canonical JSON, digests, key derivation, and timestamps
│   │   ├── identity.ts         # Prefixed entity identities and ULID schemas
│   │   ├── values.ts           # JavaScript value predicates
│   │   ├── version.ts          # Cached package version
│   │   ├── xdg.ts              # Configuration, data, state, and cache directories
│   │   ├── yaml.ts             # Bounded YAML mapping parsing
│   │   ├── files.ts            # Private filesystem validation and publication
│   │   ├── http.ts             # Shared HTTP methods, statuses, and media types
│   │   └── test-support.ts     # Isolated temporary filesystem fixtures
│   ├── custody/                # Custody component: credential envelope, platform validators, OAuth login sessions, and platform probes
│   ├── project/                # Project Service and binding lookup ownership
│   │   ├── contract.ts         # Project operations and ProjectBindings collaboration
│   │   ├── index.ts            # Service, dependencies, configuration fragment, and migrations
│   │   └── service.ts          # Private lifecycle, declarations, and binding lookup
│   ├── mission/                # [planned] Mission graph, criteria, evidence, and outcomes
│   ├── scheduler/              # [planned] Queue, claims, leases, and observations
│   ├── worker/                 # Worker Service and registration ownership
│   │   ├── contract.ts         # Worker operations and registration collaboration types
│   │   ├── index.ts            # Service, dependencies, configuration fragment, and migrations
│   │   └── service.ts          # Private lifecycle, registration handler, and replay guard
│   ├── tracking/               # [planned] Telemetry ingestion, storage, and retention
│   ├── gateway/                # HTTP transport, authentication, and invocation infrastructure
│   │   ├── contract.ts         # Gateway operation declarations
│   │   ├── index.ts            # Service composition, invocation factory, adapters, and schema
│   │   ├── client.ts           # HTTP client, client configuration, and server version discovery
│   │   ├── local.ts            # Local JWT issuance and OpenAPI generation without a server
│   │   └── service.ts          # Private listener lifecycle and HTTP wiring
│   └── apps/                   # Application entries and composition roots
│       ├── server/             # Service construction, startup, shutdown, and integration tests
│       │   └── index.ts        # Compose configuration, log, store, registry, and services
│       ├── cli/                # Non-interactive commands and client configuration
│       │   ├── index.ts        # Commander dispatch and local configuration, JWT, and Gateway commands
│       │   ├── constants.ts    # CLI command names and exit codes
│       │   └── worker.ts       # Worker command group
│       └── worker/             # Remote worker application skeleton
│           └── index.ts        # Client resolution, version check, and cancellable lifetime
├── static/                     # Packaged generated OpenAPI assets
│   ├── openapi.yaml             # Root contract index and package version
│   └── openapi/                # Service path items and shared schemas
│       ├── gateway/            # Gateway operation documents
│       ├── worker/             # Worker operation documents
│       └── shared/             # Common OpenAPI components
├── scripts/                    # Development and acceptance utilities
├── docs/                       # Internal implementation notes
│   ├── README.md               # Audience policy and project map
│   └── testing.md              # JWT acceptance procedure
├── .agents/                    # Task workflow links
│   └── skills/                 # Linked authoring, planning, review, and execution workflows
└── dist/                       # Generated build output
```

## Install and validate

Use Node.js `>=24.15.0 <25` and the pnpm version pinned in `package.json`.
`.nvmrc` selects the development Node.js version.

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm start --help
pnpm test
pnpm run verify
```

Run `pnpm run verify` before handing off code. It checks formatting, types,
tests, lint, and the build. Report failures and checks not run.

Run a focused test with:

```sh
node --test --test-timeout=30000 src/path/to/file.test.ts
```

Run JWT acceptance after authentication changes:

```sh
pnpm run test:e2e:jwt
```

The runner needs Python 3 with POSIX PTY support and creates disposable server
state. See [JWT acceptance checks](docs/testing.md).

Check changed Markdown separately:

```sh
pnpm exec prettier --check <changed-markdown-files>
```

Verify relative links and documented commands.

## Add a service

1. Create `src/<service>/contract.ts`, `index.ts`, and `service.ts`.
   Put operation declarations and collaboration types in `contract.ts`.
   Implement lifecycle, owned health probes, and `declare(registry)` in
   `service.ts`.
2. Export the service, `Dependencies`, configuration fragment, and migrations
   from `index.ts`. Export an empty migration list until the service owns tables.
3. Import its fragment in `src/config/index.ts`. Add its parsed section type
   when the fragment gains fields. Empty fragments add no YAML section.
4. Add migrations and constructor dependencies in `src/apps/server/index.ts`.
   Wire collaboration lookups, call `declare`, and seal the registry after
   declarations. Start domain services before Gateway. Quiesce all services,
   drain their work with dependencies available, join the invocation chain,
   then stop services in reverse construction order.
5. Register the service's own health probe. Add colocated lifecycle tests and
   composition coverage under `src/apps/server/`. Include its migrations in
   `src/apps/server/migrations.test.ts`.
6. Run `pnpm run verify` to check implementation and import boundaries.

## Add an operation

1. Declare the operation and its input/output schemas in the owning service's
   `contract.ts`. Set `lifetime` to `OperationLifetime.Unary`, `Wait`, or
   `Stream`, and `store` to `StoreName.Operational`. Supply the store when
   sealing the registry. A mutation must be idempotent by its own natural key;
   invocation replay lasts only within the in-memory TTL.
2. Bind its handler in the service's `declare(registry)`. Add tests beside the
   implementation and adapter integration tests under `src/apps/server/`.
3. For a peer call, pass the original caller through the direct client's
   per-call `identity` option.
4. Add any CLI command in `src/apps/cli/`. Import the contract and the HTTP
   adapter rather than the service implementation.
5. Regenerate OpenAPI and run `pnpm run verify`.

## Run the worker application

```sh
kanthord serve worker --endpoint <url> --token <jwt>
```

The worker resolves its endpoint and token from options, then
`KANTHORD_ENDPOINT` / `KANTHORD_TOKEN`, then `cli.yaml` in the configuration
directory. The default endpoint is `http://127.0.0.1:31415`.
It reads the server's package version through the OpenAPI index and refuses
an unavailable or different version. On a match it logs
`Worker application started` and waits for cancellation, `SIGINT`, or `SIGTERM`.
It hosts no instances yet, opens no database, and reads no server configuration.
`--config` is not supported. `kanthord serve` still starts the server.

## Add a migration

1. Append a migration to the owning service's `migrations.ts`. Never edit a
   published migration.
2. Prefix each table with `<service>_`. Export the migration list from the
   service's `index.ts` and include it in the server's migration assembly.
3. Include the list in both ownership checks in
   `src/apps/server/migrations.test.ts`: distinct table prefixes in a shared
   store, and successful application of each service's migrations alone.
4. Run the ownership tests and `pnpm run verify`.

## Add a configuration field

1. Add the field, format, documentation, and default to the owning service's
   fragment exported by `index.ts`, or to `src/config/global.ts` for a global
   field.
2. Update the parsed section type and pass it from the server composition root.
3. Check the `kanthord config init` default and `config validate|show` behavior
   in `src/config/index.test.ts`.
4. Update the field documentation in the owning implementation page and public
   reference. Run the configuration tests and `pnpm run verify`.

## Regenerate OpenAPI

Change operation declarations, not generated YAML. Run:

```sh
pnpm run build && node bin/kanthord.mjs gateway openapi
```

Review the changes under `static/`. Run `pnpm run verify`; the projection and
HTTP integration tests compare the generated files with the published assets.
