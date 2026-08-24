# Story 05 — P1-E2, the hostile client

Epic: `.agents/plan/epics/011-end-to-end-scenarios.md`
Depends on: Story 01, Story 02, Story 03, Story 06.

Oracle: `docs/proposal/phase-1/README.md:80-87`. This is the **one** specification of the
transport policy. Story 08 exercises a subset of it from a second place and restates none
of it.

## Change

### New — `scripts/e2e/lib/scenario/transport.ts`

The single transport oracle, exported as data so Story 08 consumes it rather than copying
it.

```ts
export type TransportCase = Readonly<{
  name: string;
  token: "valid" | "wrong" | "absent";
  host: "allowed" | "foreign" | "absent";
  origin: string | null;
  expectedStatus: number;
  expectedCode: string | null;
}>;

export const transportCases: readonly TransportCase[];

export async function runTransportCases(
  context: ScenarioContext,
  target: Readonly<{ allowedHost: string; token: string }>,
  issue: HttpIssuer,
): Promise<void>;

export async function runStartupRefusal(
  context: ScenarioContext,
  driver: ExecutionDriver,
): Promise<void>;
```

`transportCases` holds exactly these six rows, in this order. Every request is
`GET /v1/status`, the `system.status` route of `src/http/contract/system.ts:46-52`, chosen
because it is `routed` and answers `200` on a legal request.

| name            | token    | host      | origin                | status | code               |
| --------------- | -------- | --------- | --------------------- | ------ | ------------------ |
| `no-token`      | `absent` | `allowed` | `null`                | `401`  | `unauthenticated`  |
| `wrong-token`   | `wrong`  | `allowed` | `null`                | `401`  | `unauthenticated`  |
| `origin-header` | `valid`  | `allowed` | `http://evil.example` | `403`  | `origin-forbidden` |
| `foreign-host`  | `valid`  | `foreign` | `null`                | `403`  | `host-forbidden`   |
| `absent-host`   | `valid`  | `absent`  | `null`                | `403`  | `host-forbidden`   |
| `allowed-host`  | `valid`  | `allowed` | `null`                | `200`  | `null`             |

Codes come from `src/http/contract/errors.ts:3-25` and the middleware messages of
`src/http/server/origin.ts:9-17`, `host.ts:9-27` and `auth.ts:35-51`.

**There is no per-case "representative" flag.** `runTransportCases` always runs the whole
array. Selecting a subset would be a policy judgment embedded in the oracle, and there is no
ratified criterion that makes `Origin` less namespace-sensitive than `Host`. P1-E4 runs the
same six rows from its own client namespace, which is what "one specification, exercised
from a second place" means.

`runTransportCases` takes the driver's `issue`, never `node:http` directly, so the request
originates on the client host of whatever driver is in play.
`docs/proposal/README.md:107` reserves direct HTTP for the case where the protocol itself is
under test and the CLI cannot construct these requests; `localIssuer` is that direct HTTP.

Per case:

- `token: "valid"` sends `Authorization: Bearer ${target.token}`. `"wrong"` sends
  `Bearer ${target.token}x`. `"absent"` sends no `Authorization` header.
- `host: "allowed"` sends `Host: ${target.allowedHost}`. `"foreign"` sends
  `Host: not-allowed.invalid:1`. `"absent"` sets `omitHost: true`, and every issuer honours
  it the same way — `node:http` sets `Host` by default, so the issuer calls
  `request.removeHeader("host")` before `end()`.
- `origin` is sent verbatim when not `null`.
- one `context.assert(\`${name}-status\`, expectedStatus, response.statusCode)`.
- when `expectedCode` is not `null`, one
  `context.assert(\`${name}-code\`, expectedCode, body.error.code)`over the parsed
envelope of`src/http/contract/errors.ts:77-84`.
- `context.attachLog(\`${name}.http\`, ...)`holding the request line, every request header
and the response status line — all through`redact`, so the bearer value never lands in
the bundle. `docs/proposal/phase-1/README.md:87` requires the token redacted.

