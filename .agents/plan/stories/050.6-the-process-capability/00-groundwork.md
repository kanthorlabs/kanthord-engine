# Story 1 — The lint scope moves with the launcher

Epic: `.agents/plan/epics/050.6-the-process-capability.md`
Depends on: nothing of this epic — it runs first.
Kind: story-foundation
Executor: groundwork-engineer
Paths: eslint.config.js .trapload.mjs

`eslint.config.js` and `.trapload.mjs` are the two paths this epic edits that
`scripts/lane-check.sh` denies to both engineers and allows to `groundwork-engineer`. The first
carries one string replaced at four sites; the second is deleted whole.

**This story is destructive on purpose, and the window it opens is one story wide.** The moment
`eslint.config.js` stops naming `src/services/git/launcher.ts`, the still-present
`src/services/git/launcher.ts:1` — `spawn` becomes a `no-restricted-imports` violation and
`pnpm run lint` fails. The dispatch cannot be moved: `.claude/skills/work/SKILL.md:117` runs the
groundwork turn once, before the first engineer turn. EPIC 050.6 Story 2
(`01-the-launcher-the-contract-and-the-pid-check`) is the very next story and its own work closes the
window. No case of this story runs `pnpm run lint`.

## Change

### 1 — `eslint.config.js`, the four launcher sites

**Replace every occurrence of the string `src/services/git/launcher.ts` with
`src/services/process/launcher.ts` in `eslint.config.js`. There are exactly four, and no other edit
belongs in this story.**

The four sites, verified against the tree today:

| line  | role                                                               | the exact line                                                                                                                               |
| ----- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `284` | the `ignores` of the `src/**/*.ts` restriction block               | `    ignores: ["src/services/git/launcher.ts", "src/**/*.test.ts"],`                                                                         |
| `298` | the `node:child_process` message of that block                     | `                "only src/services/git/launcher.ts creates a process; see .agents/plan/stories/006-git-primitives/04-supervised-spawn.md",` |
| `410` | the `node:child_process` message of the `src/http/server/**` block | `                "only src/services/git/launcher.ts creates a process; see .agents/plan/stories/006-git-primitives/04-supervised-spawn.md",` |
| `447` | the `files` of the launcher-and-test exemption block               | `    files: ["src/**/*.test.ts", "src/services/git/launcher.ts"],`                                                                           |

Citations: `eslint.config.js:284` — `ignores`, `eslint.config.js:298` — `only src/services/git/launcher.ts creates a process`, `eslint.config.js:410` — `only src/services/git/launcher.ts creates a process`, `eslint.config.js:447` — `files`.

**Two of the four are matchers and two are messages, and all four move together.** `:284` and `:447`
decide which file may import `node:child_process`; `:298` and `:410` are the text a violator reads.
A message left naming the git path sends the next reader to a file that no longer exists.

**No `boundaries` entry changes, because the element pattern is generic.**
`eslint.config.js:133` — `src/services/*` captures every capability directory, so
`src/services/process/` classifies as a `service` with no registration. `eslint.config.js:158` —
`service-interface` matches `src/services/*/index.ts` for the same reason. A new capability is
therefore a directory, not a config edit.

Change no other key of the file: no `boundaries` element, no `boundaries/files` entry, no policy, no
other `no-restricted-imports` glob, no selector, and no entry of `nodeEdgeWriteExemptions` at
`eslint.config.js:17` — `nodeEdgeWriteExemptions`.

### 2 — `.trapload.mjs`, deleted whole

**Delete `.trapload.mjs` from the repository root.** It is a tracked one-off benchmark that spawns a
`SIGTERM`-trapping child sixty times and reports how long `stopChild` takes; its first line is
`.trapload.mjs:1` — `import { spawnSupervised } from "./src/services/git/launcher.ts";`.

**It is an orphan this epic creates, which is why this epic removes it.** EPIC 050.6 Story 2
(`01-the-launcher-the-contract-and-the-pid-check`) deletes `src/services/git/launcher.ts`, so the
import resolves to nothing afterwards.

**No gate would catch it.** `tsconfig.json:16` — `scripts/**/*.ts` includes `src/`, `test/` and
`scripts/` and not the repository root, so `pnpm run typecheck` never reads it;
`src/domain/layout.test.ts:454` — `no file under scripts/` shows the runner collects nothing outside
its patterns; and no `package.json` script and no file in the tree names `trapload`. A dangling import
would therefore survive the epic unseen.

**Repair is not the alternative.** The file measures a timing property of `stopChild` that
`src/services/git/child.test.ts:285` — `stopChild escalates to SIGKILL when the child ignores SIGTERM`
already asserts as a test, so a repaired copy would duplicate a covered proof and stay uncollected.

## Constraints

- Replace exactly four occurrences. The `numstat` case below is what proves it.
- Keep `eslint.config.js`'s existing key order, its comments and its two-space indentation. The
  comment at `eslint.config.js:279` — `the launcher is the only place a process is created` states the
  rule and not the path, so it needs no edit.
- Delete `.trapload.mjs` and create nothing in its place. Do not move it under `scripts/`: a benchmark
  the runner does not collect and no script invokes is not a test.
- Do not create `src/services/process/`. That directory is EPIC 050.6 Story 2
  (`01-the-launcher-the-contract-and-the-pid-check`), and `src/**` is outside this role's ceiling.
- Do not delete `src/services/git/launcher.ts`. Same story, same reason.
- Do not run `pnpm run lint` and do not run `pnpm run verify`. Both are red across this story by
  construction, and EPIC 050.6 Story 2 (`01-the-launcher-the-contract-and-the-pid-check`) restores
  them. This story's oracle is the build.

## Verify

```
pnpm exec prettier --check eslint.config.js
```

Add, each as a separate case:

1. `"the four launcher sites name the process capability"` —
   `grep -c 'src/services/process/launcher.ts' eslint.config.js` prints exactly `4`.

2. `"no site names the git launcher any more"` —
   `grep -c 'src/services/git/launcher.ts' eslint.config.js` prints exactly `0`.

3. `"the edit changed four lines and nothing else"` —
   `git diff --numstat -- eslint.config.js` prints exactly `4	4	eslint.config.js`. A locked file is
   where scope creep does the most damage, so the diff size is an assertion and not an observation.

4. `"the config still parses and still exports a config array"` —
   `node -e "import('./eslint.config.js').then((m) => process.stdout.write(String(Array.isArray(m.default))))"`
   prints exactly `true`, and `pnpm exec prettier --check eslint.config.js` exits `0`.

5. `"the benchmark orphan is gone and nothing named it"` — `test -e .trapload.mjs` exits non-zero,
   `git status --porcelain -- .trapload.mjs` prints exactly `D  .trapload.mjs`, and
   `grep -rl trapload --exclude-dir=node_modules --exclude-dir=.git .` prints no line. The control:
   the same `grep -rl` for `eslint.config.js` prints at least one line, so the matcher is proven to
   find a name that is present.

`pnpm run verify` is red on `pnpm run lint` until EPIC 050.6 Story 2
(`01-the-launcher-the-contract-and-the-pid-check`) moves the launcher. No case of this story runs it.

Proof: gate row 1 delivered — `eslint.config.js` holds the process path at four sites and the git
path at none. No `node --test` file of `PASS EPIC-050.6` belongs to this story; gate row 5, owned by
EPIC 050.6 Story 2 (`01-the-launcher-the-contract-and-the-pid-check`), is what proves
`pnpm run lint` green again.
