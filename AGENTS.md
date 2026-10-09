# Agent instructions

The design pages and implementation siblings in the kanthord repository under
`docs/brainstorm/` hold the rules. This file explains where things are, how to
do routine contributor tasks, and the working rules for agents.

## Project structure

```text
engine/
├── AGENTS.md                    # Project map, contributor tasks, and working rules
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
│   │   ├── service-mint.ts     # Service identity factory reserved for the server composition root
│   │   ├── json.ts             # Canonical JSON, digests, key derivation, and timestamps
│   │   ├── handover.ts         # Handover keys, additional authenticated data and envelope codec
│   │   ├── identity.ts         # Prefixed entity identities and ULID schemas
│   │   ├── values.ts           # JavaScript value predicates
│   │   ├── version.ts          # Cached package version
│   │   ├── xdg.ts              # Configuration, data, state, and cache directories
│   │   ├── yaml.ts             # Bounded YAML mapping parsing
│   │   ├── files.ts            # Private filesystem validation and publication
│   │   ├── http.ts             # Shared HTTP methods, statuses, and media types
│   │   ├── probe.ts            # Remote HTTP probe and failure-reason redaction
│   │   ├── assets.ts           # Shipped assets from the single binary or static/
│   │   └── test-support.ts     # Isolated temporary filesystem fixtures
│   ├── repository/             # Repository component: startup gate, SSH reachability, checkout, snapshot, node-branch transport, server-side git write and landing read, and repository credentials
│   │   ├── contract.ts         # Repository credential route group
│   │   ├── credential-platform.ts # github platform validator and GitHub probe
│   │   ├── credential.ts       # Repository credential routes over custody records and binding dependents
│   │   └── github.ts           # GitHub platform implementation: per-call octokit client, result classes, the delivery classification and the event decoder
│   ├── llm/                    # LLM component: LLM platforms, credential routes, OAuth login sessions, and the model connector
│   │   ├── contract.ts         # LLM credential route group, login and provider check operations, and error codes
│   │   ├── index.ts            # Component and platform table exports
│   │   ├── platforms.ts        # LLM platform validators, metadata schemas, and model defaults
│   │   ├── provider.ts         # LLM provider interface and healthcheck status of a connection
│   │   ├── probes.ts           # LLM provider checks and check model constants
│   │   ├── sessions.ts         # In-memory OAuth login sessions
│   │   ├── login.ts            # pi-ai OAuth login flow and interaction adapter
│   │   ├── model-connector.ts  # Model runtime and model from a released credential
│   │   └── service.ts          # Credential routes, metadata rules, login lifecycle, and healthchecks
│   ├── agent/                  # Agent component: agent catalog, enablements, effective configuration, and provider healthchecks
│   │   ├── contract.ts         # Agent routes, enablement and configuration schemas, and error codes
│   │   ├── index.ts            # Component and migration exports
│   │   ├── migrations.ts       # agent_enablement and agent_prompt tables
│   │   ├── config.ts           # Prompt system file and agent directory configuration fragment
│   │   ├── catalog.ts          # Static agent declarations
│   │   ├── prompt-assets.ts    # Byte-exact packaged base, agent and workbench prompts
│   │   ├── pi.ts               # Cached offline SDK loader and isolated agent directory
│   │   ├── agent-session.ts    # Isolated sessions and setup deadlines
│   │   ├── prompt-source.ts    # Bounded UTF-8 prompt source reader
│   │   ├── prompt-composer.ts  # Layer selection, attribution, digests and work prompts
│   │   ├── prompt-layers.ts    # System, agent and working layer sources, switches and states
│   │   ├── prompt-render.ts    # Framing, system prompt, pinned working texts and final prompt
│   │   ├── prompts.ts          # agent_prompt settings reads and writes
│   │   ├── prompt-locks.ts     # Configuration locks of prompt switches
│   │   ├── pinned-layers.ts    # Context and inference pins across compaction
│   │   ├── environment.ts      # Provider-free child process environment
│   │   ├── test-support.ts     # Scripted offline provider
│   │   ├── enablements.ts      # Revision, tombstone, pagination, and dependency store reads
│   │   ├── configuration.ts    # Shared provider, model, and reasoning-level validation
│   │   └── service.ts          # Enablement routes, entry validation, agent views, and provider healthchecks
│   ├── storage/                # Storage component: storage platforms, credential routes, and the S3 presign, object read and object delete
│   │   ├── contract.ts         # Storage credential route group
│   │   ├── index.ts            # Component and platform table exports
│   │   ├── platforms.ts        # s3 platform validator and metadata schema
│   │   ├── probe.ts            # S3 HeadBucket probe
│   │   ├── s3.ts               # S3 implementation: presigned PUT and GET, object metadata read, object delete and result classes
│   │   └── service.ts          # Storage credential routes over custody records and binding dependents
│   ├── custody/                # Custody component: credential store, envelope, revisions, record functions, release, and handover
│   │   ├── contract.ts         # Secret shapes, record schemas, platform set types, and record functions
│   │   ├── names.ts            # Credential name form and reserved names
│   │   ├── service.ts          # Record functions, suitability, release, handover, and inventory
│   │   ├── payload.ts         # Normalized execution credential and stored secret conversion
│   │   ├── execution-store.ts # Isolated execution credential view and serialized refresh reports
│   │   ├── workbench-store.ts # Workbench credential view over the newest live revision
│   │   └── client.ts          # Public execution credential store builder, error and type
│   ├── project/                # Project Service: projects, binding sets, and binding collaborations
│   │   ├── contract.ts         # Constants, closed sets, binding schemas, operations, collaboration and dependency types
│   │   ├── index.ts            # Service, dependencies, configuration fragment, and migrations
│   │   ├── migrations.ts       # project_project and project_binding tables
│   │   ├── store.ts            # Binding-set read, compare-and-swap write, pagination, and resource identity derivation
│   │   └── service.ts          # Lifecycle, operation handlers, and collaboration implementations
│   ├── intake/                 # Intake Service: inbound events and outbound requests
│   │   ├── contract.ts         # Service name, closed sets, bounds, error codes, outbound schemas, action operations, action table, address and result-class schemas, storage operations, inbound schemas, inbound operations, the inbound collaboration type, the inbound event schema, the event operations and the receipt, and operations
│   │   ├── index.ts            # Service, dependencies, configuration fragment, and migrations
│   │   ├── configuration.ts    # Inbound configuration schema per kind and platform, and resource identity
│   │   ├── inbound-store.ts    # Inbound rows, the record projection, the checkpoint write, the poll inbound list, the list of every inbound, pending event count, and delete with events
│   │   ├── inbound-create.ts   # Inbound create: admission of a webhook and a poll, project check, the poll release and first request, credential check, insert step, and loop start
│   │   ├── inbound-delete.ts   # Inbound delete that refuses a pending event and removes the events and the row
│   │   ├── inbound-read.ts     # Inbound list with a cursor and get with the webhook address and secret
│   │   ├── event-store.ts      # Inbound event rows, the repeat lookup, pending count, the oldest pending read, conditional state writes, the event deletes, and the record projection
│   │   ├── event-read.ts       # Inbound event list with a cursor and get by identity
│   │   ├── event-write.ts      # Inbound event retry, discard and delete, with the in-flight refusal of a discard
│   │   ├── dispatcher.ts       # Event handoff: oldest pending selection, reservation in the in-flight set, consumer call, and conditional state write
│   │   ├── poll.ts             # Poll loops: one loop per inbound, the cycle with its capacity pause and release, and the batch with its checkpoint
│   │   ├── health.ts           # Inbound resource inventory: one entry per inbound, the poll check with its release and request, and the webhook check
│   │   ├── receipt.ts          # Webhook receipt: inbound lookup, signature check, handshake, capacity bound, and insert
│   │   ├── outbound-store.ts   # Outbound request rows, conditional state writes, and the record projection
│   │   ├── outbound.ts         # Outbound runner: admission, in-flight set, deadline, read-back, and state commit
│   │   ├── outbound-read.ts    # Outbound request list and get handlers
│   │   ├── outbound-write.ts   # Outbound request discard and delete handlers
│   │   ├── action-check.ts     # Check of a request evidence: authorization, release, and platform fold
│   │   ├── action-perform.ts   # Configured action: action table lookup, authorization, platform write, and read-backs
│   │   ├── action-read.ts      # Read of a request evidence: authorization, release, and platform body
│   │   ├── address-codec.ts    # Stored form of a platform address in an outbound result
│   │   ├── storage.ts          # Presigned PUT and GET and the object check: authorization, release and Storage call
│   │   ├── storage-delete.ts   # Object delete: s3.delete_object, its read-back and its stored status
│   │   ├── webhook-secret.ts   # Verification secret of a webhook inbound, derived from the master key
│   │   ├── test-support.ts     # Unused action collaborations and a master key for Intake unit tests
│   │   └── service.ts          # Lifecycle, health probe, resource inventory, the `inboundsNaming` collaboration, the inbound removal notice and the event wake notice
│   ├── mission/                # Mission Service: mission graph, criteria, evidence, and outcomes
│   │   ├── contract.ts         # Mission schemas, operations, and collaboration types
│   │   ├── index.ts            # Service, dependencies, configuration fragment, and migrations
│   │   ├── config.ts           # Mission limits and Convict configuration schema
│   │   ├── migrations.ts       # Mission, node, revision, and dependency tables
│   │   ├── record-store.ts     # Attempts, evidence, assessments, and outcomes
│   │   ├── record-read.ts      # Record projections and blocked context
│   │   ├── record-list.ts      # Record pagination and read handlers
│   │   ├── frozen-action.ts    # Pinned repository requirements and resolutions
│   │   ├── action-context.ts   # Atomic action eligibility and earlier request candidates
│   │   ├── currency.ts         # Read-time assessment currency and selection
│   │   ├── conditions.ts       # Readiness, closure, and continuation conditions
│   │   ├── control.ts          # Transactional human-control admission and closure
│   │   ├── control-hold.ts     # Pause, ready, and resume
│   │   ├── control-close.ts    # Block, discard, and success override
│   │   ├── control-unblock.ts  # Atomic direction change and next attempt
│   │   ├── transitions.ts     # Scheduler claim, release admission, and failure
│   │   ├── execution.ts       # Live claim and execution context admission
│   │   ├── execution-read.ts  # Pinned revisions, attempts and current objective outcomes
│   │   ├── evidence-content.ts # Binding, byte and verification validation
│   │   ├── evidence-submit.ts # Evidence insertion and object upload preparation
│   │   ├── evidence-complete.ts # Checked object upload publication
│   │   ├── evidence-read.ts   # Evidence pagination and record reads
│   │   ├── evidence-content-read.ts # Caller-bounded inline and object content
│   │   ├── evidence-delete.ts # Remote-first asset and evidence deletion
│   │   ├── evidence-request.ts # Evaluation external-action requests
│   │   ├── assessment-admit.ts # Evidence, result and tested-input admission
│   │   ├── assessment-submit.ts # Assessment insertion and eligible closure
│   │   ├── node-check.ts      # On-demand checks and write-once end states
│   │   ├── delivery-match.ts  # Delivery admission match of a platform address to a request
│   │   ├── delivery-admit.ts  # Delivery admission: decode, match, Intake check and end-state commit
│   │   └── service.ts          # Lifecycle, health, and collaboration implementations
│   ├── scheduler/              # Scheduler Service: work queue, execution claims, history, and loss settlement
│   │   ├── contract.ts         # Execution schemas, operations, and collaboration contracts
│   │   ├── index.ts            # Service, dependencies, configuration fragment, and migrations
│   │   ├── config.ts           # Fixed execution deadline release reserve
│   │   ├── migrations.ts       # scheduler_job and scheduler_execution tables
│   │   ├── execution-store.ts  # Execution rows, claim-state derivation, and record projection
│   │   ├── claim.ts            # Transactional work selection and admission
│   │   ├── work-pull.ts        # Rolled-back probes, waiting, and one final commit
│   │   ├── wakeup.ts           # Project-scoped waiting pulls and coalesced notifications
│   │   ├── release.ts          # Transactional proof and Mission release routing
│   │   ├── execution-read.ts   # Claim ownership and paginated execution history
│   │   ├── settlement.ts       # Loss, revocation, credential pins, and retained attribution
│   │   └── service.ts          # Lifecycle, loss sweep, queue handlers, and collaboration entrypoints
│   ├── worker/                 # Worker registrations, native executions, and configuration collaborations
│   │   ├── contract.ts         # Worker operations, schemas, and collaboration types
│   │   ├── index.ts            # Service, dependencies, configuration fragment, and migrations
│   │   ├── migrations.ts       # Durable worker_instance rows
│   │   ├── instances.ts        # Transaction-owned registration rows, retained attribution, and live reads
│   │   ├── registrations.ts    # Capacity admission, live-registration lookup, and client attribution
│   │   ├── heartbeat.ts        # Monotonic readings, renewal, and expiry selection
│   │   ├── instance-record.ts  # Live runtime projection, activity, filters, and pagination
│   │   ├── config.ts           # Heartbeat window configuration fragment
│   │   ├── catalog.ts          # Static worker declarations
│   │   ├── action-performer.ts # Claim admission, dispatch, reuse and request evidence
│   │   ├── action-reservations.ts # Execution mutex and owner-held uncertain dispatches
│   │   ├── action-operands.ts  # Pinned assessment snapshot and action operands
│   │   ├── action-reuse.ts     # Open pull-request repository and branch checks
│   │   ├── action-classify.ts  # No-effect, unknown-effect and recording outcomes
│   │   ├── node-branch.ts      # Shared deterministic node branch name
│   │   ├── tool-table.ts       # Declared tools, host checks and bounded hygienic bash
│   │   ├── model-runtime.ts    # Execution model runtime factory over the LLM model connector
│   │   ├── test-support.ts     # Runtime fixtures over the scripted offline provider
│   │   ├── budget.ts           # Monotonic wall budget, turns and cleanup deadline
│   │   ├── verification.ts     # Sequential deadline-bounded verification commands
│   │   ├── local-git.ts        # Workspace head and verification cleanup
│   │   ├── workspace.ts        # Private workspace keys, preparation, holds and retention
│   │   ├── execution-setup.ts  # Proven execution setup from pinned configuration
│   │   ├── native-agent.ts     # Composed execution-scoped agent lifetime
│   │   ├── method-clients.ts   # Injected execution-scoped operation clients
│   │   ├── execution-run.ts    # Refusal boundary, submissions and release reconciliation
│   │   ├── judgement.ts        # Strict handoff parsing and method instructions
│   │   ├── node-reads.ts       # Bounded pinned-context and objective reads
│   │   ├── steps-objective.ts # Start checks, task revisions and objective publication
│   │   ├── steps-initiative.ts # Current objective report and initiative release
│   │   ├── evaluation-input.ts # Isolated snapshots and evidence placement
│   │   ├── evaluation.ts       # Verification evidence, assessment and action requests
│   │   ├── transcript.ts       # Execution transcript sink and no-op implementation
│   │   ├── native-method.ts    # Injected native method dispatch and resource lifetime
│   │   └── service.ts          # Registration lifecycle, instance healthchecks, report-only registration checks, and entry validation
│   ├── workbench/              # Workbench Service: human-driven agent sessions
│   │   ├── contract.ts         # Workbench operations, schemas, and error codes
│   │   ├── index.ts            # Service, dependencies, and migrations
│   │   ├── migrations.ts       # Empty migration list
│   │   ├── sessions.ts         # Workbench directory, pi session list, create, find, and stored configuration
│   │   ├── tools.ts            # Built-in tools and one tool per human operation without secret material
│   │   └── service.ts          # Session lifecycle, configuration, credential grant, runs, approvals, and operation handlers
│   ├── tracking/               # [planned] Telemetry ingestion, storage, and retention
│   ├── gateway/                # HTTP transport, authentication, and invocation infrastructure
│   │   ├── contract.ts         # Gateway operation declarations
│   │   ├── index.ts            # Service composition, invocation factory, adapters, and schema
│   │   ├── client.ts           # HTTP client, client configuration, and server version discovery
│   │   ├── local.ts            # Local JWT issuance and OpenAPI generation without a server
│   │   ├── base-path.ts        # Base path format, prefix stripping, and base href
│   │   ├── dashboard.ts        # Embedded dashboard assets outside /api
│   │   └── service.ts          # Private listener lifecycle and HTTP wiring
│   └── apps/                   # Application entries and composition roots
│       ├── server/             # Service construction, startup, shutdown, and integration tests
│       │   └── index.ts        # Compose configuration, log, store, registry, and services
│       ├── cli/                # Non-interactive commands and client configuration
│       │   ├── index.ts        # Commander dispatch and local configuration and Gateway commands
│       │   ├── jwt.ts          # Local JWT generation, inspection, and claim rendering
│       │   ├── config-path.ts  # Shared server configuration path and help text
│       │   ├── constants.ts    # CLI command names and exit codes
│       │   ├── credential.ts   # Shared credential command group of a component
│       │   ├── llm.ts          # LLM command group and login commands
│       │   ├── repository.ts   # Repository command group
│       │   ├── storage.ts      # Storage command group
│       │   ├── agent.ts        # Agent command group
│       │   ├── intake.ts       # Intake command group and outbound request commands
│       │   ├── intake-inbound.ts # Intake inbound commands
│       │   ├── intake-event.ts # Intake inbound event commands
│       │   └── worker.ts       # Worker command group
│       └── worker/             # Remote worker application skeleton
│           ├── api.ts          # Server operation clients and bounded backoff
│           └── index.ts        # Client resolution, version check, and cancellable lifetime
├── static/                     # Packaged generated OpenAPI assets
│   ├── prompt/                 # Byte-exact base, swe@1, re@1 and workbench prompt assets
│   ├── openapi.yaml             # Root contract index and package version
│   └── openapi/                # Service path items and shared schemas
│       ├── gateway/            # Gateway operation documents
│       ├── llm/                # LLM credential operation documents
│       ├── repository/         # Repository credential operation documents
│       ├── storage/            # Storage credential operation documents
│       ├── agent/              # Agent operation documents
│       ├── worker/             # Worker operation documents
│       ├── workbench/          # Workbench operation documents
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
   sealing the registry. Follow the owning operation's idempotency rule;
   evidence submissions deliberately have no natural-key deduplication.
   Invocation replay lasts only within the in-memory TTL.
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
The worker requires `client_secret` in `cli.yaml` as canonical 32-byte base64.
It has no option or environment variable. `jwt generate --project <project id> --binding <binding name>`
prints the `token` and `client_secret` fragment for this file. A `master_key`
field fails with `cli.config.invalid`.
It checks the host tools and the server package version, opens the state-directory
workspace root and registers its instance. It logs `Worker application ready`
with `runtime_identity`, `resource_identity` and `worker_name`.
It opens no database and reads no server configuration.
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

## Working rules

- Keep no backward compatibility. The project has no deployment yet.
- Name a constant for its domain role, never for the English word of its value,
  for example `PROBE_CALLS_PER_CHECK`, not `ONE_CALL`.
- Edit `.agents/plan/*` only in a main session or by hand. `scripts/lane-check.sh`
  denies it to every lane role.
- Never plan a story whose change edits a plan document. No lane role can
  execute it, and a `Paths:` line cannot authorize it.
- Expect other sessions to write sibling plans at the same time. Before you ask
  for a ruling on a shared token, list `.agents/plan/` again and search the
  sibling plans for the token. Name each sibling that already made the choice.
- Re-anchor a drifted `file:line` citation to the sentence or code block that
  the citing text means. Never re-anchor it to the first match of the identifier.
- Re-anchor only the citations that your own edit shifted, in the files that
  you edited. Leave other drift alone.
