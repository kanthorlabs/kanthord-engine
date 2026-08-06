# Story 05 — `kanthord status`

Epic: `.agent/plan/epics/009-cli-and-composition-root.md`
Depends on: Story 01 (`buildProgram`), Story 04 (`systemStatusResponse`).

## Change

### 1. `src/cli/status.ts` (new)

```ts
export type StatusCliInput = Readonly<{
  program: Command;
  client: DaemonClient;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  fail: () => void;
}>;

export function registerStatus(input: StatusCliInput): void;
```

`kanthord status`. No option, no group factory — it is a top-level command, as `docs/proposal/phase-1/README.md:76` spells it. Shape (a) of the existing CLI: an injected `DaemonClient` and `fail()` on a refusal, matching `src/cli/repository/show.ts:1-49`.

- `client.call("system.status", undefined)`. A non-ok result writes `kanthord: ${result.code}: ${result.message}\n` to stderr and calls `fail()`, writing nothing to stdout.
- Success parses the body with `systemStatusResponse.parse` and writes these lines, in this order, each to stdout:

```
kanthord: version <version>
kanthord: bind <bind>
kanthord: started <startedAt>
kanthord: health <status>
kanthord: dependency <name> <status>          one line per dependency, response order
kanthord: node <kind> <state> <blockReason> <count>   one line per node group, response order
kanthord: repository <id> <name> <divergedLandingOid> <divergedUpstreamOid>
kanthord: lease <subjectKind> <subjectId> <owner> <fence> <expiresAt>
```

- A `null` `blockReason` renders the literal `-`. A `null` `owner` renders the literal `-`. No line is ever short a field.
- An empty list writes one line instead of none: `kanthord: no dependency\n`, `kanthord: no node\n`, `kanthord: no repository needs reconcile\n`, `kanthord: no expired lease\n`. An empty list is not a refusal and does not call `fail()`.
- The CLI re-sorts nothing. `src/queries/system/read-status.ts` fixes every order in SQL, and the response order is the contract.

### 2. `src/cli/program.ts` — register it

Add `registerStatus({ program, client, stdout: dependencies.stdout, stderr: dependencies.stderr, fail: dependencies.fail })` to the registration sequence, after `registerRepositoryShow` and before the project commands.

### 3. `src/cli/program.test.ts` — the subcommand list gains `"status"`

## Constraints

- No `exitCodeForError`. A refusal is `fail()`, matching `src/cli/repository/show.ts:44` and every shape-(a) command. Story 06 is the one command in this epic that needs a routed exit code, and it needs one because `docs/proposal/phase-1/README.md:77` requires a specific failure.
- Every success line is parsed through `systemStatusResponse` first. A daemon returning an unexpected shape throws rather than printing a partial line.
- No `127.` and no `"localhost"` literal. `src/domain/loopback.test.ts` asserts exactly two non-test files under `src/` hold one.
- `src/cli/**` imports `http/contract/` and `cli/` only (`eslint.config.js:158-168`).

## Verify

```bash
node --test src/cli/status.test.ts src/cli/program.test.ts
```

### `src/cli/status.test.ts` (new)

A `harness()` factory returning `{ program, calls, stdoutText(), stderrText(), failCalls() }` over a fake `DaemonClient`, matching `src/cli/repository/show.test.ts:43-51`.

- **The full body renders every line, in order.** Against a fixture holding two dependencies, three node groups (one `blocked` with a reason, two with `blockReason: null`), one repository and two leases (one with a `null` owner), `stdoutText()` equals one exact multi-line literal written out in the test. `stderrText()` is empty and `failCalls()` is `0`.
- **P1-E1's shape.** A fixture whose `nodes` is `[{ kind: "objective", state: "pending", blockReason: null, count: 2 }, { kind: "task", state: "pending", blockReason: null, count: 4 }]` and whose other three lists are empty produces a `stdoutText()` whose lines **starting with the prefix `kanthord: node `** deep-equal

  ```
  ["kanthord: node objective pending - 2",
   "kanthord: node task pending - 4"]
  ```

  The filter is required: the command always writes the four scalar lines and the three other list sections, so comparing whole stdout to these two lines could never pass. The full-output assertion is the case above; this one is the P1-E1 oracle of `docs/proposal/phase-1/README.md:76` isolated.

- **Every list empty.** A body with four empty arrays writes the four `no …` lines after the four scalar lines, calls `fail()` zero times, and writes nothing to stderr.
- The recorded call is exactly `("system.status", undefined, undefined)`, once.
- A `401` result writes `kanthord: unauthenticated: <message>\n` to stderr, calls `fail()` once, and writes nothing to stdout.
- A `501` result writes `kanthord: not-implemented: <message>\n`, calls `fail()` once, and writes nothing to stdout. This is what the command does before Story 04 binds the route, and it stays true for a daemon of an older version.
- A body that fails `systemStatusResponse.parse` rejects — `assert.rejects` — and writes no partial line. `src/cli/db/status.test.ts` is the precedent.
- Two differing `400` messages with the same `code` produce the same `fail()` count and differ only in the message text: the command routes on `code`, never on `message`.

### `src/cli/program.test.ts`

- The top-level subcommand list gains `"status"`.

`npm run verify` exits 0.

Proof: contributes `src/cli/status.test.ts` to `node --test src/cli/**/*.test.ts`.
