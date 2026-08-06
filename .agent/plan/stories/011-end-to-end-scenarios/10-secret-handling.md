# Story 10 — Secret handling in a container run

Epic: `.agent/plan/epics/011-end-to-end-scenarios.md`
Depends on: Story 00, Story 01, Story 03, Story 07.

`.agent/plan/epics/011-end-to-end-scenarios.md:35` fixes the obligation: the token reaches a
container as a mounted file with restrictive permissions, never an environment variable and
never an argument; and the bearer header, the fixture Basic-auth header, the config file,
the printed commands, the daemon logs, the `podman inspect` output and the failure
diagnostics disclose no token.

Story 00 delivers `http.tokenFile`, so the daemon configuration names the mount path and
never holds the token. Every one of the seven surfaces is therefore an **absence**
assertion, with no exception.

## Change

### New — `scripts/e2e/lib/redact.ts`

```ts
export const redactedMarker = "[redacted]";

export type SecretRegistry = Readonly<{
  hold(value: string): void;
  redact(text: string): string;
  values(): readonly string[];
  forms(): readonly string[];
}>;

export function createSecretRegistry(): SecretRegistry;

export const secrets: SecretRegistry;
export function redact(text: string): string;
```

- `hold(value)` registers a secret. A value shorter than 8 characters is refused with
  `RunnerError("invalid-argument", "a secret must be at least 8 characters")`, because a
  short value redacted globally would corrupt unrelated output.
- `forms()` returns, for each held value: the value, its base64
  (`Buffer.from(value).toString("base64")`), and the `user:value@` Basic-auth url form that
  `test/helpers/remote/http.ts:522` builds. Every disclosure check and every redaction
  covers all three.
- `redact(text)` replaces every form with `redactedMarker`, **longest form first**, so a
  secret containing another is replaced whole.
- `redact` is pure with respect to the registry.
- `secrets` is the one process-wide registry, and `redact` is bound to it.

Every secret is held the moment it is created: the daemon bearer token by the driver, the
fixture Basic-auth token by `createFixtureProfile`, the config `masterKey` by the config
builder, and the real credential by `createRealProfile`.

### New — `scripts/e2e/lib/secret-file.ts`

```ts
export async function writeSecretFile(
  context: ScenarioContext,
  path: string,
  value: string,
): Promise<string>;
```

Writes `value` with `{ mode: 0o600 }`, then `chmod(path, 0o600)` explicitly, because the
process umask can clear bits `writeFile` requested. It calls `secrets.hold(value)`, takes the
file into the ledger, and returns `path`.

### Changed — `scripts/e2e/lib/command.ts` and `bundle.ts`

`redact` is called in exactly three places and nowhere else:

1. the printed command line, before `sink.print`;
2. `stdout` and `stderr` before they enter a `CommandRecord`;
3. the serialized bundle string and every log body, in `serializeBundle` and `writeBundle`.

### New — `scripts/e2e/podman/kanthordc`

The client wrapper baked into the product image by Story 07. Exactly:

```sh
#!/bin/sh
KANTHORD_TOKEN="$(cat /run/secrets/kanthord-token)"
export KANTHORD_TOKEN
exec kanthord "$@"
```

`src/cli/options.ts:39` already reads `KANTHORD_TOKEN` as the fallback for `--token`, so no
product change is needed. The variable is exported **by the wrapper process inside the
container**, never by `podman run --env` and never by `podman exec --env`, so it appears in
no `podman inspect` output and in no argv the runner prints.

### Changed — `scripts/e2e/lib/podman/topology.ts` — secret delivery

Before step 5 of `createTopology`:

- `podman secret create --label kanthord-e2e-run=<runId> kanthord-token-<runId> <tokenFile>`
  → take, kind `volume`, released by `podman secret rm`.
- `podman secret create --label kanthord-e2e-run=<runId> kanthord-master-<runId> <masterKeyFile>`
  → take the same way.

Steps 5 and 6 each gain:

```
--secret kanthord-token-<runId>,type=mount,target=/run/secrets/kanthord-token,mode=0600
--secret kanthord-master-<runId>,type=mount,target=/run/secrets/kanthord-master,mode=0600
```

**`mode=0600`, never `0400`.** `src/services/config/refusals.ts:33-45` refuses a
`masterKeyFile` whose mode is not exactly `0600`, and Story 00 gives `http.tokenFile` the
same rule. A `0400` mount would make the daemon refuse to start.

The **client** container carries the token secret because `kanthordc` reads it. It carries
no volume and no daemon secret beyond that.

The daemon's configuration is materialised inside the container, never on the runner host:
`startDaemon` runs `podman exec <daemonContainer> node /opt/e2e/bin/write-config.mjs`, which
reads the settings from stdin as JSON and writes
`/var/lib/kanthord/kanthord.config.json` with mode `0600`. It writes

```json
"http": { "tokenFile": "/run/secrets/kanthord-token", ... },
"masterKeyFile": "/run/secrets/kanthord-master"
```

and **no `http.token` and no `masterKey`**. `write-config.mjs` never reads either secret, so
no secret passes through it. The configuration file names two paths and holds no secret at
all.

### New — `scripts/e2e/lib/disclosure.ts`

