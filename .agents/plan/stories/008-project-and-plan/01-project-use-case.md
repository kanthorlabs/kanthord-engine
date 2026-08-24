# Story 01 — the project use case

Epic: `.agents/plan/epics/008-project-and-plan.md`

`project.create`, `project.list`, `project.show` and `project.repositories`. The binding set is what import checks an objective's `repo` against, so every later story depends on this one.

## Change

### 1. `src/domain/project-view.ts` (new — pure)

```ts
export type ProjectView = Readonly<{
  id: string;
  name: string;
  repositories: readonly string[];
  updatedAt: number;
}>;
```

The view lives in `domain/` because one command and two queries all return it. A query may **not** import a command (`eslint.config.js:117-129`, plus `src/domain/layout.test.ts:175-205`), so re-exporting it from the command module would be an illegal dependency.

### 2. `src/commands/project/create-project.ts` (new)

```ts
export type CreateProjectDependencies = Readonly<{
  storage: Storage;
  ids: IdGenerator;
  clock: Clock;
  events: EventLog;
}>;

export type CreateProjectInput = Readonly<{ name: string; actor: string }>;

export type CreateProjectRefusal = "name-taken";

export class CreateProjectError extends Error {
  readonly refusal: CreateProjectRefusal;
}

export function createProject(
  dependencies: CreateProjectDependencies,
  input: CreateProjectInput,
): ProjectView;
```

Mirror `src/commands/provider/register-provider.ts:50-100` exactly: mint the id and read the clock **before** `transact`, then in one transaction `SELECT id FROM project WHERE name = ?`, refuse `name-taken`, insert, and append the event.

```sql
INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)
```

`worker` and `e2e_json` are inserted as `null`. `project.worker` is written by `binding.worker.project`, which is `stubbed` (`src/http/contract/project.ts:34-44`), and `e2e_json` by a `post-mvp` route.

The event is `{ subjectKind: "project", subjectId: id, type: "project.created", actorKind: "human", actorId: input.actor, payload: { name } }`, appended inside the same transaction through `EventLog.append(transaction, …)` (`src/services/event/index.ts:47`).

The returned view carries `repositories: []`.

### 3. `src/commands/project/replace-project-repositories.ts` (new)

```ts
export type ReplaceProjectRepositoriesInput = Readonly<{
  id: string;
  repositories: readonly string[];
  actor: string;
}>;

export type ReplaceProjectRepositoriesRefusal =
  | "project-not-found"
  | "repository-not-found"
  | "too-many-repositories"
  | "duplicate-repository";
```

One transaction, in this order:

1. `SELECT id, name, updated_at FROM project WHERE id = ?` — absent is `project-not-found`.
2. `input.repositories.length > 1` is `too-many-repositories`. `docs/proposal/api/project.md:27` — the MVP binds one repository per project and the daemon refuses a longer list.
3. A repeated id is `duplicate-repository`. The check is a `Set` over the input, before any read.
4. For each id in the input order, `SELECT id FROM repository WHERE id = ?` — absent is `repository-not-found`.
5. `DELETE FROM project_binding WHERE project_id = ? AND kind = 'git'`, then one `INSERT INTO project_binding (project_id, kind, target_id, created_at) VALUES (?, 'git', ?, ?)` per id in the input order. `PUT` replaces, per `docs/proposal/api/project.md:21`.
6. Append `{ type: "project.repositoriesReplaced", subjectKind: "project", subjectId: id, payload: { repositories: input.repositories } }`.

`kind = 'provider'` bindings are never read and never deleted: the `DELETE` names `kind = 'git'`, because `project_binding` carries both kinds (`src/services/storage/migration-0001-core-entities.ts:33`).

`project.updated_at` is **not** rewritten. `docs/proposal/database/project.md:11` defines the column as "last edit of a default", and a binding set is not a default.

The command returns the `ProjectView` assembled from the row it already read plus `input.repositories`, so no second read runs.

### 4. `src/queries/project/show-project.ts` (new)

```ts
export type ShowProjectDependencies = Readonly<{ storage: Storage }>;

export function showProject(
  dependencies: ShowProjectDependencies,
  input: Readonly<{ id: string }>,
): ProjectView | null;
```

Two statements inside one `transact`:

```sql
SELECT id, name, updated_at FROM project WHERE id = ?
SELECT target_id FROM project_binding WHERE project_id = ? AND kind = 'git' ORDER BY target_id ASC
```

An absent row returns `null`. `ProjectView` is imported from `src/domain/project-view.ts`, so one shape serves all four routes and no query imports a command.

### 5. `src/queries/project/list-project.ts` (new)

```ts
export function listProjects(
  dependencies: ShowProjectDependencies,
  input: Readonly<Record<string, never>>,
): readonly ProjectView[];
```

`SELECT id, name, updated_at FROM project ORDER BY id ASC`, then one binding statement per row in that order. `ORDER BY id ASC` is the order rule: a project id carries a ULID, so creation order is recovered with no timestamp column.