`runStartupRefusal` starts the daemon with `http.bind` set to a non-loopback address and
`http.token` empty, and asserts:

- exit code `1`, per `src/main.ts:318`.
- stderr equals
  `kanthord: config-refused: a non-loopback bind address requires http.token\n`, the exact
  string of `src/services/config/refusals.ts:47-52`.
- assertion names `startup-refusal-exit` and `startup-refusal-message`.

The bind address used is `203.0.113.1` — a `TEST-NET-3` address, per RFC 5737, so the
refusal fires before any bind is attempted and no host route is needed.

### New — `scripts/e2e/lib/scenario/p1-e2.ts`

```ts
export const p1e2: ScenarioDeclaration;
```

`{ id: "P1-E2", mode: "deterministic", driver: "local", profile: "fixture", run }`.
`run(context)`:

1. builds the `local` driver and the `fixture` profile,
2. starts the daemon with `http.token` set and `http.allowedHosts` set to exactly
   `["127.0.0.1:<port>"]`,
3. calls `runTransportCases(context, target, driver.issue)` — all six rows,
4. stops the daemon,
5. calls `runStartupRefusal(context, driver)`.

The startup refusal runs last, because it leaves no daemon running.

## Constraints

- `transportCases` is exported and never duplicated, and never filtered. Story 08 imports
  the array and runs it whole through its own issuer. A second literal table, or a subset
  selection, anywhere under `scripts/e2e/` is a defect.
- `runTransportCases` sends no `Origin` header at all on a row whose `origin` is `null`.
  `src/http/server/origin.ts:9-17` refuses on the header's presence, so an empty-string
  `Origin` would refuse a row that must pass.
- No case in this story uses the CLI. No case reads the daemon file system.
- The daemon of step 2 binds `127.0.0.1` on a port the `local` driver allocated. P1-E2 is
  the mandatory local baseline and never requires Podman.

## Verify

`node --test scripts/e2e/lib/scenario/transport.test.ts`

Asserts, against a `node:http` server on `127.0.0.1:0` that echoes the headers it received:

- `transportCases` has exactly six rows, with the exact names, in the exact order of the
  table, and no row carries a selection flag — `Object.keys` of each row deep-equals the
  six declared keys.
- `runTransportCases` records exactly eleven assertions: a `*-status` for all six rows and
  a `*-code` for the five rows whose `expectedCode` is not `null`. The test holds the exact
  expected name array.
- `runTransportCases` sends no `Authorization` header for `no-token`, and
  `Bearer <token>x` for `wrong-token` — read off the echo server.
- `runTransportCases` sends no `Origin` header for every row whose `origin` is `null` —
  asserted with `Object.hasOwn(received.headers, "origin") === false`.
- the `absent-host` row reaches the server with no `host` header.
- a server answering `200` where the case expects `401` makes `runTransportCases` reject
  with `assertion-failed` naming `no-token-status`.
- every log the run attached passes `redact`: the raw token string appears in no attached
  log — asserted with `String.includes` over every value of `logs`.

`node --test scripts/e2e/lib/scenario/startup-refusal.test.ts`

Asserts, against a fake driver:

- `runStartupRefusal` sets `http.bind` to `203.0.113.1` and `http.token` to `""` in the
  config it hands the driver.
- a driver returning exit `1` with the exact refusal line passes both assertions.
- a driver returning exit `0` makes it reject naming `startup-refusal-exit`.
- a driver returning exit `1` with any other message makes it reject naming
  `startup-refusal-message`.

`npm run verify` exits 0.

Proof: `node scripts/e2e/run.mjs P1-E2`, the second line of the EPIC Proof block. It also
delivers the EPIC coverage line "The daemon refuses to start when it binds a non-loopback
address with no token configured" for the local case; Story 08 delivers it across a real
network boundary.
