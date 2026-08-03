# Story 07 — Startup sequence and the lock sweep

Epic: `.agent/plan/epics/001-runtime-foundation.md`
Depends on: Story 06, and Story 08 for `test/helpers/daemon.ts` and `test/helpers/home.ts`.
Source: `docs/proposal/phase-1/git-foundation.md:110`, `docs/proposal/phase-1/git-foundation.md:14` for the home layout.

## Change

**1. `src/services/home-lock/index.ts`** — `HeldHome` gains one method.

```ts
sweepRefLocks(): readonly string[];
```

**2. `src/services/home-lock/sqlite.ts`** — implement it.

- Throws `new Error("the home lock is released")` when the handle is released.
- `reposDir = join(home, "repos")`. When it does not exist, return `[]`.
- For every entry of `readdirSync(reposDir, { withFileTypes: true })` that is a directory whose name ends with `.git`, walk it recursively and collect every **file** whose name ends with `.lock`.
- Sort the collected absolute paths with `Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))`.
- `unlinkSync` each path in that sorted order, then return the sorted list.

`<home>/daemon.lock.db` and `<home>/daemon.lock.identity` sit at the home root, outside `repos`, so the walk never reaches them.

**3. `src/main.ts`** — add the `serve` command to the program Story 02 created. The order of these steps is the guarantee this story delivers.

```ts
program
  .command("serve")
  .description("run the daemon")
  .action(async () => {
    const options = program.opts();
    try {
      const { settings } = new ConvictConfig().load({
        explicitConfigPath: options.config,
        homeOverride: options.home,
        env: process.env,
        cwd: process.cwd(),
        homeDir: homedir(),
        etcDir: "/etc",
      });
      const probe = new StatfsProbe({
        platform: process.platform,
        statfs: statfsSync,
      });
      const held = new SqliteHomeLock({ probe }).acquire({
        home: settings.home,
      });
      held.publishIdentity({
        version: 1,
        pid: process.pid,
        host: hostname(),
        startedAt: new Date().toISOString(),
        instanceId: ulid(),
      });
      held.sweepRefLocks();
      process.stdout.write("kanthord: ready\n");
      setInterval(() => {}, 1 << 30);
    } catch (error) {
      if (error instanceof ConfigError || error instanceof HomeLockError) {
        process.stderr.write(`kanthord: ${error.code}: ${error.message}\n`);
        process.exitCode = 1;
        return;
      }
      throw error;
    }
  });
```

`ulid()`, `new Date().toISOString()`, `process.pid` and `hostname()` are called here, in the composition root, and the whole `HomeIdentity` is passed in. `services/home-lock` mints nothing, which is the AGENTS.md rule. EPIC 002 replaces the two ambient calls with the id and clock service interfaces, and `publishIdentity`'s signature does not change. No test asserts a minted value: every test passes its own identity.

`setInterval` is the keep-alive. A held SQLite transaction is not a libuv handle, so without it the event loop drains and the process exits. Install no signal handler: the kernel releases the lock on `SIGTERM` and on `SIGKILL` alike, and the epic's non-goals refuse a second release path.

## Constraints

- `publishIdentity` and `sweepRefLocks` are reachable only through the handle `acquire` returned, so the lock is held before the sweep by construction. Do not add a free function or a static that sweeps.
- The sweep runs exactly once, from this action, before the readiness line. Nothing else in the product ever calls it.
- `sweepRefLocks` deletes a file whose name ends `.lock` under `<home>/repos/*.git` and nothing else. It does not read a lock's contents, it does not check an age, and it never touches `<home>/repos` itself.
- `serve` opens no database and no port. EPIC 003 and EPIC 004 add those after the sweep.
- The readiness line is exactly `kanthord: ready\n` on stdout. The harness launcher matches it.

## Verify

`node --test src/services/home-lock/sqlite.test.ts` gains:

- No `repos` directory returns `[]` and creates nothing.
- An empty `repos` directory returns `[]`.
- `repos/a.git/refs/heads/main.lock`, `repos/a.git/refs/heads/x/y.lock`, `repos/b.git/config.lock` are all removed, and the returned array is those three absolute paths in bytewise order.
- `repos/a.git/refs/heads/main` and `repos/a.git/HEAD` survive, and `repos/a.git/refs/heads/main.lock.keep` survives, because it does not end in `.lock`.
- `repos/loose.lock` directly under `repos` survives, because it is not inside a `*.git` directory.
- A directory named `something.lock` survives, because only files are unlinked.
- `<home>/daemon.lock.db` and `<home>/daemon.lock.identity` survive, asserted after a sweep on a home that also holds a stale ref lock.
- Ordering is bytewise, not locale: a home holding `repos/a.git/refs/heads/Z.lock`, `repos/a.git/refs/heads/a.lock` and `repos/a.git/refs/heads/é.lock` returns them in `Buffer.compare` order.
- `sweepRefLocks` after `release()` throws `/released/`.
- The module exports exactly one name: `Object.keys(await import("./sqlite.ts"))` deep-equals `["SqliteHomeLock"]`. On its own this proves only the exported names, so it is the secondary guard. The ordering proof is the observed pair below.

`node --test src/services/home-lock/startup.test.ts` — new file, using `test/helpers/daemon.ts` and `test/helpers/home.ts` from Story 08. Each test owns its home and kills every child in `after`:

- The ordering proof, as one test on one daemon. A stale `repos/a.git/refs/heads/main.lock` is placed before startup. Once the daemon printed its readiness line, both of these hold at that same instant: the stale lock is gone, and a second daemon launched against the same home exits `1` with `home-locked`. A completed sweep and a held lock are therefore both true at one observable point, which is what `docs/proposal/phase-1/git-foundation.md:110` requires. Nothing here reads a clock.
- A `repos/a.git/refs/heads/main.lock` created **after** the readiness line still exists when the daemon exits on `SIGTERM`. No sleep: the assertion runs immediately after the write and again after the exit.
- Two daemons on one home: the second exits `1`, its stderr matches `home-locked`, and the stderr holds the first daemon's pid, read from `<home>/daemon.lock.identity`. Wait for the first daemon's readiness line before launching the second, so the identity is already published and the case is the named-holder case rather than the unavailable-identity case.
- A second `node:sqlite` database at `<home>/kanthord.db`, opened by the test while the first daemon holds the lock, creates a table and inserts a row.
- The first daemon killed with `SIGKILL`: a second daemon reaches its readiness line with no cleanup step and no wait, prints `kanthord: ready` and nothing else, and writes nothing to stderr. The test asserts nothing about `daemon.lock.db-journal`, in either direction. A held `BEGIN IMMEDIATE` under `journal_mode = DELETE` keeps a journal of its own while the lock is held, per Story 05, so the second daemon owns a journal at its readiness line and absence cannot hold there. Reaching readiness is the assertion: a hot journal that SQLite cannot roll back fails `BEGIN IMMEDIATE`, which becomes `home-lock-corrupt` and exits `1`. Recovery is the durable requirement of `docs/proposal/phase-1/git-foundation.md:96`; producing a journal is not, and removing one by hand is forbidden there.
- A home whose config sets `http.bind` to `0.0.0.0` with no token: the daemon exits `1` and its stderr matches `config-refused`.
- With `cwd` and `HOME` pointed at an empty temporary directory and `XDG_CONFIG_HOME` inside it, the daemon exits `1`, its stderr matches `config-not-found`, and the stderr names every candidate path in search order. The test first asserts `/etc/kanthord/config.json` does not exist and fails with a message naming it if it does, rather than skipping.

`npm run verify` exits 0.

Proof: `PASS 001-HOME-LOCK`, `PASS 001-ENTRY`.
