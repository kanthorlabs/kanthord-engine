# Story 5 — The composition root and the route-level acceptance

Epic: `.agent/plan/epics/023-version-compatibility-policy.md`
Depends on: Story 4.

**Last member of the coupled block.** `npm run verify` exits 0 at the close of this story.

## Change

### `src/main.ts`

Two imports beside the existing `./domain/version.ts` import at `:80`:

```ts
import { declaredCapabilities } from "./http/contract/capability.ts";
import { registry } from "./http/contract/registry.ts";
```

If `registry` is already imported, reuse the existing import.

Immediately after the `reporters` array at `:229-237`, bind the health dependencies once:

```ts
const capabilities = declaredCapabilities(registry);
const healthDependencies = {
  reporters,
  version: KANTHORD_VERSION,
  capabilities,
};
```

`declaredCapabilities(registry)` is called **once**, at construction, never per request.

Both `readHealth` call sites take that object. `src/main.ts:245`:

```ts
        "system.health": healthHandler({
          readHealth: () => readHealth(healthDependencies),
        }),
```

and `src/main.ts:255`, inside the `readStatus` binding:

```ts
              health: () => readHealth(healthDependencies),
```

Every other member of the `readStatus` binding — `storage`, `clock`, `version: KANTHORD_VERSION`, `bind: settings.http.bind`, `startedAt` — is unchanged.

### `src/main.capability.test.ts` — new file

Follow `src/main.node-write.test.ts` for structure: `describe`/`it` from `node:test`, `assert` from `node:assert/strict`, `createTemporaryHome`, `reservePort`, `runCli`, `launchDaemon`, `call` from `./cli/client.ts`, and `DatabaseSync` from `node:sqlite`.

One `before`:

```ts
home = createTemporaryHome();
port = await reservePort();
const configPath = home.writeConfig({
  http: { port, allowedHosts: [`127.0.0.1:${port}`] },
});
const migrated = await runCli({ args: ["db", "migrate", "--home", home.path] });
assert.equal(migrated.code, 0, migrated.stderr);
daemon = launchDaemon({ configPath });
await daemon.ready();
```

One `after`: `daemon.kill("SIGTERM"); await daemon.exited(); home.dispose();`.

One module-level raw call helper, because the assertions need the raw bytes and the response headers and `call` returns neither. It serves both the GET cases and the one POST case:

```ts
async function rawRequest(
  method: "GET" | "POST",
  path: string,
  token: string,
  options: Readonly<{
    headers?: Readonly<Record<string, string>>;
    body?: unknown;
  }> = {},
): Promise<Readonly<{ status: number; text: string; headers: Headers }>>;
```

Its body, pinned:

- `const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) };`
- When `options.body !== undefined`, set `headers["Content-Type"] = "application/json"` and send `JSON.stringify(options.body)`. When it is `undefined`, send no body and set no `Content-Type`.
- `const response = await globalThis.fetch(`http://127.0.0.1:${port}${path}`, { method, headers, body });`
- Return `{ status: response.status, text: await response.text(), headers: response.headers }`.

It sends no `Origin` header. A raw `fetch` sends `Host: 127.0.0.1:<port>`, which `allowedHosts` admits.

The human token is the literal `"test-token"` that `home.writeConfig` writes. The harness token comes from one `call(clientDependencies(), { operationId: "actor.register", body: { name: "harness-capability" } })` in the `before`. Assert `registered.status === 200` and `registered.ok` before reading `(registered.body as { token: string }).token`, and assert the token is a non-empty string.

Assert, one `it` per bullet:

1. **The production composition root serves the handshake.** `rawRequest("GET", "/v1/health", humanToken)` returns `200`. `JSON.parse(text)` has `version` equal to `KANTHORD_VERSION` imported from `./domain/version.ts`, and `capabilities` deep-equal to `declaredCapabilities(registry)` imported from `./http/contract/capability.ts` and `./http/contract/registry.ts`, member for member and in order. `systemHealthResponse.parse(body)` does not throw. The test constructs no handler map and injects no fake.
2. **The capability list is the expected list.** The same body's `capabilities` deep-equals `["external-drive", "per-node-write", "project-graph"]`, written as a literal in the test.
3. **A harness reads the identical handshake.** `rawRequest("GET", "/v1/health", harnessToken)` returns `200`, and its `text` is byte-identical to the human call's `text`, compared through `Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")) === 0`.
4. **A harness cannot read `system.status`.** `rawRequest("GET", "/v1/status", harnessToken)` returns `403`, and `JSON.parse(text).error.code` equals `"actor-forbidden"`.
5. **The response does not vary by the client header.** Four `rawRequest("GET", "/v1/health", humanToken, …)` calls: header absent; `X-Kanthord-Client: 0.0.1`; `X-Kanthord-Client: 999.0.0`; `X-Kanthord-Client: not a version`. Each returns `200`, and each `text` is byte-identical to the first through `Buffer.compare`. The malformed value never returns `400`.
6. **No response carries `Vary: X-Kanthord-Client`, and `Vary: Origin` is still there.** For `GET /v1/health` with the human token, `GET /v1/status` with the human token, and `rawRequest("POST", "/v1/actor", humanToken, { body: { name: "vary-probe" } })`, assert `headers.get("vary")` is a non-null string, that its lower-cased value contains `"origin"`, and that it does not contain `"x-kanthord-client"`.
7. **`GET /v1/health` writes nothing.** Open one `DatabaseSync(join(home.path, "kanthord.db"))` and hold it for the whole case. Read `JSON.stringify(database.prepare("SELECT * FROM event ORDER BY id ASC").all())` and `(database.prepare("PRAGMA data_version").get() as { data_version: number }).data_version`. Call `rawRequest("GET", "/v1/health", humanToken)` and assert `200`. Read both again and assert each is strictly equal to the value before. Close the database in a `finally`.

The `POST /v1/actor` of case 6 writes an actor row, so case 7 opens its database connection after that call and compares only against its own before-value.

## Constraints

- `declaredCapabilities(registry)` is called once in `src/main.ts`. Do not call it inside a handler.
- `src/main.capability.test.ts` builds no handler map and passes no `handlers` override. It drives the daemon `launchDaemon` starts.
- Do not add a `Vary` header anywhere. `src/http/server/origin.ts:37` already sets `Vary: Origin` in a `finally` block.
- Do not read `X-Kanthord-Client` in `src/http/server/`. `src/http/server/preflight.ts:7` keeps it in the CORS allow-list, and that is the only server-side mention.
- Reserve the port with `reservePort()` and pass `allowedHosts: ["127.0.0.1:<port>"]`. A raw `fetch` sends `Host: 127.0.0.1:<port>` and no `Origin`, so both browser defences pass.
- Do not edit `src/main.test.ts`, `src/main.readiness.test.ts` or `src/main.node-write.test.ts`.

## Verify

- `node --test src/main.capability.test.ts` exits 0 with the seven cases above.
- The full EPIC Proof block exits 0:
  ```bash
  node --test \
    src/http/contract/capability.test.ts \
    src/http/contract/system.test.ts \
    src/http/contract/example.test.ts \
    src/http/contract/registry.test.ts \
    src/http/contract/parity.test.ts \
    src/queries/system/read-health.test.ts \
    src/http/server/system/health.test.ts \
    src/main.capability.test.ts \
    && echo "PASS EPIC-023"
  ```
- `npm run verify` exits 0. This is the gate for Stories 3, 4 and 5 together.
- Proof: `src/main.capability.test.ts`, and `PASS EPIC-023` as a whole.
