# Story 6 — The composition root and the harness

Epic: `.agents/plan/epics/050.6-the-process-capability.md`
Depends on: EPIC 050.6 Story 4 (`03-the-git-runner-takes-the-runner`) and EPIC 050.6 Story 5
(`04-the-three-spawn-sites-and-the-facade`) — this story passes the runner to every signature those
two changed.
Kind: story-foundation

This story closes the `pnpm run typecheck` window the two stories before it opened, and it is where
the epic's `Gates:` and `Proof:` run green for the first time.

## Change

### 1 — `src/main.ts`

**Construct the one runner, and pass it to the four consumers.** `src/main.ts` is the only file in
the product that names `createSupervisedRunner`, per `AGENTS.md`.

Imports:

- `src/main.ts:27-30` keeps `createGitRunner` from `./services/git/run.ts` and **drops
  `systemSchedule as gitSchedule` at `:29`** — `src/services/git/run.ts` no longer exports it.
- Add `import { createSupervisedRunner, systemSchedule as gitSchedule } from "./services/process/supervisor.ts";`
  beside it. **The alias survives the move**, because `src/main.ts:193` — `systemSchedule` is a
  different, unrelated value from `./http/server/runtime/node/schedule.ts` and the two cannot share a
  binding name.

Statements, in the `serve` action:

- **Insert `const runSupervised = createSupervisedRunner(gitSchedule);` immediately above
  `src/main.ts:230` — `probeTools`.** It must precede the probe, because the probe is the daemon's
  first supervised run.
- `src/main.ts:230` — `probeTools` becomes
  `await probeTools(runSupervised, { tools: settings.tools, runDirectory: join(settings.home, "git", "run") })`.
  The object literal is unchanged.
- `src/main.ts:235` — `createGitRunner` becomes `createGitRunner(gitPaths, runSupervised)`.
- `src/main.ts:237` — `createBinaryGit` gains `runSupervised` beside `runner: gitRunner` and
  `paths: gitPaths`.

**No other line of `src/main.ts` changes.** `src/main.ts:270` — `systemSchedule` and `:728` —
`systemSchedule` keep reading the HTTP runtime schedule, and no other construction moves.

### 2 — `src/main.test.ts`

**Add the two cases of gate row 21 and change nothing else.** The suite already starts a daemon in the
`before` at `src/main.test.ts:254` — `before` and reads `src/main.ts` as source in four cases, the
first at `src/main.test.ts:511` — `readFileSync`. The new source case follows that shape.

### 3 — The twelve files under `scripts/e2e/`

**Each file constructs one runner and passes it as the new first or second argument.** Every one adds

```ts
import { createSupervisedRunner } from "<relative>/src/services/process/supervisor.ts";
```

and one `const runSupervised = createSupervisedRunner();` at the scope where its calls sit.

| file                                               | symbol and call sites                                            |
| -------------------------------------------------- | ---------------------------------------------------------------- |
| `scripts/e2e/remote.ts`                            | `createGitRunner` at `:68`, `:128`                               |
| `scripts/e2e/007/run.ts`                           | `probeTools` at `:42`; `createGitRunner` at `:127`               |
| `scripts/e2e/007/00-harness.e2e.ts`                | `probeTools` at `:29`                                            |
| `scripts/e2e/007/01-tool-probe.e2e.ts`             | `probeTools` at `:23`                                            |
| `scripts/e2e/007/05-host-key-discovery.e2e.ts`     | `scanHostKeys` at `:38`, `:62`, `:91`                            |
| `scripts/e2e/007/06-repository-inspect.e2e.ts`     | `scanHostKeys` at `:189`                                         |
| `scripts/e2e/007/07-registration-preflight.e2e.ts` | `createGitRunner` at `:50`                                       |
| `scripts/e2e/007/08-host-key-confirmation.e2e.ts`  | `scanHostKeys` at `:46`; `confirmHostKey` at `:54`, `:73`, `:91` |
| `scripts/e2e/007/09-bare-home-seeding.e2e.ts`      | `createGitRunner` at `:41`                                       |
| `scripts/e2e/007/10-repository-register.e2e.ts`    | `createGitRunner` at `:142`                                      |
| `scripts/e2e/007/11-repository-projection.e2e.ts`  | `createGitRunner` at `:141`                                      |
| `scripts/e2e/007/12-cli-commands.e2e.ts`           | `createGitRunner` at `:141`                                      |

Citations: `scripts/e2e/remote.ts:68` — `createGitRunner`, `scripts/e2e/007/run.ts:42` —
`probeTools`, `scripts/e2e/007/00-harness.e2e.ts:29` — `probeTools`,
`scripts/e2e/007/01-tool-probe.e2e.ts:23` — `probeTools`,
`scripts/e2e/007/05-host-key-discovery.e2e.ts:38` — `scanHostKeys`,
`scripts/e2e/007/06-repository-inspect.e2e.ts:189` — `scanHostKeys`,
`scripts/e2e/007/07-registration-preflight.e2e.ts:50` — `createGitRunner`,
`scripts/e2e/007/08-host-key-confirmation.e2e.ts:54` — `confirmHostKey`,
`scripts/e2e/007/09-bare-home-seeding.e2e.ts:41` — `createGitRunner`,
`scripts/e2e/007/10-repository-register.e2e.ts:142` — `createGitRunner`,
`scripts/e2e/007/11-repository-projection.e2e.ts:141` — `createGitRunner`,
`scripts/e2e/007/12-cli-commands.e2e.ts:141` — `createGitRunner`.

### 4 — The range, which every epic appends its own id to

