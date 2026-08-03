# Story 07 — CLI program skeleton

Epic: `.agent/plan/epics/004-transport-skeleton.md`
Depends on: EPIC 003 Story 03 (`src/cli/base-url.ts`, `src/cli/db/migrate.ts`), Story 05 (`src/http/contract/errors.ts`), Story 06a (`src/http/contract/registry.ts`).

This story **refactors** the two files EPIC 003 created. It deletes no assertion EPIC 003 proved.

## Change

### 1. `src/domain/loopback.ts` (new) — the one loopback classifier

```ts
export function isLoopbackHost(host: string): boolean;
export function isLoopbackUrl(value: string): boolean;
```

`isLoopbackHost` is the body currently at `src/services/config/refusals.ts:11-27`, moved unchanged: `true` for `"localhost"` and `"::1"`; `true` for a `/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/` match whose three captures each pass the octet rule (no leading zero beyond a single `0`, and not above `255`); `false` otherwise.

`isLoopbackUrl`:

1. `new URL(value)` inside a `try`. A throw returns `false`.
2. Return `false` unless `url.protocol` is `"http:"` or `"https:"`.
3. Strip a leading `[` and a trailing `]` from `url.hostname`.
4. Return `isLoopbackHost(stripped)`.

`domain/` is the only directory both `src/services/` and `src/cli/` may import — `eslint.config.js:101-104` and `:157-166`. That is what makes one home possible; a helper in either place would force a second copy.

The move is behaviour-preserving for the URL form. Measured: `new URL` rejects `http://127.999.0.1` with `ERR_INVALID_URL`, and it canonicalises `http://127.1` and `http://127.0.0.01` to hostname `127.0.0.1`. So the strict octet rule of `isLoopbackHost` never rejects a hostname `new URL` produced, and every expected value in the EPIC 003 `isLoopbackUrl` table is unchanged. `new URL("http://[::1]:7421").hostname` is `"[::1]"`, with the brackets, which is why step 3 exists.

`src/domain/loopback.ts` imports nothing. `URL` is a global.

### 2. `src/services/config/refusals.ts:11-27` — delete the local classifier

Delete the `IPV4_LOOPBACK` const, the `isValidOctet` helper and the body of `isLoopback`. Keep the export, and make it a re-export site rather than a second implementation:

```ts
export { isLoopbackHost as isLoopback } from "../../domain/loopback.ts";
```

`assertStartable` at `src/services/config/refusals.ts:29-67` keeps calling `isLoopback(input.bind)`, so its four rules and their fixed order do not change. `src/services/config/refusals.test.ts:20-40` keeps both tables and keeps passing.

### 3. `src/cli/base-url.ts` — delegate

Replace the `isLoopbackUrl` body EPIC 003 wrote with a re-export:

```ts
export { isLoopbackUrl } from "../domain/loopback.ts";
```

Every EPIC 003 case in `src/cli/base-url.test.ts` keeps its expected value. The file keeps its name so nothing that imports it moves.

### 4. `src/cli/options.ts` (new) — the one resolver

```ts
import type { Command } from "commander";

export type ClientOptions = Readonly<{
  baseUrl: string | undefined;
  token: string | undefined;
}>;

export type CliErrorCode = "db-remote-base-url" | "cli-base-url-missing";

export class CliError extends Error {
  readonly code: CliErrorCode;
  constructor(code: CliErrorCode, message: string);
}

export type ResolveInput = Readonly<{
  program: Command;
  env: Readonly<Record<string, string | undefined>>;
}>;

export function registerClientOptions(program: Command): void;

export function resolveClientOptions(input: ResolveInput): ClientOptions;

export function requireBaseUrl(options: ClientOptions): string;

export function requireLoopbackBaseUrl(options: ClientOptions): void;

export function printRefusal(
  error: CliError,
  stderr: (text: string) => void,
): void;
```

