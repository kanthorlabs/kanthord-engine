# Story 13 — The end-to-end acceptance gate

Epic: `.agents/plan/epics/007-repository-registration.md`
Depends on: every story of this epic.

One driver runs every declared scenario in order, asserts that the declared set and the delivered set are equal, cleans the remote, and writes one report. It closes the epic's Proof and the `npm run e2e:007` gate.

## Change

### 1. `scripts/e2e/007/index.ts` (new) — the declared scenario set

```ts
export type ScenarioId =
  | "E7-00a"
  | "E7-00b"
  | "E7-01"
  | "E7-03"
  | "E7-04"
  | "E7-05"
  | "E7-06"
  | "E7-07"
  | "E7-08"
  | "E7-09"
  | "E7-10"
  | "E7-11"
  | "E7-12";

export type ScenarioDeclaration = Readonly<{
  id: ScenarioId;
  story: string;
  file: string;
  goal: string;
  writesRemoteRef: boolean;
}>;

export const scenarios: readonly ScenarioDeclaration[];
```

The declared set, in dispatch order. `goal` names which epic goal or coverage line the scenario proves, and it is the column a reader checks the gate against.

| id       | story | file                               | goal                                                           | writes a ref |
| -------- | ----- | ---------------------------------- | -------------------------------------------------------------- | ------------ |
| `E7-00a` | 02    | `00-harness.e2e.ts`                | the token reads the named repository, a wrong one does not     | no           |
| `E7-00b` | 02    | `00-harness.e2e.ts`                | the cleanup removes what the gate creates                      | **yes**      |
| `E7-01`  | 01    | `01-tool-probe.e2e.ts`             | the real tools resolve and satisfy the version floor           | no           |
| `E7-03`  | 03    | `03-provider-kind-factory.e2e.ts`  | the real token round-trips through canonical serialization     | no           |
| `E7-04`  | 04    | `04-credential-routes.e2e.ts`      | the credential is stored encrypted and never read back         | no           |
| `E7-05`  | 05    | `05-host-key-discovery.e2e.ts`     | a real host scan is ordered, reproducible and tool-agreeing    | no           |
| `E7-06`  | 06    | `06-repository-inspect.e2e.ts`     | the real default branch is detected; a dead token is a verdict | no           |
| `E7-07`  | 07    | `07-registration-preflight.e2e.ts` | the write advertisement passes, refuses, and writes nothing    | no           |
| `E7-08`  | 08    | `08-host-key-confirmation.e2e.ts`  | the re-scan is load-bearing against the real host              | no           |
| `E7-09`  | 09    | `09-bare-home-seeding.e2e.ts`      | one landing branch, a full tracking namespace, no tag          | no           |
| `E7-10`  | 10    | `10-repository-register.e2e.ts`    | registration writes the row, and refuses without writing one   | no           |
| `E7-11`  | 11    | `11-repository-projection.e2e.ts`  | P1-E3: the ref layout through the route alone                  | no           |
| `E7-12`  | 12    | `12-cli-commands.e2e.ts`           | the real CLI exits non-zero and names the missing flag         | no           |

`E7-02` is absent. Story 02 builds the harness and its two scenarios are `E7-00a` and `E7-00b`, so no scenario carries its number, and the gap is declared rather than a mistake.

**Exactly one scenario writes a remote ref**, and it writes it to prove the cleanup. Every other scenario reads or dry-runs. That is the property the gate asserts, and it is what makes the gate safe to run against a repository a human cares about.

### 2. `scripts/e2e/007/run.ts` (new) — the parent driver

```ts
export type RunOutcome = Readonly<{
  runId: string;
  baseOidBefore: string;
  baseOidAfter: string;
  outcomes: readonly ScenarioOutcome[];
  leaked: readonly string[];
}>;

export function mintRunId(): string;
export function driveGate(): Promise<RunOutcome>;
```

`node --test scripts/e2e/007/*.e2e.ts` is **not** the gate. `node --test` runs each file in its own process and may run several at once, so a glob gives no ordering, no shared run id, no single before-and-after measurement, and no place to clean up after every scenario. Filename order is not an execution-order mechanism. The driver supplies all four:

