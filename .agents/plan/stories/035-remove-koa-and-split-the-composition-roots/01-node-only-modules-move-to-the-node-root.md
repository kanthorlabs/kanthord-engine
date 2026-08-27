# Story 1 — The Node-only modules move to the Node root

Epic: `.agents/plan/epics/035-remove-koa-and-split-the-composition-roots.md`
Depends on: EPIC 034 story 3.

## Change

### 1. Move the listener

- Create the directory `src/http/server/runtime/node/`.
- Move `src/http/server/start.ts` to `src/http/server/runtime/node/listen.ts`. Copy the file byte for byte, in the shape EPIC 034 story 1 leaves it. Delete `src/http/server/start.ts`.
- The file holds no relative import, so no specifier changes. Keep the exported names `listen`, `ListenInput` and `ListeningServer` unchanged.
- Move `src/http/server/start.test.ts` to `src/http/server/runtime/node/listen.test.ts`. EPIC 034 story 1 and story 2 edit that file first, so **read the file as EPIC 034 leaves it and rewrite every relative specifier it then holds**. The rule is mechanical and covers a specifier the list below does not name: the file descends two directories, so prepend `../../` to every relative specifier, then collapse `../.././` to `../../`. The list below is the specifier set of the file today, resolved by that rule:
  - `"./start.ts"` → `"./listen.ts"`
  - `"./app.ts"` → `"../../app.ts"` (two import statements)
  - `"../contract/errors.ts"` → `"../../../contract/errors.ts"`
  - `"../contract/system.ts"` → `"../../../contract/system.ts"`
  - `"./system/health.ts"` → `"../../system/health.ts"`
  - `"./system/db.ts"` → `"../../system/db.ts"`
  - `"../../queries/system/read-health.ts"` → `"../../../../queries/system/read-health.ts"` (two import statements)
  - `"../../queries/system/read-migration-status.ts"` → `"../../../../queries/system/read-migration-status.ts"`
  - `"../../cli/client.ts"` → `"../../../../cli/client.ts"` (two import statements)
  - `"../../cli/exit-code.ts"` → `"../../../../cli/exit-code.ts"`
  - `"../../../test/helpers/wait-registry.ts"` → `"../../../../../test/helpers/wait-registry.ts"`
  - `"../../../test/helpers/app.ts"` → `"../../../../../test/helpers/app.ts"`
  - `"../../../test/helpers/database.ts"` → `"../../../../../test/helpers/database.ts"`
  - `"../../../test/helpers/port.ts"` → `"../../../../../test/helpers/port.ts"`
- Change the suite name at `src/http/server/start.test.ts:42` from `"src/http/server/start.test"` to `"src/http/server/runtime/node/listen.test"`. Keep every `it(...)` name and every assertion byte for byte, including the two cases EPIC 034 story 2 adds.
- Verify the rewrite by `npm run typecheck`, which fails on an unresolved specifier. A specifier the list above does not name is not an exception to the rule; apply the rule to it.

### 2. Move the schedule

- Add `src/http/server/runtime/node/schedule.ts`:
  - `import type { Schedule } from "../../idempotency-store.ts";`
  - `export const systemSchedule: Schedule` with the body of `src/http/server/app.ts:60-64`, byte for byte: `setTimeout`, `timer.unref()`, and the returned `() => clearTimeout(timer)`.
- Delete `src/http/server/app.ts:60-64`. `app.ts` exports no `systemSchedule` after this story.
- In `src/http/server/app.ts`, replace the fallback `dependencies.schedule ?? systemSchedule` at `:103` with `dependencies.schedule ?? defaultSchedule`, where `defaultSchedule` is a module-local, non-exported `const defaultSchedule: Schedule` placed where `systemSchedule` was. Its body calls `setTimeout` and returns `() => clearTimeout(timer)`, and it does **not** call `unref`. `setTimeout` and `clearTimeout` are Web APIs, so the core imports no Node-only implementation. The EPIC Decision "The `Schedule` default is Web-native, and it stays in the core" fixes this shape.
- Keep `schedule?: Schedule` optional on `AppDependencies` at `src/http/server/app.ts:56`. Keep the `Schedule` type import at `:17`.

