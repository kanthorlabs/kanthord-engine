# Story 02 — Cleanup is central

Epic: `.agent/plan/epics/011-end-to-end-scenarios.md`
Depends on: Story 01.

## Change

### New — `scripts/e2e/lib/resources.ts`

```ts
export type ResourceKind =
  | "directory"
  | "home"
  | "lock"
  | "process"
  | "container"
  | "pod"
  | "network"
  | "volume";

export type Resource = Readonly<{
  kind: ResourceKind;
  id: string;
  release(): Promise<void>;
}>;

export type ResourceHandle = Readonly<{ kind: ResourceKind; id: string }>;

export type ResourceFailure = Readonly<{
  kind: ResourceKind;
  id: string;
  reason: string;
}>;

export type Ledger = Readonly<{
  take(resource: Resource): void;
  taken(): readonly ResourceHandle[];
}>;

export type LedgerResult<T> = Readonly<{
  value: T;
  failures: readonly ResourceFailure[];
}>;

export function createLedger(): Ledger & {
  releaseAll(): Promise<readonly ResourceFailure[]>;
};

export async function withLedger<T>(
  body: (ledger: Ledger) => Promise<T>,
): Promise<LedgerResult<T>>;
```

Behaviour, pinned:

- `take` appends. `taken()` returns the handles in take order, `kind` and `id` only.
- `releaseAll` releases in **reverse take order**, LIFO, one at a time, never concurrently.
  A container is taken after the pod that holds it, so the container is released first.
- A `release()` that rejects is caught. `releaseAll` appends
  `{ kind, id, reason: String(error) }` and continues to the next resource. It never throws
  and it never stops early.
- `releaseAll` is idempotent: a second call releases nothing and returns an empty array.
- `withLedger` runs `body(ledger)` inside `try`, calls `releaseAll` in `finally`, and
  resolves `{ value, failures }`. When `body` rejects, `withLedger` still releases, then
  assigns the failures onto the error as a `cleanupFailures` own property and rethrows that
  same error. The cause is never replaced, and the failures are never lost — `main` reads
  `error.cleanupFailures` when it builds the failure bundle.

  ```ts
  export type WithCleanupFailures = Error & {
    cleanupFailures?: readonly ResourceFailure[];
  };
  ```

- `withLedger` installs one `SIGINT` and one `SIGTERM` handler through
  `process.once(signal, handler)`, keeping a reference to each. The handler calls
  `releaseAll`, then `process.removeListener(signal, handler)`, then
  `process.kill(process.pid, signal)`, so the process dies of the signal it was sent.
  `removeListener` with the exact handler reference, never `removeAllListeners`, which would
  destroy a listener the runner did not install. Both handlers are removed the same way in
  the `finally`, before `withLedger` returns.

### New — `scripts/e2e/lib/scenario/context.ts`

```ts
export type ScenarioContext = Readonly<{
  tag: string;
  scenarioId: ScenarioId;
  bundleDirectory: string;
  take: Ledger["take"];
  sink: CommandSink;
  assert(name: string, expected: unknown, actual: unknown): void;
  daemonHost: string | null;
  clientHost: string | null;
}>;
```

`ScenarioContext` exposes `take` and never `releaseAll`. That is the "asserted by
construction" mechanism: a scenario has no way to release anything.

### New — two directory helpers in `scripts/e2e/lib/resources.ts`

```ts
export async function takeTemporaryDirectory(
  context: Pick<ScenarioContext, "take">,
  prefix: string,
): Promise<string>;

export function takeDirectory(
  context: Pick<ScenarioContext, "take">,
  path: string,
): void;
```

`takeTemporaryDirectory` mkdtemps `join(tmpdir(), prefix)`, takes the result, and returns it.
`takeDirectory` adopts a path the caller already created. **They are two functions, not one
with an optional argument**, because creation and adoption are different claims of ownership
and one signature that does both lets a caller register a directory it does not own.

`resources.ts` is the **only** module in the harness that removes a directory tree. A
scenario therefore names no removal at all: it asks for a directory and the ledger owns the
rest.

`.agent/plan/epics/011-end-to-end-scenarios.md:26` is what requires this. "A scenario
declares what it took; it never carries its own teardown path, because a teardown restated
per scenario is a teardown that one scenario forgets." A `release()` closure written inside a
scenario **is** a teardown path, even though the ledger is what invokes it. The ledger
centralizes when a teardown runs; these helpers centralize what it does. The three scenario
files each held a byte-identical copy of one `rm` closure, which is exactly the restatement
that line forbids.

