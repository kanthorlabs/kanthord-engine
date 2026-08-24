# Story 10 — Secret handling in a container run

Epic: `.agents/plan/epics/011-end-to-end-scenarios.md`
Depends on: Story 00, Story 01, Story 03, Story 07.

`.agents/plan/epics/011-end-to-end-scenarios.md:35` fixes the obligation: the token reaches a
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

**Redaction happens at an egress and nowhere else.** An egress is a place where text leaves
the process: a terminal, or a file. Captured text stays raw in memory.

1. the printed command line, before `sink.print`;
2. the serialized bundle string and every log body, in `serializeBundle` and `writeBundle`;
3. the reclaim failure line and the error line `main` writes to `stderr`.

**A captured surface is never redacted at capture.** `runCommand` puts raw `stdout` and raw
`stderr` into the `CommandRecord`, and `attachLog` attaches a raw body. This is what makes
the disclosure assertions below mean anything: an absence asserted over already-redacted
text proves the redactor ran, which is a different claim from the secret never having been
there, and it is the claim that cannot fail.

That ordering was inverted once, and it cost the EPIC a full cycle of false confidence.
`runCommand` redacted into the record and both `attachLog` call sites redacted on the way in,
so six of the seven surfaces compared a redacted string against a secret and passed by
construction. The bundle of a passing run held `Authorization: Bearer [redacted]` in the very
log the `bearer-header` surface reads: the secret _was_ emitted, the redactor removed it, and
the assertion still passed. Redaction at capture destroys the evidence the assertion needs.

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

The **client** container carries both secrets, exactly as the daemon container does: one
`podman run` secret shape serves both, so no branch decides which secret reaches which host.
`kanthordc` reads the token; the client never reads the master key. It carries no volume.

A secret the client never reads is still mounted, and that is deliberate. The alternative is
a per-role secret list, which is a branch that a future role would have to remember to
update. The mount is safe because the same rules cover it either way: `mode=0600`, absent
from `podman inspect`, absent from every printed command, and absent from every log — the
disclosure assertions below hold over both containers, not just the daemon.

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
| `printed-commands` | every printed line, and every recorded argv, `stdout` and `stderr`         |
| `daemon-logs`      | `podman logs <daemonContainer>`                                            |
| `podman-inspect`   | `podman inspect <pod> <fixture> <daemon> <client>`                         |
| `diagnostics`      | every value of the bundle's `logs`                                         |

Each asserts `false === surfaceText.includes(form)` for every form in `secrets.forms()`,
against the **raw** text, before bundle redaction, so it proves the value was never there
rather than proving redaction ran. Assertion names are `no-disclosure-<name>`, seven in
total.

**An absence assertion over an empty set passes and proves nothing, so the registry is
asserted non-empty first.** `assertNoDisclosure` refuses with
`RunnerError("assertion-failed", "the secret registry is empty; a disclosure assertion would be vacuous")`
when `secrets.forms()` is empty, **before** the seven surfaces. This is a refusal rather
than an assertion, because a vacuous proof is a defect in the harness and not a finding
about the product.

This closed a real defect. In the first implementation a local stub `redact()` shadowed the
real redactor in `command.ts`, `bundle.ts` never redacted on write, and no P1-E1 or P1-E2
path called `secrets.hold`. All eight assertions passed for a full cycle against an empty
registry. Three rules follow, and each is verified below:

- **One redactor.** `redact` is imported from `scripts/e2e/lib/redact.ts`. No module
  declares a function named `redact` of its own.
- **Hold at creation, on every path.** Every secret is held where it is minted, so a
  scenario that mints a token cannot forget. The holders are `writeSecretFile`, the podman
  driver, the local driver, the ssh driver, `createFixtureProfile` and the transport
  oracle — P1-E1 and P1-E2 included, not P1-E4 alone.
- **A non-empty registry is a precondition of a disclosure claim**, per the refusal above.

One extra assertion covers the two mount paths the configuration does name:
`no-disclosure-config-mode` asserts `podman exec <daemonContainer> stat -c %a` is `600` for
the configuration file and for both mounted secrets. Eight assertions in total.

### Changed — `scripts/e2e/lib/scenario/p1-e4.ts`

Phase 11 calls `assertNoDisclosure`, from a `finally` around phases 5 to 10.