### 3. Rewire the composition root

- In `src/main.ts`, remove `systemSchedule` from the `./http/server/app.ts` import list at `:175-178`. The list keeps `createApp` and `unimplementedFor`.
- Replace `import { listen } from "./http/server/start.ts";` at `:179` with `import { listen } from "./http/server/runtime/node/listen.ts";`.
- Add `import { systemSchedule } from "./http/server/runtime/node/schedule.ts";`.
- Keep `systemSchedule as gitSchedule` from `./services/git/run.ts` at `:29` untouched.
- `src/main.ts:256` keeps `createWaitRegistry({ schedule: systemSchedule })`, now bound to the Node root export.
- Add `schedule: systemSchedule,` to the `createApp({ … })` object literal at `src/main.ts:647-666`, beside `now:` at `:663`. The daemon therefore keeps the `unref` behaviour it has today.
- Change no other line of `src/main.ts`.

## Constraints

- No behaviour change. Every route answers the same status, the same headers and the same bytes.
- Move the two files; do not rewrite their logic. `git mv` then edit the specifiers.
- Do not touch `src/services/git/run.ts`.
- Do not make `schedule` required on `AppDependencies`. The other ten `createApp` call sites listed in `index.md` take no edit.
- Create no `src/http/server/runtime/lambda/` and no `src/http/server/runtime/worker/` directory.
- Do not edit `eslint.config.js`, `package.json` or `AGENTS.md`.
- After this story `grep -rn "node:http" src/http/server/` matches only `src/http/server/runtime/node/listen.ts`.

## Verify

- `node --test src/http/server/runtime/node/listen.test.ts` — every case that `src/http/server/start.test.ts` held passes under the new suite name, unchanged.
- `node --test src/http/server/runtime/node/schedule.test.ts` — a new file with three cases. Every case is hermetic: it uses `t.mock.timers.enable({ apis: ["setTimeout"] })` and `t.mock.timers.tick(...)`, and it reads no wall clock and starts no real timer.
  - `systemSchedule` runs its callback at the delay and not before: enable the mock timers, schedule with `1000` milliseconds, `tick(999)` and assert the callback did not run, `tick(1)` and assert it ran exactly once.
  - the returned canceller stops the callback: schedule with `1000` milliseconds, call the canceller, `tick(5000)` and assert the callback did not run.
  - `systemSchedule` unrefs the timer: replace the global with `t.mock.method(globalThis, "setTimeout", () => stub)`, where `stub` is `{ unref: t.mock.fn() }`, call `systemSchedule(1000, () => {})`, and assert `stub.unref.mock.callCount()` equals `1`. Assert no property of the source text.
- `node --test src/http/server/app.test.ts` — passes unchanged. Add two cases:
  - `createApp` called with no `schedule` builds an app, and the module source of `src/http/server/app.ts` contains neither the text `runtime/` nor the text `unref`. Read the source with `readFileSync` and `resolve(import.meta.dirname, "app.ts")`, in the shape of `src/http/server/auth.test.ts:93-98`.
  - `defaultSchedule` runs and cancels under `t.mock.timers`, through a `createApp` built with no `schedule`: assert the app builds and that `src/http/server/app.ts` names `setTimeout` and `clearTimeout`. Story 3 owns the tree-wide invariant; this case pins the one file.
- `node --test src/main.test.ts` — passes unchanged.
- `npm run verify` exits 0, and no test in it starts a timer the story added against a real clock.
- Proof: the `src/http/server/runtime/node/listen.test.ts`, `src/http/server/runtime/node/schedule.test.ts`, `src/http/server/app.test.ts` and `src/main.test.ts` lines of the EPIC Proof.
