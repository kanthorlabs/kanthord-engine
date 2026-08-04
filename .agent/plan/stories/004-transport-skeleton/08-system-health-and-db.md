# Story 08 — `system.health` and `system.db`

Epic: `.agent/plan/epics/004-transport-skeleton.md`
Depends on: Story 01 (`src/http/server/app.ts`), Story 06a (`src/http/contract/system.ts`), Story 07 (`src/cli/client.ts`, `src/cli/options.ts`, `src/cli/exit-code.ts`).

The two routes that prove the skeleton end to end. They are also the first two schema pairs in the registry.

## Change

### 1. `src/http/contract/system.ts` — attach two schema pairs

Story 06a declared four entries with no schemas. Add a `response` to two of them, and a `request` to neither: both are `GET` with no body.

```ts
export const dependencyStatuses = ["ok", "failed", "not-implemented"] as const;

export const systemHealthResponse = z.strictObject({
  status: z.enum(["ok", "degraded"]),
  dependencies: z.array(
    z.strictObject({
      name: z.string().min(1),
      status: z.enum(dependencyStatuses),
    }),
  ),
});

export const systemDbResponse = z.strictObject({
  migrations: z.array(
    z.strictObject({
      version: z.number().int().positive(),
      name: z.string().min(1),
      applied: z.boolean(),
      appliedAt: z.number().int().nullable(),
    }),
  ),
});
```

**`z.strictObject`, not `z.object`.** Measured on `zod@4.4.3`: `z.object({ status: z.literal("ok") }).safeParse({ status: "ok", version: "1" })` **succeeds** and silently strips `version`. Only `z.strictObject` rejects an unknown key. Every response schema in this epic is strict, because a test that asserts "an extra field is refused" proves nothing against a stripping schema, and `docs/proposal/api/system.md:26` names the fields `system.health` must not carry.

`systemHealthResponse` **replaces** `docs/proposal/api/system.md:22-24`, which fixes the body as the constant `{ "status": "ok" }`. Ulrich decided that `system.health` reports the status of the system through a query whose dependencies report their own status, and that the route carries the bearer token so the report is not anonymous. Open item S4 in the index carries the two proposal amendments — `README.md:177` and `phase-1/transport.md:21` — and the epic's coverage line "`system.health` answers with no token" is deleted rather than reinterpreted.

`status` is the roll-up. It is `"ok"` when no dependency reports `"failed"`, and `"degraded"` otherwise. A `"not-implemented"` dependency never degrades the daemon: `agent`, `verify` and `lease` are `NotImplemented*` classes until phase 2, and a phase-1 daemon with those absent is healthy by definition.

`dependencies` is ordered bytewise by `name`, so the response is byte-identical for identical state.

`systemDbResponse` is decided here. `docs/proposal/api/system.md:34` specifies the behaviour in prose — "Returns every migration and whether it is applied" — and names no field. The shape follows `MigrationStatus` from `src/services/storage/index.ts`, flattened to one list so a client reads one ordered table instead of joining two: `applied` is the boolean the prose names, and `appliedAt` is the recorded epoch for an applied row and `null` for a pending one.

`system.status` and `blob.show` keep no schema. They arrive with EPIC 010.

### 2. `src/queries/system/read-migration-status.ts` (new)

```ts
import type { Storage } from "../../services/storage/index.ts";

export type ReadMigrationStatusDependencies = Readonly<{ storage: Storage }>;

export type MigrationLine = Readonly<{
  version: number;
  name: string;
  applied: boolean;
  appliedAt: number | null;
}>;

export type ReadMigrationStatusResult = Readonly<{
  migrations: readonly MigrationLine[];
}>;

export function readMigrationStatus(
  dependencies: ReadMigrationStatusDependencies,
): ReadMigrationStatusResult;
```

Call `dependencies.storage.status()`. Map each `applied` entry to `{ version, name, applied: true, appliedAt }` and each `pending` entry to `{ version, name, applied: false, appliedAt: null }`. Concatenate, then sort ascending by `version`.

The sort is the ordering rule, and it is total: a version is the `migration` table's primary key, per `.agent/plan/stories/003-storage/02-migration-runner.md:53`, so no tie exists and no tie-break is needed.

This is the first file under `src/queries/`, so the directory is created here. It reaches storage through the interface, which `eslint.config.js:119-127` permits and `:190-214` requires — a query names a capability, never `node:sqlite`.

### 2b. `src/queries/system/read-health.ts` (new)