1. `mintRunId()` returns a Crockford base32 ULID from `src/services/ids/ulid.ts`. One id per run, minted once, collision-resistant — `Date.now()` is neither, and two runs in one millisecond would share a suffix and delete each other's refs.
2. Read `baseOidBefore` with `remoteRefValue` for `` `refs/heads/${env.ghBaseBranch}` ``.
3. For each declaration of `scenarios`, **in array order**, spawn `node --test <file>` as a child with `env: { ...process.env, E2E_RUN_ID: runId }` and `stdio: ["ignore","pipe","pipe"]`, and await its exit before starting the next. Sequential, because two scenarios pushing and deleting under one prefix concurrently would race each other's cleanup. Record a `ScenarioOutcome` per child from its exit code and its captured output.
4. In a `finally`: run `deleteScratchRefs` and record the returned names as `leaked`, then read `baseOidAfter`.
5. Write the report, and exit non-zero when any scenario failed, when `leaked` is non-empty, or when `baseOidBefore !== baseOidAfter`.

The `finally` is what makes the cleanup unconditional: a scenario that throws mid-push still gets its refs removed, which a per-scenario `after` hook cannot guarantee when the process dies.

### 3. `scripts/e2e/007/gate.e2e.ts` (new) — the static assertions

Six assertions, and no scenario logic of its own. It is a scenario file like any other, and the driver runs it **first**, because a declaration set that disagrees with the tree should fail before any network call.

1. **The declared set equals the delivered set.** Read `scripts/e2e/007/` with `readdirSync`, keep every `*.e2e.ts` other than `gate.e2e.ts`, and assert the file list bytewise sorted deep-equals the distinct `file` values of `scenarios`, bytewise sorted. A scenario file added without a declaration fails, and a declaration with no file fails.
2. **Every declared id is asserted somewhere.** For each declaration, read its file and assert the text contains the id string. A scenario that does not name its own id cannot be traced back to a goal.
3. **Every story of the epic has at least one scenario.** Read `.agents/plan/stories/007-repository-registration/` and assert every `NN-*.md` other than `13-*` appears as a `story` value in `scenarios`. This is the assertion that carries the epic's own requirement: a story without an end-to-end scenario fails the gate.
4. **Only `pushScratchRef` pushes without `--dry-run`.** Read every `.ts` file under `scripts/e2e/` and assert that each one containing the token `"push"` either is `remote.ts` or also contains `"--dry-run"` or `"pushScratchRef"`. `writesRemoteRef` in the table is hand-maintained declaration data and proves nothing about code; this assertion is what makes the one-writer property structural.
5. **The declared writer set matches the code.** Assert that exactly one declaration has `writesRemoteRef: true`, that it is `E7-00b`, and that `E7-00b`'s file is the only scenario file mentioning `pushScratchRef`.
6. **No hermetic file reaches the harness.** Walk `src/` and `test/` and assert no `.ts` file contains `"scripts/e2e"` or `".env.e2e"`, and that the only `test/` files any `scripts/e2e/**` file imports are `test/helpers/daemon.ts` and `test/helpers/home.ts`. This is the second half of Story 02's fence: placement is not hermeticity, and an import would carry the network into `npm run verify`.

### 4. `scripts/e2e/007/report.ts` (new)

```ts
export type ScenarioOutcome = Readonly<{
  id: ScenarioId;
  passed: boolean;
  detail: string;
}>;

export function renderReport(
  env: E2eEnv,
  outcomes: readonly ScenarioOutcome[],
): string;
```

`renderReport` produces a markdown table of id, story, goal and outcome, plus the run id, the repository name and the base branch. It never renders `env.ghToken`.

`driveGate` writes it to `.agents/e2e/007-<runId>/report.md`, so there is one script and no second entry point. `package.json` holds exactly one line for this gate:

```json
    "e2e:007": "node scripts/e2e/007/run.ts",
```

`.gitignore` already ignores `.agents/acceptance/`; add `.agents/e2e/` beside it.

`renderReport` also prints `baseOidBefore`, `baseOidAfter` and `leaked`, so a reader sees the safety result and not only the pass tally.

### 4. The epic Proof widens

**Applied.** The epic's Proof block named six globs and missed nine test files this epic delivers. It now reads:

```bash
node --test src/domain/provider-payload.test.ts \
  src/services/git/probe.test.ts src/services/git/host-key.test.ts \
  src/services/git/remote-info.test.ts src/services/git/preflight.test.ts \
  src/services/git/seed.test.ts src/services/git/binary.test.ts \
  src/commands/provider/**/*.test.ts src/queries/provider/**/*.test.ts \
  src/commands/repository/**/*.test.ts src/queries/repository/**/*.test.ts \
  src/http/server/credential/**/*.test.ts src/http/server/repository/**/*.test.ts \
  src/cli/confirm.test.ts src/cli/credential/**/*.test.ts src/cli/repository/**/*.test.ts \
  && echo "PASS EPIC-007"
```

