# Story 12 — The journey oracle, repaired

Epic: `.agents/plan/epics/016-readiness-applied.md`
Depends on: nothing in this epic. It is dispatched at step 4, **before** the atomic unit that changes import behaviour, so no window exists in which the oracle disagrees with the daemon.

An imported plan will hold a ready frontier, so `runJourney` fails on the first real scenario run without this repair. This epic repairs the oracle it breaks, and no scenario epic owns the repair. The repair is self-contained: every `runJourney` unit test drives a fake CLI that returns canned stdout (`scripts/e2e/lib/scenario/journey.test.ts:49-51`), so this story needs no production change to be green.

## Change

### `scripts/e2e/lib/profile/index.ts`

Add two members to `ScenarioProfile`, immediately after `expectedTaskCount` at `scripts/e2e/lib/profile/index.ts:10`:

```ts
expectedPendingTaskCount: number;
expectedReadyTaskCount: number;
```

Add the two names to `profileFieldNames` at `:15-25`, in the same position — after `"expectedTaskCount"` at `:22` and before `"fixtureRoot"` at `:23`.

### `scripts/e2e/lib/scenario/journey.ts`

`parseStatusCounts` at `scripts/e2e/lib/scenario/journey.ts:62-89` loses `tasksAllPending` and gains a task-state map.

```ts
function parseStatusCounts(stdout: string): Readonly<{
  objectiveCount: number;
  taskCount: number;
  taskStates: Readonly<Record<string, number>>;
}> {
  let objectiveCount = 0;
  let taskCount = 0;
  const taskStates: Record<string, number> = {};

  for (const match of stdout.matchAll(
    /^kanthord: node (\S+) (\S+) (\S+) (\d+)$/gm,
  )) {
    const kind = match[1];
    const state = match[2] as string;
    const count = Number(match[4]);
    if (kind === "objective") {
      objectiveCount += count;
    }
    if (kind === "task") {
      taskCount += count;
      taskStates[state] = (taskStates[state] ?? 0) + count;
    }
  }

  return { objectiveCount, taskCount, taskStates };
}
```

Keep the regex byte for byte. It holds four groups over the five-field line `kanthord: node <kind> <state> <blockReason|-> <count>` that `src/cli/status.ts:30` prints; `match[3]` stays unread. One key exists per observed task state, and a state the daemon never printed is absent from the map rather than zero.

The `status-counts` assertion at `:387-401` becomes:

```ts
const expectedTaskStates: Record<string, number> = {};
if (profile.expectedPendingTaskCount > 0) {
  expectedTaskStates["pending"] = profile.expectedPendingTaskCount;
}
if (profile.expectedReadyTaskCount > 0) {
  expectedTaskStates["ready"] = profile.expectedReadyTaskCount;
}

context.assert(
  "status-counts",
  {
    exitCode: 0,
    objectiveCount: profile.expectedObjectiveCount,
    taskCount: profile.expectedTaskCount,
    taskStates: expectedTaskStates,
  },
  {
    exitCode: firstStatusRecord.exitCode,
    objectiveCount: firstStatusCounts.objectiveCount,
    taskCount: firstStatusCounts.taskCount,
    taskStates: firstStatusCounts.taskStates,
  },
);
```

The two existing counts stay beside the map. The `status-unchanged` assertion at `:420-424` stays word for word; `run` still answers `not-implemented` and writes nothing.

**Zero is a legal count, and a zero-valued key is omitted from both sides.** `kanthord status` prints no line for a state that holds no node, so `parseStatusCounts` returns a map with that key absent rather than set to `0`. The expected map is built the same way, by the two `if` guards above. A plan whose tasks are all pending, or all ready, therefore compares equal. Building the expected map unconditionally would make `{ pending: 4, ready: 0 }` fail against `{ pending: 4 }`.

### Every `ScenarioProfile` literal

Each of these six literals gains `expectedPendingTaskCount` and `expectedReadyTaskCount`, placed after `expectedTaskCount`.

| file:line                                      | value                                                      |
| ---------------------------------------------- | ---------------------------------------------------------- |
| `scripts/e2e/lib/profile/fixture.ts:133`       | `expectedPendingTaskCount: 2`, `expectedReadyTaskCount: 2` |
| `scripts/e2e/lib/profile/real.ts:30`           | pass through from `input`                                  |
| `scripts/e2e/lib/scenario/p1-e4.ts:276`        | `expectedPendingTaskCount: 2`, `expectedReadyTaskCount: 2` |
| `scripts/e2e/lib/scenario/p1-e4.test.ts:68`    | `expectedPendingTaskCount: 2`, `expectedReadyTaskCount: 2` |
| `scripts/e2e/lib/scenario/journey.test.ts:160` | `expectedPendingTaskCount: 2`, `expectedReadyTaskCount: 2` |
| `scripts/e2e/lib/scenario/p1-e5.test.ts:296`   | `expectedPendingTaskCount: 2`, `expectedReadyTaskCount: 2` |

**The two-objective fixture plan holds four tasks, two pending and two ready.** `test/e2e/fixtures/two-objective/plan/journey/alpha/02-second.md` and `.../beta/02-second.md` each carry `depends_on`; `alpha/01-first.md` and `beta/01-first.md` carry none. No objective of that fixture carries `depends_on`, so both objectives are `ready` and `expectedObjectiveCount` stays `2`.

### The real-profile input path

`createRealProfile` at `scripts/e2e/lib/profile/real.ts:5-32` takes an input object at `:8-15`. Add `expectedPendingTaskCount: number` and `expectedReadyTaskCount: number` to it, after `expectedTaskCount` at `:13`, and pass both through to the returned profile.

