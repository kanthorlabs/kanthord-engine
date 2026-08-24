# Story 13 — The harness loop, written once

Epic: `.agents/plan/epics/020-wiring-and-scenarios.md`
Depends on: Story 10.

All three scenarios drive the same loop, and a loop restated per scenario is a second specification that drifts.

## Change

### A new `scripts/e2e/lib/scenario/harness.ts`

Export three functions and their input records.

```ts
export type HarnessIdentity = Readonly<{
  actorId: string;
  tokenFile: string;
  role: HostRole;
}>;

export async function registerHarness(
  driver: ExecutionDriver,
  role: HostRole,
  name: string,
): Promise<HarnessIdentity>;
```

`registerHarness` calls `driver.registerActor(role, name)` and returns the actor id, the token file and the role. It returns no token.

```ts
export type HarnessTaskResult = Readonly<{
  fence: number;
  runId: string;
  attemptNo: number;
  objectId: string;
}>;

export async function runHarnessTask(
  context: ScenarioContext,
  driver: ExecutionDriver,
  identity: HarnessIdentity,
  input: Readonly<{ nodeId: string; objectId: string; label: string }>,
): Promise<HarnessTaskResult>;
```

It runs exactly three commands through `driver.cliAs(identity.role, …)`, each with `--api-token-file identity.tokenFile`, in this order:

1. `node claim --id <nodeId>` — parse the fence, the run id and the attempt number from stdout.
2. `node heartbeat --id <nodeId> --fence <fence>` — the fence is unchanged by a heartbeat.
3. `node report --id <nodeId> --outcome accepted --object-id <objectId> --fence <fence>`.

It records one assertion per step through `context.assert`, each name prefixed by `input.label` so two tasks never collide:

```text
<label>-claim-status
<label>-claim-attempt
<label>-heartbeat-status
<label>-report-status
```

Each asserts the command exit code is `0`, except `<label>-claim-attempt`, which asserts the parsed attempt number.

```ts
export async function attestObjective(
  context: ScenarioContext,
  driver: ExecutionDriver,
  identity: HarnessIdentity,
  input: Readonly<{
    nodeId: string;
    fence: number;
    objectId: string;
    label: string;
  }>,
): Promise<void>;
```

It runs `node attest --id <nodeId> --fence <fence> --object-id <objectId>` and records `<label>-attest-status`.

Export the ordered assertion names each function emits, as a function of the label, so `scripts/e2e/lib/scenario/assertions.ts` composes an exact list:

```ts
export function harnessTaskAssertionNames(label: string): readonly string[];
export function attestAssertionNames(label: string): readonly string[];
```

### A new `scripts/e2e/lib/scenario/harness.test.ts`

Suite name `"scripts/e2e/lib/scenario/harness.test"`. Drive every case over a fake driver that records argv and returns canned stdout. Cases:

- `it("registerHarness returns the actor id and the token file and no token", ...)` — assert `Object.keys(result)` deep-equals `["actorId", "tokenFile", "role"]`.
- `it("runHarnessTask issues claim, heartbeat and report in that order", ...)` — assert the three recorded argv arrays, in order, each carrying `--api-token-file` with the identity's path.
- `it("runHarnessTask returns the fence, run id, attempt number and object id it parsed", ...)` — assert the exact record against a canned stdout.
- `it("runHarnessTask records its four assertion names in order", ...)` — assert the recorded names deep-equal `harnessTaskAssertionNames("alpha-1")`.
- `it("attestObjective sends the fence and the object id", ...)` — assert the recorded argv.
- `it("two labels produce two disjoint name sets", ...)` — assert no name collides.

## Constraints

- **It takes no teardown path.** `011-end-to-end-scenarios.md:26` makes cleanup central to the runner. The module names no `podman rm` and no `releaseAll`, which `scripts/e2e/lib/scenario/discipline.test.ts` already enforces over every file in this directory.
- It reads no token file's contents and returns no token.
- It opens no database, imports no `src/` service and calls no internal function. It drives the CLI only, per `docs/proposal/README.md:110`.
- It parses stdout. It never reads the daemon's file system.

## Verify

- `node --test scripts/e2e/lib/scenario/harness.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `scripts/e2e/lib/scenario/harness.test.ts`.
