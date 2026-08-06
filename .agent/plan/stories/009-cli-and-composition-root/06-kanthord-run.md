# Story 06 — `kanthord run`

Epic: `.agent/plan/epics/009-cli-and-composition-root.md`
Depends on: Story 01 (`buildProgram`).

`run.start` is the one `stubbed` operation this epic fronts with a command. `src/http/contract/execution.ts:4-11` declares it `phase-2` / `stubbed`, and `src/http/server/dispatch.ts:16-21` answers `501 not-implemented` with the message `run.start ships in phase-2`, before the body parser runs and before any state is touched.

## Change

### 1. `src/cli/run.ts` (new)

```ts
export type RunCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  exit: (code: number) => void;
}>;

export function registerRun(input: RunCliInput): void;
```

`kanthord run --project <id>`. A top-level command, no group factory.

- No `--project` writes `kanthord: invalid-request: --project is required\n` to stderr, calls `exit(1)`, and makes no call.
- `client.call("run.start", undefined, { id: options.project })`. `src/http/contract/path.ts:88` names every path parameter `id`, so the map key is `id` and not `project`.
- A non-ok result writes `kanthord: ${result.code}: ${result.message}\n` to stderr and calls `exit(exitCodeForError(result.code, result.status))`. `src/cli/exit-code.ts:31` maps `not-implemented` to `220`.
- An ok result parses nothing and writes `kanthord: started\n`. The route cannot return ok in phase 1; the branch exists so the command needs no edit in phase 2.

### 2. `src/cli/program.ts` — register it

Add `registerRun({ program, client, stdout: dependencies.stdout, stderr: dependencies.stderr, exit: dependencies.exit })` after `registerStatus`.

### 3. `src/cli/program.test.ts` — the subcommand list gains `"run"`

## Constraints

- **The exit code routes on `code`, never on `message`.** `docs/proposal/api/README.md:163` states the rule and `src/cli/exit-code.ts:8-30` is the one table. This command computes no number of its own and holds no literal `220`.
- `exit(code)` and not `fail()`. This is the only command in this epic that needs the granular code, because `docs/proposal/phase-1/README.md:77` requires `kanthord run` to exit non-zero **with `not-implemented`**. `src/cli/db/status.ts:1-49` is the shape for the exit side; the client side stays the injected `DaemonClient` of `src/cli/repository/show.ts`.
- The command writes nothing to stdout on a refusal. `.agent/plan/epics/009-cli-and-composition-root.md:22` — "writes nothing" — is about daemon **state**, not about the terminal: `docs/proposal/api/execution.md:24` says the route "returns `501 not-implemented` and writes no state", and `src/http/server/dispatch.ts:16-21` refuses before the body parser runs. A refusal line on stderr is required, not forbidden.
- No `--yes`, no confirmation, no retry. One call.

## Verify

```bash
node --test src/cli/run.test.ts src/cli/program.test.ts
```

### `src/cli/run.test.ts` (new)

A `harness()` over a fake `DaemonClient` and an `exit` that pushes each code into an array.

- **The `501` path.** A result of `{ ok: false, status: 501, code: "not-implemented", message: "run.start ships in phase-2", details: undefined }` writes exactly `kanthord: not-implemented: run.start ships in phase-2\n` to stderr, writes nothing to stdout, and records exactly one exit code, `220`.
- The recorded call is exactly `("run.start", undefined, { id: "project_a" })`, once.
- No `--project` writes the `invalid-request` line, records exit code `1`, and records **zero** calls.
- A `404` records exit code `140`. A `401` records `120`. Both come from `src/cli/exit-code.ts` and neither is written as a literal in the command.
- **Code, never message.** Two results with `code: "not-implemented"` and two different messages record the same exit code `220` and differ only in the stderr text.
- An unknown code with status `503` records `200`, the `DAEMON_FAULT` floor of `src/cli/exit-code.ts:36-42`.
- A `200` result writes `kanthord: started\n` and records **no** exit code.

### `src/cli/program.test.ts`

- The top-level subcommand list gains `"run"`.

`npm run verify` exits 0.

Proof: contributes `src/cli/run.test.ts` to `node --test src/cli/**/*.test.ts`.
