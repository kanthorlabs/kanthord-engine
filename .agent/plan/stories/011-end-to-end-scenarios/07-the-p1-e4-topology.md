# Story 07 — The P1-E4 topology

Epic: `.agent/plan/epics/011-end-to-end-scenarios.md`
Depends on: Story 06.

Topology: `docs/proposal/phase-1/README.md:96`.

## Change

### New — two Containerfiles, never one image

`docs/proposal/phase-1/README.md:96` requires the daemon image to stay single-purpose. One
process per container does not satisfy that: an image carrying the fixture server and the
test helpers is not single-purpose whatever its container runs. Two images therefore exist.

`scripts/e2e/podman/product.Containerfile` — the daemon and the client:

```
FROM <baseImageReference>
COPY product /opt/kanthord
RUN ln -s /opt/kanthord/src/main.ts /usr/local/bin/kanthord
COPY bin/kanthordc /usr/local/bin/kanthordc
COPY bin/write-config.mjs /opt/e2e/bin/write-config.mjs
COPY bin/e2e-request.mjs /opt/e2e/bin/e2e-request.mjs
```

The three files under `bin/` are copied from `scripts/e2e/podman/bin/` into the build
context by Story 09. `kanthordc` is the token wrapper of Story 10, `write-config.mjs` writes
the daemon configuration inside the container, and `e2e-request.mjs` is the HTTP issuer of
Story 08.

`scripts/e2e/podman/fixture.Containerfile` — the fixture remote alone:

```
FROM <baseImageReference>
COPY fixture /opt/fixture
```

Pinned rules:

- `<baseImageReference>` is
  `docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584`,
  **digest-qualified**, declared once as `baseImageReference` in
  `scripts/e2e/lib/podman/preflight.ts` and substituted into both Containerfiles by the
  provisioning step of Story 09. A floating tag is not a pin. That digest is the OCI image
  index, so one reference is correct on `arm64` and `amd64`.
  `node:24-bookworm` is the full Debian image, which already ships `git`, so no
  `apt-get` runs at build time.
- `product/` is the **already-installed** product tree, assembled locally by Story 09: the
  unpacked `npm pack` tarball plus a `node_modules` produced by `npm ci --omit=dev`. No
  `npm install` runs inside the build, so the build reaches no registry.
- Both builds run with `--pull=never` and `--network none`. Story 09 asserts both.
- The plan fixture is **not** baked into an image. `deliverDirectory` copies it into the
  client container at run time with `podman cp`, so the daemon image never carries it.

### New — `scripts/e2e/fixture-remote/main.ts`

A standalone entry for the EPIC 005 git smart-HTTP fixture, because a container cannot use
the in-process helper.

```ts
export async function main(argv: readonly string[]): Promise<number>;
```

- reads `--port <port>` and `--bind <address>`, both required.
- calls `resolveTools()` and `seedRepositories(tools)` from `test/helpers/remote/tools.ts`
  and `test/helpers/remote/seed.ts`, then `startHttpRemote(tools, seed, { bind, port })`.
- writes one line `fixture-remote: ready <origin>\n` to stdout when listening.
- releases the seed and the server on `SIGTERM`.

### Changed — `test/helpers/remote/http.ts:478-510`

One new optional third argument:

```ts
export function startHttpRemote(
  tools: Tools,
  seed: SeedRoot,
  listen?: Readonly<{ bind?: string; port?: number }>,
): Promise<HttpRemote>;
```

`http.ts:502` becomes `server.listen(listen?.port ?? 0, listen?.bind ?? "127.0.0.1", ...)`
and `http.ts:510` renders the origin from the resolved bind and port. Every existing caller
passes two arguments and is unaffected. This is the whole change to `test/helpers/`.

### New — `scripts/e2e/lib/podman/topology.ts`

```ts
export type Topology = Readonly<{
  runId: string;
  network: string;
  pod: string;
  fixtureContainer: string;
  daemonContainer: string;
  clientContainer: string;
  volume: string;
  daemonAlias: string;
  daemonPort: number;
  fixturePort: number;
  allowedHost: string;
  fixtureOrigin: string;
}>;

export function planTopology(runId: string): Topology;

export async function createTopology(
  context: ScenarioContext,
  execute: PodmanExecutor,
  images: Readonly<{ product: string; fixture: string }>,
  topology: Topology,
): Promise<void>;
```

