# Story 2 — The handler result inventory

Epic: `.agents/plan/epics/030-transport-inventory-and-parity-contract.md`
Depends on: Story 1 (the proposal states the answer rule).

Add one file: `src/http/server/app.handler-result.test.ts`. **No production file changes.**
`git diff --name-only` for this commit names exactly that one path.

Delivers P21, P22, P23, P24, P25, and the preflight half of P11.

## Change

### `src/http/server/app.handler-result.test.ts` — new file

Header, matching the convention of `src/http/server/app.test.ts:1-23`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../test/helpers/app.ts";
import { showBlobHandler } from "./blob/show-blob.ts";
import type { BlobView } from "../../queries/blob/show-blob.ts";
```

Suite name: `describe("src/http/server/app.handler-result.test", () => {`.

#### 1. The frozen table

Declare it at module level, exactly these 44 rows in this order:

```ts
const HANDLERS: readonly (readonly [string, readonly number[]])[] = [
  ["src/http/server/actor/list-actor.ts", [200]],
  ["src/http/server/actor/register-actor.ts", [200]],
  ["src/http/server/actor/revoke-actor.ts", [200]],
  ["src/http/server/actor/rotate-actor-token.ts", [200]],
  ["src/http/server/actor/show-actor.ts", [200]],
  ["src/http/server/blob/show-blob.ts", [200, 206]],
  ["src/http/server/credential/inspect-provider.ts", [200]],
  ["src/http/server/credential/list-provider.ts", [200]],
  ["src/http/server/credential/read-catalog.ts", [200]],
  ["src/http/server/credential/register-provider.ts", [200]],
  ["src/http/server/credential/remove-provider.ts", [200]],
  ["src/http/server/credential/rename-provider.ts", [200]],
  ["src/http/server/credential/set-default-provider.ts", [200]],
  ["src/http/server/credential/show-provider.ts", [200]],
  ["src/http/server/edge/list-edge.ts", [200]],
  ["src/http/server/event/list-event.ts", [200]],
  ["src/http/server/node/claim-node.ts", [200]],
  ["src/http/server/node/create-node.ts", [200]],
  ["src/http/server/node/delete-node.ts", [200]],
  ["src/http/server/node/heartbeat-node.ts", [200]],
  ["src/http/server/node/list-node.ts", [200]],
  ["src/http/server/node/list-project-node.ts", [200]],
  ["src/http/server/node/release-node.ts", [200]],
  ["src/http/server/node/report-node.ts", [200]],
  ["src/http/server/node/show-node.ts", [200]],
  ["src/http/server/node/unblock-node.ts", [200]],
  ["src/http/server/node/update-node.ts", [200]],
  ["src/http/server/plan/export-plan.ts", [200]],
  ["src/http/server/plan/import-plan.ts", [200]],
  ["src/http/server/plan/list-revision.ts", [200]],
  ["src/http/server/plan/validate-plan.ts", [200]],
  ["src/http/server/project/create-project.ts", [200]],
  ["src/http/server/project/list-project.ts", [200]],
  ["src/http/server/project/read-project-status.ts", [200]],
  ["src/http/server/project/replace-project-repositories.ts", [200]],
  ["src/http/server/project/show-project-graph.ts", [200]],
  ["src/http/server/project/show-project.ts", [200]],
  ["src/http/server/repository/inspect-repository.ts", [200]],
  ["src/http/server/repository/list-repository.ts", [200]],
  ["src/http/server/repository/register-repository.ts", [200]],
  ["src/http/server/repository/show-repository.ts", [200]],
  ["src/http/server/system/db.ts", [200]],
  ["src/http/server/system/health.ts", [200]],
  ["src/http/server/system/status.ts", [200]],
];
```

#### 2. The scan, as one pure function over a root directory

The scan takes the directory to walk, so the same function serves the tree and the negative-control
fixture. Walk **one** level of subdirectory, which is the EPIC's `src/http/server/*/*.ts` glob.

```ts
type Scanned = readonly [string, readonly number[], boolean, boolean];

function scanHandlers(root: string, prefix: string): readonly Scanned[] {
  const found: Scanned[] = [];
  for (const directory of readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    for (const name of readdirSync(join(root, directory.name))) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
      const full = join(root, directory.name, name);
      const contents = readFileSync(full, "utf8");
      if (!/:\s*Handler\b/.test(contents)) continue;
      const statuses = [
        ...new Set(
          [...contents.matchAll(/\bstatus:\s*(\d+)/g)].map((match) =>
            Number(match[1]),
          ),
        ),
      ].sort((a, b) => a - b);
      const result = contents
        .replaceAll("context.headers", "")
        .replaceAll("context.body", "");
      found.push([
        `${prefix}${directory.name}/${name}`,
        statuses,
        /\bheaders\b/.test(result),
        /\bbody\s*[,:}]/.test(result),
      ]);
    }
  }
  return found.sort((a, b) =>
    Buffer.compare(Buffer.from(a[0], "utf8"), Buffer.from(b[0], "utf8")),
  );
}
```

Strip `context.headers` and `context.body` before the two result rules run, so an input read never
counts as a result property. `/\bbody\s*[,:}]/` matches the shorthand `, body }` used at
`src/http/server/plan/import-plan.ts:42` as well as `body: value`.

The repository root is `new URL("../../../", import.meta.url).pathname`, the idiom already used at
`src/http/contract/coverage.test.ts:496`. Call the scan as
`scanHandlers(`${root}src/http/server`, "src/http/server/")`.

All four regular expressions are verified against the tree as it stands: `/:\s*Handler\b/` selects
exactly 44 files; `/\bstatus:\s*(\d+)/g` yields `[200]` for 43 of them and `[200, 206]` for
`blob/show-blob.ts`; the headers rule matches `blob/show-blob.ts` alone; and the body rule matches
all 44. Do not replace any of the four with a different rule.

#### 3. The four inventory tests

- **`the handler tree equals the frozen table`** — assert
  `scanned.map(([path, statuses]) => [path, statuses])` deep-equals `HANDLERS`. One `assert.deepEqual`
  over the whole list, so a new file, a removed file and a changed status each fail and the diff names
  the file.
- **`the whole tree answers 200 and 206 and nothing else`** — build the union from `HANDLERS`,
  sort ascending, and `assert.deepEqual(union, [200, 206])`. Compare against the literal array, never
  against a length.
- **`exactly one handler declares response headers, and it is the blob handler`** (P22) — assert
  `scanned.filter(([, , headers]) => headers).map(([path]) => path)` deep-equals
  `["src/http/server/blob/show-blob.ts"]`. Compare against the literal path, never against a count.
- **`every handler returns a body value`** (P25) — assert
  `scanned.filter(([, , , body]) => !body).map(([path]) => path)` deep-equals `[]`. This assertion
  carries the uniqueness half of P25; the preflight test carries the other half.
- **`a new handler file fails the scan and the failure names it`** — the negative control. Build a
  fixture tree under `mkdtempSync(join(tmpdir(), "kanthord-handler-"))`: one subdirectory `alpha`
  holding `one.ts` with the contents `export const h: Handler = () => ({ status: 200, body: {} });`.
  Assert `scanHandlers(fixture, "")` deep-equals `[["alpha/one.ts", [200], false, true]]`. Then write
  a second file `alpha/two.ts` with the same contents, re-scan, and assert the result deep-equals
  `[["alpha/one.ts", [200], false, true], ["alpha/two.ts", [200], false, true]]` — the added file
  appears, by name.

  **Wrap the whole body in `try { ... } finally { rmSync(fixture, { recursive: true, force: true }); }`.**
  A `rmSync` written after the assertions leaks the fixture when an assertion throws.

**Never write into `src/`.** The negative control runs against its own temporary directory.

#### 4. The three chain drives, and the preflight

Fixtures at module level, mirroring `src/http/server/blob/show-blob.test.ts:9-17`:

```ts
const content = Buffer.from("0123456789");
const hash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
const record: BlobView = {
  hash,
  size: content.length,
  content,
  createdAt: 1700000000000,
};
```

- **`a JSON result serializes as application/json`** (P23) — `createTestApp({ handlers: { "system.health": () => ({ status: 200, body: { ok: true } }) } })`,
  then `await app.get("/v1/health")`. Assert `response.status` equals `200`, and
  `response.headers["content-type"]` equals the exact string
  `"application/json; charset=utf-8"`. Compare the whole string with `assert.equal`, not with
  `assert.match`.
- **`a Buffer result serializes as bytes with an exact content-length`** (P24) —
  `createTestApp({ handlers: { "blob.show": showBlobHandler({ showBlob: () => record }) } })`, then
  `await app.get(`/v1/blob/${hash}`).buffer()`. Assert `response.status` equals `200`,
  `response.headers["content-type"]` equals `"application/octet-stream"`, and
  `response.headers["content-length"]` equals `String(content.length)` — the value `"10"`, computed
  from the fixture length, never a regular expression.
- **`a Range request answers 206 with an exact content-range`** (P24) — the same app, with
  `.set("Range", "bytes=0-4")`. Assert `response.status` equals `206`,
  `response.headers["content-range"]` equals `` `bytes 0-4/${content.length}` `` — the value
  `"bytes 0-4/10"` — and `response.headers["content-length"]` equals `"5"`. Assert the returned bytes
  deep-equal `content.subarray(0, 5)`.
- **`the preflight is the one empty-body answer`** (P25) — `createTestApp({ allowedOrigins: ["http://localhost:8080"] })`,
  then `await app.raw.options("/v1/status").set("Host", "kanthord.test").set("Origin", "http://localhost:8080")`.
  Assert `response.status` equals `204`, `response.text` equals `""`,
  `response.headers["content-length"]` equals `undefined`, and
  `response.headers["vary"]` equals `"Origin"`.

  The `vary` assertion is this story's share of **P11**. Story 4 drives no `OPTIONS` request, so no
  other full-chain test covers the preflight half of the row.

Verified values: the JSON content type is `application/json; charset=utf-8`; the preflight text is
`""`, it carries no `content-length`, and it carries `vary: Origin`.

## Constraints

- **Change no production file.** `src/http/server/app.ts` keeps its ten middlewares in their current
  order, and no handler changes.
- **Drive the chain through `createTestApp`.** Do not call `dispatchMiddleware`, `originMiddleware`
  or any other middleware factory directly, and do not construct a `Koa` instance in this file.
- **Keep the injected defaults.** `createTestApp` supplies `now: () => 0` and
  `schedule: () => () => {}` (`test/helpers/app.ts:135-136`). Override neither. Assert no timestamp.
- **Assert values, never counts and never predicates.** Compare the file set, the status union and
  the header-setting path with `assert.deepEqual` or `assert.equal` against a literal.
  `assert.ok(union.length === 2)` is a defect.
- **Do not import a handler other than `showBlobHandler`.**
- Do not derive the table from the scan.
- Do not add the file to `src/http/contract/coverage.test.ts` or any other pinned count.

## Verify

```bash
node --test src/http/server/app.handler-result.test.ts
```

- All tests pass on the current stack, first run, with no production change.

```bash
node --test src/http/server/app.test.ts src/http/server/dispatch.test.ts \
  src/http/server/blob/show-blob.test.ts src/http/server/preflight.test.ts
```

- Every one passes unchanged.
- `git diff --name-only` names exactly `src/http/server/app.handler-result.test.ts`.
- `git status --porcelain` is empty after the run.

`npm run verify` exits 0.

Proof: this story delivers the `app.handler-result.test.ts` line of the EPIC Proof block, and rows
P21, P22, P23, P24 and P25 of the parity surface. It delivers these gate bullets: **"The inventory
table matches the tree by exact deep equality"**, **"The inventory asserts a value, never a count
alone"**, and **"The blob byte assertions are exact"**.
