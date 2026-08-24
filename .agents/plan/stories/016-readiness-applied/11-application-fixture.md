# Story 11 — The application fixture

Epic: `.agents/plan/epics/016-readiness-applied.md`
Depends on: Story 10.

## Change

Add one new file, `src/main.readiness.test.ts`, with the suite name `"src/main.readiness.test"`. It contains no production code. It follows the pattern of `src/main.test.ts:151-180`.

### The setup, in exactly this order

1. `home = createTemporaryHome()` from `test/helpers/home.ts`.
2. `port = await reservePort()` from `test/helpers/port.ts`.
3. `const configPath = home.writeConfig({ http: { port, allowedHosts: [`127.0.0.1:${port}`] } })`.
4. `await runCli({ args: ["db", "migrate", "--home", home.path] })` from `test/helpers/cli.ts`; assert `code === 0`.
5. **Seed the registry directly into the migrated database, before the daemon starts.** Open `join(home.path, "kanthord.db")` with `DatabaseSync` from `node:sqlite`. Wrap it in a local **`Transaction`-shaped adapter** — `{ run: (sql, p = []) => { db.prepare(sql).run(...p); }, get: (sql, p = []) => db.prepare(sql).get(...p), all: (sql, p = []) => db.prepare(sql).all(...p) }`. Call `db.exec("BEGIN")`, then `seedRegistry(adapter)` from `test/helpers/rows.ts`, then `db.exec("COMMIT")`, then `db.close()`. It is an adapter and not a transaction context; the explicit `BEGIN`/`COMMIT` is what makes the seed atomic. `seedRegistry` writes three blob rows, the provider, `project_a`, the repository named `kanthord-verify`, and the project binding. Do not call `seedGraph`; the import creates every node.
6. `daemon = launchDaemon({ configPath })` from `test/helpers/daemon.ts`; `await daemon.ready()`. `launchDaemon` spawns `process.execPath` with the absolute entry `test/helpers/daemon.ts:26` resolves from `import.meta.url`, so the `tmpdir()` working directory does not affect module resolution.
7. Read `join(home.path, "daemon.lock.identity")` and `JSON.parse` it. Keep `identity.instanceId` in a module-level binding.
8. **Run the whole HTTP sequence once, inside the same `before` hook**, and store every response in a module-level binding. Each `it` asserts over the stored responses and issues no request of its own. A second `plan.import` from an `it` would be a retry and would change the semantics.

Tear down in an `after` hook: `daemon.kill("SIGTERM")`, `await daemon.exited()`, `home.dispose()`. The hook runs whether an `it` failed or not.

Every HTTP call goes through `call()` from `src/cli/client.ts`, with the client dependencies of `src/main.test.ts:138-142`:

```ts
const clientDependencies = () => ({
  baseUrl: `http://127.0.0.1:${port}`,
  token: "test-token",
  fetch: globalThis.fetch,
});
```

`writeConfig` from `test/helpers/home.ts` writes the config whose token that literal matches. Do not invent another token.

**No git operation happens.** `ImportPlanDependencies` at `src/commands/plan/import-plan.ts:35-44` holds `storage`, `plan`, `blobs`, `reader`, `graph`, `ids`, `clock` and `events`, and **no `git` member**. Import resolves `repo: kanthord-verify` to the seeded repository id through a `repository` table read at `src/commands/plan/import-plan.ts:120-127`. It never opens, fetches or clones. That is why the seeded row is the whole registration this test needs.

### The plan documents

Declare these six documents as a module-level constant. Every identity is explicit, so the test asserts an identity it chose.

```
IDENTITY_INITIATIVE = "initiative_01ARZ3NDEKTSV4RRFFQ69G5FAV"
IDENTITY_OBJECTIVE_ALPHA = "objective_01BQZ3NDEKTSV4RRFFQ69G5FAV"
IDENTITY_TASK_ALPHA_ONE  = "task_01DRZ3NDEKTSV4RRFFQ69G5FAV"
IDENTITY_TASK_ALPHA_TWO  = "task_01ERZ3NDEKTSV4RRFFQ69G5FAV"
IDENTITY_OBJECTIVE_BETA  = "objective_01FQZ3NDEKTSV4RRFFQ69G5FAV"
IDENTITY_TASK_BETA_ONE   = "task_01GRZ3NDEKTSV4RRFFQ69G5FAV"
```

The six documents, verbatim. `documents` is `readonly { path: string; content: string }[]` in this order:

```
path: plan/i/initiative.md
---
id: initiative_01ARZ3NDEKTSV4RRFFQ69G5FAV
kind: initiative
title: Two objective readiness
---
Bootstrap the frontier.
```

```
path: plan/i/o--alpha/objective.md
---
id: objective_01BQZ3NDEKTSV4RRFFQ69G5FAV
kind: objective
title: Alpha
repo: kanthord-verify
---
Deliver the first half.
```

```
path: plan/i/o--alpha/01-t.md
---
id: task_01DRZ3NDEKTSV4RRFFQ69G5FAV
kind: task
title: Alpha first
worker: tdd@1
---
Do the first alpha step.