```ts
export type DependencyStatus = "ok" | "failed" | "not-implemented";

export type DependencyReporter = Readonly<{
  name: string;
  probe: () => DependencyStatus;
}>;

export type ReadHealthDependencies = Readonly<{
  reporters: readonly DependencyReporter[];
}>;

export type DependencyLine = Readonly<{
  name: string;
  status: DependencyStatus;
}>;

export type ReadHealthResult = Readonly<{
  status: "ok" | "degraded";
  dependencies: readonly DependencyLine[];
}>;

export function readHealth(
  dependencies: ReadHealthDependencies,
): ReadHealthResult;
```

Call every `probe()` in reporter order. A `probe` that **throws** is recorded as `"failed"` — a dependency that cannot answer is a dependency that is down, and a health query never propagates a probe error. Sort the resulting lines bytewise by `name` through `Buffer.compare`. Set `status` to `"degraded"` when any line is `"failed"`, and `"ok"` otherwise.

The query takes reporters rather than services, so `queries/` names no capability it does not use, and each later epic appends one reporter in `src/main.ts` without editing this file.

### 2c. `Storage.ping()` — the declaration landed here as a scope exception

`SqliteStorage` implements `ping(): void` as one `SELECT 1` outside any transaction, and `sqlite.test.ts` covers it. `.agent/plan/stories/002-domain-and-state-machine/11-service-interfaces.md` owns the declaration and `.agent/plan/stories/003-storage/02-migration-runner.md` owns the implementation, both for this consumer.

**Create nothing here.** **Amended after EPIC 004 review (B4):** the `Storage` interface did _not_ declare `ping()` when this story ran, while the implementation and its test already shipped it. That was a defect in EPIC 002's `11-service-interfaces.md`, whose owner is the interface. The one-line declaration `ping(): void;` landed in `src/services/storage/index.ts` during EPIC 004 as a retained scope exception, because no route could typecheck without it. Add no other `src/services/` edit here, and add no storage _behaviour_ — the method body stays in the capability that owns it.

It exists because no other method is a safe health probe: `status()` bootstraps the `migration` table, so it writes, and `transact()` opens `BEGIN IMMEDIATE`, so it takes a write lock. A health probe must do neither.

### 3. `src/http/server/system/health.ts` (new)

```ts
import type { Handler } from "../app.ts";
import type { ReadHealthResult } from "../../../queries/system/read-health.ts";

export type HealthHandlerDependencies = Readonly<{
  readHealth: () => ReadHealthResult;
}>;

export function healthHandler(dependencies: HealthHandlerDependencies): Handler;
```

The returned handler calls `dependencies.readHealth()` and returns `{ status: 200, body: result }`. It parses no request and branches on nothing.

The status is `200` even when the body says `"degraded"`. A reachable daemon reporting truthfully is not an HTTP error, a monitor reads the body field, and `503` would need a code the error table does not hold. This also closes open item S4's `AGENTS.md` half: the route now binds to exactly one query, as `AGENTS.md` requires.

### 4. `src/http/server/system/db.ts` (new)

```ts
import type { Handler } from "../app.ts";
import type { ReadMigrationStatusResult } from "../../../queries/system/read-migration-status.ts";

export type DbHandlerDependencies = Readonly<{
  readMigrationStatus: () => ReadMigrationStatusResult;
}>;

export function dbHandler(dependencies: DbHandlerDependencies): Handler;
```

The returned handler calls `dependencies.readMigrationStatus()` and returns `{ status: 200, body: result }`. It parses no request, it branches on nothing, and it formats by returning the query result unchanged. `main.ts` binds the query to its storage.

### 5. `src/main.ts` — bind the two handlers

Build the handler map for `createApp`:

```ts
const reporters = [
  {
    name: "storage",
    probe: (): DependencyStatus => {
      storage.ping();
      return "ok";
    },
  },
];

const handlers = {
  "system.health": healthHandler({
    readHealth: () => readHealth({ reporters }),
  }),
  "system.db": dbHandler({
    readMigrationStatus: () => readMigrationStatus({ storage }),
  }),
};
```

`storage` is the one live dependency in this epic. `git` arrives in EPIC 006, and `agent`, `verify` and `lease` stay `not-implemented` through phase 1 — each appends one reporter in its own epic. A `probe` that returns `"ok"` after a call that throws on failure is the whole pattern: `readHealth` converts the throw.

`storage` is the instance Story 02 constructs for the migration gate. One instance serves the gate and the route.

The `unimplemented` expression Story 01 wrote is unchanged — it filters the registry against `handlers`, so it now yields twenty-one ids instead of twenty-three with no edit. Assert that count in `src/http/server/app.test.ts`.

