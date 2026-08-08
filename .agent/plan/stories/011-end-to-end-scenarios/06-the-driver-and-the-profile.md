# Story 06 — Two axes: the execution driver and the scenario profile

Epic: `.agent/plan/epics/011-end-to-end-scenarios.md`
Depends on: Story 01, Story 02, Story 03.

Axis definitions: `docs/proposal/README.md:63-74`.

## Change

### New — `scripts/e2e/lib/driver/index.ts`

The interface only. No implementation, no re-export of one — the same rule
`AGENTS.md` puts on `src/services/<capability>/index.ts`.

```ts
export type DriverName = "local" | "podman" | "ssh";

export type HostRole = "daemon" | "client";

export type DaemonConfig = Readonly<{
  home: string;
  actor: string;
  masterKey: string;
  http: Readonly<{
    bind: string;
    port: number;
    token: string;
    allowedHosts: readonly string[];
  }>;
  tools: Readonly<{ git: string; ssh: string; sshKeyscan: string }>;
  attemptLimit: number;
}>;

export type DaemonHandle = Readonly<{
  baseUrl: string;
  allowedHost: string;
  ready(): Promise<void>;
  stop(): Promise<void>;
  logs(): Promise<Readonly<{ stdout: string; stderr: string }>>;
}>;

export type HttpIssuer = (
  request: Readonly<{
    method: string;
    path: string;
    headers: Readonly<Record<string, string>>;
    omitHost: boolean;
  }>,
) => Promise<Readonly<{ status: number; body: string }>>;

export type ExecutionDriver = Readonly<{
  name: DriverName;
  identity(role: HostRole): Promise<BundleIdentity>;
  deliverBinary(role: HostRole): Promise<string>;
  deliverDirectory(
    role: HostRole,
    source: string,
    name: string,
  ): Promise<string>;
  retrieveDirectory(
    role: HostRole,
    source: string,
    destination: string,
  ): Promise<void>;
  deliverConfig(config: DaemonConfig): Promise<string>;
  deliverToken(token: string): Promise<string>;
  assertBareMachine(): Promise<void>;
  cli(argv: readonly string[]): Promise<CommandRecord>;
  issue: HttpIssuer;
  daemonNetwork?(): Promise<
    Readonly<{ bind: string; port: number; allowedHosts: readonly string[] }>
  >;
  startDaemon(config: DaemonConfig): Promise<DaemonHandle>;
  startDaemonExpectingRefusal(
    config: DaemonConfig | null,
  ): Promise<CommandRecord>;
  collectLogs(): Promise<Readonly<Record<string, string>>>;
}>;

export const driverMethodNames: readonly (keyof ExecutionDriver)[];
```

`driverMethodNames` is the literal list of the fourteen keys above, in declaration order.
It is the mechanism behind the EPIC coverage line "The `podman` and `ssh` drivers expose one
interface, asserted by construction".

Every method covers exactly one of the responsibilities `docs/proposal/README.md:69` names:
command execution per host, binary delivery, configuration delivery, token delivery, daemon
start and stop, log collection, and the merge of two hosts into one bundle — `identity` and
`collectLogs` are the merge. Three methods exist because a two-host run needs them and a
one-host run must not special-case them:

- `deliverDirectory(role, source, name)` copies a local directory to the host of `role` and
  returns the path there. The plan fixture reaches the **client** through this method on
  every driver, so no scenario branches on where the client runs.
- `assertBareMachine()` proves `/etc/kanthord/config.json` is absent on the daemon host, and
  throws `RunnerError("unavailable", "/etc/kanthord/config.json exists on the daemon host; P1-E1 needs a bare machine")`
  when it is present. Journey step 2 depends on it, and ambient host state must never be
  assumed.
- `issue` originates an HTTP request **from the client host**. `localIssuer` is
  `node:http.request`; the podman and ssh drivers issue from their client. The transport
  cases of Story 05 take the driver's `issue`, so the same oracle runs from either place.

### New — `scripts/e2e/lib/driver/local.ts`

```ts
export async function createLocalDriver(
  context: ScenarioContext,
): Promise<ExecutionDriver>;
```

- `deliverBinary` runs `npm pack --pack-destination <tmp>` in the repository root once,
  then `npm install --global --prefix <tmp>/prefix <tmp>/kanthord-<version>.tgz`, and
  returns `<tmp>/prefix/bin/kanthord`. This is what `.agent/plan/epics/001-runtime-foundation.md:33-35`
  means by the packaged binary: the `bin` link of `package.json:11-13`, not a compiled
  artifact. The result is memoized for the process, so one run packs once.
- `identity("daemon")` and `identity("client")` both return the runner host identity.
- `cli(argv)` runs `[binary, ...argv]` through `runCommand`, with `cwd` set to the
  configuration directory and `env` limited to
  `{ PATH: \`${dirname(binary)}:${dirname(process.execPath)}\`, HOME: <tmp>/home, KANTHORD_TOKEN: <token> }`.
