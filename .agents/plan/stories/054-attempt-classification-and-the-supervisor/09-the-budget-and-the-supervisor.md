# Story 9 — The budget and the supervisor

Epic: `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md`
Depends on: Story 6 (`06-the-evidence-union-and-the-classifiers`), for `InternalEvidence` and
`Termination`, which the interface names in its own signatures.
Kind: story-foundation

This story changes no drawn path, so it carries no `Diagrams:`, no `Baselines:` and no `Seams:` line.

Every path it edits is allowed to one engineer lane by `scripts/lane-check.sh`, so it declares no
`Executor:` and no `Paths:` line. **`eslint.config.js` needs no edit**:
`eslint.config.js:133` — `src/services/*` classifies a service by glob and captures the capability
name, so a new capability directory is admitted by construction.

**`ambiguousBudget` refuses a negative value and admits zero**, so its format is
`nonNegativeInteger` and not the `positiveInteger` that `attemptLimit` carries. The epic's Decisions
state `ambiguousBudget = 0` converts the first ambiguous termination, so zero is a configured value
and not an error. `eslint.config.js` is irrelevant here;
`src/services/config/convict.ts:56` — `nonNegativeInteger` already exists and is already registered
at `src/services/config/convict.ts:356`, so no new format function is written.

**The refusal code is `config-invalid`, not `config-refused`.** Every convict format failure is
caught at `src/services/config/convict.ts:398` — `config.validate` and rethrown as
`ConfigError("config-invalid", ...)`, and `attemptLimit` is the shipped precedent —
`src/services/config/convict.test.ts:388` — `config-invalid — attemptLimit validation` asserts exactly
that. `src/services/config/refusals.ts:29` — `assertStartable` holds the `config-refused` rules, and
none of them is about an integer range. A budget rule added there would put one integer refusal in a
different place from every other.

## Change

### 1 — `src/services/config/index.ts` — one setting

**Add one field to `src/services/config/index.ts:28`** — `Settings`, immediately after
`src/services/config/index.ts:34` — `attemptLimit`:

```ts
ambiguousBudget: number;
```

Position is load-bearing: `src/services/config/convict.test.ts:104` — `Settings key order` asserts the
key order of the returned object by value, and case 4 moves that literal.

### 2 — `src/services/config/convict.ts` — the schema entry, the env coercion and the extraction

**Add one schema entry to `src/services/config/convict.ts:154`** — `buildSchema`, after
`src/services/config/convict.ts:241` — the closing brace of `attemptLimit`:

```ts
    ambiguousBudget: {
      format: "nonNegativeInteger",
      default: 2,
      env: "KANTHORD_AMBIGUOUS_BUDGET",
    },
```

**Add one entry to `src/services/config/convict.ts:363`** — `idempotencyEnvIntegers`, after
`src/services/config/convict.ts:371` — `KANTHORD_ATTEMPT_LIMIT`:

```ts
      ["KANTHORD_AMBIGUOUS_BUDGET", "ambiguousBudget"],
```

**Without that entry a non-numeric env value passes through as a string.**
`src/services/config/convict.ts:377` — the loop calls
`src/services/config/convict.ts:62` — `parseEnvInteger`, which returns `NaN` for anything but an
optionally signed run of digits, and `NaN` then fails the format. An env var declared in the schema
and absent from this list is the shipped hole the loop exists to close.

**Add one extraction to `src/services/config/convict.ts:511`** — the returned `settings`, after
`src/services/config/convict.ts:537` — `attemptLimit`:

```ts
        ambiguousBudget: config.get("ambiguousBudget") as number,
```

**Nothing is added to `src/services/config/refusals.ts`.** `StartableInput` gains no member, and
`assertStartable` gains no rule.

**`src/main.ts` is not edited here.** No command consumes `ambiguousBudget` until EPIC 054.1, and
`settings.attemptLimit` reaches `claimNode` at `src/main.ts:570` — `attemptLimit` because that command
already takes it. Wiring a value into a dependency object nothing reads would be a change no case
could assert.

### 3 — `src/services/supervisor/index.ts` — the interface

**Create `src/services/supervisor/index.ts`**, in the shape of
`src/services/agent/index.ts:32` — `Agent`:

```ts
import type {
  InternalEvidence,
  Termination,
} from "../../domain/termination.ts";

export type {
  InternalEvidence,
  Termination,
} from "../../domain/termination.ts";

export type LaunchRequest = Readonly<{
  runId: string;
  attemptId: string;
  worker: string;
  workspacePath: string;
  timeoutMs: number;
}>;

export type WorkerHandle = Readonly<{ runId: string; attemptId: string }>;

export type LaunchedWorker = Readonly<{
  handle: WorkerHandle;
  startedAt: number;
}>;

export type ClassifyInput = Readonly<{
  evidence: InternalEvidence;
  ambiguousUsed: number;
  ambiguousBudget: number;
}>;

export type SupervisorErrorCode = "not-implemented";

export class SupervisorError extends Error {
  readonly code: SupervisorErrorCode;
  constructor(code: SupervisorErrorCode, message: string) {
    super(message);
    this.name = "SupervisorError";
    this.code = code;
  }
}

export interface Supervisor {
  launch(request: LaunchRequest): Promise<LaunchedWorker>;
  observe(handle: WorkerHandle): Promise<InternalEvidence>;
  classify(input: ClassifyInput): Termination;
}
```

