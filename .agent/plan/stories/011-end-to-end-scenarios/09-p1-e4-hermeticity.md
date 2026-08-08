# Story 09 — P1-E4 hermeticity

Epic: `.agent/plan/epics/011-end-to-end-scenarios.md`
Depends on: Story 07.

Five rules, one mechanism each. `docs/proposal/README.md:96-98` and
`.agent/plan/epics/011-end-to-end-scenarios.md:29-34`.

## Change

### New — `scripts/e2e/lib/podman/preflight.ts`

```ts
export const minimumPodmanVersion = "5.0.0";
export const baseImageReference =
  "docker.io/library/node:24-bookworm@sha256:934240a162082fd8b8a2f90cd5114446443f1eba1c5378f6687167ca405e6584";

export type PodmanFacts = Readonly<{
  version: string;
  rootless: boolean;
  architecture: string;
}>;

export async function assertPodman(
  execute: PodmanExecutor,
): Promise<PodmanFacts>;
```

`assertPodman` runs, in order:

1. `podman version --format {{.Client.Version}}`. A non-zero exit, or a spawn failure,
   throws `RunnerError("unavailable", "podman is not reachable; install podman and, on macOS, run: podman machine start")`.
2. Parse `/^(\d+)\.(\d+)\.(\d+)/`. No match throws
   ``RunnerError("unavailable", `podman reported an unreadable version: ${output}`)``.
3. Compare the triple **numerically** against `minimumPodmanVersion`. Below it throws
   ``RunnerError("unavailable", `podman ${found} is below the tested minimum ${minimumPodmanVersion}`)``.
   This mirrors the `git` rule of `test/helpers/remote/tools.ts:43`.

   `5.0.0` is **ratified by Ulrich on 2026-08-06**, the same standing
   `minimumGitVersion = "2.34.0"` holds at `test/helpers/remote/tools.ts:43`. It is derived
   from the features this EPIC uses: `--internal` networks with a per-pod alias,
   `podman secret` with `type=mount` and `mode=`, label filters on `pod ps`, `volume ls`,
   `secret ls` and `network ls`, and `--network none` on `podman build`. The development
   machine runs client `6.0.0`, so the pin has headroom.

4. `podman info --format {{.Host.Security.Rootless}} {{.Host.Arch}}` fills `rootless` and
   `architecture`.

   **A present binary with a stopped machine reaches this step, not step 1.** Measured on
   the development machine on 2026-08-06: `podman version` prints client `6.0.0` and exits
   zero with no machine running, while `podman info` fails with
   `Cannot connect to Podman … unable to connect to Podman socket`. `assertPodman` therefore
   treats a non-zero `podman info` as the **stopped** case and throws
   `RunnerError("unavailable", "podman is installed but not running; start it with: podman machine start")`.
   Step 1 keeps its own message for an absent binary. The EPIC requires "absent, stopped, or
   below the pinned version" to each fail loudly, and only `podman info` separates absent
   from stopped.

It never runs `podman machine start`. It never calls `t.skip`. Absence is a failure.

### New — `scripts/e2e/lib/podman/provision.ts`

```ts
export type ProvisionResult = Readonly<{
  images: Readonly<{ product: string; fixture: string }>;
  productDigest: string;
  baseDigest: string;
  architecture: string;
}>;

export async function provisionImages(
  execute: PodmanExecutor,
  executeHost: PodmanExecutor,
  runId: string,
): Promise<ProvisionResult>;
```

`execute` issues every `podman` command. `executeHost` issues every `npm` command on the
runner host. The two are separate parameters of the same shape, because the `## Verify`
block asserts which executor each command reached, and because a hermetic unit test fakes
`npm` exactly as it fakes `podman`. `AGENTS.md`'s Tests contract forbids a unit test that
reaches the network, so a real `npm ci` inside `node --test` is not available.

The build is **fully offline**. Nothing inside a `podman build` reaches a registry, a
package mirror or a DNS server.

1. `npm pack --pack-destination <work>` in the repository root. `productDigest` is
   `sha256:` plus the sha256 of that tarball's bytes. This is the product artifact digest.