The Node directory is on `PATH`because the installed`kanthord`shebang is`#!/usr/bin/env node` (`src/domain/version.test.ts:16-36`), and `env`finds nothing with
the npm prefix alone.`KANTHORD_TOKEN`is read by`src/cli/options.ts:39`, so no `--token`
  reaches argv and the printed command holds no secret.
- `startDaemon` writes the config, spawns `[binary, "serve"]`, and resolves once stdout
  holds `kanthord: ready\n` — `src/main.ts:302` — within the readiness deadline of
  Story 09. It takes the process and the temporary home into the ledger through
  `context.take` at the moment each exists.
- `startDaemonExpectingRefusal` spawns the same way and resolves the `CommandRecord` when
  the process exits. It never waits for readiness. A `config` of `null` means **deliver no
  config**: the driver writes nothing and spawns onto a bare machine, so the daemon refuses
  with `config-not-found` and names its search order. A `config` means deliver that config
  and spawn, so the daemon refuses on the config's own content. P1-E1 takes the first form
  and P1-E2 the second, and one method serves both because the spawn is identical.
- The local driver writes its config at `<home>/kanthord.config.json` and spawns the daemon
  with `cwd` equal to `<home>`, so the delivered config is the cwd candidate of
  `src/services/config/search-order.ts`. That is what `docs/proposal` calls candidate 2, and
  Story 04 expectation 3 requires the process to run with that same `cwd`.
- `deliverDirectory(role, source, name)` copies `source` into `<tmp>/deliver/<name>` with
  `cp -R` semantics and returns that path. The local driver has one host, and the copy
  still happens, so the local run exercises the same code path as the other two.
- `assertBareMachine()` stats `/etc/kanthord/config.json` and throws `unavailable` when it
  exists.
- `issue` is `localIssuer`.
- The port is allocated by binding a `node:net` server to `127.0.0.1:0`, reading
  `address().port`, and closing it before the config is written.

### New — `scripts/e2e/lib/profile/index.ts`

```ts
export type ProfileName = "fixture" | "real";

export type ScenarioProfile = Readonly<{
  name: ProfileName;
  origin: string;
  credentialArguments: readonly string[];
  defaultBranch: string;
  planDirectory: string;
  expectedObjectiveCount: number;
  expectedTaskCount: number;
  fixtureRoot: string | null;
  expectedObjectIds: Readonly<Record<string, string>> | null;
}>;

export const profileFieldNames: readonly (keyof ScenarioProfile)[];
```

- `planDirectory` is the path **on the client host**, produced by
  `driver.deliverDirectory("client", …)`. A profile therefore delivers its own plan, and no
  scenario knows where the client runs.
- `expectedObjectiveCount` and `expectedTaskCount` are profile data, because
  `runJourney` step 15 asserts them and P1-E3 imports the operator's plan rather than the
  fixture. A literal count in `journey.ts` is a defect.
- `fixtureRoot` and `expectedObjectIds` are `null` on the real profile. That is the
  mechanism behind `docs/proposal/README.md:72`: a fixture-profile run asserts fixture
  object ids and a fixture default branch, a real-profile run asserts neither.

### New — `scripts/e2e/lib/profile/fixture.ts`

```ts
export async function createFixtureProfile(
  context: ScenarioContext,
  driver: ExecutionDriver,
): Promise<ScenarioProfile>;
```

**The fixture profile owns the fixture remote's lifecycle.** It starts the remote the
scenario needs and takes it into the ledger:

- on the `local` driver, it calls `createHttpRemote()` from
  `test/helpers/remote/index.ts:65` in process, takes `dispose` into the ledger, and reads
  `origin` from it.
- on the `podman` driver, the fixture container of Story 07 already serves it, and the
  profile takes `origin` from `topology.fixtureOrigin`.

Which of the two applies is decided by `driver.name` **inside the profile factory only**.
That is the one legal place, because the profile axis is what supplies the origin.

- `defaultBranch` is `"main"` — `test/helpers/remote/seed.ts:95-116` initialises with
  `--initial-branch=main`.
- `planDirectory` is
  `await driver.deliverDirectory("client", "test/e2e/fixtures/two-objective/plan", "plan")`.
- `expectedObjectiveCount` is `2` and `expectedTaskCount` is `4`.
- `fixtureRoot` is `test/e2e/fixtures/two-objective`.
- `expectedObjectIds` is `fixtureObjectIds` from `test/helpers/remote/seed.ts:22`.
- `credentialArguments` builds `["credential", "register", "--name", "fixture", "--kind",
"git", "--transport", "http-basic", "--username", remote.username, "--token-file",
<path>]`, where `<path>` is the token file Story 10 owns.

### New — `scripts/e2e/lib/profile/real.ts`

