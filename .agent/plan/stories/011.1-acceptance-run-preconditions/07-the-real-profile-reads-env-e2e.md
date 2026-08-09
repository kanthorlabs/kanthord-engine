# Story 07 — The real profile reads `.env.e2e`

Epic: `.agent/plan/epics/011.1-acceptance-run-preconditions.md`

## Change

One file: `scripts/e2e/lib/scenario/p1-e3.ts`.

### 1. Imports

Add:

```ts
import { loadE2eEnv, E2eEnvError, type E2eEnv } from "../../env.ts";
```

Remove `import { readFile } from "node:fs/promises";` (line 1) — nothing else in the file uses it.

### 2. The required environment list shrinks

Replace `requiredEnvVars` (lines 13-20) with:

```ts
const requiredEnvVars = [
  "KANTHORD_E2E_REAL_PLAN",
  "KANTHORD_E2E_REAL_OBJECTIVES",
  "KANTHORD_E2E_REAL_TASKS",
] as const;
```

`KANTHORD_E2E_REAL_ORIGIN`, `KANTHORD_E2E_REAL_BRANCH` and `KANTHORD_E2E_REAL_TOKEN_FILE` are gone.
The plan path and the two counts stay explicit environment inputs, because a real plan is authored
per run.

### 3. `checkPrerequisites` loads `.env.e2e` and returns the derived inputs

```ts
export type RealInputs = Readonly<{
  origin: string;
  defaultBranch: string;
  token: string;
  planPath: string;
  expectedObjectiveCount: number;
  expectedTaskCount: number;
}>;

export async function checkPrerequisites(
  context: ScenarioContext,
  execute: SshExecutor,
  env: Readonly<Record<string, string | undefined>>,
  loadEnv: () => E2eEnv = loadE2eEnv,
): Promise<RealInputs>;
```

Body order, keeping every existing check in place:

1. The two `daemonHost` / `clientHost` checks (lines 46-51) — unchanged.
2. The `requiredEnvVars` loop (lines 53-57) — unchanged, now over three names.
3. The two `isPositiveInteger` checks (lines 59-70) — unchanged.
4. **New**, after the integer checks and before the two ssh pings:

   ```ts
   let e2eEnv: E2eEnv;
   try {
     e2eEnv = loadEnv();
   } catch (error) {
     if (error instanceof E2eEnvError) {
       throw new RunnerError(
         "unavailable",
         `P1-E3 needs ${error.missing.join(", ")} in .env.e2e`,
       );
     }
     throw error;
   }
   ```

   `loadE2eEnv` (`scripts/e2e/env.ts:50`) throws `E2eEnvError` with `missing` populated both when the
   file is absent (all three keys) and when a key is absent, empty or malformed
   (`scripts/e2e/env.ts:54-80`). The message therefore names each missing key.

5. The two ssh pings (lines 72-92) — unchanged.
6. Return:

   ```ts
   return {
     origin: `https://github.com/${e2eEnv.ghRepo}.git`,
     defaultBranch: e2eEnv.ghBaseBranch,
     token: e2eEnv.ghToken,
     planPath: env.KANTHORD_E2E_REAL_PLAN as string,
     expectedObjectiveCount: Number.parseInt(
       env.KANTHORD_E2E_REAL_OBJECTIVES as string,
       10,
     ),
     expectedTaskCount: Number.parseInt(
       env.KANTHORD_E2E_REAL_TASKS as string,
       10,
     ),
   };
   ```

### 4. `runP1E3` takes the inputs

Replace the signature (lines 95-99) and the whole derivation block (lines 100-115) with:

```ts
export async function runP1E3(
  context: ScenarioContext,
  driver: ExecutionDriver,
  inputs: RealInputs,
): Promise<void> {
  secrets.hold(inputs.token);
  const deliveredTokenPath = await driver.deliverToken(inputs.token);

  const profile = await createRealProfile(context, driver, {
    origin: inputs.origin,
    credentialArguments: [
      "--name",
      "real",
      "--kind",
      "git",
      "--transport",
      "http-basic",
      "--username",
      "",
      "--token-file",
      deliveredTokenPath,
    ],
    defaultBranch: inputs.defaultBranch,
    localPlanPath: inputs.planPath,
    expectedObjectiveCount: inputs.expectedObjectiveCount,
    expectedTaskCount: inputs.expectedTaskCount,
  });

  await runJourney(context, driver, profile);
}
```

`credentialArguments` is unchanged. The token still reaches the daemon host only through
`driver.deliverToken`, which writes it with `install -m 600` and pipes the value on stdin
(`scripts/e2e/lib/driver/ssh.ts:81-103`, `:198-204`) — never an argv, never an environment variable.

### 5. `run` threads the inputs

In `run` (lines 144-160):

```ts
  const inputs = await checkPrerequisites(context, execute, process.env);

  const driver = await createSshDriver(context, { ... });   // unchanged

  await runP1E3(context, driver, inputs);