2. Unpack the tarball into `<work>/product-context/product/`, copy the repository's
   `package-lock.json` into that directory, then run
   `npm ci --omit=dev --prefix <work>/product-context/product` **locally, on the runner
   host**, so the image build copies an already-installed tree. The copy is required:
   `npm pack` excludes `package-lock.json` from the tarball, and `npm ci` refuses to run
   without one. The image build therefore runs no `npm install`, and Story 07's
   Containerfiles reach no network.
3. Copy `scripts/e2e/fixture-remote/` and its `test/helpers/remote/` dependencies into
   `<work>/fixture-context/fixture/`, and `npm ci --omit=dev` there the same way.
4. `podman image inspect --format {{.Id}} <baseImageReference>`. A non-zero exit throws
   ``RunnerError("unavailable", `the base image ${baseImageReference} is not present; run: podman pull ${baseImageReference}`)``.
   `baseDigest` is that id. The base image is **never pulled by the runner**, and it is
   referenced by digest, so the id it resolves to cannot drift.
5. Two builds, each with `--pull=never` **and `--network none`**:
   - `podman build --pull=never --network none --tag kanthord-e2e-product:<runId> --label kanthord-e2e-run=<runId> --file scripts/e2e/podman/product.Containerfile <work>/product-context`
   - `podman build --pull=never --network none --tag kanthord-e2e-fixture:<runId> --label kanthord-e2e-run=<runId> --file scripts/e2e/podman/fixture.Containerfile <work>/fixture-context`
6. `podman image inspect --format {{.Id}}` on each tag gives the content-addressed id.
   `images.product` and `images.fixture` are those ids, never the tags, so the scenario
   consumes content rather than a name.
7. `architecture` comes from `podman image inspect --format {{.Architecture}}` on the
   product image.

`productDigest`, `baseDigest`, `imageId` and `architecture` are four separate bundle notes.
`docs/proposal/phase-1/README.md:98` requires them separate, because an `arm64` pass is not
evidence for another architecture.

### New — `scripts/e2e/lib/podman/reclaim.ts`

```ts
export const runLabel = "kanthord-e2e-run";

export type ReclaimOutcome = Readonly<{ kind: ResourceKind; id: string }>;

export type ReclaimReport = Readonly<{
  reclaimed: readonly ReclaimOutcome[];
  failed: readonly ReclaimOutcome[];
}>;

export async function reclaimByLabel(
  execute: PodmanExecutor,
  runId: string,
): Promise<ReclaimReport>;
```

**An outcome carries its kind, never a bare id.** Podman ids are unique per kind and not
across kinds, so a flat `string[]` cannot say which removal failed. A status encoded into a
string — a `failed:<id>` prefix in the same array as the successes — is not a result type,
and its one caller dropped it.

Issues, in this exact order, each with `--filter label=${runLabel}=${runId}`:

1. `podman rm --force --filter label=... ` over the ids from `podman ps --all --quiet --filter label=...`
2. `podman pod rm --force` over `podman pod ps --quiet --filter label=...`
3. `podman secret rm` over the ids from `podman secret ls --quiet --filter label=...`
4. `podman volume rm --force` over `podman volume ls --quiet --filter label=...`
5. `podman network rm --force` over `podman network ls --quiet --filter label=...`
6. `podman image rm --force` over `podman image ls --quiet --filter label=...`

Containers first, then the pod that held them, then the secrets, the volume, the network
and the images the run built. An empty list for a kind issues no remove command and is not a
failure.

**Removal is verified, never assumed.** A remove command that exits zero is not proof that
every listed id is gone, because the command is filtered rather than enumerated. After the
removes for one kind, `reclaimByLabel` re-lists that kind's label and puts every id still
present into `failed`. Everything absent goes into `reclaimed`.

`reclaimByLabel` itself never throws on a failed removal. It reports. The caller decides,
and the two callers decide differently:

- **`p1-e4.ts`, before creating anything — fails closed.** A non-empty `failed` throws
  ``RunnerError("assertion-failed", `a stale resource survived reclaim: <kind> <id>`)``
  before the run starts. A surviving stale container or volume is ambient state inside a run
  that claims to be hermetic, so the run does not start. This is the one place the EPIC's
  "'Nothing remains after a crash' is not achievable" line does **not** license continuing:
  that line concedes a crash may leave resources, not that a live run may build on them.