**A disclosure failure never replaces the failure already in flight.** A `finally` that
throws discards the exception the `try` was carrying, so a run that failed in phase 8 would
report a disclosure error and lose its real cause — at exactly the moment a human needs it.
Phase 11 therefore mirrors `withLedger`'s `cleanupFailures` contract:

```ts
export type WithDisclosureFailure = Error & { disclosureFailure?: Error };
```

- phases 5-10 succeeded, disclosure fails → throw the disclosure error.
- phases 5-10 failed, disclosure succeeds → rethrow the original error.
- both failed → attach the disclosure error to the original as a `disclosureFailure` own
  property and rethrow **that same original object**. The cause is never replaced, and the
  disclosure finding is never lost.

## Constraints

- No `podman run`, `podman exec` or `podman build` in the whole EPIC carries `--env` or
  `-e`, and none carries a secret in argv. A test asserts this over the recorded argv of a
  full fake run.
- `redact` is called at the three egress points named above, and at no capture point.
  A recorded `stdout`, a recorded `stderr` and an attached log body are raw.
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
- with an **empty** registry, `assertNoDisclosure` throws `assertion-failed` and records no
  assertion at all.
- an attached `*.http` log holding the raw bearer token rejects naming
  `no-disclosure-bearer-header`, and an attached non-`http` log holding it rejects naming
  `no-disclosure-diagnostics`. Both surfaces were unfalsifiable while capture redacted, so
  each case is a guard against that inversion returning.
- a recorded command whose raw `stdout` holds the token rejects naming
  `no-disclosure-printed-commands`. A recorded `stdout` reaches `bundle.json`, so it is a
  surface, not merely an input. This is the anti-vacuity guard, and it is what makes the seven passes
  above mean something.
- a source check over `scripts/e2e/lib/**` finds no second declaration of `redact` —
  `function redact`, `const redact =` and `let redact =` appear in `redact.ts` only. A local
  stub that shadows the real redactor is what made the first implementation vacuous.

`node --test scripts/e2e/lib/command.test.ts` and `bundle.test.ts` — extended:

- a `CommandRecord` built from a process that emits a held secret on `stdout` and on `stderr`
  holds that secret **verbatim**, and holds no `redactedMarker`. Redaction at capture is the
  defect this case names, and the case fails if it returns.
- the printed command line for an argv carrying a held secret holds `redactedMarker` and no
  form of the secret. The terminal is an egress.
- `writeBundle` of a bundle whose recorded `stdout` and whose log body each carry a held
  secret writes a `bundle.json` and a log file containing no form of the secret. A write path
  that serializes but does not redact is the defect this case names.

`node --test scripts/e2e/lib/scenario/transport.test.ts` — extended:

- the attached `wrong-token.http` log holds the bearer header verbatim, and `redact` of that
  same text holds no form of the token. The two assertions together pin the boundary: raw in
  memory, redacted on the way out.

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

- `secrets.forms()` is non-empty after the fake run, asserted **before** the sweep below.
  The sweep iterates the forms, so an empty registry would pass it trivially.
- over the full fake run, no recorded argv contains any form in `secrets.forms()`.

**The printed-line half of that sweep is delivered by the Proof, not by this test.** The
fakes answer `driver` calls directly and never reach `runCommand`, so `printedLines` is empty
in a fake run and a loop over it would assert nothing — the same vacuity this story exists to
remove, reintroduced one level down. A real `node scripts/e2e/run.mjs P1-E4` prints every
command through `runCommand` and asserts `no-disclosure-printed-commands` over those lines.
The gap is recorded here rather than covered by a test that cannot fail.

- a fake run that fails in phase 8 still executes phase 11.
- a fake run that fails in phase 8 **and** discloses a secret rejects with the phase-8 error
  object itself — asserted with `assert.equal(caught, thrown)` — carrying
  `disclosureFailure` whose message is the failing assertion name.
- a fake run that succeeds through phase 10 and discloses a secret rejects with the
  disclosure error, and that error carries no `disclosureFailure`.

`npm run verify` exits 0.

Proof: precondition of `node scripts/e2e/run.mjs P1-E4`. It delivers the EPIC coverage line
"The token appears in no `podman inspect` output, no printed command, no config dump and no
log, asserted over a deliberately failing run as well as a passing one", in full, with the
config dump included as an absence assertion.
