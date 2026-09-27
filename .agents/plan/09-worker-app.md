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

## Healthcheck

### Component healthcheck

The `Worker` class implements `Service`. It is the worker application process — a separate process with no `HealthRegistry` and no HTTP listener.

| Component           | Key      | When 200                                         | When 503                                                            |
| ------------------- | -------- | ------------------------------------------------ | ------------------------------------------------------------------- |
| HTTP client startup | `client` | `started === true` AND `shutdown.err() === null` | before `start()` completes, or after `quiesce()` cancels `shutdown` |

`client: 200` proves that startup completed (version check passed and, after task 09.1, masterKey validated) and the process is running. It does not prove ongoing connectivity to the server; if the server disappears after startup, `client` stays `200`. No remote call occurs. The `masterKey` check (task 09.1) does not add a separate component; a running process with `client: 200` has already passed it.

`started` is set to `true` inside `start()` after `log("Worker application started")` emits. At the moment of that notice, `healthcheck()` still returns `{ client: 503 }`. The notice is informational, not health-derived.

In ERD 1, `Worker.healthcheck()` has no runtime consumer. The worker app is a separate process; the server `HealthRegistry` does not include it. ERD 2 adds registration-aware consumption.

### Resource healthcheck

None in ERD 1.

Sources:

- `worker-service.impl.md:165` — "The resource healthcheck of an instance reports `healthy` when its last heartbeat is inside `worker.heartbeatWindow`, and `unhealthy` otherwise." (registered instance, ERD 2)
- `engine/.agents/plan/00-index.md:18` — "Worker registrations (`worker_registration` table)...Heartbeat and work pull are registration lifecycle (ERD 2)."

## Depends on

- Plan 01 → `src/apps/server/cli-support.ts` (`kanthord`, `environment`), which task 09.E uses.

The skeleton consumes no service seam from plans 01–08.

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

### 09.3 Add explicit healthcheck tests

- Files:
  - `src/apps/worker/index.test.ts`

- Do:
  1. Add a test: construct a `Worker` without calling `start()`; call `healthcheck()` and assert `{ client: HealthStatus.Unavailable }`.
  2. Add a test: after a version-check failure (server returns wrong version), `healthcheck()` returns `{ client: HealthStatus.Unavailable }`.
  3. Add a test: after a failed start caused by absent `masterKey` (task 09.1), `healthcheck()` returns `{ client: HealthStatus.Unavailable }`. Use a fixture with a valid server but no `masterKey` in `cli.yaml`.
  4. Add a test: after `await worker.quiesce()` but before `stop()` returns, `healthcheck()` returns `{ client: HealthStatus.Unavailable }`. Assert this to prove the transition at shutdown cancellation, not only at completed stop.

- Rules:
  - No code comments.
  - `client: 200` tests already exist at `index.test.ts:65` and `index.test.ts:74-76`; add only the missing cases listed above.
  - Step 3 depends on task 09.1; run this task after 09.1.

- Done when: `pnpm run verify` passes. Tests cover pre-start, version-check failure, failed-start with absent `masterKey` and post-quiesce states.

### 09.E E2E proof

- Files:
  - `src/apps/server/e2e-worker-app.test.ts`

- Do:
  1. Define `spawnWorker(args: string[], env: NodeJS.ProcessEnv)` using `spawn` from `node:child_process`. It invokes the CLI by the same `--input-type=module -e` entry pattern as `kanthord()` in `src/apps/server/cli-support.ts`, but returns immediately without waiting for exit. It collects stdout and stderr as UTF-8 text. It splits stderr into lines on `\n`, holds a partial line until the next chunk or the stream end, and buffers every complete line. It returns `{ waitForLine(predicate: (line: string) => boolean): Promise<string>; kill(signal: NodeJS.Signals): void; exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string[] }> }`. `waitForLine` checks already-collected lines first, then waits for new ones; it rejects after `SPAWN_LINE_TIMEOUT_MS = 15000` ms, and it rejects at once when the process exits or emits a spawn `error` before a match. `exited` resolves only after the process exits and both stdio streams close, with the exit code, the terminating signal, the complete stdout and the complete stderr lines; a spawn `error` rejects `exited` at once, because a failed spawn can close without an `exit` event.
  2. Define `stopWorker(proc)`: when the spawn failed and no child exists, it returns. Otherwise it sends `SIGTERM`, waits for `exited` up to `CLEANUP_WAIT_MS = 5000` ms, sends `SIGKILL` if it has not settled, and waits for `exited` again up to `CLEANUP_WAIT_MS`; when it still has not settled, it throws an `Error` that fails the test. Every test that spawns wraps its body in `try { ... } finally { await stopWorker(proc) }`. The `finally` block runs inside the test body, so the child stops before any `t.after()` hook of `gatewayFixture`, `temporary` or the fake server; those hooks then release their resources even when `stopWorker` reports a failure. A test that asserts a graceful shutdown awaits its own `proc.exited` within `CLEANUP_WAIT_MS` before the `finally`, and asserts `signal === null` and the exit code; a forced `SIGKILL` therefore fails that assertion and never counts as a graceful stop.
  3. Build the environment of every spawn with `environment(temporary(t))`, with `environment` from `src/apps/server/cli-support.ts` and `temporary` from `src/kernel/test-support.ts`. `environment` overrides only `XDG_CONFIG_HOME`, so each test isolates the configuration directory; in ERD 1 the worker application reads no other XDG directory. Write `cli.yaml` at `join(directories(env).config, "cli.yaml")`, with `directories` from `src/config/index.ts` (the path expression of `cli-worker.test.ts:21–22`), using `writePrivate` from `src/kernel/files.ts`, which sets mode `0600`. The "setup through CLI only" rule does not apply to `cli.yaml`, because no CLI command creates or modifies it.
  4. For E09.4, create a `node:http` server bound to `127.0.0.1:0` that answers `GET /api/openapi.yaml` with a JSON body `{ info: { version: FAKE_VERSION } }` where `FAKE_VERSION = "0.0.0"`. Start it before the spawn and close it in `t.after()`. Derive the fake endpoint from the bound port.
  5. For E09.5 and E09.6, call `gatewayFixture(t, { machines: fakeMachines() })` and set `KANTHORD_TOKEN` to `await fixture.machineToken(TEST_WORKER_BINDING)`.
  6. Write one test per row in the `## E2E` table.