`printRefusal` writes exactly `kanthord: ${error.code}: ${error.message}\n` to `stderr`. It lives here, in the module that owns both `CliError` codes, and every command imports it. There is no second copy in `src/cli/db/migrate.ts` or `src/cli/db/status.ts`. The line shape matches `src/main.ts:53`.

**Options resolve inside an action, never at registration.** `program.opts()` is empty until commander has parsed, and every `register*` function runs before `parseAsync`. So no `register*` function calls `resolveClientOptions`, and no module-level constant holds a base URL. Each action's first statement resolves the options it needs. `src/main.ts` therefore passes a **factory**, not a resolved value — see edit 8 below.

`registerClientOptions` adds two program-level options:

- `--base-url <url>`, description `"daemon base url"`.
- `--token <token>`, description `"bearer token for the daemon"`.

`resolveClientOptions` reads `input.program.opts()` and falls back to the environment, in this precedence: `options.baseUrl ?? env.KANTHORD_BASE_URL`, and `options.token ?? env.KANTHORD_TOKEN`. An empty string from either source resolves to `undefined`, so a blank variable is the same as an unset one. The client environment variable is `KANTHORD_TOKEN`; `KANTHORD_HTTP_TOKEN` at `src/services/config/convict.ts:51` is the daemon's own setting and this resolver never reads it.

`requireBaseUrl` returns `options.baseUrl` when it is a string, and otherwise throws `CliError("cli-base-url-missing", "no daemon base url; set --base-url or KANTHORD_BASE_URL")`. Every command that calls a route uses it.

`requireLoopbackBaseUrl` returns when `options.baseUrl` is `undefined` — no base URL means the local daemon home, which is the case `db migrate` runs in. When it is a string and `isLoopbackUrl` is `false`, it throws:

```
CliError("db-remote-base-url", `${baseUrl} is not a loopback daemon; db migrate opens the database file on the daemon machine`)
```

That is the exact message and exact code `.agent/plan/stories/003-storage/03-kanthord-db-migrate.md:65` pinned. It moves from `db migrate` into the resolver and keeps its bytes.

`CliError` sets `this.name = "CliError"`. Both codes belong to the closed startup-refusal set of `.agent/plan/epics/001-runtime-foundation.md:67` and neither is an HTTP code.

### 5. `src/cli/exit-code.ts` (new)

```ts
import type { ErrorCode } from "../http/contract/errors.ts";

export const LOCAL_REFUSAL = 1;
export const TRANSPORT_FAILURE = 2;
export const REFUSED_BY_DAEMON = 100;
export const DAEMON_FAULT = 200;

export const exitCodes: Readonly<Record<ErrorCode, number>> = {
  "invalid-request": 110,
  unauthenticated: 120,
  "origin-forbidden": 130,
  "host-forbidden": 131,
  "not-found": 140,
  "stale-revision": 150,
  "illegal-transition": 151,
  "binding-in-use": 152,
  "needs-reconcile": 153,
  "acknowledgement-required": 154,
  "lease-held": 155,
  "idempotency-mismatch": 156,
  "choices-stale": 157,
  "choices-changed": 158,
  "plan-invalid": 160,
  "choices-invalid": 161,
  "identity-kind-mismatch": 162,
  "credential-rejected": 163,
  "internal-error": 210,
  "not-implemented": 220,
};

export function exitCodeForError(code: string, status: number): number;
```

**Three categories, one per hundred.** The leading digit is the category, so a script reads the class without a table.

| Range       | Category | Meaning                                             |
| ----------- | -------- | --------------------------------------------------- |
| `1`–`99`    | local    | the request never reached the daemon                |
| `100`–`199` | refused  | the daemon refused the request                      |
| `200`–`255` | daemon   | the daemon failed, or has not implemented the route |

`0` is success and is never returned for a failure.