**`WorkerHandle` names a run and an attempt, and carries no pid.**
`../docs/workflow/worker.md:483` — `another machine` states a later worker runs elsewhere, and the
epic's Decisions require the interface to admit that without a signature change. A `pid` member would
be the field a remote implementation could not fill.

**`launch` and `observe` are asynchronous and `classify` is not.** The first two do I/O — spawning a
process tree and waiting on its termination —
per `../docs/workflow/worker.md:481` — `separate process`. `classify` takes the observation and two
numbers and returns a value.

**`classify` is on the interface and not left to the two domain functions.** It composes
`classifyInternal` with `convertOnExhaustion`, and it belongs to the supervisor because a remote
supervisor is what observed the termination: the daemon cannot see a process on another machine, so
the component that classifies has to be the component that observed.
`../docs/workflow/worker.md:465` — `supervisor` states that directly.

**`SupervisorErrorCode` holds one code.** `AgentErrorCode` at
`src/services/agent/index.ts:21` — `AgentErrorCode` holds a second, `"agent-timeout"`, because an
implementation raises it. No implementation of this interface exists, so a second code here would be
a value nothing throws.

**The interface holds no implementation.**
`src/domain/layout.test.ts:166` — `no src/services/*/index.ts contains an implementation` scans every
service `index.ts` for the string `implements ` and refuses it.

### 4 — `src/services/supervisor/not-implemented.ts` — the throwing implementation

**Create `src/services/supervisor/not-implemented.ts`**, mirroring
`src/services/agent/not-implemented.ts:8` — `NotImplementedAgent`:

```ts
import {
  SupervisorError,
  type ClassifyInput,
  type InternalEvidence,
  type LaunchRequest,
  type LaunchedWorker,
  type Supervisor,
  type Termination,
  type WorkerHandle,
} from "./index.ts";

const message = "the supervisor service is implemented in EPIC 110";

export class NotImplementedSupervisor implements Supervisor {
  launch(request: LaunchRequest): Promise<LaunchedWorker> {
    void request;
    throw new SupervisorError("not-implemented", message);
  }

  observe(handle: WorkerHandle): Promise<InternalEvidence> {
    void handle;
    throw new SupervisorError("not-implemented", message);
  }

  classify(input: ClassifyInput): Termination {
    void input;
    throw new SupervisorError("not-implemented", message);
  }
}
```

**Each method throws synchronously**, even the two whose return type is a `Promise`. That is the
shipped behaviour of `src/services/agent/not-implemented.ts:9` — `invoke`, and
`src/services/agent/not-implemented.test.ts:15` — `invoke throws AgentError(not-implemented) synchronously` names it in the test. A rejected promise would need `await` at every call site to
surface, and no call site exists yet.

**`src/services/supervisor/index.ts` re-exports `InternalEvidence` and `Termination`**, which is the
line the implementation's import depends on. `src/services/execution/index.ts:6` — `export type { RunKind }` is the shipped precedent for a service interface re-exporting a domain type it names in
its own signatures. Without it the implementation would import
`../../domain/termination.ts` a second time and the two files could drift on which types the seam
speaks.

### 5 — `src/domain/layout.test.ts` — the directory list and the stub list

**Add `"supervisor"` to the array at `src/domain/layout.test.ts:108`**, between
`src/domain/layout.test.ts:128` — `"storage"` and `src/domain/layout.test.ts:129` — `"verify"`, and
**rename the `it` at `src/domain/layout.test.ts:101`** from
`"src/services/ holds exactly the twenty-one capabilities plus home-lock"` to
`"src/services/ holds exactly the twenty-two capabilities plus home-lock"`. The array is a
`deepEqual` over a sorted `readdirSync`, so a new directory that is not in it fails immediately.

**Add `"supervisor"` to the list at `src/domain/layout.test.ts:152`**, so
`src/domain/layout.test.ts:151` — `agent, verify, lease and worker-health each hold a not-implemented.ts` covers this stub too, and **rename that `it`** to name five capabilities. Without
this edit the stub file exists and nothing requires it to keep existing.

## Constraints

- `ambiguousBudget` is `nonNegativeInteger` with the default `2`. It admits `0` and refuses `-1` and
  `1.5`.
- The env var is `KANTHORD_AMBIGUOUS_BUDGET`, and it appears in both the schema entry and the
  env-integer list. Either alone is a hole.
- `src/services/config/refusals.ts` is not edited, and `StartableInput` gains no member.
- `src/main.ts` is not edited.
- `src/services/supervisor/index.ts` holds no `implements ` and no implementation.
- `src/services/supervisor/` holds exactly `index.ts`, `not-implemented.ts` and
  `not-implemented.test.ts`. No fake in `test/helpers/` is written: nothing injects this interface
  yet, and a fake with no consumer is a file the next epic has to reconcile.