The original globs would print `PASS` while the provider kind factory, the tool probe, host key discovery, the preflight, the seeding, the interface assembly and every handler were absent. The EPIC also now names `npm run e2e:007` separately, as a gate outside the Proof.

## Constraints

- The gate creates no remote ref of its own. It only asserts and cleans.
- `deleteScratchRefs` deletes only refs whose name ends with the current `runId`. A concurrent run's refs survive.
- The report never contains `env.ghToken`.
- The gate asserts the story coverage from the story directory, not from a hand-maintained list. A new story that ships without a scenario fails without anyone remembering to update the gate.
- `npm run e2e:007` is not part of `npm run verify`. `AGENTS.md` requires the hermetic suite to make no network call.

## Verify

`npm run e2e:007`

### The six gate assertions

- The declared set equals the delivered file set. Prove the assertion by construction as well: run the same comparison against a fabricated list holding one extra name and assert it reports that name. The comparison is a pure function so it is testable without adding a file.
- Every declaration's file contains its id.
- Every story `01`..`12` appears as a `story` value. Assert the extracted story list bytewise sorted deep-equals the sorted list `["01","02","03","04","05","06","07","08","09","10","11","12"]`, which is the twelve story numbers other than `13`.
- Only `remote.ts` pushes without `--dry-run`, asserted over every file under `scripts/e2e/`.
- Exactly one declaration has `writesRemoteRef: true`, it is `E7-00b`, and only that scenario's file mentions `pushScratchRef`.
- No file under `src/` or `test/` mentions `scripts/e2e` or `.env.e2e`, and `scripts/e2e/**` imports no `test/` file other than `daemon.ts` and `home.ts`.

### The driver

- `mintRunId()` returns a 26-character Crockford base32 string, and two calls differ.
- **Every scenario receives the same run id.** Each scenario asserts `env.runId === process.env.E2E_RUN_ID`, and the driver asserts every child was spawned with the same value. This is the assertion that a glob-based gate could not make.
- **A scenario run without `E2E_RUN_ID` refuses.** `node --test scripts/e2e/007/09-bare-home-seeding.e2e.ts` with no `E2E_RUN_ID` in the environment exits non-zero, and the failure names `E2E_RUN_ID`. A hand-run scenario never invents a suffix.
- **The scenarios run sequentially.** Have the driver record a start and an end timestamp per child and assert no two intervals overlap.
- **The cleanup runs after a failing scenario.** Point the driver at a fabricated scenario list whose one entry exits non-zero after `pushScratchRef`, and assert the driver still deleted the ref and still exited non-zero.
- `driveGate` exits non-zero when `leaked` is non-empty, and when `baseOidBefore !== baseOidAfter`. Both are driven with a fabricated outcome rather than by damaging the remote.

### The whole-gate assertions

- `npm run e2e:007` exits `0` on a machine holding `.env.e2e`, and every scenario reports a pass.
- `npm run e2e:007` on a machine with no `.env.e2e` exits non-zero, and the first failure names the file and the three required keys. It never reports a pass and never skips.
- **The base branch is untouched by the whole gate.** `driveGate` reads it before the first child and after the last, in a `finally`, and exits non-zero on a difference. It cannot live in a scenario file: a scenario is one child among several and sees neither the start nor the end of the suite. `E2E_GH_BASE_BRANCH` is read-only for the epic, and this is the one assertion that proves it across every scenario at once.
- **`npm run verify` makes no network call.** Run `npm run verify` with the loopback interface reachable and `.env.e2e` **removed**, and assert it exits `0`. A hermetic suite that had come to depend on the real remote would fail, and the fixture remotes of EPIC 005 serve on loopback and are unaffected.

### The coverage boundary this gate does not close

Three of the epic's coverage lines cannot be proved against one real remote, and the report names each rather than implying it passed.

- **A read-only credential that fetches successfully is refused by the preflight.** One personal access token presents one permission level. Proved against the EPIC 005 HTTP fixture in Story 07, which serves reads to anyone and refuses a write.
- **A plain HTTP url is accepted on a loopback host and refused elsewhere.** `github.com` serves no plain HTTP. Proved against the fixture in EPIC 006 Story 02 and in Story 10's handler test.
- **A url carrying a password in its userinfo is refused while one carrying only a username is not.** A refusal before any network call, proved in EPIC 006 Story 02.

`renderReport` prints these three as a named section, so a reader of the report cannot mistake the gate for total coverage.

`npm run verify` exits 0. `npm run e2e:007` exits 0.

Proof: this story delivers the widened Proof block above and the `npm run e2e:007` gate. It contributes no `src/` test file.