### New — `takeImage` and `removeTree` in `scripts/e2e/lib/resources.ts`

```ts
export function takeImage(
  context: Pick<ScenarioContext, "take">,
  execute: PodmanExecutor,
  id: string,
): void;

export async function removeTree(path: string): Promise<void>;
```

`takeImage` takes the image with kind `image`, releasing it with
`podman image rm --force <id>`. `p1-e4.ts` calls it twice, for the product image and the
fixture image, replacing the two `release()` closures it holds today. Those two closures are
the last teardown written inside a scenario file.

`removeTree(path)` is `rm(path, { recursive: true, force: true })` and nothing else.
`provision.ts` calls it in the same `finally` where it calls `rmSync` today.

**The invariant, stated exactly.** Three modules under `scripts/e2e/lib/**` may remove
something, and no other may:

- `resources.ts` — every directory tree, through `removeTree` and the ledger.
- `driver/**` — a driver owns the host it drives, and removal there is that host's teardown.
- `secret-file.ts` — one `unlink` of one secret file, inside its own release closure.

Everything else reaches removal through `resources.ts`. The earlier phrasing, "resources.ts is
the only module in the harness that removes a directory tree", was too strong to be true and
too strong to be enforceable: a glob written against it fails `driver/local.ts` and
`secret-file.ts`, which break no rule. A rule that fails an innocent file gets disabled, so
the three exemptions are named here rather than discovered at lint time.

**`provision.ts` keeps its prompt deletion and does not join the ledger.** Its scratch
directory holds an `npm pack` tarball and two installed `node_modules` trees, and it is
already dead the moment the two image builds finish. A ledger-held directory lives until the
run ends, so taking it would hold hundreds of megabytes for the length of a P1-E4 run to buy
nothing. The invariant is about which module removes a tree, not about which resources the
ledger owns.

`assert(name, expected, actual)` records an assertion result through the bundle writer of
Story 03 and throws `RunnerError("assertion-failed", name)` on inequality, compared with
`node:assert/strict.deepStrictEqual` semantics.

### Changed — `scripts/e2e/lib/main.ts`

Wrap the scenario invocation:

```ts
const { failures } = await withLedger(async (ledger) =>
  scenario.run(context(ledger)),
);
```

A non-empty `failures` array is written into the bundle under `cleanupFailures` and makes
`main` return `1`, because a resource the runner could not release is a failed run.

## Constraints

- **No file under `scripts/e2e/lib/scenario/` may import a removal function, and none may
  import `node:child_process`.** This is an `eslint.config.js` `no-restricted-imports` entry
  on the `scripts/e2e/lib/**` glob, ignoring `resources.ts`, `secret-file.ts` and `driver/**`
  — the three modules named above — in the same shape as the `domain/` purity rule, so
  `npm run lint` fails on a violation. The glob covers the whole harness rather than
  `scenario/**` alone, because `provision.ts` proved a second remover can appear anywhere.
  `node:child_process` stays banned on `scenario/**` only: a driver spawns by definition. Removal and process control reach a scenario only
  through `resources.ts` and the driver.

  **The ban is by imported name, not by module.** `paths` entries carry `importNames`:
  `rm`, `rmSync`, `rmdir`, `rmdirSync`, `unlink`, `unlinkSync` from `node:fs`, and `rm`,
  `rmdir`, `unlink` from `node:fs/promises`. `node:child_process` is banned whole, because a
  scenario has no legitimate use for it. A blanket ban on `node:fs` would be wrong: a scenario
  reads the file system legitimately, and `journey.ts` (`readFile`, `readdir`), `p1-e2.ts`
  (`mkdir`), `p1-e3.ts` (`readFile`) and `scenario/tools.ts` (`accessSync`) each break no
  rule. `importNames` matches the **imported binding**, so `import { rm as removeTree }` is
  caught by the same entry — the rename the old text scan could not see.

  **A forbidden-substring test cannot carry this rule.** A text scan for `rm(` is defeated by
  `import { rm as anything }`, which is a rename the scan cannot see and a linter resolves.
  A rule with no mechanism is a rule a reviewer applies inconsistently, and this one had a
  mechanism that looked sound and enforced nothing.

- No file under `scripts/e2e/lib/scenario/` may contain the text `releaseAll`, `podman rm`,
  `podman pod rm`, `podman network rm` or `podman volume rm`. These five are literal argv
  strings rather than identifiers, so no import rename reaches them and a text scan is the
  right mechanism. Every teardown is a `release()` closure handed to `take` at the moment the
  resource is created, and every such closure lives in `resources.ts` or a driver.