```

The rest of `run` — the four disclosure assertions at lines 168-183 — is unchanged.

## Constraints

- `.env.e2e` is the single source of the origin, the default branch and the credential. Do not read
  `KANTHORD_E2E_REAL_ORIGIN`, `KANTHORD_E2E_REAL_BRANCH` or `KANTHORD_E2E_REAL_TOKEN_FILE` anywhere.
- `checkPrerequisites` loads `.env.e2e` exactly once, and `runP1E3` never loads it. Two loads are two
  sources of truth.
- The origin is `https://github.com/<E2E_GH_REPO>.git`. `E2E_GH_REPO` is validated as `owner/name` by
  `scripts/e2e/env.ts:29`.
- Every failure of `checkPrerequisites` is `unavailable`, never `assertion-failed`.
- Do not change `runJourney` or `createRealProfile`.
- `scripts/e2e/env.ts` is not under `src/`, so Story 05's discipline test still passes.

## Verify

`node --test scripts/e2e/lib/scenario/p1-e3.test.ts`. Add these cases, using the file's existing
`fakeContext` and `fakeDriver` helpers (`p1-e3.test.ts:42+`, `:267-345`):

1. `checkPrerequisites` with the three `KANTHORD_E2E_REAL_*` values present, reachable hosts, and a
   stub `loadEnv` returning
   `{ ghToken: "gh-secret", ghRepo: "kanthorlabs/kanthord", ghBaseBranch: "main", runId: "r1" }`
   resolves to exactly:

   ```ts
   {
     origin: "https://github.com/kanthorlabs/kanthord.git",
     defaultBranch: "main",
     token: "gh-secret",
     planPath: "/tmp/plan",
     expectedObjectiveCount: 2,
     expectedTaskCount: 4,
   }
   ```

2. A stub `loadEnv` throwing `new E2eEnvError("...", ["E2E_GH_TOKEN", "E2E_GH_REPO"])` → rejects with
   `RunnerError`, `code === "unavailable"`, message
   `P1-E3 needs E2E_GH_TOKEN, E2E_GH_REPO in .env.e2e`.
3. A stub `loadEnv` throwing with all three keys → the message names all three, in the
   `E2E_REQUIRED_KEYS` order of `scripts/e2e/env.ts:13-17`.
4. Each of `KANTHORD_E2E_REAL_PLAN`, `KANTHORD_E2E_REAL_OBJECTIVES`, `KANTHORD_E2E_REAL_TASKS`
   absent → rejects with `unavailable`, message `P1-E3 needs <NAME>`. Table-driven.
5. `KANTHORD_E2E_REAL_ORIGIN`, `KANTHORD_E2E_REAL_BRANCH` and `KANTHORD_E2E_REAL_TOKEN_FILE` absent
   from `env` **does not** reject, so the regression that would re-introduce them is caught.
6. `runP1E3` with a fake driver and the `RealInputs` of case 1 calls `deliverToken` exactly once with
   `"gh-secret"`, and passes `origin`, `defaultBranch`, `localPlanPath`,
   `expectedObjectiveCount` and `expectedTaskCount` straight through to `createRealProfile`.
7. **SECURITY:** the token value appears in no recorded command argv, no bundle assertion and no
   attached log. Drive a full fake run, collect the sink's recorded `CommandRecord.argv`, the
   context's assertion rows and its logs, join them and assert the token string is absent. Follow the
   `secretsDisclosed` shape at `p1-e3.ts:140-142` and the `SECURITY:` naming used at
   `scripts/e2e/lib/profile/profile.test.ts:154`.
8. Update the existing `p1-e3.test.ts` cases that construct the six old environment variables so they
   construct the three remaining ones plus a stub `loadEnv`.

- `npm run verify` exits 0.
- Proof: this story delivers no line of the EPIC Proof block; P1-E3 is not invoked there. It is
  covered by the `Coverage required beyond the Proof` bullet "P1-E3 raises `unavailable` and names
  each missing key when `.env.e2e` is absent or incomplete, and the real token appears in no printed
  command, no bundle and no log."