### 6. `src/http/contract/project.ts` — five schemas

Insert above `export const project = operations([` at `:4`:

```ts
export const projectName = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

export const projectCreateRequest = z.object({ name: projectName });

export const projectView = z.object({
  id: z.string(),
  name: z.string(),
  repositories: z.array(z.string()),
  updatedAt: z.number(),
});

export const projectCreateResponse = projectView;
export const projectShowResponse = projectView;
export const projectListResponse = z.object({ projects: z.array(projectView) });
export const projectRepositoriesRequest = z.object({
  repositories: z.array(z.string().min(1)),
});
export const projectRepositoriesResponse = projectView;
```

`projectName` copies the `repositoryName` grammar at `src/http/contract/repository.ts:39-43`, so the two resources spell a name the same way.

`worker` and `e2eJson` are **not** members of `projectView`. Both are written only by a `stubbed` or `deferred` route, so a member that is always `null` would be contract for a value this phase cannot produce. This is the rule Story 11 of EPIC 007 applied to the profile hash.

Attach `request` and `response` to the four `routed` entries at `:6-32`. Set no `successStatus`: `src/http/contract/openapi.test.ts:199-202` asserts that no entry sets one.

### 7. `src/http/server/project/` (new — four handler files plus `refusals.ts`)

`create-project.ts`, `list-project.ts`, `show-project.ts`, `replace-project-repositories.ts`. Each parses, calls exactly one command or query, and formats. Mirror `src/http/server/repository/show-repository.ts:1-25` for a parameterised read and `register-repository.ts:15-43` for a body-parsing write.

- `create` and `replace` `safeParse` their contract schema and throw `httpError("invalid-request", …)` on failure, then wrap the call in `try/catch (error) { throw toHttpError(error); }`.
- `show` throws `httpError("not-found", `no project ${id}`)` on a `null` result, and on an absent `context.parameters["id"]`.
- `list` reads no query parameter. `HandlerContext` is `{ operation, parameters, body }` (`src/http/server/app.ts:21-25`) and carries no query string, so no list route in this product filters.
- `replace` reads `context.parameters["id"]` and ignores any `id` in the body.

`src/http/server/project/refusals.ts` maps every refusal, following `src/http/server/repository/refusals.ts:8-40`:

| refusal                 | `httpError`                                         |
| ----------------------- | --------------------------------------------------- |
| `name-taken`            | `invalid-request`, `details.refusal = "name-taken"` |
| `project-not-found`     | `not-found`                                         |
| `repository-not-found`  | `not-found`                                         |
| `too-many-repositories` | `invalid-request`, `details.refusal`                |
| `duplicate-repository`  | `invalid-request`, `details.refusal`                |

An unrecognised error is re-thrown, as at `repository/refusals.ts:89`.

### 8. `src/main.ts` — bind four handlers

Add `"project.create"`, `"project.list"`, `"project.show"` and `"project.repositories"` to the `handlers` literal at `:142-189`, wired as `provider.*` is. The `unimplemented` filter at `:190-193` needs no edit.

### 9. Contract test counts after this story

- `src/http/contract/registry.test.ts:78-99` — the `request` list deep-equals `["project.create","project.repositories","provider.register","repository.inspect","repository.register"]` (5) and the `response` list deep-equals `["project.create","project.list","project.repositories","project.show","provider.list","provider.register","provider.show","repository.inspect","repository.list","repository.register","repository.show","system.db","system.health"]` (13). Both bytewise sorted. Update the title to name the counts.
- `src/http/contract/openapi.test.ts:205-224` — `components.schemas` keys count **19** and deep-equal the bytewise sort of `Error` plus those five request ids and thirteen response ids.
- `src/http/contract/system.test.ts:173-196` — the same two lists, `withResponse.length` becomes 13.
- Unchanged: `registry.test.ts:14-16` (53), `:29-38` (23 routed / 30 stubbed), `parity.test.ts:12-22`, `openapi.test.ts:74-80` (47 paths), `:112-120` (53 ids), `:184-203` (no `successStatus`), `app.test.ts:160-165` and `dispatch.test.ts:182-194` (21 unimplemented — both bind only the two system routes).

## Constraints

- No migration. `project` and `project_binding` already exist (`migration-0001-core-entities.ts:26,33`), and no column is added, so no `docs/proposal/database/*.md` SQL fence is edited.
- `Transaction` is synchronous (`src/services/storage/index.ts:1-5`), and every command and query here is synchronous end to end.
- One command is one transaction. The event is appended inside it.
- No query selects `*`.
- `ProjectView` lives in `domain/`. No query and no handler imports a command module for a type.
- `project.repositories` deletes only `kind = 'git'` rows.
- The refusal order in `replaceProjectRepositories` is fixed: project, length, duplicate, repository existence. A test asserts each refusal with the other faults absent and one case that carries two faults, to pin the order.

## Verify

