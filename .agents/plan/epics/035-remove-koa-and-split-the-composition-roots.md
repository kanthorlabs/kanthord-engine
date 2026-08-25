# EPIC 035 — Remove koa, and split the composition roots

Status: **draft**. It is the sixth and last Hono epic of the 030–039 band, inside phase 1b, after
EPIC 029. It depends on EPIC 032, EPIC 033 and EPIC 034. Three of its actions edit a file that
`scripts/lane-check.sh:36-48` locks: `package.json`, `eslint.config.js` and `AGENTS.md`. They are
S1, S2 and S3 under `## Open items`. **The epic completes only when the human applies S1, S2 and
S3.** The stories land the source edits; the three suggestions close the door.

**Human action required at completion.** Two of the three are partly applied already, on 2026-08-23:

- `eslint.config.js` now confines `hono`, `hono/*` and `@hono/*` the same way it confines `koa` and
  `@koa/*`. The remaining half of S2 bans `koa` and `@koa/*` inside `src/http/server/**` too. It
  lands only after story 4, because the ban fails `npm run lint` while one koa import survives.
- `AGENTS.md` now names the framework without naming koa, and it names this band. The remaining half
  of S3 adds the core-purity row to the enforcement table. It lands with story 3, which supplies the
  mechanism that row cites.
- S1 is untouched and unchanged. Remove the five koa entries from `package.json` after story 4 and
  after `npm run verify` is green.

## Goal

Two jobs. The first removes Koa. The second carries the value.

**Job one — remove Koa.** EPIC 032 and EPIC 034 replace every Koa import. This epic proves the tree
is clean and keeps it clean.

**Job two — split the composition roots.** A framework swap does not make the transport portable.
Node-only calls sit in modules that every runtime shares. This epic names each one and gives it a
home.

The shape the tree ships:

| Where                           | Rule                                                    |
| ------------------------------- | ------------------------------------------------------- |
| `src/http/server/**`            | the Fetch-native core. No `node:` import.               |
| `src/http/server/runtime/node/` | the Node runtime root. It names every Node-only API.    |
| `src/main.ts`                   | the process composition root. It imports the Node root. |

## Non-goals

- **No new runtime entrypoint.** The band builds no Lambda handler and no Worker export. EPIC 036
  gates that decision.
- **No behaviour change.** Every route answers the same status, the same headers and the same bytes.
- **No new operation.** The registry is unchanged.
- **No change to the import matrix rows.** The core keeps the `http/server/` row of `AGENTS.md`. The
  runtime root is a directory inside that row, not a seventh top-level directory.
- **No test-boundary work.** The phase-2 TODO of `AGENTS.md` stays open. See `## Open items`.

## Decisions

- **The Fetch-native core is `src/http/server/**` except `src/http/server/runtime/**`.** No file in
  the core imports a `node:` builtin. The core uses Web APIs only: `Request`, `Response`, `Headers`,
  `TextEncoder`, `Uint8Array` and `crypto.subtle`. `src/http/server/node/` holds the handlers of the
  `node` domain entity, so the runtime directory takes the name `runtime` and the collision cannot
  happen.

- **Each runtime gets its own root, and only a root names a platform API.** The Node root is
  `src/http/server/runtime/node/`. It holds the listener, the timer schedule and the node adapter of
  EPIC 034. The Lambda root `src/http/server/runtime/lambda/` and the Worker root
  `src/http/server/runtime/worker/` are declared here and built by nobody. EPIC 036 decides whether
  they get built at all. Phase 1b ships the Node root alone.

- **A bundler cannot traverse a Node-only implementation from the core.** The core imports a type or
  an interface, and a root imports the implementation. `AGENTS.md` already states that rule for a
  service; this epic applies the same rule to the transport. `Schedule` is the example: the core
  declares the type, and the Node root supplies `systemSchedule`.

- **A test enforces the invariant, not a reviewer.** `AGENTS.md` holds an enforcement table, and each
  rule in it names one mechanism. The mechanism here is `src/http/server/core-purity.test.ts`. It
  walks the core tree and fails on a `node:` import, and the failure names the offending file. S2
  adds the eslint rule beside it, and S3 adds the row to the table.

- **A second test bans Koa across the tree.** `src/koa-absence.test.ts` scans `src/`, `test/` and
  `scripts/` and fails on the string `koa`. The ban therefore holds from the moment the stories land,
  before the human applies S2.

