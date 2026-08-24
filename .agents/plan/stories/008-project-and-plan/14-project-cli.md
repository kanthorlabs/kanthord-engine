# Story 14 — the project CLI

Epic: `.agents/plan/epics/008-project-and-plan.md`
Depends on: Story 01.

`kanthord project create`, `project list`, `project show`, and the repository binding. Import rejects an objective whose repository is not bound to its project, so a human with no project command cannot reach import at all. P1-E1 depends on this story.

## Change

### 1. `src/cli/project/index.ts` (new)

```ts
export function projectCommand(program: Command): Command;
```

The idempotent group factory of `src/cli/repository/index.ts:3`: return the existing `project` subcommand when one is registered, otherwise create it with `.description("manage projects")`.

### 2. `src/cli/project/create.ts` (new)

```ts
export type CreateProjectCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

export function registerProjectCreate(input: CreateProjectCliInput): void;
```

`kanthord project create --name <name>`. Shape (a) of the existing CLI: an injected `DaemonClient`, inline flag validation, and `fail()` on a refusal — `src/cli/repository/show.ts:1-49` is the pattern.

- No `--name` writes `kanthord: invalid-request: --name is required\n` and calls `fail()`.
- `client.call("project.create", { name })`. A non-ok result writes `kanthord: ${result.code}: ${result.message}\n` and calls `fail()`.
- Success parses the body with `projectCreateResponse.parse` and writes one line per field:

  ```
  kanthord: project <id>
  kanthord: name <name>
  kanthord: repositories <none>
  ```

  `repositories` prints the ids joined with `,` when the list is non-empty, and the literal `<none>` when it is empty. A field is printed even when its value is absent, so a script reading the output has a fixed line count.

### 3. `src/cli/project/list.ts` (new)

`kanthord project list`. No option. `client.call("project.list", undefined)`, `projectListResponse.parse`, then one line per project:

```
kanthord: project <id> <name> <repositories or <none>>
```

An empty list writes `kanthord: no project\n` and exits zero. An empty result is not a refusal.

### 4. `src/cli/project/show.ts` (new)

`kanthord project show --id <id>`. The same three-line output as `create`. A `404` writes `kanthord: not-found: ...` and calls `fail()`.

### 5. `src/cli/project/repository.ts` (new)

`kanthord project repository --id <id> --repository <name>`, repeatable.

- `--repository` takes a repository **name**, and the command resolves it to an id. `docs/proposal/api/repository.md:68-70` makes the id mandatory on the wire and a name the thing a human types; `src/cli/repository/register.ts:60` already resolves a credential name through `provider.list` for the same reason. This command calls `repository.list`, parses with `repositoryListResponse`, and matches on `name`.
- A name matching no repository writes `kanthord: not-found: no repository named <name>\n` and calls `fail()`, with no call to `project.repositories`.
- Two `--repository` flags are collected into an array by a commander collector, and the daemon refuses a list longer than one with `too-many-repositories`. The CLI does not duplicate that limit: one refusal in one place.
- No `--repository` at all sends `{ repositories: [] }`, which clears the binding set. That is `PUT` semantics and a human clearing a binding needs a spelling for it.
- On success, `projectRepositoriesResponse.parse` and the three-line output of `show`.

### 6. `src/main.ts` — register four commands

`registerProjectCreate`, `registerProjectList`, `registerProjectShow`, `registerProjectRepository`, each taking `{ program, client, stdout: writeOut, stderr: writeErr, fail }` from the values already built at `:305-331`.

## Constraints

- `src/cli/**` imports `http/contract/` and `cli/`, never a command, a query or a service (`eslint.config.js:159-167`).
- No CLI file holds a `127.` or a `"localhost"` literal. `src/domain/loopback.test.ts` asserts that exactly two non-test files under `src/` do.
- Every refusal writes `kanthord: <code>: <message>\n` to stderr and calls `fail()`. No command in this story uses `exitCodeForError`, matching `src/cli/repository/show.ts`.
- Every success output is parsed through a contract schema first, so a daemon that returns an unexpected shape fails loudly.
- A name is resolved to an id in the CLI, never on the wire.

## Verify

```
node --test src/cli/project/create.test.ts src/cli/project/list.test.ts \
  src/cli/project/show.test.ts src/cli/project/repository.test.ts
```

Each test builds a `Command`, injects a recording `DaemonClient` whose `call` returns a scripted `CallResult` and records `(operationId, body, parameters)`, and captures `stdout`, `stderr` and `fail` into arrays. `src/cli/repository/show.test.ts` and `register.test.ts` are the patterns.

### `create.test.ts`

- A successful create writes the three lines, exactly, and `fail` was not called.
- The recorded call is `("project.create", { name: "kanthord-verify" }, undefined)`.
- No `--name` writes the `invalid-request` line, calls `fail()`, and records **zero** calls.
- A `400` with `details.refusal === "name-taken"` writes `kanthord: invalid-request: <message>\n` and calls `fail()`.
- A body that fails `projectCreateResponse.parse` throws rather than printing a partial line.
- `repositories <none>` is printed for an empty list, and `repositories repo_a` for one entry.

### `list.test.ts`

- Two projects write two lines in the response order. The CLI does not re-sort; the daemon's order is the contract.
- An empty list writes `kanthord: no project\n` and does not call `fail()`.
- The recorded call is `("project.list", undefined, undefined)`.

### `show.test.ts`

- A successful show writes the three lines.
- The recorded call carries `{ id }` as the parameter map, not as a body.
- No `--id` writes the `invalid-request` line and records zero calls.
- A `404` writes the `not-found` line and calls `fail()`.

### `repository.test.ts`

- **The name resolves.** One `--repository kanthord-verify` records two calls in order: `repository.list`, then `project.repositories` with `{ repositories: ["repo_a"] }`. The order assertion is what proves the resolution happens before the write.
- A name matching nothing writes the `not-found` line, calls `fail()`, and records exactly **one** call.
- Two `--repository` flags send both ids, and a scripted `400` with `details.refusal === "too-many-repositories"` is printed and fails. The CLI itself does not refuse.
- No `--repository` sends `{ repositories: [] }`.
- The match on `name` is exact and case-sensitive: a repository named `Kanthord` is not matched by `kanthord`.
- Two repositories with distinct names resolve to their own ids, asserted on a two-entry `repository.list` response.

### The four commands together

- Registering all four twice against one `program` yields one `project` subcommand with four children, which is the idempotent group factory asserted.

`npm run verify` exits 0.

Proof: contributes `src/cli/project/**/*.test.ts`. It is inside the EPIC Proof glob, so it delivers `PASS EPIC-008`.