Within the refused and daemon categories the **tens** step once per distinct HTTP status and the **units** separate codes that share one, which makes the number derivable from the error table rather than arbitrary: `110` is the one `400`, `120` the `401`, `130` and `131` the two `403` codes, `140` the `404`, `150`–`158` the nine `409` codes in table order, `160`–`163` the four `422` codes. `210` is `500` and `220` is `501`. The highest value is `220`, well under the ceiling.

**The ceiling is why there are three categories and not more.** A POSIX exit status is masked to `& 0xFF`, so `256` becomes `0` — success reported for a failure. The third category therefore ends at `255` rather than `299`, and a fourth hundred is not available. `exitCodes` values are asserted to be at most `255` for that reason.

`LOCAL_REFUSAL` is `1`, unchanged, because `.agent/plan/epics/001-runtime-foundation.md:67` fixes every startup refusal at exit `1` and `.agent/plan/stories/003-storage/03-kanthord-db-migrate.md` fixes `db-remote-base-url` there too. Both `CliError` codes — `db-remote-base-url` and `cli-base-url-missing` — exit `1`. `TRANSPORT_FAILURE` is `2`, a new distinction that conflicts with nothing: it separates "the daemon did not answer" from "the local configuration is wrong", which is the split a script needs most and which exit `1` alone cannot express. `3`–`99` are unassigned.

`exitCodeForError(code, status)`:

1. Return `exitCodes[code]` when `code` is a known key.
2. Otherwise return `REFUSED_BY_DAEMON` when `status` is `400`–`499`, and `DAEMON_FAULT` when `status` is `500`–`599`. A daemon newer than this CLI sends a code this build does not know, and the category floor still tells a script which side is at fault.
3. Otherwise return `LOCAL_REFUSAL`.

Taking `status` as well as `code` is what makes step 2 possible; `call` already returns both. Routing stays on `code` for every code the CLI knows — the status is consulted only when the code is unrecognised, which is the one case where no per-code decision can exist.

`exitCodes` is keyed on `ErrorCode` and **exhaustive**. `Record<ErrorCode, number>` is the mechanism: adding a code to `errorStatuses` without adding it here fails `tsc --noEmit`, so a new semantic code forces an explicit exit-code decision at review time rather than inheriting one silently.

`docs/proposal/` fixes no exit-code table, so this whole scheme is decided here — see open item S2 in the index.

### 6. `src/cli/client.ts` (new)

```ts
import type { Operation } from "../http/contract/operation.ts";

export type ClientDependencies = Readonly<{
  baseUrl: string;
  token: string | undefined;
  fetch: typeof globalThis.fetch;
}>;

export type CallInput = Readonly<{
  operationId: string;
  parameters?: Readonly<Record<string, string>>;
  body?: unknown;
}>;

export type CallResult =
  | Readonly<{ ok: true; status: number; body: unknown }>
  | Readonly<{
      ok: false;
      status: number;
      code: string;
      message: string;
      details: unknown;
    }>;

export function buildRequest(
  dependencies: ClientDependencies,
  input: CallInput,
): Readonly<{ url: string; init: RequestInit }>;

export function call(
  dependencies: ClientDependencies,
  input: CallInput,
): Promise<CallResult>;
```

`buildRequest`:

1. `findOperation(input.operationId)`; a missing operation throws a plain `Error` — an unknown operation id is a programming error, not a user refusal.
2. Render the path with `renderPath(operation.path)`, then replace each `:id` and `:hash` token with the parameter value **verbatim**, not percent-encoded. A parameter the path declares and the input omits throws a plain `Error`.

