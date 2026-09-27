# Plan 09: Worker app integration

## Scope

ERD 1 requires two tasks from the worker app: the `masterKey` check at start (09.1), and the JSON-line log records and the shutdown contract of a settled state (09.2), per Ulrich's `serve worker` ruling of 2026-09-27 (`docs/brainstorm/worker-service.impl.md` "The worker application").

The worker application skeleton is already complete for all other ERD 1 behaviors.

**Already implemented** (`src/apps/worker/index.ts`, `src/apps/cli/index.ts`):

- Server version check via `gateway.openapi`; refuses a version mismatch with both versions in the diagnostic.
- Logs `Worker application started` on a version match.
- Graceful stop on `SIGINT`, `SIGTERM` and context cancellation.
- `Worker.healthcheck()` returns `client: HealthStatus.Healthy` while running and `HealthStatus.Unavailable` after stop.
- `kanthord serve worker` subcommand with `--endpoint` and `--token` options; refuses `--config`.

**This plan delivers** (Tasks 09.1 and 09.2):

- `masterKey` read from `cli.yaml` at worker app start; stop with a diagnostic when absent or invalid.
- `masterKey` field added to `clientSchema` and `ClientConfiguration` so service commands ignore it silently, as the Gateway implementation page requires.

- Operational log records as JSON lines on stderr, the startup notice `Worker application started`, the exit codes, the 10-second watchdog of a settled state and the ignored `SIGHUP` (Task 09.2).

**Stays with B9**: shutdown during a live execution, and a registration or a work pull with no answer. ERD 1 has neither, because registration and work pulls are ERD 2.

**Out of scope (ERD 2)**:

- Registration, the `Worker application ready` record, deregistration at shutdown, heartbeat, work pull, credential handover and instance hosting.

No new table. No database. The worker app communicates over HTTP only.

## Sources

- `engine/AGENTS.md` ("Run the worker application") — confirms version check, start log and cancellable wait are already implemented; states no instances are hosted and no database is opened.
- `engine/src/apps/worker/index.ts` — existing skeleton: `Worker` class, `start`, `quiesce`, `stop`, `run`, `healthcheck`, `runWorker`.
- `engine/src/apps/cli/index.ts:118–137` — `serve worker` subcommand; `--endpoint` and `--token` implemented; `--config` refused.
- `engine/src/gateway/client.ts:33–36` — `clientSchema` uses `z.strictObject` with `endpoint` and `token` only; `masterKey` is rejected as unknown; must be widened to allow it.
- `engine/src/apps/worker/index.test.ts` — colocated tests covering the existing skeleton.
- `docs/brainstorm/worker-service.impl.md#the-credential-handover` — "An absent or invalid `masterKey` stops the start of `kanthord serve worker`."
- `docs/brainstorm/gateway-service.impl.md#the-client-configuration-file` — "`masterKey` holds the 32-byte key of the server encoded in base64, and only `kanthord serve worker` reads it. It has no environment variable and no option. A CLI command of a service group ignores it."
- `engine/docs/cli/other.md#serve-worker` — the ruled options (`--endpoint`, `--token`), readiness output and shutdown contract; `masterKey` has no env var and no option.
- `docs/brainstorm/worker-service.impl.md#the-worker-application` — one instance per process, startup order, JSON-line log records, exit codes, settled-state watchdog, B9 boundary.
- `docs/brainstorm/worker-service.md` — worker host, placement and boundary; "opens no database."
- `docs/reference/erd/01-setup.md` — ERD 1 scope; ERD 2 covers registration, execution and credential handover.
- `docs/reference/erd/README.md#owners-without-a-table` — "The `worker` application and an external harness hold no table of the server."

## Depends on

None. The skeleton consumes no seam from plans 01–08.

## Provides

No seam. The worker app produces no collaboration type that another ERD 1 plan consumes.

## Tasks

### 09.1 Add `masterKey` read and validation at worker app start

- Files:
  - `src/gateway/client.ts`
  - `src/apps/worker/index.ts`
  - `src/apps/worker/index.test.ts`