`planTopology(runId)` is pure and returns exactly:

| field              | value                           |
| ------------------ | ------------------------------- |
| `network`          | `kanthord-e2e-${runId}`         |
| `pod`              | `kanthord-e2e-pod-${runId}`     |
| `fixtureContainer` | `kanthord-e2e-fixture-${runId}` |
| `daemonContainer`  | `kanthord-e2e-daemon-${runId}`  |
| `clientContainer`  | `kanthord-e2e-client-${runId}`  |
| `volume`           | `kanthord-e2e-home-${runId}`    |
| `daemonAlias`      | `kanthord-daemon`               |
| `daemonPort`       | `7421`                          |
| `fixturePort`      | `7422`                          |
| `allowedHost`      | `kanthord-daemon:7421`          |
| `fixtureOrigin`    | `http://127.0.0.1:7422`         |

The ports are fixed literals, not allocated. Each run gets its own pod and its own network,
no host port is published, and no container uses host networking, so no collision is
possible.

`createTopology` issues these commands, in this exact order, each taking its resource into
the ledger immediately after it succeeds:

1. `podman network create --internal --label kanthord-e2e-run=<runId> <network>` → take
   `network`.
2. `podman volume create --label kanthord-e2e-run=<runId> <volume>` → take `volume`.
3. `podman pod create --name <pod> --network <network>:alias=<daemonAlias> --label kanthord-e2e-run=<runId>`
   → take `pod`.
4. `podman run --detach --pod <pod> --name <fixtureContainer> --label kanthord-e2e-run=<runId> --pull=never <images.fixture> node /opt/fixture/main.ts --bind 127.0.0.1 --port 7422`
   → take `fixtureContainer`.
5. `podman run --detach --pod <pod> --name <daemonContainer> --label kanthord-e2e-run=<runId> --pull=never --volume <volume>:/var/lib/kanthord --secret <secret arguments of Story 10> <images.product> sleep infinity`
   → take `daemonContainer`.
6. `podman run --detach --network <network> --name <clientContainer> --label kanthord-e2e-run=<runId> --pull=never --secret <secret arguments of Story 10> <images.product> sleep infinity`
   → take `clientContainer`.

**The daemon container's entrypoint is `sleep infinity`, not `kanthord serve`.** The
scenario starts and stops the daemon **process** three times — the refusal, the wrong allow
list, the journey — while the container is created once. `startDaemon` therefore runs
`podman exec --detach <daemonContainer> kanthord serve` and `stop()` runs
`podman exec <daemonContainer> pkill -TERM -f 'kanthord serve'`. A container whose
entrypoint is the daemon cannot be reconfigured between starts, and recreating it per start
would recreate the network namespace the run is proving.

Pinned consequences of that order:

- the fixture and the daemon join the **pod**, so they share one network namespace and the
  daemon reaches the fixture at `http://127.0.0.1:7422`. The plain-HTTP url rule of
  `docs/proposal/phase-1/git-foundation.md` is satisfied, not relaxed.
- the client joins the **network** and not the pod, so it is a second network namespace and
  it resolves the daemon only by the alias `kanthord-daemon`.
- the client mounts no volume, so it cannot read the daemon file system.
- the daemon home is `/var/lib/kanthord` on a **named volume**. The daemon's own
  `StatfsProbe` decides whether that is acceptable —
  `src/services/home-lock/statfs-probe.ts:24-28` reads the filesystem magic on Linux, and
  the container is Linux, so the check is effective. The topology asserts nothing about the
  volume's filesystem; it lets the daemon decide.
- LIFO release means client, daemon, fixture, pod, volume, network — containers before the
  pod that holds them, and the network last.

### New — `scripts/e2e/lib/driver/podman.ts`

```ts
export type PodmanExecutor = (
  argv: readonly string[],
) => Promise<CommandRecord>;

export async function createPodmanDriver(
  context: ScenarioContext,
  input: Readonly<{
    execute: PodmanExecutor;
    images: Readonly<{ product: string; fixture: string }>;
    topology: Topology;
  }>,
): Promise<ExecutionDriver>;
```