The value is not encoded, and that is a contract requirement rather than a shortcut. `docs/proposal/api/system.md:65`: "The path parameter is the `blob.hash` value exactly as the citing field returned it: `GET /v1/blob/sha256:9f2a…`. The API never reformats it… A colon is legal in a path segment, so nothing is percent-encoded." `matchRoute` in Story 06a binds the raw segment for the same reason, so client and daemon agree byte for byte. Every parameter this API carries is either a minted prefixed id — `[0-9A-Za-z_]` only — or a `sha256:<hex>` hash, and no member of either set contains a character that needs encoding. `buildRequest` therefore rejects a value that would need it: throw a plain `Error` when a parameter value does not match `/^[A-Za-z0-9_:.-]+$/`, so a caller cannot smuggle a `/` or a `?` into a path segment. 3. `url` is `dependencies.baseUrl` with every trailing `/` stripped, plus the rendered path. 4. `init.method` is `operation.method`. 5. `init.headers` always carries `Accept: application/json` and `X-Kanthord-Client: <KANTHORD_VERSION>`, read from `src/domain/version.ts`. It carries `Authorization: Bearer <token>` when `dependencies.token` is a string, and `Content-Type: application/json` when `input.body` is not `undefined`. 6. `init.body` is `JSON.stringify(input.body)` when `input.body` is not `undefined`, and absent otherwise.

`X-Kanthord-Client` is sent on every request. `docs/proposal/api/README.md:43` requires the client to send its version and fixes no validation on the daemon side, so the daemon ignores it in this phase.

No `Origin` header is ever set. The CLI is not a browser, and setting one would earn a `403` from Story 04.

`call` awaits `dependencies.fetch(url, init)`, then:

- On a `response.ok`, parse the body as JSON when `Content-Type` matches `/application\/json/`, and return `{ ok: true, status, body }`. A non-JSON success body returns the text as `body`.
- Otherwise read the body and return `{ ok: false, ... }`. Deriving the four fields has exactly one path, and every failure inside it lands on the same fallback:
  1. Read the body as text. Parse it with `JSON.parse` inside a `try`.
  2. On a `JSON.parse` throw, or a `Content-Type` that does not match `/application\/json/`, or an `errorEnvelopeSchema.safeParse` failure over the parsed value, return `{ ok: false, status, code: "internal-error", message: \`the daemon answered ${status} with no error envelope\`, details: undefined }`.
  3. Otherwise return `{ ok: false, status, code: parsed.error.code, message: parsed.error.message, details: parsed.error.details }`.

Malformed JSON, HTML, an empty body and a well-formed JSON document that is not the envelope all reach step 2. `call` never throws on a daemon response; it throws only when `fetch` itself rejects, and a caller treats that as exit `1`. `code` is returned as the string the daemon sent and is **not** narrowed to `ErrorCode` — a daemon newer than the CLI may send a code this build does not know, and `exitCodeForError` falls back to the category floor for one.

`fetch` is injected so a test drives the client without a socket. `main.ts` passes `globalThis.fetch`.

### 7. `src/cli/db/migrate.ts` — read the resolved base URL

Three edits to the file EPIC 003 wrote:

1. Delete the `--base-url <url>` option from the `db migrate` subcommand. It is a program option now.
2. Delete the local `options.baseUrl ?? input.env.KANTHORD_BASE_URL` resolution and the local `isLoopbackUrl` refusal. Call `requireLoopbackBaseUrl(resolveClientOptions({ program, env }))` instead, inside the action, before anything else.
3. `RegisterDbMigrateInput` gains no field. `program` is already there, and `env` is already there.

Keep `--home <path>` on the subcommand. `.agent/plan/stories/003-storage/03-kanthord-db-migrate.md:60` states why: commander does not accept a program option written after a subcommand, and `db migrate` is invoked as `kanthord db migrate --home <path>`.

Keep the injected `MigrateHandler`, the success lines `kanthord: applied ${version} ${name}` and `kanthord: no change`, and the `fail()` seam. `db migrate` still imports no service — `AGENTS.md` puts the handler in the program and `main.ts` injects it.

The refusal print calls `printRefusal(error, input.stderr)` from `src/cli/options.ts`, then `fail()`. `src/cli/db/migrate.ts` formats no line of its own.

