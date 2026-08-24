# Story 5 — `test/helpers/command-recorder.ts`

Epic: `.agents/plan/epics/020-wiring-and-scenarios.md`
Depends on: Story 4.

The recorder builds the real program with recording stand-ins for the four side-effect dependencies, and resolves each recorded HTTP request to exactly one operation id. Story 6 consumes it.

## Change

### A new `test/helpers/command-recorder.ts`

Export these types and one factory:

```ts
export type RecordedRequest = Readonly<{
  method: string;
  path: string;
  operationId: string;
}>;

export type CommandRecorder = Readonly<{
  run(argv: readonly string[]): Promise<void>;
  operationIds(): readonly string[];
  requests(): readonly RecordedRequest[];
  migrateCalls(): number;
  serveCalls(): number;
  writeFileCalls(): readonly Readonly<{ path: string; content: string }>[];
  stdout(): string;
  stderr(): string;
  failures(): number;
}>;

export function createCommandRecorder(
  options?: Readonly<{ respond?: (request: RecordedRequest) => unknown }>,
): CommandRecorder;
```

`createCommandRecorder` builds `ProgramDependencies` in the shape `src/cli/parity.test.ts:10-63` already uses, with four dependencies replaced by recorders and every other dependency a benign fake:

- **`fetch`** — records `{ method, path }` from the request, resolves the operation id, pushes a `RecordedRequest`, and returns a `Response` with status `200`, header `content-type: application/json`, and a body from `options.respond` or `{}` when no responder is given. It opens no socket.
- **`writeFile`** — pushes `{ path, content }` and writes nothing.
- **`migrate`** — increments `migrateCalls` and returns `[]`.
- **`serve`** — increments `serveCalls` and resolves.

`stdout`, `stderr` and `fail` accumulate into strings and a counter rather than throwing. `env` is `{}`, `cwd` is a fixed literal, `randomBytes` is deterministic, `confirm.isTty` is `false`, and `readFile` plus `fs` throw when called, exactly as the existing fakes do.

`run(argv)` calls `buildProgram(dependencies)` fresh, calls `registerClientOptions` through `buildProgram` as usual, and parses with:

```ts
await program.parseAsync(
  ["--base-url", "http://127.0.0.1:7421", "--token", "recorder-token", ...argv],
  { from: "user" },
);
```

A fresh program per `run` keeps two rows independent.

### The resolver, in the same file

```ts
export function resolveOperationId(method: string, path: string): string;
```

It compares the method and the path against the rendered template of each `registry` entry. Build each template with `renderPath(entry.path)` from `src/http/contract/path.ts:97-105`, which yields `/v1/node/:id/claim` and `/v1/blob/:hash`. Split the candidate path on `/` after stripping the query string, split the template on `/`, and require equal segment counts. A template segment that starts with `:` matches exactly one non-empty path segment; every other segment must match bytewise. The method must match `entry.method` exactly.

Collect every match. Zero matches throws an error naming the method and the path. Two or more matches throws an error naming the method, the path and every matching operation id. Exactly one match returns its operation id.

### A new `test/helpers/command-recorder.test.ts`

Suite name `"test/helpers/command-recorder.test"`. Cases:

- `it("resolves a concrete path to its one operation id", ...)` — assert `resolveOperationId("GET", "/v1/project")` is `project.list`.
- `it("resolves a parameter segment", ...)` — assert `resolveOperationId("GET", "/v1/project/project_01ARZ3NDEKTSV4RRFFQ69G5FAV")` is `project.show`.
- `it("ignores the query string", ...)` — assert `resolveOperationId("GET", "/v1/event?limit=10")` is `event.list`.
- `it("throws naming the method and path when no template matches", ...)` — assert `resolveOperationId("GET", "/v1/nowhere")` throws, and the message holds `GET` and `/v1/nowhere`.
- `it("throws naming every match when two templates match", ...)` — call the resolver against a locally built two-entry template list that deliberately holds one duplicate pair, and assert the message names both ids. Build the malformed fixture locally; mutate no imported registry object.
- `it("records the request one CLI leaf issues", ...)` — run `["project", "list"]` and assert `operationIds()` deep-equals `["project.list"]`.
- `it("records zero requests and one migrate call for db migrate", ...)` — run `["db", "migrate"]` and assert `operationIds()` is `[]` and `migrateCalls()` is `1`.
- `it("issues no network request", ...)` — assert that a recorder run over `["project", "list"]` completes with the injected `fetch` alone, by asserting the recorded request count and that no real port was opened. Bind no server in this file.
- `it("keeps two runs independent", ...)` — run two leaves on one recorder and assert `operationIds()` holds the two ids in call order.

## Constraints

- **Hermetic.** The recorder opens no socket, starts no server, writes no file and spawns no process.
- The recorder builds the real `buildProgram`. It never re-implements a command and never registers a leaf of its own.
- The helper lives under `test/helpers/` and no production file imports it.

## Verify

- `node --test test/helpers/command-recorder.test.ts` exits 0.
- `npm run verify` exits 0.
- Proof: `test/helpers/command-recorder.test.ts`. Hermetic coverage: `020-wiring-and-scenarios.md:154`.
