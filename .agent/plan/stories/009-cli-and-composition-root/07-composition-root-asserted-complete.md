# Story 07 — the composition root, asserted complete

Epic: `.agent/plan/epics/009-cli-and-composition-root.md`
Depends on: Story 04 (`system.status` bound), Story 05 and Story 06 (the two CLI commands it drives), Story 09 (the shutdown path and `daemon.exit()`), EPIC 008 (every project, plan, node and edge handler bound).

`eslint.config.js:314-334` forbids a test from importing `src/main.ts`, and `src/main.ts` exports nothing. So this test drives the real binary as a child process, exactly as `src/services/home-lock/startup.test.ts:92` and `scripts/e2e/007/10-repository-register.e2e.ts:102` already do. That is also what the EPIC's coverage line requires: an answer from a started daemon rather than from a stub.

## Change

### 1. `test/helpers/port.ts` (new) — the one `reservePort`

```ts
export function reservePort(): Promise<number>;
```

The body is `test/helpers/daemon.test.ts:14-23` moved verbatim: open a `net.createServer()`, `listen(0, "127.0.0.1")`, read `AddressInfo.port`, `close`, resolve. Replace the local copy with an import in all four current call sites — `test/helpers/daemon.test.ts:14`, `test/helpers/cli.test.ts:17`, `src/http/server/start.test.ts:21` and `src/services/home-lock/startup.test.ts:26` — and delete each local definition. This story and Story 08 would otherwise be the fifth and sixth copy. S2 in the index.

`test/helpers/remote/ssh.ts:94` keeps `reserveLoopbackPort`. It rejects with a fixture-specific message instead of casting `AddressInfo`, and it is a fixture concern rather than a test concern. Leave it.

A test asserts `reservePort()` twice yields two different numbers, both above `1023`, and that the returned port binds.

### 2. `src/http/server/app.ts` — one `unimplementedFor`

`test/helpers/app.ts:16-23` and `src/main.ts:236-239` hold the same four-line filter. Export it once, beside the `bindingOffenders` that consumes the same rule:

```ts
export function unimplementedFor(
  handlers: Readonly<Record<string, Handler>>,
): readonly string[];
```

`src/main.ts:236-239` becomes `const unimplemented = unimplementedFor(handlers);`. `test/helpers/app.ts:16-23` re-exports it rather than redeclaring it, so `unimplementedFor` keeps its current import path for the eleven test files that use it. A test helper may import `http/server` (`eslint.config.js:314-334` disallows only the composition root), so this collapses the duplicate without the helper reaching `src/main.ts`. S3 in the index.

`src/http/server/app.test.ts:160-165` keeps its `21` and needs no edit: the function is the same filter, now in one place.

### 3. `src/main.test.ts` (new) — the assertion this story exists for

No other production change. If an assertion fails, the fix is a binding in `src/main.ts`, and that fix belongs to the story that owns the handler.

One `describe("src/main.test", ...)` with one daemon for the whole suite, built in a `before` hook:

1. `createTemporaryHome()` (`test/helpers/home.ts:11`).
2. `const port = await reservePort()` — the body duplicated in four test files today; copy it, do not export a fifth variant. See S2.
3. `home.writeConfig({ http: { port, allowedHosts: [`127.0.0.1:${port}`] } })`. `test/helpers/home.ts:23,25` hardcodes `7421` in both fields, so both must be overridden or the `Host` check refuses every request.
4. `runCli({ args: ["db", "migrate", "--home", home.path] })` (`test/helpers/cli.ts`), asserted to exit `0`. `src/http/server/migration-gate.ts` refuses to start an unmigrated home.
5. `launchDaemon({ config: home.configPath })` and `await daemon.ready()` (`test/helpers/daemon.ts:29,71`).
6. `after`: `daemon.kill()` and await its exit **when the daemon was assigned**, then `home.dispose()` **when the home was created**. Both are guarded on the binding being defined, and the `before` hook wraps steps 2 to 5 in a `try`/`catch` that disposes the home and rethrows. A `ready()` timeout at step 5 must not leave a temporary home behind.

`reservePort` is imported from `test/helpers/port.ts`, which section 1 creates.

Every call goes through `call(clientDependencies, { operationId, parameters, body })` from `src/cli/client.ts:81`, with `baseUrl: \`http://127.0.0.1:${port}\`` and `token: "test-token"` — the token `test/helpers/home.ts:24` writes.

**The fixture table.** One `const fixtures: Readonly<Record<string, { parameters?: Record<string,string>; body?: unknown; expect: number | "any-but-501" }>>` authored in the test, holding one row per `routed` operation. Ids that must not exist use the literal `01JZZZZZZZZZZZZZZZZZZZZZZZ` under the operation's own prefix, so the shape passes and the lookup misses.