## Verify

```
node --test src/services/config/convict.test.ts src/services/supervisor/not-implemented.test.ts src/domain/layout.test.ts
```

Extend `src/services/config/convict.test.ts`, whose fixtures are
`src/services/config/convict.test.ts:21` — `validFile` and
`src/services/config/convict.test.ts:40` — `loadInput`, and whose `attemptLimit` block at
`src/services/config/convict.test.ts:388` — `config-invalid — attemptLimit validation` is the shape
cases 1 to 3 copy. Add `src/services/supervisor/not-implemented.test.ts`, copying
`src/services/agent/not-implemented.test.ts` including its `assert.throws` predicate form.

**`src/services/config/startup.test.ts` is not the file for these cases.** It launches a real daemon
and asserts one `config-refused` refusal, and every integer-format case in this repository lives in
`convict.test.ts`. The epic's Proof block names `startup.test.ts`; the cases below name the file that
holds the mechanism.

Add, each as a separate `it`:

1. `"throws config-invalid for ambiguousBudget: -1"` — `validFile({ ambiguousBudget: -1 })`, asserting
   the thrown error's `code` is `"config-invalid"`. This is the epic's gate row 20.

2. `"throws config-invalid for ambiguousBudget: 1.5"` — the same shape with `1.5`, asserting
   `"config-invalid"`. A second sub-case passes `KANTHORD_AMBIGUOUS_BUDGET: "abc"` through
   `loadInput`'s `env` and asserts the same code, which is what proves the env-integer entry of
   section 2 is present. This is the epic's gate row 20.

3. `"defaults ambiguousBudget to 2 when omitted, and loads 0"` — a `validFile()` with no
   `ambiguousBudget` key loads and `result.settings.ambiguousBudget` is `2`; a second sub-case with
   `ambiguousBudget: 0` loads and answers `0`. The second is the control that zero is a value and not
   a refusal, and it is the boundary `convertOnExhaustion` is asserted at by Story 6
   (`06-the-evidence-union-and-the-classifiers`) case 6. This is the epic's gate row 20.

4. `"Settings key order is home, actor, masterKey, http, tools, attemptLimit, ambiguousBudget, leaseTtlMs, runTtlMs, runMaxLifetimeMs"` —
   update `src/services/config/convict.test.ts:104` — `Settings key order`, taking the new key in that
   position and renaming the `it` to match. This is what stops the setting being appended somewhere
   a reader does not expect.

5. `"KANTHORD_AMBIGUOUS_BUDGET=5 wins over the file value"` — `validFile({ ambiguousBudget: 2 })` plus
   `env: { KANTHORD_AMBIGUOUS_BUDGET: "5" }` answers `5`, in the idiom of
   `src/services/config/convict.test.ts:635` — `KANTHORD_ATTEMPT_LIMIT=7 wins over file attemptLimit`.

6. `"an unknown key ambiguousBudgetMs throws config-invalid"` — `validFile({ ambiguousBudgetMs: 2 })`
   asserting `"config-invalid"`, which is the strict-mode control at
   `src/services/config/convict.ts:398` — `allowed: "strict"`. It is the pair to
   `src/services/config/convict.test.ts:568` — `an unknown key runTtlMillis throws config-invalid`.

7. `"NotImplementedSupervisor.launch, .observe and .classify each throw not-implemented"` — three
   sub-cases in one `it`, each `assert.throws` with the predicate form of
   `src/services/agent/not-implemented.test.ts:21`, asserting `error instanceof SupervisorError`,
   `error.code` is `"not-implemented"`, `error.name` is `"SupervisorError"` and `error.message` is
   `"the supervisor service is implemented in EPIC 110"`. Asserted **by code**, and the message
   asserted as a fourth value rather than as the oracle. This is the epic's gate row 21.

8. `"the supervisor interface declares exactly three members and no implementation"` — read
   `src/services/supervisor/index.ts` as text, assert the `Supervisor` slice holds `launch`, `observe`
   and `classify` and holds no fourth `(`-terminated name, and assert the file holds no
   `implements `. The second half duplicates
   `src/domain/layout.test.ts:166` — `no src/services/*/index.ts contains an implementation` on
   purpose: that case scans every service and this one names the file, so a reader of this story sees
   which rule applies.

9. `"src/services/ holds exactly the twenty-two capabilities plus home-lock"` — update the array and
   the `it` name at `src/domain/layout.test.ts:101`, and update the list and the `it` name at
   `src/domain/layout.test.ts:151`. The control is `src/domain/layout.test.ts:134` — `every service directory holds an index.ts`, which auto-discovers directories and therefore already requires
   `src/services/supervisor/index.ts` to exist.

`pnpm run verify` exits 0.

Proof: PASS line delivered — `src/services/supervisor/not-implemented.test.ts` in `PASS EPIC-054`.