- `cli(argv)` runs `podman exec <clientContainer> kanthordc --base-url http://kanthord-daemon:7421 ...argv`.
  `kanthordc` is the Story 10 wrapper, so no token reaches this argv.
- `deliverDirectory(role, source, name)` runs
  `podman cp <source> <container>:/opt/e2e/<name>` and returns `/opt/e2e/<name>`.
- `assertBareMachine()` runs `podman exec <daemonContainer> test -e /etc/kanthord/config.json`
  and requires a non-zero exit. A fresh product image never carries that file, so this
  passes by construction and the assertion documents it.
- `issue` is `podmanIssuer` of Story 08, running from the client container.
- `identity(role)` runs `podman exec <container> node -e ...` printing hostname, platform
  and architecture, one role per container.
- `collectLogs()` runs `podman logs <container>` for the three containers, returning them
  keyed `fixture`, `daemon`, `client`.
- `deliverBinary` returns `kanthord`, the linked name inside the product image.

## Constraints

- The daemon's `http.bind` is `0.0.0.0` and its `http.allowedHosts` is exactly
  `["kanthord-daemon:7421"]`. An allow list left at `127.0.0.1` returns `403 host-forbidden`
  on every call, which Story 08 proves deliberately.
- No `podman run` publishes a host port, and none carries `--network host` or
  `--network=host`. Nothing is reachable from the runner host except through `podman exec`.
- `--pull=never` is on every `podman run` and every `podman build`.
- The change to `test/helpers/remote/http.ts` is the two lines named above and the
  signature. Do not restructure `startHttpRemote`, and do not change `createHttpRemote` in
  `test/helpers/remote/index.ts:65`.
- The daemon image contains no fixture code and no `test/helpers/` code. A test asserts the
  two Containerfiles copy disjoint trees.

## Verify

`node --test scripts/e2e/lib/podman/topology.test.ts`

Asserts, with a fake `PodmanExecutor` recording argv:

- `planTopology("R1")` deep-equals the twelve-field table above with `R1` substituted, and
  two calls with the same run id deep-equal.
- `createTopology` issues exactly six commands, in the exact order listed, with the exact
  argv arrays.
- every command carries `--label kanthord-e2e-run=R1`.
- every `podman run` carries `--pull=never`, and none carries `--network host`,
  `--network=host` or `--publish`.
- the fixture and daemon commands carry `--pod <pod>`; the client command carries
  `--network <network>` and no `--pod`.
- the client command carries no `--volume`.
- the fixture command uses `images.fixture` and the other two use `images.product`.
- the daemon and client commands both end in `sleep infinity`; neither argv contains
  `serve`.
- `context.taken()` after `createTopology` deep-equals, in take order,
  `[network, volume, pod, fixture, daemon, client]` with kinds
  `["network", "volume", "pod", "container", "container", "container"]`.
- a failure on command 4 leaves `taken()` holding the first three.
- `startDaemon` then `stop()` then `startDaemon` issues two `podman exec --detach
<daemonContainer> kanthord serve` commands and one `pkill`, and issues no
  `podman run` and no `podman rm` in between.

`node --test scripts/e2e/lib/podman/image.test.ts`

- both Containerfiles begin `FROM docker.io/library/node:24-bookworm@sha256:` — the base is
  digest-qualified in each.
- neither Containerfile contains `apt-get`, `npm install`, `npm ci`, `curl` or `wget`.
- the two `COPY` source trees are disjoint: the product Containerfile copies no path under
  `fixture`, and the fixture Containerfile copies no path under `product`.

`node --test test/helpers/remote/http.test.ts` — the existing suite, plus one new case:

- `startHttpRemote(tools, seed, { bind: "127.0.0.1", port: 0 })` behaves as the two-argument
  call, and `startHttpRemote(tools, seed)` still binds `127.0.0.1:0`. No existing case
  changes.

`npm run verify` exits 0.

Proof: precondition of `node scripts/e2e/run.mjs P1-E4`, the third line of the EPIC Proof
block.