### 7b. `src/cli/db/index.ts` (new) — the one `db` command

`registerDbMigrate` and `registerDbStatus` both need the same commander `db` command, and neither may create a second one — commander would accept two `db` commands and dispatch only the first.

```ts
import type { Command } from "commander";

export function dbCommand(program: Command): Command;
```

`dbCommand` looks for an existing subcommand named `db` in `program.commands` and returns it. When there is none it creates it with `program.command("db").description("database maintenance")` and returns that. It is idempotent, so call order does not matter.

Edit `src/cli/db/migrate.ts` to call `dbCommand(input.program)` instead of creating the `db` command itself. `src/cli/db/status.ts` calls the same function.

### 8. `src/main.ts` — program options and the client

1. Call `registerClientOptions(program)` after the existing `--config` and `--home` options at `src/main.ts:17-18`.
2. Build a **factory**, not a value, and pass it to each registrar that calls a route:

```ts
const clientFactory = (): ClientDependencies => {
  const options = resolveClientOptions({ program, env: process.env });
  return {
    baseUrl: requireBaseUrl(options),
    token: options.token,
    fetch: globalThis.fetch,
  };
};
```

The factory runs inside an action, after commander has parsed, so `program.opts()` is populated and `requireBaseUrl` throws its `CliError` at the moment a command actually needs a base URL rather than at startup. A command that needs no base URL — `db migrate` — never calls it.

3. Extend the refusal printer at `src/main.ts:51-58` with `CliError`, beside `ConfigError`, `HomeLockError` and `StartupError`.

## Constraints

- **No second loopback classifier.** `src/domain/loopback.ts` is the only file in `src/` that holds a `127.` literal or a `"localhost"` literal, with one exception: `src/services/config/convict.ts:47` keeps `default: "127.0.0.1"` for `http.bind`. That is a configuration default, not a classification, and `docs/proposal/phase-1/transport.md:13` fixes the value.
- `src/cli/**` imports no service and no command. `eslint.config.js:157-166` and `:234-258` fail the build otherwise.
- `src/cli/client.ts` builds no path by string concatenation of literals. Every path comes from `renderPath` over a registry entry.
- Do not delete or weaken an EPIC 003 assertion. Every case in `src/cli/base-url.test.ts` and `src/cli/db/migrate.test.ts` survives; only the invocation form of `--base-url` changes.
- Do not read `KANTHORD_HTTP_TOKEN` in `src/cli/`.

## Verify

`node --test src/domain/loopback.test.ts` — new file, suite `"src/domain/loopback.test"`:

- The `isLoopbackHost` true table: `"localhost"`, `"::1"`, `"127.0.0.1"`, `"127.0.0.2"`, `"127.1.2.3"`, `"127.0.0.0"`, `"127.255.255.255"`.
- The `isLoopbackHost` false table: `"0.0.0.0"`, `"192.168.1.10"`, `"128.0.0.1"`, `"127.0.0.256"`, `"127.00.0.1"`, `"127.0.0"`, `"127.0.0.1.1"`, `"[::1]"`, `"LOCALHOST"`, `""`, `"example.test"`.
- The `isLoopbackUrl` true table: `"http://127.0.0.1:7421"`, `"http://localhost:7421"`, `"http://[::1]:7421"`, `"https://127.0.0.1"`, `"http://127.1:7421"`, `"http://127.0.0.01"`. The last two are the canonicalisation cases — `new URL` rewrites both hostnames to `127.0.0.1`.
- The `isLoopbackUrl` false table: `"http://example.test"`, `"https://10.0.0.5:7421"`, `"ftp://127.0.0.1"`, `"file:///tmp/x"`, `"not a url"`, `""`, `"http://127.999.0.1:7421"`, `"127.0.0.1:7421"`.
- `src/domain/loopback.ts` read as text contains no `import` statement — the purity of `domain/` asserted by construction, and the reason `eslint.config.js:172-189` bans `node:*` here.