```ts
export async function createRealProfile(
  context: ScenarioContext,
  driver: ExecutionDriver,
  input: Readonly<{
    origin: string;
    credentialArguments: readonly string[];
    defaultBranch: string;
    localPlanPath: string;
    expectedObjectiveCount: number;
    expectedTaskCount: number;
  }>,
): Promise<ScenarioProfile>;
```

`fixtureRoot` and `expectedObjectIds` are `null`. `planDirectory` is
`await driver.deliverDirectory("client", input.localPlanPath, "plan")`, so the operator's
plan reaches the client host on the `ssh` driver the same way the fixture reaches it on the
other two. Every other field comes from `input`, which Story 11 fills from the environment.

### New — `scripts/e2e/lib/scenario/index.ts`

```ts
export type ScenarioId = "P1-E1" | "P1-E2" | "P1-E3" | "P1-E4";

export type ScenarioDeclaration = Readonly<{
  id: ScenarioId;
  mode: "deterministic" | "deployment";
  driver: DriverName;
  profile: ProfileName;
  run(context: ScenarioContext): Promise<void>;
}>;

export const scenarios: readonly ScenarioDeclaration[];
```

`scenarios` holds exactly four entries, ordered by `id` bytewise ascending:

| id      | mode            | driver   | profile   |
| ------- | --------------- | -------- | --------- |
| `P1-E1` | `deterministic` | `local`  | `fixture` |
| `P1-E2` | `deterministic` | `local`  | `fixture` |
| `P1-E3` | `deployment`    | `ssh`    | `real`    |
| `P1-E4` | `deterministic` | `podman` | `fixture` |

Each row matches `docs/proposal/phase-1/README.md:63,82,92,102-103`.

## Constraints

- `scripts/e2e/lib/driver/index.ts` and `scripts/e2e/lib/profile/index.ts` export types and
  the two name lists only. They import no implementation.
- A scenario module imports the two interfaces and never a concrete driver by name. `main`
  constructs the driver from the declaration's `driver` field, which is the only place a
  driver name maps to a factory.
- The journey and the transport cases are shared code. Neither branches on `driver.name`.
  A behaviour that differs per driver lives behind a driver method. The **one** permitted
  `driver.name` read in the whole EPIC is inside `createFixtureProfile`, where it selects
  the fixture-remote lifecycle.

## Verify

`node --test scripts/e2e/lib/driver/interface.test.ts`

Asserts, by construction:

- `driverMethodNames` has exactly fourteen entries, in the declaration order above.
- for each of the three factories — local, podman, ssh — the constructed driver's
  `Object.keys(driver).sort()` deep-equals `[...driverMethodNames].sort()`. The podman and
  ssh factories are constructed against a fake command executor, so the test spawns nothing.
- for each factory, every `driverMethodNames` entry other than `name` is `typeof "function"`.
- `driver.name` equals the factory's declared name.

`node --test scripts/e2e/lib/profile/profile.test.ts`

Asserts:

- `profileFieldNames` has exactly nine entries in declaration order.
- `createFixtureProfile` returns `defaultBranch: "main"`,
  `expectedObjectiveCount: 2`, `expectedTaskCount: 4`, and `expectedObjectIds`
  deep-equalling `fixtureObjectIds` of `test/helpers/remote/seed.ts:22`.
- `createFixtureProfile` calls `driver.deliverDirectory("client",
"test/e2e/fixtures/two-objective/plan", "plan")` exactly once, and `planDirectory` is
  what that returned — asserted with a fake driver returning a sentinel path.
- `createFixtureProfile` on a fake driver named `local` takes one resource of kind
  `directory` for the in-process fixture remote; on a fake named `podman` it takes none and
  reads the origin from the topology.
- `createRealProfile` returns `fixtureRoot: null` and `expectedObjectIds: null`, and calls
  `deliverDirectory` with `input.localPlanPath`.
- both profiles carry the same key set — `Object.keys` sorted deep-equal.

`node --test scripts/e2e/lib/scenario/index.test.ts`

Asserts:

- `scenarios` has exactly four entries.
- the ids are `["P1-E1", "P1-E2", "P1-E3", "P1-E4"]` and are bytewise ascending under
  `Buffer.compare`.
- each row's `mode`, `driver` and `profile` deep-equal the table above.
- exactly one row has `mode: "deployment"`, and it is `P1-E3`.
- no scenario module file text contains `driver.name ===` — asserted by reading each file
  under `scripts/e2e/lib/scenario/` and `scripts/e2e/lib/profile/`.

`npm run verify` exits 0.

Proof: delivers the EPIC coverage line "The `podman` and `ssh` drivers expose one interface,
asserted by construction. The scenario profile is the other axis, so a driver swap never
silently changes what a scenario claims." It is a precondition of all three
`node scripts/e2e/run.mjs <id>` Proof lines.
