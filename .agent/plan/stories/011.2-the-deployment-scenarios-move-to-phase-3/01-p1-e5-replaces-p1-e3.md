# Story 01 — P1-E5 replaces P1-E3, on the local driver

Epic: `.agent/plan/epics/011.2-the-deployment-scenarios-move-to-phase-3.md`
Depends on: Story 00 (the `integration` mode must exist before a row declares it).

One atomic change. The id, the mode, the driver and the run body move together, because
`scripts/e2e/lib/scenario/index.test.ts:32` asserts the `(mode, driver, profile)` triple per id
and `:45` asserts exactly one `deployment` row. Landing the rename alone leaves a row that
declares `ssh` and a suite that contradicts the proposal.

## Ordering fact — pin this before editing

`"P1-E5"` sorts **after** `"P1-E4"` bytewise (`0x35 > 0x34`).
`scripts/e2e/lib/scenario/index.test.ts:22-30` asserts the registry ids are bytewise ascending.
Every list below is therefore ordered `P1-E1, P1-E2, P1-E4, P1-E5` — the new id is last, and the
`P1-E4` entry moves ahead of it. Do not keep the old third position.

## Change — the five id lists

Each is an independent literal. None derives from another.

1. `scripts/e2e/lib/tag.ts:6` —
   `export type ScenarioId = "P1-E1" | "P1-E2" | "P1-E3" | "P1-E4";`
   becomes
   `export type ScenarioId = "P1-E1" | "P1-E2" | "P1-E4" | "P1-E5";`
2. `scripts/e2e/lib/main.ts:44-49` — `knownScenarioIds` becomes
   `["P1-E1", "P1-E2", "P1-E4", "P1-E5"]`.
3. `scripts/e2e/lib/record/verdict.ts:20-25` — `knownScenarioIds` becomes the same four, same
   order. This is the set the scenario axis requires, so the verdict now demands a `P1-E5`
   bundle.
4. `scripts/e2e/lib/record/acceptance.ts:63-68` — `knownScenarioIds` becomes the same four, same
   order. Here the list is an existence probe only (`:84-91` breaks on the first hit).
5. `scripts/e2e/lib/scenario/index.ts:20-49` — delete the `P1-E3` entry at `:36-40`, and append
   after the `P1-E4` entry:

   ```ts
     {
       id: "P1-E5",
       mode: "integration",
       driver: "local",
       profile: "real",
       run: p1e5.run,
     },
   ```

   Match the shape of the four existing rows exactly. Change the import at
   `scripts/e2e/lib/scenario/index.ts:7` from `./p1-e3.ts` / `p1e3` to `./p1-e5.ts` / `p1e5`,
   and place it so the import order follows the registry order.

## Change — the module rename

- `git mv scripts/e2e/lib/scenario/p1-e3.ts scripts/e2e/lib/scenario/p1-e5.ts`
- `git mv scripts/e2e/lib/scenario/p1-e3.test.ts scripts/e2e/lib/scenario/p1-e5.test.ts`
- Rename the exported symbols `p1e3` → `p1e5` and `runP1E3` → `runP1E5`
  (`scripts/e2e/lib/scenario/p1-e3.ts:129`, `:206-212`).
- Update the declaration at `p1-e5.ts:206-212` to
  `{ id: "P1-E5", mode: "integration", driver: "local", profile: "real", run }`.

## Change — the run body takes the local driver

`scripts/e2e/lib/scenario/p1-e3.ts:164-204` builds an `SshExecutor` and calls
`createSshDriver`. Replace that composition with the local one, mirroring
`scripts/e2e/lib/scenario/p1-e1.ts:7-11`:

```ts
async function run(context: ScenarioContext): Promise<void> {
  const inputs = await checkPrerequisites(context, process.env);
  const driver = await createLocalDriver(context);
  await runP1E5(context, driver, inputs);

  const logs = await driver.collectLogs();
  ...the four disclosure assertions, unchanged in name and order...
}
```

- Delete the `SshExecutor`, the `captured` array and the `sshArgv` helper
  (`p1-e3.ts:26-36`, `:165-171`).
- The disclosure assertions keep their four ids and their order:
  `no-disclosure-bearer-header`, `no-disclosure-config`, `no-disclosure-printed-commands`,
  `no-disclosure-daemon-logs` (`p1-e3.ts:188-203`). The command text they scan now comes from
  `context.commandsRecorded?.() ?? []` joined on `\n`, because there is no captured ssh argv.
  Keep `secretsDisclosed` (`p1-e3.ts:160-162`) unchanged.
