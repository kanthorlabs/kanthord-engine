# Story 08 — daemon-backed `npm run verify`

Epic: `.agent/plan/epics/009-cli-and-composition-root.md`
Depends on: Story 07 (the daemon answers every routed operation). Land it last, so the gate every earlier story ran is the gate this story leaves behind.

`.agent/plan/stories/001-runtime-foundation/09-staged-verify.md:22` removed `node src/main.ts db status` from `verify` and named this epic as the one that restores it. `docs/proposal/phase-1/domain.md:43` fixes the five steps: migrate a temporary home, start the daemon on a loopback port with a token, call `db status`, stop the daemon, remove the home.

## Change

S1 is already applied and needs no further action: `scripts/lane-check.sh:87-94` now routes a `scripts/*.test.ts` to the test-engineer and every other `scripts/` path to the software-engineer, so the test file below is in the test-engineer's lane.

### 1. `scripts/verify-db-status.ts` (new) — the step, injectable

The lifecycle lives in the script, and the test imports it. The reverse — logic in `test/helpers/` and a thin script importing it — would put a step of `npm run verify` behind a test helper, and `AGENTS.md` states "No production file imports a test or a test helper". `scripts/e2e/007/12-cli-commands.e2e.ts:24-30` importing `test/helpers/` is not the same case: the e2e harness is not a gate step. The script does consume `test/helpers/home.ts`, `daemon.ts` and `cli.ts` for the daemon lifecycle, which is the existing precedent and is what `eslint.config.js:335-343` allows by giving `scripts/**` a parser and no boundary rule. See S6.

```ts
export type DbStatusStepDependencies = Readonly<{
  stdout: (text: string) => void;
  callDbStatus: (
    input: Readonly<{ baseUrl: string; token: string }>,
  ) => Promise<Readonly<{ code: number; stdout: string; stderr: string }>>;
}>;

export type DbStatusStepResult = Readonly<{
  home: string;
  port: number;
  migrated: number;
  daemonPid: number;
  daemonExit: number | null;
}>;

export const systemDbStatusDependencies: DbStatusStepDependencies;

export async function runDbStatusStep(
  dependencies: DbStatusStepDependencies,
): Promise<DbStatusStepResult>;
```

`runDbStatusStep` performs, in order:

1. `const home = createTemporaryHome()` and `const port = await reservePort()`, imported from `test/helpers/port.ts`, which Story 07 section 1 creates.
2. `home.writeConfig({ http: { port, allowedHosts: [`127.0.0.1:${port}`] } })`. Both fields, for the reason in Story 07.
3. `runCli({ args: ["db", "migrate", "--home", home.path] })`. A non-zero exit throws `Error("verify: db migrate exited <code>")`.
4. `launchDaemon({ config: home.configPath })`, then `await daemon.ready()`.
5. `dependencies.callDbStatus({ baseUrl: \`http://127.0.0.1:${port}\`, token: "test-token" })`. A non-zero exit throws `Error("verify: db status exited <code>")` carrying the captured stderr.
6. The whole of steps 4 and 5 sits inside a `try`, and the `finally` runs `daemon.kill()`, awaits the exit, then `home.dispose()`. Step 3's failure reaches the same `finally` through an outer `try` that owns the home.

`systemDbStatusDependencies.callDbStatus` is `runCli({ args: ["db", "status", "--base-url", baseUrl, "--token", token] })`. `docs/proposal/api/system.md:44` makes `db status` the HTTP client command, so the step calls the real CLI and not `fetch`.

`migrated` is the count of lines `db migrate` printed. It is returned so the caller can print it; nothing asserts a specific number.

### 2. `scripts/verify-db-status.ts` — the entry guard, in the same file

Below the two exports:

```ts
if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await runDbStatusStep(systemDbStatusDependencies);
    process.stdout.write("kanthord: verify db status ok\n");
  } catch (error) {
    process.stderr.write(`kanthord: verify: ${String(error)}\n`);
    process.exitCode = 1;
  }
}
```