```ts
export type DisclosureSurface = Readonly<{ name: string }>;

export const disclosureSurfaces: readonly DisclosureSurface[];

export async function assertNoDisclosure(
  context: ScenarioContext,
  execute: PodmanExecutor,
  topology: Topology,
): Promise<void>;
```

Seven surfaces, one obligation:

| name               | source                                                                     |
| ------------------ | -------------------------------------------------------------------------- |
| `bearer-header`    | every attached `*.http` log                                                |
| `basic-header`     | `podman logs <fixtureContainer>`                                           |
| `config`           | `podman exec <daemonContainer> cat /var/lib/kanthord/kanthord.config.json` |
| `printed-commands` | every line the sink printed, and every recorded argv                       |
| `daemon-logs`      | `podman logs <daemonContainer>`                                            |
| `podman-inspect`   | `podman inspect <pod> <fixture> <daemon> <client>`                         |
| `diagnostics`      | every value of the bundle's `logs`                                         |

Each asserts `false === surfaceText.includes(form)` for every form in `secrets.forms()`,
against the **raw** text, before bundle redaction, so it proves the value was never there
rather than proving redaction ran. Assertion names are `no-disclosure-<name>`, seven in
total.

One extra assertion covers the two mount paths the configuration does name:
`no-disclosure-config-mode` asserts `podman exec <daemonContainer> stat -c %a` is `600` for
the configuration file and for both mounted secrets. Eight assertions in total.

### Changed — `scripts/e2e/lib/scenario/p1-e4.ts`

Phase 11 calls `assertNoDisclosure`, from a `finally` around phases 5 to 10.

## Constraints

- No `podman run`, `podman exec` or `podman build` in the whole EPIC carries `--env` or
  `-e`, and none carries a secret in argv. A test asserts this over the recorded argv of a
  full fake run.
- `redact` is called in exactly the three places named above.
- `assertNoDisclosure` reads `secrets.forms()` and runs before serialization.
- The disclosure phase runs on the failure path as well as the success path.

## Verify

`node --test scripts/e2e/lib/redact.test.ts`

- `hold("short")` throws `invalid-argument`.
- `redact("Bearer abcdefgh12")` with `abcdefgh12` held equals `"Bearer [redacted]"`.
- with `abcdefgh12` and `abcdefgh12345` both held, `redact("abcdefgh12345")` equals
  `"[redacted]"` — longest first, one marker, never `"[redacted]345"`.
- `forms()` for one held value has exactly three entries: the value, its base64, and the
  `user:value@` form.
- `redact(Buffer.from("reader:r-tok-long").toString("base64"))` with `r-tok-long` held holds
  no readable secret.
- `redact("http://writer:w-tok-long@127.0.0.1:7422/x")` with `w-tok-long` held holds no
  `w-tok-long`.
- `redact` does not mutate the registry: `values()` before and after deep-equal.

`node --test scripts/e2e/lib/secret-file.test.ts`

- `writeSecretFile` into a `mkdtemp` directory produces a file whose
  `statSync(path).mode & 0o777` is `0o600`, under a process umask of `0o000` set for the
  test and restored after.
- the value is registered, and the file is in `context.taken()`.

`node --test scripts/e2e/lib/disclosure.test.ts`

- `disclosureSurfaces` has exactly seven entries, named exactly as the table, in table
  order.
- clean outputs produce eight passing assertions with the exact eight names.
- an inspect output containing the token rejects naming `no-disclosure-podman-inspect`.
- an inspect output containing only `Buffer.from(token).toString("base64")` still rejects.
- a config dump containing the token rejects naming `no-disclosure-config`. Story 00 is what
  makes this assertion satisfiable.
- a config dump naming `"tokenFile": "/run/secrets/kanthord-token"` and no token passes.
- a config file at mode `644` rejects naming `no-disclosure-config-mode`, and so does a
  mounted secret at `0400`.

`node --test scripts/e2e/lib/podman/topology.test.ts` — extended:

- `createTopology` issues two `podman secret create` commands, both labelled, before the
  daemon `podman run`.
- both the daemon and the client `podman run` carry two `--secret` arguments with
  `type=mount` and `mode=0600`. No `--secret` anywhere carries `mode=0400`.
- no command in the whole recording carries `--env` or `-e`.
- the client `podman run` carries no `--volume`.
- `startDaemon` issues `podman exec <daemonContainer> node /opt/e2e/bin/write-config.mjs`
  and writes the settings on stdin; neither the recorded argv nor the stdin JSON contains a
  token, an `http.token` key or a `masterKey` key. The stdin JSON does contain
  `http.tokenFile` and `masterKeyFile`.

`node --test scripts/e2e/lib/scenario/p1-e4.test.ts` — extended:

- over the full fake run, no recorded argv and no printed line contains any form in
  `secrets.forms()`.
- a fake run that fails in phase 8 still executes phase 11.

`npm run verify` exits 0.

Proof: precondition of `node scripts/e2e/run.mjs P1-E4`. It delivers the EPIC coverage line
"The token appears in no `podman inspect` output, no printed command, no config dump and no
log, asserted over a deliberately failing run as well as a passing one", in full, with the
config dump included as an absence assertion.