| operationId            | parameters / body                                  | `expect`      |
| ---------------------- | -------------------------------------------------- | ------------- |
| `system.health`        | —                                                  | `200`         |
| `system.db`            | —                                                  | `200`         |
| `system.status`        | —                                                  | `200`         |
| `provider.list`        | —                                                  | `200`         |
| `provider.register`    | a valid `providerRegisterRequest` for kind `llm`   | `200`         |
| `provider.show`        | `{ id: "provider_01JZZ…" }`                        | `404`         |
| `repository.list`      | —                                                  | `200`         |
| `repository.show`      | `{ id: "repository_01JZZ…" }`                      | `404`         |
| `repository.inspect`   | a valid `repositoryInspectRequest`                 | `any-but-501` |
| `repository.register`  | a valid `repositoryRegisterRequest`                | `any-but-501` |
| `project.create`       | `{ name: "kanthord-verify" }`                      | `200`         |
| `project.list`         | —                                                  | `200`         |
| `project.show`         | `{ id: "project_01JZZ…" }`                         | `404`         |
| `project.repositories` | `{ id: "project_01JZZ…" }`, `{ repositories: [] }` | `404`         |
| `plan.validate`        | `{ id: "project_01JZZ…" }`, a valid body           | `404`         |
| `plan.import`          | `{ id: "project_01JZZ…" }`, a valid body           | `404`         |
| `plan.export`          | `{ id: "project_01JZZ…" }`                         | `404`         |
| `plan.revisions`       | `{ id: "project_01JZZ…" }`                         | `404`         |
| `node.list`            | —                                                  | `200`         |
| `node.show`            | `{ id: "node_01JZZ…" }`                            | `404`         |
| `edge.list`            | `{ id: "project_01JZZ…" }`                         | `404`         |

**The two `any-but-501` bodies are pinned, not left to build time.** Both use a loopback URL on a port reserved and immediately closed in the `before` hook, so the git subprocess fails with a connection refusal and never leaves the machine:

```ts
const deadUrl = `http://127.0.0.1:${await reservePort()}/dead.git`;
// repository.inspect
{ url: deadUrl, credentialId: "provider_01JZZZZZZZZZZZZZZZZZZZZZZZ" }
// repository.register
{ name: "dead", url: deadUrl, credentialId: "provider_01JZZZZZZZZZZZZZZZZZZZZZZZ",
  upstreamBranch: "main", hostFingerprint: null }
```

Each is `any-but-501` and nothing stricter because the refusal code depends on which check fires first — the missing credential or the unreachable remote — and pinning that would re-specify EPIC 007 from a second place. What this row proves is that the operation is bound and that its git, crypto and storage dependencies were constructed: an unconstructed one throws and lands as `500 internal-error`, which assertion (c) below rejects. The hermetic loopback **remote** of EPIC 005 is not started here; `scripts/e2e/007/` already drives the success path end to end.

## The assertions

### Every routed operation

- **The fixture table covers the registry.** `Object.keys(fixtures)` and `registry.filter((e) => e.status === "routed" && !pending.includes(e.operationId)).map((e) => e.operationId)`, each sorted through `Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"))`, deep-equal. Bytewise, never bare `.sort()` — `AGENTS.md` makes explicit ordering a product rule and the registry itself is bytewise sorted at `src/http/contract/registry.ts:29-31`. Adding a `routed` operation without a fixture fails here, so the sweep cannot silently shrink.
- **No routed operation answers `501`.** For each fixture row, `result.status !== 501`. This is the unbound assertion and the shared-`501`-handler assertion at once: `src/http/server/dispatch.ts:22-28` answers `501 not-implemented` for a `routed` operation with no handler entry, so an unbound operation fails here and the failure message names the `operationId`.
- **No routed operation answers `internal-error`.** For each row, `result.ok === true || result.code !== "internal-error"`. A service that `src/main.ts` never constructed throws inside its handler and reaches the envelope as `500 internal-error`, so an unwired dependency fails here rather than passing as "not the 501 handler".
- **Each named expectation holds.** For each row whose `expect` is a number, `result.status` equals it.

### The two operations EPIC 010 owns

- `const pending = ["blob.show", "event.list"] as const`.
- Each answers `501` with `code: "not-implemented"`, and the message ends `is not implemented yet` rather than `ships in` — `src/http/server/dispatch.ts:22-28` writes the first for a `routed` operation with no handler and the second for a `stubbed` one, so this distinguishes "unbound" from "a later phase".
- `blob.show`'s parameter is keyed `hash`, not `id`. `src/http/contract/path.ts:92` builds `{ kind: "parameter", value: "hash" }` and it is the one operation in the registry that does (`registry.test.ts:105-113`). The fixture is `{ hash: "sha256:" + "0".repeat(64) }`. `event.list` takes no parameter.
- `registry.filter((e) => e.status === "routed").map((e) => e.operationId).filter((id) => !(id in fixtures))`, bytewise sorted, deep-equals `pending`. EPIC 010 empties this constant, and until it does, the list is two names rather than an open door. It is the residue of B1 and it disappears with EPIC 010's `system.status` bullet.