- Do:
  1. In `src/gateway/client.ts`, change `clientSchema` from `z.strictObject({ endpoint, token })` to `z.strictObject({ endpoint: ..., token: ..., masterKey: z.string().optional() })`. Add `masterKey?: string` to the `ClientConfiguration` interface.
  2. In `src/gateway/client.ts`, verify that `resolveClient` passes `masterKey` through the returned object unchanged (no fallback, no env var, no option).
  3. In `src/apps/worker/index.ts`, after `resolveClient`, validate `config.masterKey`: if absent, throw `new Diagnostic("worker.start.master_key_absent", "worker: masterKey is required in cli.yaml.")`. If present and not a valid base64 encoding of exactly 32 bytes, throw `new Diagnostic("worker.start.master_key_invalid", "worker: masterKey must be a base64 encoding of exactly 32 bytes.")`.
  4. Use `Buffer.from(config.masterKey, "base64")` and assert `.length === 32` for the byte-length check.
  5. In `src/apps/worker/index.test.ts`, add a test that an absent `masterKey` in `cli.yaml` fails start with `worker.start.master_key_absent`. Add a test that a present but invalid value (wrong byte length) fails start with `worker.start.master_key_invalid`. Add a test that a valid 32-byte base64 key passes the check and reaches `Worker application started`.

- Rules:
  - `masterKey` has no environment variable and no CLI option (`gateway-service.impl.md#the-client-configuration-file`).
  - Service commands must ignore `masterKey` silently; adding the field to `clientSchema` with `.optional()` satisfies this without rejecting their files (`gateway-service.impl.md#the-client-configuration-file`).
  - `worker.start.master_key_absent` and `worker.start.master_key_invalid` are derived codes; the design page names no explicit codes for this check, but their three-part form complies with `architecture.impl.md:339`.
  - No code comments. No env-var fallback for `masterKey`. No CLI option for `masterKey`.

- Done when: `pnpm run verify` passes. Test with absent `masterKey` fails with code `worker.start.master_key_absent`. Test with invalid key fails with code `worker.start.master_key_invalid`. Test with valid 32-byte base64 key logs `Worker application started`.

### 09.2 Emit JSON-line log records and apply the settled-state shutdown contract

- Files:
  - `src/apps/worker/index.ts`
  - `src/apps/worker/index.test.ts`
- Do:
  1. In `src/apps/worker/index.ts`, replace the default `log` that writes a plain line with an `OperationalLog` from `src/kernel/log.ts`, built with `{ level: "info", destination: LogDestination.StandardError }`. The worker opens no file, so the state directory argument is unused by the stderr destination; pass `directories(this.options.env).state` from `src/kernel/xdg.ts:4`.
  2. Log the startup notice as `logger.info("Worker application started")`. Keep the `log` injection point of `WorkerOptions` for tests, typed as `(message: string) => void`, and route the default through the logger.
  3. On a startup failure, `run` returns the diagnostic; the caller in `src/apps/cli/index.ts` already prints it and exits `1`. Keep that path unchanged.
  4. In `stop()`, arm `const watchdog = setTimeout(() => process.exit(WORKER_STOP_EXIT_FAILURE), WORKER_STOP_WATCHDOG_MS)` before the quiesce, and clear it in `finally`, following `src/apps/server/index.ts:213–227`. Declare `WORKER_STOP_WATCHDOG_MS = 10000` and `WORKER_STOP_EXIT_FAILURE = 1`. In ERD 1 every stop is a settled state: no registration, no work pull and no execution exist.
  5. In `run()`, register `process.on("SIGHUP", ignoreHangup)` with a named no-op `ignoreHangup`, and remove it with the `SIGINT` and `SIGTERM` handlers in `finally`. Without a handler, Node terminates the process on `SIGHUP`.
- Rules:
  - Log records are JSON lines on stderr; no token is printed (`worker-service.impl.md` "The worker application"; `engine/docs/cli/other.md` "serve worker").
  - `SIGINT` and `SIGTERM` stop further startup; `SIGHUP` reopens nothing.
  - The watchdog applies only to a settled state; ERD 2 limits it when registration and work pulls exist.
  - No code comments. Named constants for every number.
- Done when: `pnpm run verify` passes. Tests prove that the startup notice is one JSON line with `msg: "Worker application started"`, that `SIGHUP` leaves the process running, that `SIGTERM` stops it with a `null` result, and that a stop that does not finish triggers the watchdog (fake timers and a stubbed `process.exit`).

## Blockers

None.