- **`--reclaim <tag>`, the explicit operator path — reports and exits non-zero.** It prints
  the report per kind and returns `1` when `failed` is non-empty, so the operator sees what
  is left and what to remove by hand.

The ledger of Story 02 is the success and failure path of a live run; `reclaim` is the crash
path of a dead one.

### Changed — `scripts/e2e/lib/main.ts` — the `--reclaim <tag>` mode

`main` takes `--reclaim <tag>`, which is mutually exclusive with a scenario id and with
`--tag`. It runs `assertPodman`, then `reclaimByLabel(execute, tag)`, prints the report, and
returns `0` or `1`.

It **claims no bundle directory and writes no bundle.** `claimBundleDirectory` refuses a
reused tag, and a stale tag's directory is exactly what a crashed run left behind, so a
reclaim that claimed a directory could never run for the tag it exists to clean. It also
asserts nothing about the product, and a bundle is product evidence. The reclaim report is
the invocation's own output, printed and returned as an exit code.

`--reclaim` is why the EPIC promises manual recovery rather than automatic recovery. A
scenario run reclaims its own tag and no other, because a label filter cannot distinguish a
stale run from a live concurrent one.

### New — `scripts/e2e/lib/podman/readiness.ts`

```ts
export const readinessDeadlineMilliseconds = 30000;
export const readinessIntervalMilliseconds = 250;

export async function pollHealth(
  issue: HttpIssuer,
  target: Readonly<{ token: string; allowedHost: string }>,
): Promise<void>;
```

Polls `GET /v1/health` — `src/http/contract/system.ts:30-37` — with
`Authorization: Bearer <token>` and `Host: <allowedHost>`, every
`readinessIntervalMilliseconds`, until a `200`, to the deadline. `system.health` requires
the token and passes the `Host` and `Origin` checks like every route
(`src/http/server/app.test.ts:21,35`), so the poll carries the right headers or it never
succeeds.

On timeout it throws
``RunnerError("assertion-failed", `the daemon was not healthy within ${readinessDeadlineMilliseconds}ms`)``
after attaching the last response status, the last body and `podman logs` for all three
containers to the bundle. Diagnostics are kept, never discarded.

There is no `setTimeout` sleep anywhere in the scenario path.

### Changed — `scripts/e2e/lib/driver/local.ts`

Use `readinessDeadlineMilliseconds` and `readinessIntervalMilliseconds` for the local
daemon start too, replacing any literal. `test/helpers/daemon.ts:83-89` uses 5000 ms for a
unit test; the e2e path is a separate constant and does not change that helper.

## Constraints

- Every `podman network create` carries `--internal`. Every `podman run` and `podman build`
  carries `--pull=never`, and every `podman build` also carries `--network none`. There is
  no other network in the scenario, and no build step reaches one.
- Every `npm` invocation runs on the runner host, before the first `podman build`. No
  `npm`, `apt-get`, `curl` or `wget` runs inside an image build.
- Every created resource carries `--label kanthord-e2e-run=<runId>`. Cleanup is by label,
  never by name.
- No unit test in this story spawns `podman`. Each drives a fake `PodmanExecutor`.
- The runner never runs `podman machine start`, `podman pull`, `podman login`, or
  `apt-get` outside the image build.

## Verify

`node --test scripts/e2e/lib/podman/preflight.test.ts`

Asserts, with a fake executor:

- `minimumPodmanVersion` equals `"5.0.0"`.
- a version output `5.0.0` and `5.4.1` each pass; `4.9.9` throws `unavailable` with the
  message `podman 4.9.9 is below the tested minimum 5.0.0`.
- a spawn failure on `podman version` throws `unavailable` with a message containing
  `install podman`.
- a **successful** `podman version` of `6.0.0` with a **failing** `podman info` throws
  `unavailable` with the exact message
  `podman is installed but not running; start it with: podman machine start`. This is the
  stopped case, and its message differs from the absent case.
- unreadable output throws `unavailable`.
- `assertPodman` issues no command matching `/^podman machine/` — asserted over the full
  recorded argv list.
- `assertPodman` never resolves without a version, and no code path calls `t.skip`.