### 6. `src/cli/db/status.ts` (new)

```ts
import type { Command } from "commander";

import type { ClientDependencies } from "../client.ts";

export type RegisterDbStatusInput = Readonly<{
  program: Command;
  client: ClientDependencies;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  exit: (code: number) => void;
}>;

export function registerDbStatus(input: RegisterDbStatusInput): void;
```

Register `db status` on the same `db` command `src/cli/db/migrate.ts` created. It declares no option of its own — the base URL and the token are program options now.

The action:

1. `requireBaseUrl` over `resolveClientOptions`. A `CliError` prints `kanthord: <code>: <message>` to `stderr` and calls `exit(1)`.
2. `await call(client, { operationId: "system.db" })`.
3. On `ok: false`, write `kanthord: <code>: <message>\n` to `stderr` and call `exit(exitCodeForError(code, status))`.
4. On `ok: true`, parse the body with `systemDbResponse.parse`. Write one line per migration to `stdout`, in the order the body carries:

```
<name> <applied|pending>
```

Then return without calling `exit`, so the process exits `0`.

The output carries the name and not the version, because a migration name already begins with its zero-padded version — `0001-core-entities`, per `.agent/plan/stories/003-storage/index.md`. Two columns, one space, no header, no alignment padding. A pending migration is not a failure: `db status` reports, and Story 02 owns the refusal.

The client parses the response with the contract schema rather than trusting it. That is the second consumer `AGENTS.md` names for `http/contract/`, exercised for the first time.

### 7. `src/main.ts` — register `db status`

Call `registerDbStatus` beside `registerDbMigrate`, passing the client dependencies built in Story 07 and `(code) => { process.exitCode = code; }` as `exit`.

## Constraints

- `src/http/server/system/health.ts` returns a literal. It reads no configuration, no clock, no storage and no version.
- `src/http/server/system/db.ts` holds no domain branch. Parse, invoke, format — the three steps `AGENTS.md` admits in a handler.
- `src/queries/system/read-migration-status.ts` imports no vendor package and no `node:*` module. `eslint.config.js:190-214` fails the build otherwise.
- `db status` calls the route. It never opens SQLite. `docs/proposal/api/system.md:36` makes `db migrate` the one exception, and `db status` is named there as the HTTP half.
- Attach no schema to `system.status` or `blob.show`.

## Verify

`node --test src/http/contract/system.test.ts` — new file, suite `"src/http/contract/system.test"`:

- `systemHealthResponse.parse({ status: "ok", dependencies: [] })` succeeds, and so does one with two dependency lines.
- `systemHealthResponse` rejects each of: `{ status: "ok" }` (no `dependencies`); `{ status: "up", dependencies: [] }`; `{ status: "ok", dependencies: [], version: "27.8.1" }`; `{ status: "ok", dependencies: [{ name: "", status: "ok" }] }`; `{ status: "ok", dependencies: [{ name: "storage", status: "fine" }] }`; `{ status: "ok", dependencies: [{ name: "storage", status: "ok", extra: 1 }] }`. Assert with `safeParse(...).success === false` rather than by comparing parsed output, because a `z.object` would return `success: true` with the extra key stripped and a parsed-output comparison would still look right.
- `dependencyStatuses` deep-equals `["ok", "failed", "not-implemented"]`.
- `systemDbResponse.parse` accepts `{ migrations: [] }` and `{ migrations: [{ version: 1, name: "0001-core-entities", applied: true, appliedAt: 1700000000 }, { version: 2, name: "0002-graph-and-plan", applied: false, appliedAt: null }] }`.
- `systemDbResponse.parse` rejects each of: a missing `migrations` key; a `version` of `0`; a `version` of `1.5`; a `name` of `""`; an `appliedAt` of `"1700000000"`; an extra key beside `migrations`.
- `findOperation("system.health")?.response` is `systemHealthResponse`, and `findOperation("system.db")?.response` is `systemDbResponse`, both asserted with `assert.strictEqual`.
- `findOperation("system.health")?.request` and `findOperation("system.db")?.request` are both `undefined`.
- `findOperation("system.status")?.response` and `findOperation("blob.show")?.response` are both `undefined`.
- Exactly two entries in `registry` carry a `response`, and none carries a `request`.