## Acceptance criteria

- The first alpha step is done.
```

```
path: plan/i/o--alpha/02-t.md
---
id: task_01ERZ3NDEKTSV4RRFFQ69G5FAV
kind: task
title: Alpha second
depends_on:
  - task_01DRZ3NDEKTSV4RRFFQ69G5FAV
worker: tdd@1
---
Do the second alpha step.

## Acceptance criteria

- The second alpha step is done.
```

```
path: plan/i/o--beta/objective.md
---
id: objective_01FQZ3NDEKTSV4RRFFQ69G5FAV
kind: objective
title: Beta
depends_on:
  - objective_01BQZ3NDEKTSV4RRFFQ69G5FAV
repo: kanthord-verify
---
Deliver the second half.
```

```
path: plan/i/o--beta/01-t.md
---
id: task_01GRZ3NDEKTSV4RRFFQ69G5FAV
kind: task
title: Beta first
worker: tdd@1
---
Do the first beta step.

## Acceptance criteria

- The first beta step is done.
```

Each `content` value ends with one trailing LF. Every task body carries an `## Acceptance criteria` heading, per `docs/proposal/phase-1/plan-format.md:21`. `repo` is mandatory on an objective and absent on a task, per `:27`. `tdd@1` is a registered worker kind (`src/domain/worker.ts`). Frontmatter key order is `id`, `kind`, `title`, `depends_on`, `worker`, `repo`, per `docs/proposal/phase-1/plan-format.md:49`.

### The HTTP sequence, in exactly this order

1. `plan.validate` with `{ id: "project_a" }` and body `{ fromRevision: null, documents }`. Assert `status === 200`. Bind `validatedRevision = body.revision` and `documentsHash = body.documentsHash`; `src/queries/plan/validate-plan.ts:57-58` returns both. `validatedRevision` is `null` for a first import.
2. `plan.import` with `{ id: "project_a" }` and body `{ fromRevision: validatedRevision, importId: "import-readiness-1", documents, choices: [], validatedRevision, documentsHash }`. Assert `status === 200`. Bind `importedRevision = body.revision`. **`importedRevision` is a different value from `validatedRevision`** — the first names the revision the import minted, the second names the revision the choices were validated against. Keep two bindings and never reuse one name for both.
3. `node.list`. Assert `status === 200`.
4. `node.show` on `IDENTITY_OBJECTIVE_ALPHA` and on `IDENTITY_OBJECTIVE_BETA`. Assert `status === 200` for each.
5. `event.list` with an explicit `limit` of `200`. `src/http/contract/cursor.ts:5` defaults `limit` to `100` and caps it at `500`. The default is enough for this import today, so pass `200` and assert the returned array length is below `200`. The assertion then proves no page was dropped, and it stays sound if a later epic adds startup events.

## Constraints

- The test imports its module under test, `domain/`, service interfaces, `test/helpers/` and `node:` builtins only. It imports no service implementation, and it imports `src/main.ts` not at all. `node:sqlite` is a builtin and is legal here; `eslint.config.js:248-274` and `:300-325` exempt `src/**/*.test.ts`.
- `launchDaemon` passes no parent environment. Do not rely on `PATH` or `HOME`.
- This test proves no packaging. `launchDaemon` spawns `src/main.ts`, `npm run verify` never runs `npm run build`, and `package.json` publishes `dist/main.js`. Assert nothing about `dist/`.
- Do not register a repository over HTTP and do not start a git remote. The seeded `repository` row is the whole registration this test needs.
- Do not assert a timestamp and do not assert a minted event id.
- Do not assert a node count in place of a frontier. Every state assertion names an identity.