`node --test scripts/e2e/lib/podman/provision.test.ts`

- `baseImageReference` matches `/^docker\.io\/library\/node:24-bookworm@sha256:[0-9a-f]{64}$/`.
  A tag with no digest fails this assertion, so the pin cannot drift.
- a missing base image throws `unavailable` naming `podman pull` and the digest-qualified
  reference.
- `provisionImages` issues exactly two `podman build` commands, each with `--pull=never`,
  `--network none`, its own `--file`, and `--label kanthord-e2e-run=R1`.
- `images.product` and `images.fixture` are the inspected ids, not the tags — asserted with
  a fake returning `sha256:abc…` for the inspect and a different string for the tag, and
  the two ids differ.
- `productDigest`, `baseDigest` and `architecture` are three distinct fields, each populated
  from its own source.
- no command matching `/^podman pull/` is issued, and every `npm` command is issued to the
  host executor rather than to `podman`.

`node --test scripts/e2e/lib/podman/reclaim.test.ts`

- `reclaimByLabel(execute, "R1")` issues the six list commands and the six remove
  commands, in the exact order, each carrying `--filter label=kanthord-e2e-run=R1`.
- an empty list for every kind issues the six list commands and no remove command, and
  resolves `{ reclaimed: [], failed: [] }`.
- a stale run: the list commands return ids, the re-list returns empty, and `reclaimed` holds
  `{ kind, id }` for each — asserted as objects, so a bare id fails the case.
- a remove that fails once and succeeds on the repeat resolves with the id in `reclaimed`.
  **Both failure shapes are covered: a thrown executor error, and a non-zero exit code.** The
  retry is load-bearing for a transient `resource busy`, and a version of this loop that
  retried only a thrown error made the non-zero exit invisible — the defect that let a wrong
  `--filter` argv pass a full cycle.
- **a remove that exits zero while the re-list still returns the id puts it in `failed`.**
  This is the verification case: a zero exit is not evidence of absence.
- two kinds returning the same id string produce two distinct outcomes, one per kind. A
  flat id list could not tell them apart.
- `reclaimByLabel` itself throws for no removal failure. The decision belongs to the caller.

`node --test scripts/e2e/lib/scenario/p1-e4.test.ts` — extended:

- a fake in which one stale volume survives reclaim makes `runP1E4` throw
  `assertion-failed` naming the kind and the id, and issues **no** `podman run` afterwards.
  The run fails closed before it creates anything.

`node --test scripts/e2e/lib/main.test.ts` — extended:

- `--reclaim R1` runs `assertPodman` and `reclaimByLabel` for `R1`, and issues no
  `podman run` and no scenario step.
- `--reclaim R1` creates no directory under `.data/` — asserted over a temporary run root
  before and after.
- `--reclaim R1` with a non-empty `failed` returns `1`, and with an empty one returns `0`.
- `--reclaim R1 P1-E4` and `--reclaim R1 --tag t1` each throw `invalid-argument`.

`node --test scripts/e2e/lib/podman/readiness.test.ts`

- `pollHealth` requests `GET /v1/health` with both the `Authorization` and the `Host`
  headers set — read off a recording issuer.
- an issuer answering `503` twice then `200` resolves, and issued exactly three requests.
- an issuer answering `503` forever rejects with `assertion-failed`, and the bundle holds
  the last status and the container logs.
- the scenario path contains no sleep: no file under `scripts/e2e/lib/` other than
  `readiness.ts` contains `setTimeout`, and `readiness.ts` uses it only for the interval —
  asserted by reading the file texts.

`npm run verify` exits 0.

Proof: precondition of `node scripts/e2e/run.mjs P1-E4`, plus one line of its own:

```bash
node scripts/e2e/run.mjs --reclaim <tag-of-a-stale-run> \
  && node scripts/e2e/run.mjs P1-E4 \
  && echo "PASS STORY-09-RECLAIM"
```

It delivers four EPIC coverage lines: the leave-nothing-behind rule together with Story 02,
the explicit `--reclaim <tag>` rule, the pre-run fail-closed rule, and "Podman absent,
stopped, or below the pinned version fails the gate loudly and names the remedy. It never
skips."