- **The bytewise comparator is Web-native, and EPIC 031 already added it.** EPIC 031 creates
  `src/http/server/bytewise.ts` with `compareBytewise`, and it migrates `dispatch.ts`, `query.ts`,
  `single.ts`, `invalid-request.ts` and `idempotency-response.ts`. This epic adds `byteLength` to
  that same file and migrates the remaining call sites. A second helper file is a defect.
  Determinism is unchanged: the comparison stays bytewise on UTF-8, which is what `Buffer.compare`
  gave. The `AGENTS.md` determinism rule keeps its meaning, and the non-ASCII ordering test keeps its
  assertion.

- **The idempotency fingerprint uses Web Crypto, and it becomes async.** `crypto.subtle.digest`
  returns a promise, so `fingerprint` returns `Promise<string>`. It has one call site,
  `src/http/server/idempotency.ts:85`, and that site is already async. The digest stays SHA-256 and
  the hex encoding is unchanged, so an existing record key still matches.

- **`@koa/cors` was dead before this epic.** It sits in `package.json` and in no file under `src/`,
  `test/` or `scripts/`. `src/http/server/origin.ts` is hand-rolled. Removal of that package is not a
  saving this refactor produced, and S1 states so.

## Stories

Author with `/author`. The sequence below is the dependency order; each story is one commit.

1. **The Node-only modules move to the Node root.** Move `src/http/server/start.ts` to
   `src/http/server/runtime/node/listen.ts`, and move its test to
   `src/http/server/runtime/node/listen.test.ts`. Move `systemSchedule` out of
   `src/http/server/app.ts:60-64` into `src/http/server/runtime/node/schedule.ts`. `app.ts` keeps the
   `Schedule` type and exports no implementation. Update `src/main.ts:175-179`, `:256` and `:644` to
   import from the new paths. After this story `node:http` appears in no core file.
2. **The core drops `node:buffer` and `node:crypto`.** Add `byteLength(value: string): number` to
   `src/http/server/bytewise.ts`, over the module-level `TextEncoder` that EPIC 031 added there. In
   `src/http/server/idempotency-key.ts` replace `Buffer.byteLength` at `:55` with `byteLength`,
   `Buffer.compare` at `:69` with `compareBytewise`, and `createHash` at `:57` with
   `crypto.subtle.digest("SHA-256", …)`. `fingerprint` returns `Promise<string>`. Await it at
   `src/http/server/idempotency.ts:85`. Delete the `node:crypto` import from `idempotency-key.ts`;
   it carries no `node:buffer` import, because every `Buffer` use there is the global. Replace the
   six global `Buffer.byteLength` calls at `src/http/server/idempotency-store.ts:61-62`, `:98-99`
   and `:112-113` with `byteLength`. EPIC 031 already removed `node:buffer` from `dispatch.ts`,
   `query.ts`, `single.ts`, `invalid-request.ts` and `idempotency-response.ts`, so this story
   touches neither.
3. **The core-purity test fails on a `node:` import.** Add `src/http/server/core-purity.test.ts`. It
   reads every `.ts` file under `src/http/server/`, skips `runtime/` and skips `*.test.ts`, and
   asserts no file matches an import from a `node:` specifier. The assertion message names the file
   and the specifier. The test reads the tree from disk, so a new core file is covered on the day it
   lands.
4. **The Koa-absence test fails on a `koa` import.** Add `src/koa-absence.test.ts`. It reads every
   file under `src/`, `test/` and `scripts/`, and asserts none contains the string `koa`. The
   assertion message names the file and the line number. The test excludes itself by path.
5. **The proposal states the transport structure.** Amend `docs/proposal/phase-1/transport.md`. Add
   one section after `:10`, named `## The transport core and its runtime roots`. It states the core
   directory, the no-`node:` invariant, the Node root, and the two declared unbuilt roots. It names
   the enforcing test. No code.

## Verification gate

Gates: `npm run verify`

Proof:

```bash
node --test \
  src/http/server/core-purity.test.ts \
  src/koa-absence.test.ts \
  src/http/server/bytewise.test.ts \
  src/http/server/runtime/node/listen.test.ts \
  src/http/server/runtime/node/schedule.test.ts \
  src/http/server/app.test.ts \
  src/http/server/dispatch.test.ts \
  src/http/server/query.test.ts \
  src/http/server/single.test.ts \
  src/http/server/invalid-request.test.ts \
  src/http/server/idempotency-key.test.ts \
  src/http/server/idempotency.test.ts \
  src/http/server/idempotency-record.test.ts \
  src/http/server/idempotency-response.test.ts \
  src/http/server/idempotency-store.test.ts \
  src/http/server/route.test.ts \
  src/http/server/envelope.test.ts \
  src/http/server/auth.test.ts \
  src/http/server/authorize.test.ts \
  src/http/server/host.test.ts \
  src/http/server/origin.test.ts \
  src/http/server/preflight.test.ts \
  src/http/server/shutdown.test.ts \
  src/http/server/blob/show-blob.test.ts \
  src/http/server/event/list-event.test.ts \
  src/main.test.ts \
  && echo "PASS EPIC-035"
```

