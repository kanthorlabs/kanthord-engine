# Story 4 — Delete the koa bridge and drop the `app` half

Epic: `.agents/plan/epics/034-the-node-adapter.md`
Depends on: Story 3 (it takes the last `koaFromHono` caller).

## Change

### Deletion

- Delete `src/http/server/koa-bridge.ts`.
- `src/http/server/koa-bridge.test.ts` is already gone. Story 3 deleted it, together with the last
  `koaFromHono` caller.

### `src/http/server/app.ts`

- Drop the `app: Koa` field from the `App` type. EPIC 032 story 16 leaves it as
  `Readonly<{ app: Koa; hono: Hono<AppEnv>; cancelWaits: () => void }>`. After this edit it is:

```ts
export type App = Readonly<{
  hono: Hono<AppEnv>;
  cancelWaits: () => void;
}>;
```

- Delete the `Koa` type import.
- Delete the `koaFromHono` import from `./koa-bridge.ts`.
- Delete the `Build app with koaFromHono` line of `createApp` and the `app` property of its returned
  object. `createApp` returns `{ hono, cancelWaits }`.

### Nothing else

- `src/main.ts` already reads the `hono` half from Story 1 and takes no further edit.
- `src/http/server/shutdown.ts` takes no edit.
- No test file takes an edit. Story 3 left every caller on the hono half.

## Constraints

- Add 0 cases and remove 0 cases. Story 3 removed the 6 cases of
  `src/http/server/koa-bridge.test.ts`, and story 2 restated all six against the node adapter.
- This story writes no test and deletes no test. It edits production modules only.
- Do not move `systemSchedule` out of `src/http/server/app.ts:60-64`. `app.ts:62` calls `.unref()`
  and `app.ts:103` uses `systemSchedule` as the default of the optional `schedule` dependency. EPIC
  035 owns that move.
- Do not edit `package.json`. `@types/koa` and `@types/koa__cors` stay until EPIC 035 S1 removes
  them, and `scripts/lane-check.sh:41` locks the file.
- Do not split the composition root and do not add a `src/http/server/runtime/**` module. EPIC 035
  owns both.

## Verify

- `node --test --test-reporter=tap 2>&1 | grep -m1 '^# pass'` reports the same number as after
  Story 3. This story changes no case count.
- `grep -rni koa src test scripts` returns nothing at all. The search is case-insensitive, so a
  leftover `Koa` type import is caught. Every match on the tree today is an import
  that EPIC 032, EPIC 033 or this epic replaces, and no file names koa in a string or a comment.
- `grep -rn "app:" src/http/server/app.ts` shows no `app: Koa` field.
- `npm run typecheck` exits 0. An unedited `koaFromHono` caller fails here, and that means Story 3 is
  incomplete.
- `grep -rn "overrideGlobalObjects" src test` reports exactly two lines — one in
  `src/http/server/start.ts` and one in `test/helpers/agent.ts` — and each reads `false`. Neither the
  start test nor the level-2 suite protects the other site, so this grep is the only gate that covers
  both.
- `grep -rn "serve(" src/http/server/` returns nothing. `serve()` cannot express the split between
  the bind address and the URL authority, per Story 1.
- The full EPIC Proof block passes:

```bash
node --test \
  src/http/server/start.test.ts \
  src/http/server/shutdown.test.ts \
  src/http/server/app.test.ts \
  src/http/server/dispatch.test.ts \
  src/http/server/route.test.ts \
  src/http/server/event/wait.test.ts \
  src/main.test.ts \
  src/main.event-wait.test.ts \
  src/main.authorization.test.ts \
  src/main.capability.test.ts \
  && echo "PASS EPIC-034"
```

- `src/main.test.ts:264` answers every routed operation over a real socket, unedited.
- `src/main.event-wait.test.ts:292` answers a pending wait empty and exits without the wait elapsing,
  unedited.
- `src/http/server/shutdown.test.ts:274` still asserts `cancelWaits` before the listener close, and
  the four step names stay `waits`, `listener`, `storage`, `home-lock`.
- `npm run verify` exits 0: `typecheck`, the full `node:test` suite, `eslint .`, and
  `verify-db-status`.
- Proof: delivers the `PASS EPIC-034` marker and owns the complete Proof block.
