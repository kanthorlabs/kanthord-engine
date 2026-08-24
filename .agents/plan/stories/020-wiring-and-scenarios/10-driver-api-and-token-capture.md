# Story 10 — The driver API, and the secure token capture

Epic: `.agents/plan/epics/020-wiring-and-scenarios.md`
Depends on: Story 9.

**The token capture is the CLI `--token-file` option, not a runner capture mode.** `015-actor-identity.md:39` decides this and supersedes `020-wiring-and-scenarios.md:39,68`: `kanthord actor register --name <name> --token-file <path>` creates the file exclusively at mode `0600` before it issues the request, and prints the actor id with a redacted confirmation.

`scripts/e2e/podman/bin/e2e-request.mjs` therefore gains **no `captureToken` mode and no redaction**. It is still edited, for one purpose only: to accept a `tokenFile` field on its stdin request and read the bearer token from that path inside the container. Those two statements are not in tension — the capture belongs to the CLI, and the request helper only consumes what the CLI already wrote.

## Change

### `scripts/e2e/lib/driver/index.ts`

`ExecutionDriver` gains three members, and `driverMethodNames` at `:71-87` gains all three in declaration order, because `scripts/e2e/lib/driver/interface.test.ts:57-65` compares `Object.keys(driver).sort()` against that list.

```ts
cliAs(
  role: HostRole,
  argv: readonly string[],
  options?: Readonly<{ tokenFile?: string }>,
): Promise<CommandRecord>;
issueAs(role: HostRole, request: HttpRequest): Promise<HttpResponse>;
registerActor(
  role: HostRole,
  name: string,
): Promise<Readonly<{ actorId: string; tokenFile: string }>>;
```

- **`cli(argv)` stays, and equals `cliAs("client", argv)`.** No phase-1 call site changes.
- **`issue(request)` stays, and equals `issueAs("client", request)`.**

**The credential is an explicit argument, never driver state.** `cliAs` appends `--api-token-file <path>` when, and only when, the caller passes `options.tokenFile`. With the option absent it uses the configured token the driver already delivers, which is the bootstrap `human` actor. The driver stores no "current actor", so these questions have one answer each and none reaches build time:

- A command before any registration runs as the configured human actor.
- A second `registerActor` on one role mints a second identity and returns a second path. It replaces nothing, because nothing is stored.
- Two actors on one role are selected by passing two different `tokenFile` values.
- Registration itself always runs as the configured human actor, so `registerActor` calls `cliAs` with no `tokenFile`. `actor.register` admits `human` alone (`015-actor-identity.md:66`).
- A revoked actor's file is left as it is. A later call with that path receives `401`, which is the assertion a revocation test wants.

**The token file path is fixed by construction, never derived from the caller's name.** `registerActor` builds the path as a per-role directory plus a monotonic counter within the run — for podman `/opt/e2e/tokens/<role>-<n>`, for local `<runTemporaryDirectory>/tokens/<role>-<n>`, with `n` starting at `1`. The name never enters the path, so an unsafe name, a duplicate name and a repeated registration each stay well defined, and no pre-existing file is ever reused. The CLI creates each file exclusively, so a collision fails loudly rather than overwriting a live secret.

- The request type keeps the `HttpIssuer` shape of `:31-39` — `method`, `path`, `headers`, `omitHost`, optional `body` — and gains an optional `tokenFile: string`. When `tokenFile` is present the issuer reads the bearer token from that path **inside the container** and sends it; the runner never holds the value. A caller-selected header, `Idempotency-Key` included, is passed through `headers`, which is why a scenario needs `issueAs` at all: `src/cli/client.ts:63-73` builds a fixed header set and admits no arbitrary header.

`DaemonConfig` at `:9-21` gains `leaseTtlMs: number` immediately after `attemptLimit`, so a scenario configures the lease term of `018-claim-and-lease.md:48`. Carry it into the settings payload `toSettingsPayload` writes.

### `registerActor`, in each driver

`registerActor(role, name)` runs one command and returns no token:

```ts
await driver.cliAs(role, [
  "actor",
  "register",
  "--name",
  name,
  "--token-file",
  path,
]);
```

`path` is built by the rule above. The call itself passes **no** `tokenFile`, so the registration runs as the configured human actor. Parse the actor id from stdout. Return `{ actorId, tokenFile: path }`.

The returned record carries **no token field**, and the runner process never reads the file's contents.