`node --test src/services/config/refusals.test.ts` — the existing file, unchanged. It is the regression suite for the move, and every case must still pass with the re-export in place.

`node --test src/cli/base-url.test.ts` — the existing file, unchanged for the same reason. Add one case: `"http://127.999.0.1:7421"` is `false`, so the tightened path has a witness.

`node --test src/cli/options.test.ts` — new file, suite `"src/cli/options.test"`. Each case builds a fresh `new Command()`, calls `registerClientOptions`, and parses with `program.parse([...], { from: "user" })`:

- `["--base-url", "http://127.0.0.1:7421"]` with `env: {}` resolves `baseUrl` to that string and `token` to `undefined`.
- `[]` with `env: { KANTHORD_BASE_URL: "http://h:1", KANTHORD_TOKEN: "t" }` resolves both from the environment.
- `["--base-url", "http://flag:1"]` with `env: { KANTHORD_BASE_URL: "http://env:1" }` resolves to `"http://flag:1"` — the flag wins.
- `[]` with `env: { KANTHORD_BASE_URL: "" }` resolves `baseUrl` to `undefined`.
- `requireBaseUrl({ baseUrl: undefined, token: undefined })` throws a `CliError` with `code === "cli-base-url-missing"` and message exactly `"no daemon base url; set --base-url or KANTHORD_BASE_URL"`.
- `requireBaseUrl({ baseUrl: "http://h:1", token: undefined })` returns `"http://h:1"`.
- `requireLoopbackBaseUrl({ baseUrl: undefined, token: undefined })` returns `undefined` and throws nothing.
- `requireLoopbackBaseUrl({ baseUrl: "http://127.0.0.1:7421", token: undefined })` throws nothing.
- `requireLoopbackBaseUrl({ baseUrl: "http://remote.test:7421", token: undefined })` throws a `CliError` with `code === "db-remote-base-url"` and message exactly `"http://remote.test:7421 is not a loopback daemon; db migrate opens the database file on the daemon machine"`.
- A program option written after the subcommand is not accepted. `["db", "migrate", "--base-url", "http://x:1"]` on a program that also has `db migrate` registered fails commander parsing. Assert the failure rather than a resolved value, because this is the constraint that fixes the invocation form for every other test.
- `resolveClientOptions` reads nothing before parsing: on a fresh program with `registerClientOptions` called but `parse` not called, `resolveClientOptions({ program, env: {} })` returns `{ baseUrl: undefined, token: undefined }`. That is the fact the factory exists for, and asserting it stops a later refactor from hoisting the call.
- `printRefusal(new CliError("db-remote-base-url", "m"), write)` writes exactly `"kanthord: db-remote-base-url: m\n"` and nothing else.

`node --test src/cli/db/index.test.ts` — new file, suite `"src/cli/db/index.test"`:

- `dbCommand(program)` on a fresh program creates a subcommand named `db`, and `program.commands.filter((c) => c.name() === "db").length` is `1`.
- Two calls return the identical object (`assert.strictEqual`), and the count stays `1`.
- Calling `registerDbMigrate` and `registerDbStatus` on one program leaves exactly one `db` command carrying exactly the two subcommands `migrate` and `status`, asserted as a sorted name list deep-equal to `["migrate", "status"]`.
- Both are reachable: parsing `["db", "migrate", "--home", h]` runs the migrate action, and `["db", "status"]` runs the status action. Assert each action's call counter, because a second `db` command would silently shadow one of them.

`node --test src/cli/exit-code.test.ts` — new file, suite `"src/cli/exit-code.test"`:

- `Object.keys(exitCodes)` sorted bytewise deep-equals `Object.keys(errorStatuses)` sorted bytewise. That is the exhaustiveness assertion at runtime; `Record<ErrorCode, number>` is the same assertion at compile time, and both are wanted because a cast could defeat the type.
- A table over every one of the twenty codes, asserting `exitCodeForError(code, errorStatuses[code])` equals the literal above, one case per code. Assert the case count is `20`.
- **The ceiling.** Every value in `exitCodes` is an integer, at least `1` and at most `255`. `0` never appears. Assert `Math.max(...Object.values(exitCodes)) <= 255` on its own line — this is the assertion that stops a fourth category being added, since `256` masks to `0` and would report success on a failure.
- **The category invariant.** For every code, `exitCodes[code]` lands in the block its status implies: a `4xx` status gives a value in `100`–`199`, and a `5xx` status gives a value in `200`–`255`. Drive it from `errorStatuses` so a miscategorised code fails without a hand-written expectation.
- Codes sharing a status differ: the two `403` codes give `130` and `131`; the nine `409` codes give nine distinct values, all in `150`–`158`; the four `422` codes give four distinct values in `160`–`163`. Assert `new Set(Object.values(exitCodes)).size === 20` — no two codes share an exit code.
- Unknown codes fall to the category floor: `exitCodeForError("invented-future-code", 409)` is `100`; `exitCodeForError("invented-future-code", 503)` is `200`; `exitCodeForError("invented-future-code", 302)` is `1`; `exitCodeForError("", 0)` is `1`.
- The four exported constants are `1`, `2`, `100` and `200`, asserted individually. `LOCAL_REFUSAL` is `1` because `.agent/plan/epics/001-runtime-foundation.md:67` fixes every startup refusal there, and `.agent/plan/stories/003-storage/03-kanthord-db-migrate.md` fixes `db-remote-base-url` there too — that value is a cross-epic contract and this assertion is what protects it.
- `not-implemented` is `220`, asserted on its own as well as in the table, because `.agent/plan/epics/009-cli-and-composition-root.md:22` routes `kanthord run` on it.

`node --test src/cli/client.test.ts` — new file, suite `"src/cli/client.test"`. `fetch` is a hand-written mock recording its arguments and returning a `new Response(...)`:

- `buildRequest` for `{ operationId: "system.db" }` with `baseUrl: "http://127.0.0.1:7421"` gives `url === "http://127.0.0.1:7421/v1/db/status"` and `init.method === "GET"`.
- A trailing slash is stripped: `baseUrl: "http://127.0.0.1:7421/"` gives the same url. So does `"http://127.0.0.1:7421///"`.
- `buildRequest` for `{ operationId: "node.show", parameters: { id: "task_01JQ8ZAN9P" } }` gives url ending `"/v1/node/task_01JQ8ZAN9P"`.
- A parameter is **not** percent-encoded: `{ operationId: "blob.show", parameters: { hash: "sha256:9f2a" } }` gives a url ending exactly `"/v1/blob/sha256:9f2a"`, with a literal colon. Assert the url does not contain `"%3A"`. `docs/proposal/api/system.md:65` requires it, and Story 06a's `matchRoute("GET", "/v1/blob/sha256:9f2a")` case is the daemon half of the same byte agreement.
- A parameter value that would need encoding is refused: each of `{ id: "a/b" }`, `{ id: "a?b" }`, `{ id: "a b" }`, `{ id: "" }` on `node.show` throws a plain `Error` that is not a `CliError`.
- `init.headers` always carries `X-Kanthord-Client` equal to `KANTHORD_VERSION`, and `Accept: application/json`. Assert on a request with a token and on one without.
- With `token: "t"`, `init.headers.Authorization` is `"Bearer t"`. With `token: undefined`, `Object.hasOwn(headers, "Authorization")` is `false`.
- `init.headers` never carries an `Origin` key, on any of the cases above.
- With a body, `init.headers["Content-Type"]` is `"application/json"` and `init.body` is the exact `JSON.stringify` output. Without a body, both keys are absent.
- `buildRequest({ operationId: "nope.invented" })` throws a plain `Error` that is not a `CliError`.
- `buildRequest({ operationId: "node.show" })` with no `parameters` throws a plain `Error`.
- `call` on a `200` JSON response returns `{ ok: true, status: 200, body: <parsed> }`.
- `call` on a `404` envelope response returns `ok: false` with `code === "not-found"`, `message` from the body, and `details === undefined`.
- `call` on a `409` envelope with `details` returns those `details` deep-equal to the sent object.
- `call` never throws on a daemon response. A table of four malformed `500` bodies, each returning `ok: false`, `status === 500`, `code === "internal-error"` and `message === "the daemon answered 500 with no error envelope"`: the HTML string `"<h1>oops</h1>"`; the truncated JSON `'{"error":'`; an empty body; and the well-formed but off-contract `'{"message":"nope"}'`. Assert each returns rather than throws.
- `call` returns an unknown code unchanged: a `409` envelope whose `code` is `"invented-future-code"` returns that string, and `exitCodeForError(result.code, 409)` of it is `100` — the refused-category floor. A daemon newer than the CLI is not a crash.
- `call` on a `501` envelope returns `code === "not-implemented"`, and `exitCodeForError(result.code, 501)` is `220`. This is the pairing `.agent/plan/epics/009-cli-and-composition-root.md:22` will rely on for `kanthord run`.
- The mock `fetch` is called exactly once per `call`.