- `runP1E5` (`p1-e3.ts:129-158`) keeps every line: `secrets.hold`, `driver.deliverToken`,
  `createRealProfile` with the same credential arguments, and `runJourney`. `createRealProfile`
  is driver-agnostic (`scripts/e2e/lib/profile/real.ts:5-34`), so it needs no edit.

## Change — the prerequisites drop the two hosts

`scripts/e2e/lib/scenario/p1-e3.ts:44-127` — `checkPrerequisites` loses its `execute` parameter
and its host checks. New signature:

```ts
export async function checkPrerequisites(
  context: ScenarioContext,
  env: Readonly<Record<string, string | undefined>>,
  loadEnv: typeof loadE2eEnv = loadE2eEnv,
): Promise<RealInputs>;
```

- Delete the `daemonHost === null` and `clientHost === null` refusals (`:51-57`).
- Delete both ssh pings (`:91-111` in the current body, the two `execute(... ["true"])` calls and
  their `RunnerError("unavailable", …)` branches).
- Keep, unchanged in order: the `KANTHORD_E2E_REAL_PLAN`, `KANTHORD_E2E_REAL_OBJECTIVES` and
  `KANTHORD_E2E_REAL_TASKS` checks, the two positive-integer checks, and the `loadE2eEnv`
  translation of `E2eEnvError` into `RunnerError("unavailable", …)`.
- Add, as the **first** refusal in the function, so a stale invocation fails before anything else:

  ```ts
  if (context.daemonHost !== null || context.clientHost !== null) {
    throw new RunnerError(
      "invalid-argument",
      "P1-E5 runs on one machine and takes no host option",
    );
  }
  ```

## Change — the host guards, in the same cycle

These two edits cannot wait for a later story. `scripts/e2e/lib/main.ts:611` and `:617` compare
`scenario.id !== "P1-E3"`. Once `ScenarioId` drops that member, TypeScript reports the comparison
as having no overlap and `npm run typecheck` fails. The guard change is therefore part of this
story.

`scripts/e2e/lib/main.ts:611-622` — replace

```ts
if (invocation.daemonHost !== null && scenario.id !== "P1-E3") {
  throw new RunnerError(
    "invalid-argument",
    "--daemon-host applies to P1-E3 only",
  );
}
if (invocation.clientHost !== null && scenario.id !== "P1-E3") {
  throw new RunnerError(
    "invalid-argument",
    "--client-host applies to P1-E3 only",
  );
}
```

with

```ts
if (invocation.daemonHost !== null) {
  throw new RunnerError(
    "invalid-argument",
    "--daemon-host belongs to a phase-3 deployment scenario",
  );
}
if (invocation.clientHost !== null) {
  throw new RunnerError(
    "invalid-argument",
    "--client-host belongs to a phase-3 deployment scenario",
  );
}
```

Keep both guards where they are, after the scenario lookup at `scripts/e2e/lib/main.ts:601-603`
and before `claimBundleDirectory` at `:624`, so a refused invocation claims no bundle directory.
`parseArguments` keeps accepting and returning both tokens (`:137-138`, `:162-165`, `:421-426`),
because phase 3 uses them. The exit status stays `2` through `exitCodeFor` on `invalid-argument`.

## Change — the unknown-scenario refusal names the known ids

`scripts/e2e/lib/main.ts:417` (inside `parseArguments`) currently reads
`` `unknown scenario ${scenarioIdCandidate}` ``. The EPIC coverage requires the runner to name
`P1-E5` in its refusal, and the current message names only what the operator typed. Replace the
message with

```ts
`unknown scenario ${scenarioIdCandidate}; known ids are ${knownScenarioIds.join(", ")}`;
```

`knownScenarioIds` is already in scope at `scripts/e2e/lib/main.ts:44-49`, and its new order makes
the rendered text exactly
`unknown scenario P1-E3; known ids are P1-E1, P1-E2, P1-E4, P1-E5`.
Leave the second occurrence at `scripts/e2e/lib/main.ts:607` unchanged: it guards a registry miss
that `parseArguments` already rejected, and it names no id set.

## Change — every message string names P1-E5

Replace the id in each of these literals, text otherwise unchanged:

- `p1-e5.ts` — the former `:61` `` `P1-E3 needs ${name}` ``, `:68`, `:74`, `:85`
  (`` `P1-E3 needs ${…} in .env.e2e` ``). The two host messages at `:53` and `:56` are deleted
  with the host checks above.
- `scripts/e2e/lib/driver/ssh.ts:272` — `` `…; P1-E3 needs a bare machine` `` becomes
  `` `…; P3-E6 needs a bare machine` ``. The ssh driver stays for phase 3.
