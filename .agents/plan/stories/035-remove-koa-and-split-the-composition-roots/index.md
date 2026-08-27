# EPIC 035 — Remove koa, and split the composition roots — stories

Epic: `.agents/plan/epics/035-remove-koa-and-split-the-composition-roots.md`
Prereq: EPIC 034 (sequence order). EPIC 031, EPIC 032, EPIC 033 and EPIC 034 land first.

After this epic `src/http/server/**` is the Fetch-native core with no `node:` import, `src/http/server/runtime/node/` is the only Node-only place in the transport, and no file under `src/`, `test/` or `scripts/` names koa.

## Dispatch order

1 → 2 → 3 → 4 → 5. Each story is one commit.

Story 1 and story 2 are the source moves. Story 3 and story 4 add the two enforcing tests, and each one fails before its predecessor lands. Story 5 is documentation only and depends on story 1 for the directory names.

## Stories

- 1 — the Node-only modules move to `src/http/server/runtime/node/` → `01-node-only-modules-move-to-the-node-root.md`
- 2 — the core drops `node:crypto` and the global `Buffer` → `02-the-core-drops-node-crypto-and-buffer.md`
- 3 — `core-purity.test.ts` fails on a `node:` import in the core → `03-the-core-purity-test.md`
- 4 — `koa-absence.test.ts` fails on the string `koa` → `04-the-koa-absence-test.md`
- 5 — `docs/proposal/phase-1/transport.md` states the structure → `05-the-proposal-states-the-transport-structure.md`

## Proof coverage

Each Proof file belongs to exactly one story, or to the regression set.

| Proof file                                      | Story |
| ----------------------------------------------- | ----- |
| `src/http/server/core-purity.test.ts`           | 3     |
| `src/koa-absence.test.ts`                       | 4     |
| `src/http/server/bytewise.test.ts`              | 2     |
| `src/http/server/runtime/node/listen.test.ts`   | 1     |
| `src/http/server/runtime/node/schedule.test.ts` | 1     |
| `src/http/server/app.test.ts`                   | 1     |
| `src/http/server/dispatch.test.ts`              | 2     |
| `src/http/server/query.test.ts`                 | 2     |
| `src/http/server/single.test.ts`                | 2     |
| `src/http/server/invalid-request.test.ts`       | 2     |
| `src/http/server/idempotency-key.test.ts`       | 2     |
| `src/http/server/idempotency.test.ts`           | 2     |
| `src/http/server/idempotency-record.test.ts`    | 2     |
| `src/http/server/idempotency-response.test.ts`  | 2     |
| `src/http/server/idempotency-store.test.ts`     | 2     |
| `src/main.test.ts`                              | 1     |

`src/http/server/core-purity.test.ts` of story 3 also carries the EPIC gate row "the Node root is the only Node-only place": it asserts that no core file reaches `runtime/` or `@hono/node-server`, and that `src/main.ts` is the only production importer of the Node root. No other test proves that row.

The remaining ten Proof files are the regression set. No story edits one, and every one stays green after every story: `route.test.ts`, `envelope.test.ts`, `auth.test.ts`, `authorize.test.ts`, `host.test.ts`, `origin.test.ts`, `preflight.test.ts`, `shutdown.test.ts`, `blob/show-blob.test.ts` and `event/list-event.test.ts`. A story that has to edit one of them has found a defect; report it rather than edit the expectation.

## Facts (needed for implementation)