Hermetic coverage required beyond the Proof:

- **`npm run verify` is clean**: `typecheck`, the full `node:test` suite, `eslint .`, and
  `verify-db-status`.
- **`grep -rn "koa" src/ test/ scripts/` returns nothing**, asserted by `src/koa-absence.test.ts`
  rather than by hand. The test names the offending file and line on failure.
- **No file in the Fetch-native core imports a `node:` builtin**, asserted by
  `src/http/server/core-purity.test.ts`. The failure names the offending file and the specifier. A
  file added under `src/http/server/runtime/` does not trigger it, and a file added anywhere else
  under `src/http/server/` does.
- **The daemon boots and answers a request end to end.** One daemon-backed test starts the process,
  sends an authenticated request, reads the status and the body, and stops the process.
- **Every EPIC 030 parity test still passes.** The transport inventory and the parity contract of
  EPIC 030 run unchanged, and no expectation in them is edited by this epic.
- **The bytewise order is unchanged.** The non-ASCII ordering test of the determinism rule asserts
  the same order through `compareBytewise` that it asserted through `Buffer.compare`.
- **The idempotency fingerprint is stable.** An exact-string test pins the SHA-256 hex for one named
  method, path, query and body, and the value equals the value the `node:crypto` implementation
  produced.
- **The Node root is the only Node-only place.** `src/http/server/runtime/node/` holds the listener
  and the schedule, and `src/main.ts` is the only importer of both.
- **No test depends on a wall clock, a shared temporary directory, or an ambient git configuration.**
  A test that needs a home uses its own `mktemp` directory and removes it.

## Open items

- S1 - status:OPEN - action:YES - remove the Koa dependencies - `package.json` carries five Koa
  packages that no file imports after story 4. - fix:Delete `koa`, `@koa/bodyparser` and `@koa/cors`
  from `dependencies`, and `@types/koa` and `@types/koa__cors` from `devDependencies`. Run
  `npm install` to update `package-lock.json`. - why:`scripts/lane-check.sh:41` locks the toolchain
  manifest, so no agent lane edits it. Note two facts. `hono` and `@hono/node-server` entered through
  the suggestions of EPIC 032 and EPIC 034, so the net dependency count is close to break-even, and
  this refactor does not justify itself on that count. `@koa/cors` was already dead: it appears in
  `package.json` and in no file under `src/`, `test/` or `scripts/`, because
  `src/http/server/origin.ts` is hand-rolled.
- S2 - status:OPEN - action:YES - ban Koa in eslint - `eslint.config.js` has no rule against a Koa
  import, so a new one passes lint. - fix:Add a `no-restricted-imports` group to the
  `files: ["src/**/*.ts"]` block at `eslint.config.js:237-257`, beside the `gitLibraries` group and
  the `node:child_process` group. Use `group: ["koa", "@koa/*"]` and the message
  `"the transport runs on hono; see docs/proposal/phase-1/transport.md"`. - why:`scripts/lane-check.sh:47-49`
  locks every `*.config.*` file. The test of story 4 holds the ban until this lands, and the eslint
  rule gives the faster failure afterwards.
- S3 - status:OPEN - action:YES - amend the architecture contract - `AGENTS.md` names koa in the
  `src/http/server/**` line, and its enforcement table has no row for the core invariant. -
  fix:Change the `http/server/**` line to read `the runtime roots, the middleware, and the handlers`.
  Add one enforcement row: rule `no node: import in the Fetch-native core`, mechanism
  `src/http/server/core-purity.test.ts, plus a no-restricted-imports glob`. - why:`scripts/lane-check.sh:43`
  locks the architecture contract. The sentence becomes false on the day story 1 lands, and a rule
  with no mechanism is a rule a reviewer applies inconsistently.
- **The `AGENTS.md` test-boundary TODO is not a blocker here.** That clause forbids a new **phase-2**
  epic before it closes. This epic is phase 1b, and the band 030–039 is phase 1b.
- **The Lambda root and the Worker root stay unbuilt.** This epic declares the two directory names and
  creates neither. EPIC 036 decides whether the product ships either one.