- `scripts/e2e/007/index.ts:106` — the free-text `goal` string
  `"P1-E3: the ref layout through the route alone"` becomes
  `"P1-E5: the ref layout through the route alone"`. This is a separate registry with its own id
  union; only the text changes.

## Constraints

- `scripts/e2e/lib/driver/ssh.ts` and `scripts/e2e/lib/driver/ssh.test.ts` keep every other line.
  Phase 3 consumes the driver.
- `scripts/e2e/lib/driver/ssh.test.ts:20` sets `scenarioId: "P1-E3"` in its fake context. Change
  it to `"P1-E5"` only because the `ScenarioId` union no longer admits the old value; assert
  nothing new about it.
- Do not touch `createRealProfile`, `runJourney`, or any journey assertion id.

## Verify

- `node --test scripts/e2e/lib/scenario/index.test.ts` — update and assert:
  - `:9-16` `expectedTable` becomes the four rows, with
    `"P1-E5": { mode: "integration", driver: "local", profile: "real" }`.
  - `:18` stays `assert.equal(scenarios.length, 4)`.
  - `:24` becomes `assert.deepEqual(ids, ["P1-E1", "P1-E2", "P1-E4", "P1-E5"])`, and the
    `Buffer.compare` ascending assertion at `:26-29` stays and must pass unchanged.
  - Replace the test at `:45` with two: `exactly one row is mode integration, and it is P1-E5`
    asserting the id string, and `no row is mode deployment` asserting
    `scenarios.filter((s) => s.mode === "deployment").length === 0`.
  - `:53` (no `driver.name` equality check in scenario or profile modules) stays and must pass.
- `node --test scripts/e2e/lib/record/verdict.test.ts` —
  - `:26-31` `allScenarioIds` becomes the four new ids in the new order.
  - `:230-236` the commit-drift case renames to `P1-E5 bundle on commit c2`, mutating
    `writeBundleStub(tag, "P1-E5", …)` and expecting
    `"P1-E5 is on commit c2; the verify record is on c1"`, exit `1`.
  - Add one test `the verdict requires a P1-E5 bundle`: build a complete run, delete the
    `P1-E5` bundle directory, and assert one failure with reason
    `P1-E5 has no bundle under tag t1`, axis `scenario`, code `unavailable`, exit `3`.
- `node --test scripts/e2e/lib/main.test.ts` —
  - `:32-42` becomes a `P1-E5` invocation with **no** host flags, asserting
    `{ scenarioId: "P1-E5", tag: "t1", daemonHost: null, clientHost: null }`.
  - Add `main(['P1-E3']) returns 2 and names every known id`, asserting the return value is `2`
    and the stderr line is exactly
    `e2e: invalid-argument: unknown scenario P1-E3; known ids are P1-E1, P1-E2, P1-E4, P1-E5\n`.
  - Add four host-refusal tests, two ids by two flags, each asserting the return value is `2` and
    the exact stderr line:
    - `main(['P1-E1', '--daemon-host', 'a'])` →
      `e2e: invalid-argument: --daemon-host belongs to a phase-3 deployment scenario\n`
    - `main(['P1-E5', '--daemon-host', 'a'])` → the same line, so the refusal is proved
      id-independent
    - the two `--client-host` twins with the matching message. The client-host refusal has no test
      today; this story adds it.
  - Add `a refused host option claims no bundle directory`: run
    `main(["P1-E5", "--tag", "t1", "--daemon-host", "a"])` inside a temp cwd and assert
    `.data/acceptance-t1/P1-E5` does not exist.
- `node --test scripts/e2e/lib/scenario/p1-e5.test.ts` — the renamed file. Every expected-message
  literal at the former `:134`, `:141`, `:152`, `:163`, `:174`, `:185`, `:196`, `:293`, `:327`
  names `P1-E5`. The fixture `scenarioId` at `:55` becomes `"P1-E5"`. `:824` asserts
  `p1e5.id === "P1-E5"`, `mode === "integration"`, `driver === "local"`, `profile === "real"`.
  Add one test `checkPrerequisites refuses a context carrying a daemon host` asserting
  `RunnerError` code `invalid-argument` and message
  `P1-E5 runs on one machine and takes no host option`, and one for `clientHost`.
  Delete the two ssh-ping tests and the two host-absence tests.
- `node --test scripts/e2e/lib/driver/interface.test.ts` and
  `node --test scripts/e2e/lib/driver/ssh.test.ts` — both stay green with no assertion removed.
- `npm run verify` exits 0.
- Proof: delivers `node scripts/e2e/run.mjs P1-E5 --tag "$TAG"` of the EPIC Proof block.