- **Every line number in the EPIC and in these stories is the line number of the tree today, 2026-08-27.** EPIC 031, 032, 033 and 034 rewrite `src/http/server/app.ts`, `src/http/server/start.ts`, `src/http/server/idempotency-key.ts`, `src/http/server/idempotency.ts` and `src/main.ts` first. Anchor every edit on the named symbol, and read the line number as a locator only.
- **`src/http/server/runtime/` needs no `eslint.config.js` edit.** `eslint.config.js:111-115` declares the `http-server` element as `pattern: "src/http/server"` with `partialMatch: false`, so a file under `src/http/server/runtime/node/` is already an `http-server` file. `boundaries/no-unknown-files` does not fire.
- **`src/koa-absence.test.ts` needs no `eslint.config.js` edit.** `eslint.config.js:120-126` classifies `src/**/*.test.ts` as category `test`, which is how `src/main.test.ts` passes today.
- **There are two `systemSchedule` exports.** `src/http/server/app.ts:60` is the transport one, and `src/services/git/run.ts:43` is the git one. `src/main.ts:29` imports the git one as `gitSchedule`. Story 1 moves the transport one only.
- **`Schedule` is declared in `src/http/server/idempotency-store.ts:18`, not in `app.ts`.** `app.ts:17` imports it as a type.
- **The core holds two Node-only forms, and only one carries a `node:` specifier.** An `import … from "node:…"` is what story 3 detects. The global `Buffer` carries no import, so no rule and no test reaches it; story 2 removes the last core uses of it by hand.
- **`node:` appears as an object property in two non-test core files.** `src/http/server/node/create-node.ts:33` and `src/http/server/node/update-node.ts:33` read `node: parsed.data.node,`. A story-3 test that matches the bare text `node:` fails on both. The test must match import syntax.
- **A source-reading test already exists in the tree.** `src/http/server/auth.test.ts:1-2` imports `readFileSync` from `node:fs` and `resolve` from `node:path`, and `:93-98` asserts a string is absent from a source file. Stories 3 and 4 follow that shape.
- **A tree-reading helper already exists.** `test/helpers/proposal.ts:1-13` uses `readdirSync`, `readFileSync` and `resolve(import.meta.dirname, …)`. Stories 3 and 4 resolve their roots the same way.
- **`node --test` with no path argument discovers `**/*.test.ts`.** `scripts/run-tests.mjs:37-40` passes no path, so a new test file joins `npm test` on the day it lands.
- **`npm run verify` runs `prettier --write` first.** A new file must already be prettier-clean, or the format step rewrites it inside the gate.
- **`src/http/server/idempotency-key.ts` imports `node:crypto` only.** It has no `node:buffer` import today; it reads the global `Buffer` at `:55`, `:57` and `:69`.
- **EPIC 031 story 1 already takes `idempotency-key.ts:69`.** That story replaces the `Buffer.compare` comparator there with `compareBytewise` and adds the `./bytewise.ts` import to the file. Story 2 of this epic therefore extends an import that exists, and it edits `:55` and `:57` only.
- **`prettier` realigns a markdown table to its longest cell.** A story that inserts a table into a `docs/` file states that the `prettier --write` output is the committed text, and it asserts no byte-for-byte equality with the text the story quotes.
- **`src/http/server/idempotency-store.ts` reads the global `Buffer` at six sites**: `:61`, `:62`, `:98`, `:99`, `:112` and `:113`. EPIC 031 declares these out of its scope, so story 2 takes them.
- **`fingerprint` has exactly one call site**, `src/http/server/idempotency.ts:85`, inside an `async` middleware.
- **`createApp` has 12 call sites, and none of them passes `schedule`.** `src/main.ts:647`, `src/http/server/app.test.ts:359` and `:379`, `src/http/server/dispatch.test.ts:138`, `:156`, `:174`, `:191`, `:207` and `:225`, `src/http/server/start.test.ts:26` and `:107`, and `test/helpers/app.ts:127`. `src/http/server/authorize.test.ts:159` passes a `schedule` to `createIdempotency`, not to `createApp`. Story 1 keeps `schedule` optional, so eleven of those sites take no edit and `src/main.ts:647` takes one.
- **`Schedule` reaches a timer at one place.** `src/http/server/idempotency-store.ts:219` calls `this.schedule(joinTimeoutSeconds * 1000, …)` for a join timeout and cancels it on settle. No other code path creates a timer from `schedule`.
- **No test reads `docs/proposal/phase-1/transport.md`.** Story 5 breaks no assertion.
- **The Proof of the EPIC is one command that ends `echo "PASS EPIC-035"`.** Each story names the files of that command it delivers or must keep green.
