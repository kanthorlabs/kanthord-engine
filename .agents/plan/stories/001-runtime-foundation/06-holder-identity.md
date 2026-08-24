# Story 06 — Holder identity

Epic: `.agents/plan/epics/001-runtime-foundation.md`
Depends on: Story 05.
Source: `docs/proposal/phase-1/git-foundation.md:74-94`.

## Change

**1. `src/services/home-lock/index.ts`** — add the identity type, extend the handle, the input and the error.

```ts
export type HomeIdentity = Readonly<{
  version: 1;
  pid: number;
  host: string;
  startedAt: string;
  instanceId: string;
}>;

export interface HeldHome {
  readonly path: string;
  publishIdentity(identity: HomeIdentity): void;
  release(): void;
}

export type AcquireInput = Readonly<{
  home: string;
  identityWaitMs?: number;
  identityPollMs?: number;
  beforeRetry?: () => void;
}>;
```

`HomeLockError` gains `readonly holder: HomeIdentity | null`, as a third constructor argument defaulting to `null`.

`identityWaitMs` defaults to `200`. `identityPollMs` defaults to `20`. `beforeRetry` is a test seam: the implementation calls it exactly once, immediately before the single retry, and never elsewhere. It exists so that "the holder died while the contender was looking" is asserted without a sleep.

**2. `src/services/home-lock/identity.ts`** — new file, pure apart from the type import.

```ts
export function renderIdentity(identity: HomeIdentity): string;
export function parseIdentity(bytes: string): HomeIdentity | null;
```

`renderIdentity` builds a fresh object literal with the keys in exactly this order — `version`, `pid`, `host`, `startedAt`, `instanceId` — and returns `JSON.stringify(literal, null, 2) + "\n"`. It never spreads the argument, because a spread carries the argument's key order.

`parseIdentity` returns `null` on any failure and never throws. It requires `version === 1`, `Number.isInteger(pid)`, and `host`, `startedAt` and `instanceId` each a non-empty string. Any other shape, and any `JSON.parse` throw, is `null`.

**3. `src/services/home-lock/sqlite.ts`** — two additions.

`HeldHome.publishIdentity(identity)`:

- Throws `new Error("the home lock is released")` when the handle is released.
- `writeFileSync(join(home, "daemon.lock.identity." + identity.instanceId + ".tmp"), renderIdentity(identity), { mode: 0o600 })`.
- `renameSync` that temporary path onto `join(home, "daemon.lock.identity")`.

The contender path, replacing step 6 of Story 05 for `errcode === 5` only:

1. `identityPath = join(home, "daemon.lock.identity")`. Poll `fs.existsSync(identityPath)`. When it is false, call the injected `sleeper(identityPollMs)` and poll again, until the file appears or the accumulated sleep budget reaches `identityWaitMs`. Count the budget from the sleeps requested, not from a clock reading, so the loop is a pure function of `identityWaitMs`, `identityPollMs` and the file's appearance. `identityWaitMs` of `0` polls once and never sleeps. The default `sleeper` of Story 05 uses `Atomics.wait`, because `acquire` is synchronous.
2. `holder = parseIdentity(readFileSync(identityPath, "utf8"))`, guarded so a missing file gives `null`.
3. Call `input.beforeRetry` when it is present.
4. Retry the same open, the same four statements and `BEGIN IMMEDIATE`, once. Success returns a `HeldHome`.
5. `errcode === 5` again throws `HomeLockError("home-locked", <message>, holder)`. Any other `errcode` throws `HomeLockError("home-lock-corrupt", ...)` with a `null` holder.

The message, exactly one of two forms:

- `holder` non-null: `the daemon home <home> is locked by pid <pid> on <host> since <startedAt> (instance <instanceId>)`
- `holder` null: `the daemon home <home> is locked by another process; the holder identity is unavailable`

## Constraints

- Identity is diagnostic. Nothing reads it to decide ownership, to steal a lock, to delete a file or to skip the retry. The refusal happens whether or not the file parsed.
- `publishIdentity` is reachable only through a `HeldHome`, so an identity can never be written before the lock is held. That is the whole guarantee — do not add a free function that writes the file.
- The retry runs exactly once, whatever the wait produced.
- The wait loop reads no clock. `Date.now()`, `performance.now()` and `process.hrtime` appear nowhere in this capability, so the number of sleeps for a given input is fixed and a test asserts it exactly.
- The temporary name carries the `instanceId`, so two contenders never collide on it.

## Verify

`node --test src/services/home-lock/identity.test.ts`, which asserts:

- `renderIdentity({ version: 1, pid: 16801, host: "devbox", startedAt: "2026-08-03T10:00:00.000Z", instanceId: "01JQ8Z4A2B" })` equals this exact string, byte for byte, including the trailing newline:

```
{
  "version": 1,
  "pid": 16801,
  "host": "devbox",
  "startedAt": "2026-08-03T10:00:00.000Z",
  "instanceId": "01JQ8Z4A2B"
}
```

- The same identity built with its keys in a different literal order renders the same bytes.
- `parseIdentity(renderIdentity(x))` deep-equals `x`.
- `parseIdentity` returns `null` for `""`, for `"{"`, for `"{}"`, for a truncated prefix of a valid document, for `version: 2`, for `pid: "16801"`, and for `host: ""`.

`node --test src/services/home-lock/sqlite.test.ts` gains:

- `publishIdentity` writes `daemon.lock.identity` with mode `0o600`, its bytes equal `renderIdentity(identity)`, and no `*.tmp` file remains in the home.
- `publishIdentity` after `release()` throws `/released/`, and no file is written.
- Holder published, then a second instance acquires: it throws `code === "home-locked"`, `error.holder` deep-equals the published identity, and the message holds the pid, the host, the `startedAt` and the `instanceId`.
- Holder never published: the second instance throws `home-locked`, `error.holder` is `null`, and the message ends `the holder identity is unavailable`.
- `daemon.lock.identity` holding a truncated document: the second instance still throws `home-locked` with a `null` holder and the same message.
- `beforeRetry` releasing the holder makes `acquire` succeed, and `beforeRetry` ran exactly once, counted by the test's own closure.
- `beforeRetry` that does nothing leaves `acquire` throwing `home-locked`, and it still ran exactly once.
- Every contender test injects a counting `sleeper` that does nothing, and passes an explicit `identityWaitMs` and `identityPollMs`. No test calls the default `sleeper`, and no assertion reads a clock.
- `identityWaitMs: 0`, `identityPollMs: 20`: the injected `sleeper` is never called, and `acquire` throws `home-locked`.
- `identityWaitMs: 100`, `identityPollMs: 20`, no identity file ever published: the injected `sleeper` is called exactly five times, each with `20`. The wait budget is exact, not approximate.
- `identityWaitMs: 100`, `identityPollMs: 20`, with the identity file already present: the `sleeper` is never called, and `error.holder` deep-equals it.
- The predecessor race: the test writes a valid identity for pid `999999`, a first `SqliteHomeLock` then acquires and does **not** publish, and a second one is refused. `error.holder` is `null`, the message ends `the holder identity is unavailable`, and the pid `999999` appears nowhere in it. Without the stale-identity removal of Story 05 step 7, this test names a process that never held the lock.

`npm run verify` exits 0.

Proof: `PASS 001-HOME-LOCK`.