### The two CLI commands, over the started daemon

`.agent/plan/epics/009-cli-and-composition-root.md:40` requires that `kanthord status` and `kanthord run` "each answer against the started daemon rather than a stub". A `call()` to `system.status` does not prove that: it skips registration in the program, client-option resolution, the HTTP round trip and the rendering. These four cases run the real binary against the same daemon, through `runCli` (`test/helpers/cli.ts`), with `args` carrying `--base-url http://127.0.0.1:<port> --token test-token`.

- **`kanthord status` answers.** `runCli({ args: ["status", "--base-url", …, "--token", "test-token"] })` exits `0`, writes nothing to stderr, and its stdout holds a line matching `/^kanthord: version /`, one matching `/^kanthord: bind /` and one matching `/^kanthord: health (ok|degraded)$/`. Exact line content is Story 05's assertion against a pinned body; here the daemon supplies the body, so the assertion is on shape.
- **`kanthord run` exits non-zero with `not-implemented`.** `runCli({ args: ["run", "--project", "project_01JZZZZZZZZZZZZZZZZZZZZZZZ", …] })` exits `220`, its stderr holds a line starting `kanthord: not-implemented: `, and its stdout is empty. `run.start` is `stubbed`, so this is the one call in the file that expects a `501` from a non-`routed` operation, and it is what proves the `stubbed` path reaches the CLI's exit-code table.
- **`kanthord run` leaves `kanthord status` unchanged.** Capture `kanthord status` stdout before and after the `run` call. The two outputs are equal after dropping the `kanthord: started ` line, which is constant anyway. `docs/proposal/phase-1/README.md:77` is this assertion, and it is the only place in phase 1 where "writes no state" is proved rather than asserted by construction.
- **The daemon and the CLI report one version.** `runCli({ args: ["--version"] })` exits `0` and its stdout trimmed equals the `version` field of the `kanthord status` output. `docs/proposal/phase-1/README.md:69` requires it and no unit test can, because the two values reach the terminal from two processes.

### The daemon's own record

- After the whole sweep, `daemon.stderr()` contains no occurrence of `kanthord: internal-error:`. `src/main.ts:247-250` writes that line for every unhandled handler throw, so this catches a failure the envelope swallowed.
- `daemon.stderr()` contains no occurrence of `kanthord: recovery:` — the startup recovery of EPIC 007.5 finds nothing on a home it just migrated.

### The daemon stops cleanly

Story 09 delivers the shutdown path; these three assertions are the composition-root end of it, and they run last.

- `daemon.kill("SIGTERM")` then `await daemon.exit()` yields code `0`.
- `daemon.stderr()` ends with `kanthord: stopped\n` and holds no `kanthord: shutdown: ` failure line.
- `runCli({ args: ["db", "migrate", "--home", home.path] })` then exits `0`. Without a released home lock it prints `kanthord: home-locked:` — `test/helpers/cli.test.ts:97-126` is the precedent. This is the only assertion in the repository that proves the lock is released rather than orphaned by a killed process.

## Constraints

- Hermetic. One `mktemp` home, two reserved loopback ports — the daemon's and the dead one the two git fixtures point at — no shared directory, no network beyond `127.0.0.1`. The home is removed in `after` whether the suite passed or failed, and by the `before` hook's own `catch` when setup failed before the daemon existed.
- **The story owns the depended-on order.** The `kanthord run` case must run after the first `kanthord status` capture and before the second. Node's `node:test` runs `it` bodies in declaration order inside one `describe`, so the three cases are declared in that order and nothing else is required.
- The test imports `test/helpers/`, `src/cli/client.ts`, `src/http/contract/` and `node:` builtins. It imports no command, no query, no service implementation and not `src/main.ts`.
- One daemon for the suite. Sixteen launches would make this the slowest file in the repository for no added coverage.
- Assert a status, never a body. A response shape is the owning epic's assertion; this file proves the wire is connected.

## Verify

```bash
node --test src/main.test.ts test/helpers/port.test.ts src/http/server/app.test.ts test/helpers/daemon.test.ts test/helpers/cli.test.ts src/http/server/start.test.ts src/services/home-lock/startup.test.ts
```

The last five run because section 1 replaces a local `reservePort` in four of them and section 2 moves `unimplementedFor`. Each must stay green with no assertion deleted.

- Every assertion above passes against a clean tree.
- **The failure is proved, once, by hand.** Comment out the `"system.status"` binding in `src/main.ts`, run the file, confirm it fails and that the failure message contains the string `system.status`. Restore it. Record the observed message in the story's `/work` discussion file.
- **The second failure is proved, once, by hand.** Add `"blob.show"` to `fixtures` with `expect: 200`, run the file, confirm the `pending` deep-equal fails. Remove it.

`npm run verify` exits 0.

Proof: contributes `src/main.test.ts`, which the EPIC Proof names directly.
