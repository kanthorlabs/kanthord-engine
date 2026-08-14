# Story 3 — `kanthord event list`, the one command this epic ships

Epic: `.agent/plan/epics/020-wiring-and-scenarios.md`
Depends on: Story 1.

`event.list` is already `routed` at `src/http/contract/event.ts:63-73` and already bound at `src/main.ts:313`. This story adds the CLI leaf that reaches it, and nothing else.

## Change

### A new `src/cli/event/index.ts`

Mirror `src/cli/project/index.ts` exactly:

```ts
import type { Command } from "commander";

export function eventCommand(program: Command): Command {
  const existing = program.commands.find(
    (command) => command.name() === "event",
  );
  if (existing !== undefined) {
    return existing;
  }
  return program.command("event").description("read the event log");
}
```

### A new `src/cli/event/list.ts`

Follow `src/cli/project/list.ts:15-46` end to end: the `RegisterEventListCliInput` type carries `program`, `client`, `stdout`, `stderr` and `fail`; the registrar guards against a duplicate leaf; the action makes one `client.call`, maps a failure to `kanthord: <code>: <message>` on stderr plus `fail()`, and parses success through `eventListResponse`.

Declare exactly seven options, each mapping to one field of `eventListRequest` at `src/http/contract/event.ts:11-17` and `cursorRequest` at `src/http/contract/cursor.ts:3-6`:

```text
--subject-kind <kind>   -> subjectKind
--subject <id>          -> subject
--type <event-type>     -> type
--actor-kind <kind>     -> actorKind
--actor <id>            -> actor
--after <event-id>      -> after
--limit <n>             -> limit
```

Build the query object with only the options the caller supplied; omit an absent field rather than sending `undefined`. Pass the query as the query argument of `client.call`, the argument `018-claim-and-lease.md` story `16-cli-commands.md:14-38` adds to `DaemonClient.call`. Declare no filter the query schema does not hold.

On an empty list print exactly:

```text
kanthord: no event
```

Otherwise print one line per event, in the order the response returns them, which is event id order and the order the `after` cursor of `eventListRequest` requires. Add no client-side sort.

```text
kanthord: event <createdAt> <eventId> <actorKind>/<actorId> <type> <subjectKind>/<subjectId> <payload>
```

### The canonical payload renderer, in `src/cli/event/list.ts`

Export one pure function from the same file:

```ts
export function renderPayload(value: unknown): string;
```

It returns `JSON.stringify` of the value with every object key sorted bytewise at every depth. Sort with `Buffer.compare(Buffer.from(a), Buffer.from(b))`. Recurse into objects and into arrays; an array keeps its own order. A non-object value renders as `JSON.stringify` of itself. `null` renders as `null`.

`eventView.payload` is `z.unknown()` at `src/http/contract/event.ts:26` and stays so — `019-outcome-report.md:80` keeps it, and its story `14-event-payload-contract.md` edits that file not at all. The renderer therefore takes `unknown` and imports nothing from `src/http/contract/event-payload.ts`.

### Registration and inventory

- `src/cli/program.ts`: call `registerEventList` inside `buildProgram`, in the position the existing bytewise order of registrations implies, passing `program`, the shared `client`, `dependencies.stdout`, `dependencies.stderr` and `dependencies.fail`.
- `src/cli/inventory.ts`: add one entry in its sorted position, between the `db status` entry and the `plan export` entry:

  ```ts
  { path: ["event", "list"], operationIds: ["event.list"] },
  ```

### A new `src/cli/event/list.test.ts`

Suite name `"src/cli/event/list.test"`. Follow the harness convention of `src/cli/project/list.test.ts`: a local `harness()` builds a fake `DaemonClient` that pushes each call into a `calls` array and returns a caller-supplied response, string-accumulating `stdout` and `stderr`, a `fail` counter, `registerClientOptions(program)` before the registrar, and `program.parseAsync(args, { from: "user" })`.

Cases:

- `it("sends every supplied option on the query", ...)` — parse all seven options at once and assert the single recorded call deep-equals the operation id `event.list` with the query holding all seven mapped fields.
- `it("omits an absent option from the query", ...)` — parse with `--type` alone and assert the query holds `type` and no other key.
- `it("prints one record per event in the order the response returns", ...)` — respond with three events and assert the exact three stdout lines, in response order.
- `it("prints a payload with every key sorted bytewise at every depth", ...)` — respond with one event whose payload is a nested object declared with keys out of order, and assert the exact printed bytes.
- `it("prints the same payload bytes for two key orders of one payload", ...)` — call `renderPayload` twice over two objects with identical entries inserted in different orders and assert the two strings are equal.
- `it("prints kanthord: no event on an empty list", ...)` — assert the exact single line.
- `it("prints the error line and fails on a refused call", ...)` — respond `{ ok: false, code: "invalid-request", message: "limit must not exceed 500" }` and assert stderr equals `kanthord: invalid-request: limit must not exceed 500\n`, that `fail` ran once, and that stdout is empty.

## Constraints

- **The command is human-only.** `event.list` declares `allowedActors: ["human"]`. This story changes no registry row and edits `src/http/contract/event.ts` not at all.
- **No `event show`, no pager, no aggregation, no client-side filter.** One route, one command.
- Add no second command over `event.list`.
- The leaf reads the daemon through `client.call` only. It opens no database and imports no query.

## Verify

- `node --test src/cli/event/list.test.ts src/cli/inventory.test.ts src/cli/program.test.ts` exits 0.
- `src/cli/program.test.ts` case `"registers the nine declared top-level commands, sorted bytewise"` gains `event` and now names ten. Update that literal list and its description in the same edit.
- `src/cli/inventory.test.ts` counts move by one command and one distinct operation id. Update each pinned scalar in that file to the value the assertion diff reports.
- `npm run verify` exits 0.
- Proof: `src/cli/event/list.test.ts`, `src/cli/inventory.test.ts`, `src/cli/program.test.ts`. Hermetic coverage: `020-wiring-and-scenarios.md:160`.