`node --test src/cli/db/migrate.test.ts` — the existing file, updated in one way only. Every case that passed `--base-url` on the subcommand now passes it before `db`: `["--base-url", url, "db", "migrate", "--home", home]`. Every assertion keeps its expected value, including:

- a non-loopback base URL refuses with `db-remote-base-url`, writes the exact stderr line, calls `fail()`, and the injected `MigrateHandler` is never called — nothing is written;
- the home lock is still held for the duration;
- the configured home is read when no `--home` is given;
- the success lines and the `kanthord: no change` line are unchanged.

Add two cases:

- `["db", "migrate", "--home", home]` with `env: { KANTHORD_BASE_URL: "http://remote.test:7421" }` refuses with `db-remote-base-url`. The environment fallback reaches the refusal through the shared resolver.
- `["db", "migrate", "--home", home]` with `env: {}` succeeds. No base URL is the local case.

`node --test test/helpers/lint.test.ts` — the existing file, extended with two `lintCase` assertions that pin the new boundary the CLI relies on:

- `filePath: "src/cli/client.ts"` with code `import { registry } from "../http/contract/registry.ts";` returns a rule list not containing `"boundaries/dependencies"`.
- `filePath: "src/cli/client.ts"` with code `import { SqliteStorage } from "../services/storage/sqlite.ts";` returns a rule list containing `"boundaries/dependencies"`.

**The single-classifier assertion.** Add to `src/domain/loopback.test.ts`: walk `src/` recursively with `fs.readdirSync(..., { withFileTypes: true })`, keep every `.ts` file that is not a `.test.ts` and not a `.d.ts`, and read each as text. Collect the `src/`-relative path of every file containing the substring `"127."` or the substring `"localhost"`. Assert the collected list, bytewise sorted, deep-equals:

```ts
["domain/loopback.ts", "services/config/convict.ts"];
```

Then assert the second entry earns its place and nothing more: of the lines in `src/services/config/convict.ts` holding either substring, there is exactly one, and it contains `default: "127.0.0.1"`. That is the `http.bind` default of `src/services/config/convict.ts:47`, fixed by `docs/proposal/phase-1/transport.md:13` — a configuration value, not a classification.

A resolver that forks a copy of the policy fails this assertion by naming its own file.

`npm run verify` exits 0.

Proof: contributes `src/cli/options.test.ts`, `src/cli/exit-code.test.ts` and `src/cli/client.test.ts` to `node --test src/cli/**/*.test.ts`, and keeps `src/cli/base-url.test.ts` and `src/cli/db/migrate.test.ts` in it.
