# Story 07 — Startup sequence

Epic: `.agent/plan/epics/001-runtime-foundation.md`
Depends on: Story 06, and Story 08 for `test/helpers/daemon.ts` and `test/helpers/home.ts`.
Source: `docs/proposal/phase-1/git-foundation.md`, and its home layout.

The lock sweep this story once carried is now EPIC 007.5. A `git` child outlives the daemon, so holding the home lock does not prove that no `git` is running, and removing a lock a live `git` still owns turns a recoverable crash into a corrupted repository. Startup must reap before it sweeps, and a reap needs a journal row that only a real git operation writes. `docs/proposal/phase-3/recovery.md` holds the sequence.

## Change

**1. `src/main.ts`** — add the `serve` command to the program Story 02 created. The order of these steps is the guarantee this story delivers.

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

- `publishIdentity` is reachable only through the handle `acquire` returned, so the lock is held before the identity is published by construction. Do not add a free function or a static.
- `serve` removes nothing from the home. EPIC 007.5 owns every removal, and it runs a reap before any of them. A startup that deletes a lock file it cannot prove is stale is the defect this story no longer contains.
- `serve` opens no database and no port. EPIC 003 and EPIC 004 add those.
- The readiness line is exactly `kanthord: ready\n` on stdout. The harness launcher matches it.

## Verify

`node --test src/services/home-lock/startup.test.ts` — new file, using `test/helpers/daemon.ts` and `test/helpers/home.ts` from Story 08. Each test owns its home and kills every child in `after`:

- The ordering proof, as one test on one daemon. Once the daemon printed its readiness line, a second daemon launched against the same home exits `1` with `home-locked`. A held lock is therefore true at an observable point.
- A `repos/a.git/refs/heads/main.lock` created after the readiness line still exists when the daemon exits on `SIGTERM`. No running operation removes a lock it did not create, and this story removes none at all. No sleep: the assertion runs immediately after the write and again after the exit.
- Two daemons on one home: the second exits `1`, its stderr matches `home-locked`, and the stderr holds the first daemon's pid, read from `<home>/daemon.lock.identity`. Wait for the first daemon's readiness line before launching the second, so the identity is already published and the case is the named-holder case rather than the unavailable-identity case.
- A second `node:sqlite` database at `<home>/kanthord.db`, opened by the test while the first daemon holds the lock, creates a table and inserts a row.
- The first daemon killed with `SIGKILL`: a second daemon reaches its readiness line with no cleanup step and no wait, prints `kanthord: ready` and nothing else, and writes nothing to stderr. The test asserts nothing about `daemon.lock.db-journal`, in either direction. A held `BEGIN IMMEDIATE` under `journal_mode = DELETE` keeps a journal of its own while the lock is held, per Story 05, so the second daemon owns a journal at its readiness line and absence cannot hold there. Reaching readiness is the assertion: a hot journal that SQLite cannot roll back fails `BEGIN IMMEDIATE`, which becomes `home-lock-corrupt` and exits `1`. Recovery is the durable requirement; producing a journal is not, and removing one by hand is forbidden.
- A home whose config sets `http.bind` to `0.0.0.0` with no token: the daemon exits `1` and its stderr matches `config-refused`.
- With `cwd` and `HOME` pointed at an empty temporary directory and `XDG_CONFIG_HOME` inside it, the daemon exits `1`, its stderr matches `config-not-found`, and the stderr names every candidate path in search order. The test first asserts `/etc/kanthord/config.json` does not exist and fails with a message naming it if it does, rather than skipping.

`node --test src/services/home-lock/sqlite.test.ts` asserts the module exports exactly one name: `Object.keys(await import("./sqlite.ts"))` deep-equals `["SqliteHomeLock"]`.

`npm run verify` exits 0.

Proof: `PASS 001-HOME-LOCK`, `PASS 001-ENTRY`.