## Verify

Every bullet below is one `it` in `src/main.readiness.test.ts`.

- `it("an import leaves the exact ready frontier", ...)` — assert the `node.list` body holds exactly six nodes, and assert the `{ id, state }` pair of each with `assert.deepEqual` against this exact list, sorted bytewise by `id`:
  - `initiative_01ARZ3NDEKTSV4RRFFQ69G5FAV` → `ready`
  - `objective_01BQZ3NDEKTSV4RRFFQ69G5FAV` → `ready`
  - `objective_01FQZ3NDEKTSV4RRFFQ69G5FAV` → `pending`
  - `task_01DRZ3NDEKTSV4RRFFQ69G5FAV` → `ready`
  - `task_01ERZ3NDEKTSV4RRFFQ69G5FAV` → `pending`
  - `task_01GRZ3NDEKTSV4RRFFQ69G5FAV` → `ready`
- `it("a node with no dependency edge is ready at all three kinds", ...)` — assert `ready` for the initiative, for the alpha objective and for the alpha first task, each named by identity.
- `it("node.show returns ready for the first objective and pending for the second", ...)` — assert `state` on both `node.show` bodies.
- `it("the import appends exactly four node.ready events, in the exact order", ...)` — filter the `event.list` body to `type === "node.ready"` and assert the `subjectId` sequence deep-equals `["initiative_01ARZ3NDEKTSV4RRFFQ69G5FAV", "objective_01BQZ3NDEKTSV4RRFFQ69G5FAV", "task_01DRZ3NDEKTSV4RRFFQ69G5FAV", "task_01GRZ3NDEKTSV4RRFFQ69G5FAV"]`. Assert no `node.pending` event exists. **This asserts one exact sequence and does not prove bytewise ordering**: these six identities sort the same way under a locale-sensitive, a kind-first and a ULID-first comparator. EPIC bullet `:96` — the locale-versus-bytewise guarantee — is delivered by Story 2 with the identities `node_Z`, `node_a` and `node_B`, and by Story 7 over the recorded appends.
- `it("every node.ready event carries the daemon instance identity", ...)` — for each of the four events assert `actorKind === "daemon"` and `actorId === identity.instanceId`, read from `<home>/daemon.lock.identity`.
- `it("the readiness attribution differs from the import attribution", ...)` — read the six `node.imported` events and the one `plan.imported` event out of the same `event.list` body. Assert, in this one test:
  - the seven import events share **one** actor id: `new Set(importEvents.map((e) => e.actorId)).size === 1`. Bind that value as `importActorId`.
  - every import event has `actorKind === "human"`.
  - every `node.ready` event has `actorKind === "daemon"` and `actorId === identity.instanceId`.
  - `importActorId !== identity.instanceId`.

  Asserting only "the values differ" would pass for a random or wrong import actor. The set-size assertion plus the two exact `actorKind` assertions pin both attributions, and they do not couple to the shape of the actor id that EPIC 015 resolves.

- `it("every node.ready payload names the import that caused it", ...)` — for each of the four events assert `payload.revision === importedRevision`, `payload.importId === "import-readiness-1"`, `payload.reason === "dependency-satisfied"`, `payload.from === "pending"` and `payload.to === "ready"`. Use `importedRevision`, never `validatedRevision`.
- `it("the composition binds a real readiness", ...)` — this is the previous bullets taken together; state it as an assertion that the four `node.ready` events exist at all. A no-op readiness produces none, and no component test can prove the real composition root selected `DependencyReadiness`.
- Run `node --test --test-timeout=60000 src/main.readiness.test.ts`; it exits 0.
- `node --test --test-timeout=60000 src/main.test.ts src/main.readiness.test.ts` exits 0. The two suites each own a temporary home and a reserved port, so they never share state.
- `npm run verify` exits 0.
- Proof: `PASS EPIC-016`, through `src/main.readiness.test.ts`, which is named explicitly in the Proof block and does not exist before this epic. Hermetic coverage: `.agents/plan/epics/016-readiness-applied.md:86`, `:87`, `:88` and `:89`. The waived-edge bullet at `:90` is delivered by Story 2 and Story 4: no route writes `edge.waived_at` in phase 1, so no application fixture can reach it.
