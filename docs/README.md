# Internal engine documentation

This directory contains implementation details and technical notes for engine contributors. It is **not the public manual** and is not published to GitHub Pages.

The public documentation lives in the kanthord repository and is published at [kanthord.kanthorlabs.com](https://kanthord.kanthorlabs.com). Internal brainstorming belongs to that repository's `docs/brainstorm/`, not here. Discussion material is input, not proof of implemented behavior.

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

## Internal notes

- [Engine CLI specification](cli/README.md): target commands, arguments, and
  parameters, with one document per service and one for shared commands.
- [JWT acceptance checks](testing.md): repeatable contributor validation.
- [Agent instructions](../AGENTS.md): project map and routine contributor tasks.

## Authoring policy

Keep these notes self-contained in a standalone engine checkout. Document only engine-specific details not already covered by the public documentation. Link to local source and tests for mechanisms and invariants; link to existing public pages instead of duplicating their content here. No implementation note should require the parent repository's discussion history.

Distinguish implemented behavior, approved future design, and unresolved proposals. Update relevant notes when implementation changes, and update the public documentation in the kanthord repository when users or API consumers are affected. Never promote a brainstorming proposal into a shipped guarantee without verifying it against source and tests.