```
node --test src/domain/project-view.test.ts \
  src/commands/project/create-project.test.ts \
  src/commands/project/replace-project-repositories.test.ts \
  src/queries/project/show-project.test.ts \
  src/queries/project/list-project.test.ts \
  src/http/server/project/create-project.test.ts \
  src/http/server/project/list-project.test.ts \
  src/http/server/project/show-project.test.ts \
  src/http/server/project/replace-project-repositories.test.ts \
  src/http/contract/registry.test.ts src/http/contract/openapi.test.ts \
  src/http/contract/system.test.ts
```

Storage is real SQLite through `createMigratedStorage()` (`test/helpers/database.ts:30`). `ids` is `createMockIdGenerator({ ulids: [...] })` (`test/helpers/ids.ts:8`) and `clock` is `createMockClock({ start: 1700000000000, step: 1000 })` (`test/helpers/clock.ts:5`). The event log is a hand-written fake recording `(transaction, input)` pairs.

### `project-view.test.ts`

- `Object.keys` of one literal of the shape, bytewise sorted, deep-equals `["id","name","repositories","updatedAt"]`. A member added for one route and not another fails here.

### `create-project.test.ts`

- A create returns `{ id: "project_<the mock ulid>", name, repositories: [], updatedAt: 1700000000000 }`, and `Object.keys(view)` bytewise sorted deep-equals `["id","name","repositories","updatedAt"]`.
- The row is readable: `SELECT worker, e2e_json FROM project WHERE id = ?` returns both `null`.
- A second create with the same name throws `CreateProjectError` with `refusal === "name-taken"`, and `SELECT COUNT(*) FROM project` is unchanged from before the call.
- The event fake recorded exactly one append, with `type === "project.created"`, and its `transaction` is the same object the insert used.
- The refusal writes no event: after the `name-taken` case the fake recorded one append in total.

### `replace-project-repositories.test.ts`

Seed with `seedRegistry` (`test/helpers/rows.ts:21`), which writes `project_a`, `repo_a` and one `git` binding.

- Replacing with `[]` leaves `SELECT COUNT(*) FROM project_binding WHERE kind='git'` at `0`, and the view's `repositories` is `[]`.
- Replacing with `["repo_a"]` on an empty binding set inserts one row, and the view's `repositories` deep-equals `["repo_a"]`.
- A second repository row inserted directly, then `["repo_a","<the second>"]`, throws `too-many-repositories`, and the binding table is byte-identical to before (compare the full `SELECT project_id, kind, target_id FROM project_binding ORDER BY target_id`).
- `["repo_a","repo_a"]` throws `duplicate-repository`.
- `["repo_missing"]` throws `repository-not-found` and the existing binding survives.
- An unknown project id throws `project-not-found`.
- A `provider` binding inserted directly survives a `git` replacement.
- `project.updated_at` is the same value before and after a successful replacement.
- Ordering: `["repo_a","repo_b"]` refuses, so the insert order is asserted on the single-entry case by reading `created_at` from the mock clock.

### `show-project.test.ts` / `list-project.test.ts`

- `show` on `project_a` returns `repositories: ["repo_a"]`; on an unknown id returns `null`.
- `show` returns bindings bytewise ascending: insert two `git` bindings whose insertion order is the reverse of their id order and assert the returned order follows the id.
- `list` returns three projects in ascending id order, with names whose alphabetical order is the reverse of the id order.
- `list` on an empty table returns `[]`.
- Every view passes `projectView.safeParse(...).success === true`.
- Read the two module sources and assert neither contains `SELECT *`.

### The four handler tests

`createTestApp` from `test/helpers/app.ts:34`.

- `POST /v1/project` with `{ name: "kanthord-verify" }` answers `200`, and `projectCreateResponse` parses the body.
- `POST /v1/project` with `{ name: "Kanthord" }` answers `400` `invalid-request` (the grammar refuses an uppercase letter), and `SELECT COUNT(*) FROM project` is unchanged.
- A duplicate name answers `400` with `error.details.refusal === "name-taken"`.
- `GET /v1/project` answers `200` with `{ projects: [...] }`.
- `GET /v1/project/project_01HZY8QF3M4N5P6R7S8T9V0W1X` on a `null` stub answers `404` `not-found`.
- `PUT /v1/project/:id/repository` with `{ repositories: ["repo_a"] }` answers `200`, and the body parses against `projectRepositoriesResponse`.
- `PUT /v1/project/:id/repository` with two ids answers `400` with `details.refusal === "too-many-repositories"`.
- `PUT /v1/project/:id/binding/worker` answers `501` with a message ending `"ships in phase-2"`, and `SELECT COUNT(*) FROM project_binding` plus `SELECT COUNT(*) FROM event` are equal before and after. This is the `AGENTS.md` rule for a `stubbed` route, asserted against database state.
- No response body names a daemon path.

`npm run verify` exits 0.

Proof: contributes `src/domain/project-view.test.ts`, `src/commands/project/*.test.ts`, `src/queries/project/*.test.ts` and `src/http/server/project/*.test.ts`. All four are inside the EPIC Proof glob, so it delivers `PASS EPIC-008`.