- Rules:
  - E09.1 uses `kanthord` from `src/apps/server/cli-support.ts` (provided by plan 01); E09.2 through E09.6 use `spawnWorker`.
  - E09.2 and E09.3 start no fixture server; `KANTHORD_ENDPOINT` points to `UNREACHABLE_ENDPOINT = "http://127.0.0.1:1"`.
  - Named constants for every fixed string or number; no code comments.

- Done when: `node --test --test-timeout=30000 src/apps/server/e2e-worker-app.test.ts` passes and `pnpm run verify` passes.

## E2E

- Test file: `src/apps/server/e2e-worker-app.test.ts` (runs in `pnpm run verify`).
- Harness: `gatewayFixture` from `src/apps/server/test-support.ts` starts the real server on a loopback port with an in-memory store; `kanthord(args, env)` from `src/apps/server/cli-support.ts` (plan 01) runs the CLI as a subprocess with disposable XDG state; `spawnWorker(args, env)`, defined in the test file, starts `kanthord serve worker` as a long-running subprocess and exposes `waitForLine`, `kill` and `exited`; `cli.yaml` is created with `writePrivate` from `src/kernel/files.ts` at mode `0600`.
- Rules: setup goes through the CLI only, except `cli.yaml` which has no CLI create command and is written directly as a private file; the state check is a CLI read, never a store read, except for the process-lifecycle rows E09.2–E09.6, whose state is the exit code, the terminating signal and the output of the process; a refusal asserts the exact exit code and the error code at the start of stderr; stdout is parsed as JSON where the CLI page says the command prints JSON.
- ERD 1: registration is ERD 2; `Worker application ready` is not emitted in ERD 1; `Worker application started` is the only startup notice. On shutdown in ERD 1, no `runtimeIdentity` exists, so the worker makes no deregistration call; exit 0 follows a successful stop lifecycle, and exit 1 follows a cleanup failure or watchdog expiry.

| Id    | Commands                                                                                                                                                                                                                                                         | Exit | Expect                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E09.1 | `kanthord serve worker --config <path>`                                                                                                                                                                                                                          | 1    | stderr starts with `cli.serve.worker_config:`                                                                                                                                                                                                                                                                                                                                                                           |
| E09.2 | `spawnWorker(["serve", "worker"], env)`; no `cli.yaml`; `KANTHORD_ENDPOINT = UNREACHABLE_ENDPOINT`                                                                                                                                                               | 1    | stderr starts with `worker.start.master_key_absent:`                                                                                                                                                                                                                                                                                                                                                                    |
| E09.3 | `spawnWorker(["serve", "worker"], env)`; `cli.yaml` with `masterKey` of 16 bytes encoded in base64; `KANTHORD_ENDPOINT = UNREACHABLE_ENDPOINT`                                                                                                                   | 1    | stderr starts with `worker.start.master_key_invalid:`                                                                                                                                                                                                                                                                                                                                                                   |
| E09.4 | `spawnWorker(["serve", "worker"], env)`; valid `masterKey` in `cli.yaml`; `KANTHORD_ENDPOINT` pointing to a fake HTTP server that returns `{ info: { version: "0.0.0" } }` for `GET /api/openapi.yaml`                                                           | 1    | stderr starts with `worker.version.mismatch:`; stderr contains both the local package version and `0.0.0`                                                                                                                                                                                                                                                                                                               |
| E09.5 | `spawnWorker(["serve", "worker"], env)`; valid `masterKey`; `KANTHORD_ENDPOINT = fixture.endpoint`; `KANTHORD_TOKEN = await fixture.machineToken(TEST_WORKER_BINDING)`; `waitForLine` matching `Worker application started`; send `SIGTERM`; await `proc.exited` | 0    | `waitForLine` resolves with a valid JSON line whose parsed `msg` equals `"Worker application started"`; every nonempty line of `proc.exited.stderr` parses as one JSON record; exactly one record has `msg` equal to `"Worker application started"` and no record has `msg` equal to `"Worker application ready"`; `proc.exited.stdout` is empty; no stderr line contains the machine token; `signal` is `null`; exit 0 |
| E09.6 | same spawn as E09.5; `waitForLine` matching `Worker application started`; send `SIGHUP`; wait `SIGHUP_WAIT_MS = 200` ms; assert process still alive; send `SIGTERM`; await `proc.exited`                                                                         | 0    | process alive after `SIGHUP`; `signal` is `null` and exit 0 after `SIGTERM`                                                                                                                                                                                                                                                                                                                                             |

## Blockers

None.