**Append `"050.6"` to `authoredEpics` of `scripts/epic-sequence-range.ts`, directly after `"050.5"`
and before `"051"`, and add the same string in the same position to the literal at
`test/sequence/conformance.test.ts:255` — `assert.deepEqual`.** The two must move together: that case
deep-equals the exported array against a written-out list, so a one-sided edit fails it.

**The append is what makes the range gate read this epic's stories.**
`scripts/epic-sequence-range.ts:1` — `authoredEpics` names every epic whose stories exist, and
`test/sequence/conformance.test.ts:41` — `for (const epicId of authoredEpics)` walks the story
directory of each. Without the entry the gate reads nothing of EPIC 050.6, and
`.agents/plan/stories/051.2-the-command-gate/index.md:112` records the convention: each epic of the
range appends its own id.

**`shippedEpics` does not change.** It names every epic whose code exists and gates whether a diagram
is due; `test/sequence/conformance.test.ts:267` — `slice` asserts it stays a prefix, and
`"050.6"` appended to the longer list keeps that true. This epic declares no diagram, so the walk
finds no `Diagrams:` line and asks for no scenario file.

**Both paths are engineer lanes**, so no `Paths:` grant is needed: `scripts/epic-sequence-range.ts` is
the software-engineer's and `test/sequence/conformance.test.ts` is the test-engineer's.

**The harness carries no `node --test` proof, because the runner does not collect it.**
`src/domain/layout.test.ts:454` — `no file under scripts/ is collected by the default test runner`
asserts that. `pnpm run typecheck` covers all twelve: `tsconfig.json:16` — `scripts/**/*.ts` is in
the `include`, so a call site left at its old arity fails the gate. `pnpm run e2e:007` runs only when
a human runs it, and EPIC 011 owns the acceptance run.

## Constraints

- `src/main.ts` holds exactly one `createSupervisedRunner(` call, and it precedes `probeTools`.
- `gitSchedule` keeps its name and now resolves to `./services/process/supervisor.ts`. The two
  `systemSchedule` bindings stay distinct.
- Every `scripts/e2e/` runner is `createSupervisedRunner()` with no argument: the harness runs on the
  real clock, and no e2e file arms a fake schedule.
- Change no behaviour of any e2e scenario. Each edit is one import, one construction and one argument
  per call site.
- Append `"050.6"` and nothing else to `authoredEpics`. Do not add `051.1`, `051.4` or `051.5`: those
  belong to their own epics, and the range currently fails on them for reasons outside this epic.
- Do not touch `shippedEpics`. EPIC 050.6 ships no diagram, and the prefix assertion must stay true.
- This story adds no configuration key. `agent.timeoutMs`, `agent.path` and `check.path` belong to
  EPIC 106 and EPIC 107, and no file under `src/services/config/` is touched.

## Verify

```
node --test src/main.test.ts
```

Add, each as a separate `it`:

1. `"a started daemon runs git through the composed runner and leaves no pid file"` — the daemon of
   the suite's `before` at `src/main.test.ts:254` is ready, which is only reachable when
   `probeTools` resolved `git --version` and `ssh -V` through the composed runner. In the same case,
   `readdirSync(join(home.path, "git", "run"))` deep-equals `[]`. The control: the test writes
   `join(home.path, "git", "run", "control.pid")` itself and the same `readdirSync` then reports
   `["control.pid"]`, so the empty-directory assertion detects a present file; the case removes it
   before it ends.

2. `"main.ts constructs exactly one supervised runner, above the tool probe"` — reading
   `resolve(import.meta.dirname, "./main.ts")` the way `src/main.test.ts:511` — `readFileSync` does:
   `(source.match(/createSupervisedRunner\(/g) ?? []).length` equals `1`;
   `source.indexOf("createSupervisedRunner(")` is less than `source.indexOf("probeTools(")`;
   `source.includes("createGitRunner(gitPaths, runSupervised)")` is `true`; and
   `(source.match(/systemSchedule/g) ?? []).length` equals `4` — the aliased import from the process
   capability, the HTTP runtime import at `src/main.ts:193`, and its two uses at `:270` and `:728`.
   `src/main.ts` holds four occurrences of the token today, at `:29`, `:193`, `:270` and `:728`, and
   this story moves the first from one module to another without changing the count.

3. `"the range names this epic and the two lists agree"` —
   `node --test test/sequence/conformance.test.ts` exits `0`, and its case
   `"shippedEpics is a prefix of authoredEpics"` passes over an `authoredEpics` whose value
   deep-equals `["050", "050.1", "050.2", "050.3", "050.4", "050.5", "050.6", "051", "051.2", "051.3"]`.
   In the same case, `node scripts/verify-epic-sequence.ts` reads the six story files of this epic and
   reports no error about `050.6`. The control: the same runner over an `authoredEpics` missing the
   entry reports nothing at all about `050.6`, which is the state this case exists to leave behind.

4. `"the harness type-checks at the new arity"` — a build-only check. `pnpm run typecheck` exits `0`,
   and `grep -rn 'createGitRunner(paths)' scripts/` prints no line.

5. `"the whole gate is green"` — a build-only check. `pnpm run verify` exits `0`, and the epic's
   `Proof:` block prints `PASS EPIC-050.6`.

`pnpm run verify` exits 0.

Proof: gate row 21 delivered — `src/main.test.ts` in `PASS EPIC-050.6`, and
`test/sequence/conformance.test.ts` through `pnpm test` inside `pnpm run verify`. This story is also where the
whole `Proof:` block first runs, because it lands the last two consumers of the changed signatures.
