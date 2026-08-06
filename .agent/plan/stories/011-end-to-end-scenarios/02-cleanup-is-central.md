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

- No file under `scripts/e2e/lib/scenario/` may contain the text `releaseAll`, `rm(`,
  `kill(`, `podman rm`, `podman pod rm`, `podman network rm` or `podman volume rm`. Every
  teardown is a `release()` closure handed to `take` at the moment the resource is created.
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

- the file text contains none of the eight forbidden tokens listed in Constraints.
- `ScenarioContext` has no `releaseAll` key — asserted structurally over a constructed
  context object with `Object.hasOwn`.

`npm run verify` exits 0.

Proof: precondition of every `node scripts/e2e/run.mjs <id>` line, and of the EPIC coverage
line "P1-E4 leaves no container, no pod, no Podman network and no volume carrying its run
id, after a failing run as well as a passing one".