A later call names the identity explicitly: `cliAs(role, argv, { tokenFile })`, and `issueAs` names the same path in `request.tokenFile`. `src/cli/options.ts:34-42` already declares `--api-token-file`, and `resolveClientOptions` already enforces mode `0600`, rejects a missing file and refuses `--token` together with `--api-token-file`.

**The local driver never lets the runner read a token.** The local driver runs the CLI as a child process, so the token file is read by that child exactly as it is in a container. `issueAs` on the local driver must not read the file in the runner process: route it through the same child request helper the podman driver uses, invoked as a `node` child process with the request on stdin. A local `issueAs` implemented with an in-process `fetch` plus a `readFile` puts the secret in the runner and is refused, because `assertNoDisclosure` reads the raw command records before redaction.

**`useActorToken` is refused.** It would put the token in the runner process, and `assertNoDisclosure` reads the raw `CommandRecord` at `scripts/e2e/lib/disclosure.ts:92-104` before serialization redacts anything.

### `scripts/e2e/lib/driver/podman.ts`

Build one issuer per client rather than the single `issue` bound at `:94-98`. `clientBaseUrl` and `clientToken` at `:99-100` become one record keyed by role. `issueAs` selects the issuer by role; `issue` delegates to `issueAs("client", …)`. `cliAs` runs `podman exec` against `containerFor(role)`; `cli` delegates to `cliAs("client", …)`.

### `scripts/e2e/lib/driver/local.ts` and `ssh.ts`

Both implement all three members. The local driver runs every role in the one execution context and writes token files under the run temporary directory. The ssh driver maps `client2` to the client host, as Story 9 states. Both keep `cli` and `issue` as delegations.

### `scripts/e2e/lib/driver/interface.test.ts`

- `expectedMethodNames` at `:13-29` gains the three names in the same order as `driverMethodNames`.
- Add `it("cli and cliAs(\"client\") reach the same target with the same arguments", ...)` — over a recording executor, assert the two recorded argv arrays are equal.
- Add `it("issue and issueAs(\"client\") build the same request", ...)` — the same shape over a recording issuer.
- Add `it("registerActor returns no token field", ...)` — assert `Object.keys(result)` deep-equals `["actorId", "tokenFile"]`.
- Add `it("registerActor runs as the configured human actor", ...)` — assert the recorded registration argv carries no `--api-token-file`.
- Add `it("two registrations on one role return two distinct token paths", ...)` — assert the counter increments and neither path holds the actor name.
- Add `it("cliAs appends --api-token-file only when the caller passes one", ...)` — assert both argv shapes over a recording executor.
- Add `it("no driver reads a token file in the runner process", ...)` — assert over each driver that a `readFile` spy on the token paths records zero calls across a registration and a subsequent `cliAs` and `issueAs`.
- Add `it("the recorded registration prints no token", ...)` — over a recording executor with a known response, assert the recorded stdout holds the actor id and holds no token value, and that `--token-file` appears in the recorded argv.
- The `local`, `podman` and `ssh` drivers each satisfy the shape assertion, so phase 3 inherits a working driver.

## Constraints

- **The runner holds no harness token.** No driver member returns one, no driver stores one, and no scenario reads a token file's contents. The runner process never calls `readFile` on a token path in any driver.
- Edit `scripts/e2e/podman/bin/e2e-request.mjs` only to accept `tokenFile` and read the bearer token from it. Add no capture mode and no redaction there — the CLI prints no secret, so `assertNoDisclosure` passes by construction.
- **`cliAs` carries no implicit credential.** The token file is an explicit argument or it is absent, and absent means the configured human actor.
- Add no fourth driver member. Three, exactly.
- `cli` and `issue` keep their current signatures, so no phase-1 call site changes.

## Verify

- `node --test scripts/e2e/lib/driver/interface.test.ts scripts/e2e/lib/driver/local.test.ts scripts/e2e/lib/driver/ssh.test.ts scripts/e2e/lib/driver/podman-issuer.test.ts` exits 0.
- `cliAs`, `issueAs` and `registerActor` are members of `driverMethodNames`.
- `npm run verify` exits 0.
- Proof: `scripts/e2e/lib/driver/interface.test.ts`, `scripts/e2e/lib/disclosure.test.ts`. Hermetic coverage: `020-wiring-and-scenarios.md:161`, `:162`, `:163`.