- A resource is taken **immediately after** it exists, in the same statement group that
  created it. Never at the end of a setup block.
- `withLedger` must not swallow the body's rejection. A cleanup failure never replaces the
  cause.

## Verify

`node --test scripts/e2e/lib/resources.test.ts`

Asserts:

- take order `[a, b, c]` releases in order `c, b, a` — a shared array records each id.
- a rejecting `release()` on `b` still releases `a`, and `releaseAll` resolves
  `[{ kind: "process", id: "b", reason: "Error: boom" }]`.
- `releaseAll` called twice releases each resource once.
- `withLedger` with a body that resolves `7` returns `{ value: 7, failures: [] }` and the
  resources are released.
- `withLedger` with a body that throws rethrows that exact error object — asserted with
  `assert.equal(caught, thrown)` — and the resources are still released.
- `withLedger` with a body that throws **and** a failing `release()` rethrows the body's
  error carrying `cleanupFailures` with the one failure. The cleanup failure never replaces
  the cause.
- a pre-installed foreign `SIGINT` listener survives `withLedger` — asserted by installing
  one before, and finding it still in `process.listeners("SIGINT")` after.
- `taken()` returns `[{ kind, id }]` shape only, and holds no `release` key.
- after `withLedger` resolves, `process.listenerCount("SIGINT")` and
  `process.listenerCount("SIGTERM")` are each back to the count captured before the call.

`node --test scripts/e2e/lib/scenario/discipline.test.ts`

Asserts, over every file matched by `scripts/e2e/lib/scenario/*.ts` excluding
`*.test.ts`:

- the file text contains none of the five forbidden argv strings listed in Constraints.
- `ScenarioContext` has no `releaseAll` key — asserted structurally over a constructed
  context object with `Object.hasOwn`.

`node --test scripts/e2e/lib/resources.test.ts` — extended:

- `takeTemporaryDirectory(context, "kanthord-e2e-x-")` creates a directory that exists, takes
  it with kind `directory`, and `releaseAll` removes it.
- `takeDirectory` takes a caller-created path without creating anything, and `releaseAll`
  removes it.
- a release on an already-removed directory does not fail, and produces no
  `ResourceFailure` — a scenario that removed nothing must not fail a run.

`npm run lint` — the mechanism, not a test:

- an `import { rm } from "node:fs/promises"` added to any file under
  `scripts/e2e/lib/scenario/` fails lint. So does `import { rm as removeTree }`, and so does
  `import { spawn } from "node:child_process"`. The rename is what the previous mechanism
  missed, and a linter resolves a rename by construction.
- an `import { readFile } from "node:fs/promises"` in the same directory passes lint. The rule
  bans removal, not file access, and a rule that fails an innocent file gets disabled.
- an `import { rmSync } from "node:fs"` added to `scripts/e2e/lib/podman/provision.ts` fails
  lint. The same import passes in `resources.ts`, in `secret-file.ts` and in `driver/local.ts`,
  which are the three named exemptions. The chokepoint is enforced rather than agreed, and the
  exemptions are enumerated rather than implied.

`node --test scripts/e2e/lib/resources.test.ts` — extended for `takeImage` and `removeTree`:

- `takeImage(context, execute, "sha256:abc")` takes one handle of kind `image` with that id,
  and `releaseAll` issues exactly `podman image rm --force sha256:abc` — asserted over a
  recording executor.
- `removeTree` on a populated temporary directory leaves it absent, and `removeTree` on a
  path that does not exist resolves without throwing.

`node --test scripts/e2e/lib/scenario/p1-e4.test.ts` — amended:

- the two image handles still appear in `context.takenResources()` with the same two ids, and
  the file `p1-e4.ts` contains no `release(` at all. The existing image-handle case keeps its
  assertions; only the seam that produced them changes.

`node --test scripts/e2e/lib/podman/provision.test.ts` — amended:

- the scratch directory is absent after `provisionImages` resolves, and absent after it
  rejects. Prompt deletion is the behaviour being preserved, so it is asserted on both paths.

`npm run verify` exits 0.

Proof: precondition of every `node scripts/e2e/run.mjs <id>` line, and of the EPIC coverage
line "P1-E4 leaves no container, no pod, no Podman network and no volume carrying its run
id, after a failing run as well as a passing one".