`RealInputs` at `scripts/e2e/lib/scenario/p1-e5.ts:31-38` gains the same two members after `expectedTaskCount` at `:36`. `checkPrerequisites` parses them from two new environment names, in the pattern of `KANTHORD_E2E_REAL_TASKS` at `scripts/e2e/lib/scenario/p1-e5.ts:98`:

- `KANTHORD_E2E_REAL_PENDING_TASKS` → `expectedPendingTaskCount`
- `KANTHORD_E2E_REAL_READY_TASKS` → `expectedReadyTaskCount`

Add both names to the required-name list `checkPrerequisites` validates, and add both to the `createRealProfile` call at `scripts/e2e/lib/scenario/p1-e5.ts:146`.

**Validate the two new names with a nonnegative check, not `isPositiveInteger`.** `isPositiveInteger` at `scripts/e2e/lib/scenario/p1-e5.ts:25-27` tests `/^[1-9]\d*$/` and therefore rejects `0`. A real plan whose tasks are all pending has `KANTHORD_E2E_REAL_READY_TASKS=0`, which is legal. Add a sibling helper beside it:

```ts
function isNonNegativeInteger(value: string | undefined): boolean {
  return value !== undefined && /^(0|[1-9]\d*)$/.test(value);
}
```

Use `isNonNegativeInteger` for `KANTHORD_E2E_REAL_PENDING_TASKS` and `KANTHORD_E2E_REAL_READY_TASKS` only. Leave `isPositiveInteger` and its existing callers unchanged; an objective count and a task count of zero remain illegal.

Assert in `scripts/e2e/lib/scenario/p1-e5.test.ts` that `KANTHORD_E2E_REAL_READY_TASKS=0` is accepted and that `KANTHORD_E2E_REAL_READY_TASKS=-1` and `KANTHORD_E2E_REAL_READY_TASKS=x` are each refused.

`.agents/plan/epics/016-readiness-applied.md:58` names four files. The EPIC's own hermetic bullet at `:108` requires **every** `ScenarioProfile` literal in `scripts/e2e/`, so `real.ts`, `p1-e5.ts` and `p1-e5.test.ts` are in scope as well.

## Constraints

- Do not change `kanthord status` output. `src/cli/status.ts:28-31` stays byte for byte. This story asserts a count, not a frontier list, because `status` prints counts.
- Do not change the `parseStatusCounts` regex and do not read `match[3]`.
- Do not change the `status-unchanged` assertion.
- Do not change `expectedObjectiveCount` anywhere. Both fixture objectives are `ready` and the count is state-independent.
- Do not add a third state key to the asserted map. The fixture plan yields `pending` and `ready` only.
- `scripts/e2e/lib/scenario/**` may not import `node:child_process`. `eslint.config.js:400-420` enforces it.

## Verify

- `scripts/e2e/lib/profile/profile.test.ts`: add `"expectedPendingTaskCount"` and `"expectedReadyTaskCount"` to `expectedFieldNames` at `:17-27`, after `"expectedTaskCount"`. The key-list test then fails if a profile literal omits either name. Add `assert.equal(profile.expectedPendingTaskCount, 2)` and `assert.equal(profile.expectedReadyTaskCount, 2)` beside `:104-105`. Update the two real-profile input literals at `:209-210` and `:244-245` with the two new members, and keep the same-key-set test at `:219-252` passing.
- `scripts/e2e/lib/scenario/journey.test.ts`: change the fake `status --project` stdout at `:49-51` from three `pending` lines to four lines:

  ```
  "kanthord: node initiative ready - 1\n" +
  "kanthord: node objective ready - 2\n" +
  "kanthord: node task pending - 2\n" +
  "kanthord: node task ready - 2\n";
  ```

  The suite then drives one status output that holds a `pending` task line and a `ready` task line, and `runJourney` asserts both counts.

- `scripts/e2e/lib/scenario/journey.test.ts`: add a test in the pattern of `:766-781`. Build `brokenProfile = { ...fixture.profile, expectedReadyTaskCount: 3 }`, call `runJourney`, and assert it rejects with a `RunnerError` whose `code` is `"assertion-failed"` and whose `message` is `"status-counts"`. Add the mirror case for `expectedPendingTaskCount: 3`.
- `scripts/e2e/lib/scenario/journey.test.ts`: the seventeen-named-assertion order test at `:528` keeps the same seventeen names. `status-counts` is renamed nowhere.
- Three fake `status --project` stdout fixtures print four `pending` tasks today and must print two `pending` and two `ready`. Replace each with exactly this value:

  ```
  kanthord: node objective ready - 2
  kanthord: node task pending - 2
  kanthord: node task ready - 2
  ```

  The three sites are `scripts/e2e/lib/scenario/p1-e4.test.ts:280`, `scripts/e2e/lib/scenario/p1-e5.test.ts:556` and — with the initiative line of `journey.test.ts:49` kept — `scripts/e2e/lib/scenario/journey.test.ts:49-51`. A fixture left at `task pending - 4` makes `runJourney` reject with `status-counts`.

- `grep -rn "tasksAllPending" scripts/` returns nothing. `parseStatusCounts` exports no such member, and no consumer names it.
- `node --test scripts/e2e/lib/profile/profile.test.ts scripts/e2e/lib/scenario/journey.test.ts scripts/e2e/lib/scenario/p1-e4.test.ts scripts/e2e/lib/scenario/p1-e5.test.ts` exits 0.
- `npm run typecheck` exits 0. A profile literal that omits either new member fails it.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-016`, through `scripts/e2e/lib/profile/profile.test.ts` and `scripts/e2e/lib/scenario/journey.test.ts`. Hermetic coverage: `.agents/plan/epics/016-readiness-applied.md:107` and `:108`.