The guard is required, not stylistic: without it, importing the module from the test would run the step at import time.

### 3. `package.json:20` — the last edit of the epic

```json
"verify": "npm run typecheck && npm test && npm run lint && node scripts/verify-db-status.ts"
```

`scripts/lane-check.sh:41` locks `package.json` against both implementing roles, so Ulrich applies this line by hand. **It must be applied after sections 1 and 2 are green, never before.** `node` on a missing file exits `1`, so applying it first turns `npm run verify` red for every story of this epic, and `npm run verify` is the epic's own `Gates:` line. Story 001/09 removed this same step for the mirror-image reason. See B3.

The sequence inside this story is therefore: write the test, write the script, run `node --test scripts/verify-db-status.test.ts` green, run `node scripts/verify-db-status.ts` by hand and see it exit `0`, then apply the line, then run `npm run verify`.

## Constraints

- The step order is `typecheck`, `test`, `lint`, `db status`. The daemon step is last, because it is the slowest and because a lint failure should not cost a daemon boot.
- The step reserves its own port and writes its own home. It never reads `KANTHORD_HOME`, never uses `7421`, and never touches the developer's real home.
- The `finally` is unconditional. A throw at any step still kills the daemon and removes the home.
- `scripts/verify-db-status.ts` adds no flag, no argument and no environment variable. `npm run verify` takes none today.
- Do not touch `"test": "node --test --test-timeout=60000"`.

## Verify

```bash
node --test scripts/verify-db-status.test.ts
```

### `scripts/verify-db-status.test.ts` (new)

Each case injects `callDbStatus` so the daemon lifecycle is real and the outcome is scripted. `runDbStatusStep` also returns the killed child's `pid` and the resolved exit code, so a case can assert on the process rather than only on the port.

Three cleanup assertions, named once and reused by every case below:

1. **The home is gone.** `existsSync(result.home)` is `false`, and `existsSync(join(result.home, "daemon.lock.db"))` is `false` with it.
2. **The child is reaped.** The exit code the step awaited is defined — the step does not resolve or reject until the daemon process has exited. A free port proves the listener closed; only an observed exit proves no child survives.
3. **No lock is held.** A second `runDbStatusStep` immediately after the first resolves. One assertion covers both a leaked lock and a leaked port, because the second run reserves its own port and acquires its own home lock, and neither can succeed while the first run's daemon lives.

- **The passing run.** A `callDbStatus` returning `{ code: 0, stdout: "…", stderr: "" }` resolves, and all three cleanup assertions hold.
- **The failing run cleans up identically.** A `callDbStatus` returning `{ code: 3, … }` rejects with a message containing `db status exited 3`, and all three cleanup assertions hold after the rejection. This is the coverage line the EPIC names.
- **A `callDbStatus` that throws** rejects with that error, and all three hold.
- **A failure before the daemon starts cleans up too.** With `home.writeConfig` given an `http.port` already bound by a `net` server the test opened, `launchDaemon`'s `ready()` times out or the child exits; the step rejects, `existsSync(home)` is `false`, and no child survives. This is the case a `finally` scoped only around steps 4 and 5 would miss, so it is what proves the outer `try` owns the home.
- `callDbStatus` receives a `baseUrl` of `http://127.0.0.1:<the reserved port>` and the token `test-token`, asserted on the recorded input.
- The daemon really started: the captured stdout of the launch contains `kanthord: ready`.
- The step reads no `KANTHORD_*` variable from the ambient environment: with `KANTHORD_HOME` set to `/nonexistent`, the passing case still resolves.

### By hand, once

- `npm run verify` exits `0` from a clean tree and prints `kanthord: verify db status ok` last.
- `git diff package.json` touches the `verify` line only.
- With `KANTHORD_HOME` set to a non-existent path, `npm run verify` still exits `0`. The step ignores it.

Proof: contributes `scripts/verify-db-status.test.ts`, which is outside the EPIC Proof glob — see B2 in the index, which widens the Proof. This story also delivers the epic `Gates:` line, `npm run verify`, in its final form.