**No request schema names a server path.** Add to the same file. Walk `registry`, keep every entry with a `request`, convert each with `z.toJSONSchema(schema, { target: "openapi-3.0", io: "input" })`, and collect every property name at every depth. Assert the collected set contains none of `"path"`, `"filePath"`, `"dir"`, `"directory"`, `"cwd"`, `"home"`, `"gitDir"`, `"workspacePath"`, `"absolutePath"`. The assertion reads the authored schemas rather than searching for a path-like name in source text, so it cannot be defeated by a rename. `docs/proposal/api/README.md:181` is the rule, and it is bidirectional — assert the same over every `response` schema.

The set of request schemas is empty in this story, and the assertion is written now so it is standing when a schema arrives. Record in the same test, as a comment-free assertion, that `plan.import` is the one contract-approved carrier of a client-side relative path: assert `findOperation("plan.import")?.request === undefined` today, so the day that schema lands, this file is the place the exemption is reviewed. `docs/proposal/api/graph.md:52` fixes the rule the schema must then encode — a relative POSIX path starting `plan/`, ending `.md`, with no empty, `.` or `..` segment and no backslash or NUL — and it is a client path, never a location on the daemon.

`node --test src/queries/system/read-migration-status.test.ts` — new file, suite `"src/queries/system/read-migration-status.test"`. Storage is a hand-written fake object implementing `Storage`, whose `status()` returns the pinned value and whose other three methods throw:

- Both lists empty gives `{ migrations: [] }`.
- Applied `[{ version: 1, name: "0001-core-entities", appliedAt: 1700000000 }]` and pending `[{ version: 2, name: "0002-graph-and-plan" }, { version: 3, name: "0003-execution-and-journal" }]` gives three lines in version order, the first `applied: true` with its `appliedAt`, the other two `applied: false` with `appliedAt: null`. Assert the whole array with one `assert.deepEqual`.
- Interleaved and out-of-order input sorts: applied `[{ version: 3, ... }]` and pending `[{ version: 1, ... }, { version: 2, ... }]` gives versions `[1, 2, 3]`. The input order does not reach the output.
- The result passes `systemDbResponse.parse` in each case above, which is what pins the query to the contract.
- `transact`, `migrate` and `close` are never called. Assert each fake method's call count is `0`.

`node --test src/queries/system/read-health.test.ts` — new file, suite `"src/queries/system/read-health.test"`. Reporters are hand-written objects with a counted `probe`:

- No reporters gives `{ status: "ok", dependencies: [] }`.
- One `"ok"` reporter gives `status: "ok"` and one line.
- One reporter returning `"failed"` gives `status: "degraded"`.
- One reporter whose `probe` **throws** gives that line `status: "failed"` and the result `status: "degraded"`. `readHealth` does not rethrow — assert it returns.
- A `"not-implemented"` reporter alone gives `status: "ok"`. A phase-1 daemon with `agent`, `verify` and `lease` absent is healthy, and this is the assertion that pins it.
- A `"not-implemented"` reporter beside a `"failed"` one gives `status: "degraded"`.
- Ordering is bytewise by name and not input order: reporters supplied as `zebra`, `Alpha`, `alpha` come back in `Buffer.compare` order, so `Alpha` precedes `alpha` precedes `zebra`. Assert the exact name sequence.
- Every `probe` is called exactly once, including when an earlier one throws.
- Each result passes `systemHealthResponse.parse`, which is what pins the query to the contract.

`node --test src/http/server/system/health.test.ts` — new file, suite `"src/http/server/system/health.test"`, through `createTestApp` with `healthHandler` bound over a mock `readHealth`:

- `get("/v1/health")` answers `200` with the body deep-equal to the query result, and the body passes `systemHealthResponse.parse`.
- A `"degraded"` result also answers `200`. Assert the status is `200` and `body.status` is `"degraded"` — a truthful report is not an HTTP error.
- **`raw.get("/v1/health").set("Host", "kanthord.test")` with no token answers `401`.** No route is exempt. This assertion is the inverse of the epic's original coverage line and it must fail if an exemption returns.
- The same request with the correct token and `Origin: http://evil.example` answers `403` with code `origin-forbidden`, and with `Host: evil.example` answers `403` with code `host-forbidden`.
- The mock query is called exactly once per `200`, and not at all on the `401` or either `403`. A refused request never probes a dependency, so an unauthenticated caller cannot drive database reads.
- The handler called directly with a synthetic `HandlerContext` returns `{ status: 200, body: <the query result> }`, so the format step is proved without the chain.

`node --test src/http/server/system/db.test.ts` — new file, suite `"src/http/server/system/db.test"`:

- With a bound `dbHandler` over a mock query returning two lines, `get("/v1/db/status")` answers `200` with the body deep-equal to the query result, and the body passes `systemDbResponse.parse`.
- `raw.get("/v1/db/status").set("Host", "kanthord.test")` with no token answers `401`. `system.db` carries the bearer scheme, unlike `system.health`.
- The mock query is called exactly once per request, and it is not called at all on the `401`.
- `get("/v1/status")` still answers `501` — binding `system.db` does not bind `system.status`.

`node --test src/cli/db/status.test.ts` — new file, suite `"src/cli/db/status.test"`. `fetch` is the mock of Story 07, returning a `Response` built from `JSON.stringify` with `Content-Type: application/json`:

- A `200` body with the two-line fixture writes exactly two `stdout` lines, `"0001-core-entities applied\n"` then `"0002-graph-and-plan pending\n"`, and `exit` is never called.
- An empty `migrations` array writes no `stdout` line, and `exit` is never called.
- The request the mock `fetch` received has method `GET`, a url ending `"/v1/db/status"`, and an `X-Kanthord-Client` header equal to `KANTHORD_VERSION`.
- With `--token t`, the request carries `Authorization: Bearer t`.
- A `401` envelope response writes `"kanthord: unauthenticated: <message>\n"` to `stderr`, calls `exit(120)`, and writes nothing to `stdout`.
- A `501` envelope response calls `exit(220)`.
- A `500` non-envelope response calls `exit(210)` and writes the `internal-error` line.
- No base URL and no `KANTHORD_BASE_URL` writes `"kanthord: cli-base-url-missing: no daemon base url; set --base-url or KANTHORD_BASE_URL\n"` to `stderr`, calls `exit(1)`, and the mock `fetch` is never called.
- A `200` body that fails `systemDbResponse.parse` — for example `{ migrations: [{ version: 1 }] }` — throws out of the parse rather than printing a partial table. Assert the rejection; a daemon answering off-contract is not a case the CLI papers over.

**End to end, over a real socket.** Add to `src/http/server/start.test.ts` — the file Story 01 created:

- **The port is chosen before the app is built.** `fetch` sends `Host: 127.0.0.1:<port>` and forbids overriding the `Host` header, so the allow list must already name the port — but `listen(app, ...)` needs the app first. Reading the port back from `listen` is circular. Resolve it by reserving the port first:

```ts
function reservePort(): number {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  const { port } = probe.address() as net.AddressInfo;
  probe.close();
  return port;
}
```

Call `reservePort()`, build the app with `allowedHosts: ["127.0.0.1:" + port]`, then `listen(app, { bind: "127.0.0.1", port })` on that exact port. `probe.listen` is synchronous enough for `address()` on the next line under `node:net`; if the implementer finds it is not, await the `listening` event before reading it. This is the one place in the epic that binds a fixed port rather than `0`.

- Build a migrated storage with `createMigratedStorage()` from `test/helpers/database.ts`, bind both handlers, and drive the real port with `src/cli/client.ts` over `globalThis.fetch`. `after()` closes the server and disposes the storage.
- `call` for `system.health` with the correct token returns `ok: true`, the body passes `systemHealthResponse.parse`, `status` is `"ok"`, and `dependencies` deep-equals `[{ name: "storage", status: "ok" }]` — a real `SqliteStorage.ping()` against the migrated temporary database.
- `call` for `system.health` with `token: undefined` returns `ok: false` with `code === "unauthenticated"`. Every route needs the token.
- After `storage.close()`, `call` for `system.health` returns `ok: true` with `status: "degraded"` and the `storage` line `"failed"`. This is the one case that proves the probe reads live state rather than reporting a constant, and it runs last because it closes the connection.
- `call` for `system.db` with the correct token returns `ok: true`, and the body passes `systemDbResponse.parse` with every migration `applied: true`.
- `call` for `system.db` with `token: undefined` returns `ok: false` with `code === "unauthenticated"`.
- `call` for `system.status` with the correct token returns `ok: false` with `code === "not-implemented"` and `exitCodeForError(code, 501) === 220`.

This is the one case in the epic where the registry, the renderer, the four middleware, the query, the handler and the CLI client all run in one process against one socket. Every other case isolates one of them.

`npm run verify` exits 0.

Proof: contributes `src/http/contract/system.test.ts`, `src/http/server/system/health.test.ts` and `src/http/server/system/db.test.ts` to `node --test src/http/**/*.test.ts`, and `src/cli/db/status.test.ts` to `node --test src/cli/**/*.test.ts`. `src/queries/system/read-migration-status.test.ts` is covered by `npm run verify`.
