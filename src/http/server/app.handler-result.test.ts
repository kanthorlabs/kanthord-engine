import { readdirSync, readFileSync } from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  createSocketTestApp,
  BOOTSTRAP_ACTOR_FIXTURE,
} from "../../../test/helpers/app.ts";
import { findOperation } from "../contract/registry.ts";
import { showBlobHandler } from "./blob/show-blob.ts";
import type { BlobView } from "../../queries/blob/show-blob.ts";
import { handlerStatuses } from "./app.ts";
import type { HandlerContext } from "./app.ts";

const HANDLERS: readonly (readonly [string, readonly number[]])[] = [
  ["src/http/server/actor/list-actor.ts", [200]],
  ["src/http/server/actor/register-actor.ts", [200]],
  ["src/http/server/actor/revoke-actor.ts", [200]],
  ["src/http/server/actor/rotate-actor-token.ts", [200]],
  ["src/http/server/actor/show-actor.ts", [200]],
  ["src/http/server/agent/list-agents.ts", [200]],
  ["src/http/server/blob/show-blob.ts", [200, 206]],
  ["src/http/server/credential/cancel-provider-login.ts", [204]],
  ["src/http/server/credential/complete-provider-login.ts", [200]],
  ["src/http/server/credential/inspect-provider.ts", [200]],
  ["src/http/server/credential/list-provider.ts", [200]],
  ["src/http/server/credential/read-catalog.ts", [200]],
  ["src/http/server/credential/register-provider.ts", [200]],
  ["src/http/server/credential/remove-provider.ts", [200]],
  ["src/http/server/credential/rename-provider.ts", [200]],
  ["src/http/server/credential/set-default-provider.ts", [200]],
  ["src/http/server/credential/show-provider.ts", [200]],
  ["src/http/server/credential/start-provider-login.ts", [200]],
  ["src/http/server/credential/verify-provider.ts", [200]],
  ["src/http/server/edge/list-edge.ts", [200]],
  ["src/http/server/event/list-event.ts", [200]],
  ["src/http/server/node/claim-node.ts", [200]],
  ["src/http/server/node/create-node.ts", [200]],
  ["src/http/server/node/delete-node.ts", [200]],
  ["src/http/server/node/list-node.ts", [200]],
  ["src/http/server/node/list-project-node.ts", [200]],
  ["src/http/server/node/release-node.ts", [200]],
  ["src/http/server/node/renew-node.ts", [200]],
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
  ["src/http/server/worker/list-workers.ts", [200]],
];

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
        /\b(?:body|bytes)\s*[,:}]/.test(result),
      ]);
    }
  }
  return found.sort((a, b) =>
    Buffer.compare(Buffer.from(a[0], "utf8"), Buffer.from(b[0], "utf8")),
  );
}

const repositoryRoot = new URL("../../../", import.meta.url).pathname;
const scanned = scanHandlers(
  `${repositoryRoot}src/http/server`,
  "src/http/server/",
);

const content = Buffer.from([
  0x00, 0x80, 0xff, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36,
]);
const hash = `sha256:${createHash("sha256").update(content).digest("hex")}`;
const record: BlobView = {
  hash,
  size: content.length,
  content,
  createdAt: 1700000000000,
};
const blobMedia = findOperation("blob.show")?.responseMedia;

describe("src/http/server/app.handler-result.test", () => {
  it("the handler tree equals the frozen table", () => {
    assert.deepEqual(
      scanned.map(([path, statuses]) => [path, statuses]),
      HANDLERS,
    );
  });

  it("the declared status set is the exact closed list and the tree answers 200 and 206 and nothing else", () => {
    assert.deepEqual(handlerStatuses, [200, 204, 206, 304]);
    const union = [
      ...new Set(HANDLERS.flatMap(([, statuses]) => [...statuses])),
    ].sort((a, b) => a - b);
    assert.deepEqual(union, [200, 204, 206]);
  });

  it("exactly one handler declares response headers, and it is the blob handler", () => {
    assert.deepEqual(
      scanned.filter(([, , headers]) => headers).map(([path]) => path),
      ["src/http/server/blob/show-blob.ts"],
    );
  });

  it("every handler except cancellation returns a payload value", () => {
    assert.deepEqual(
      scanned.filter(([, , , payload]) => !payload).map(([path]) => path),
      ["src/http/server/credential/cancel-provider-login.ts"],
    );
  });

  it("a new handler file fails the scan and the failure names it", () => {
    const fixture = mkdtempSync(join(tmpdir(), "kanthord-handler-"));
    try {
      const alpha = join(fixture, "alpha");
      mkdirSync(alpha);
      const source =
        'export const h: Handler = () => ({ kind: "json", status: 200, body: {} });';
      writeFileSync(join(alpha, "one.ts"), source);
      assert.deepEqual(scanHandlers(fixture, ""), [
        ["alpha/one.ts", [200], false, true],
      ]);
      writeFileSync(join(alpha, "two.ts"), source);
      assert.deepEqual(scanHandlers(fixture, ""), [
        ["alpha/one.ts", [200], false, true],
        ["alpha/two.ts", [200], false, true],
      ]);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("a JSON result serializes as application/json", async () => {
    const app = await createSocketTestApp({
      handlers: {
        "system.health": () => ({
          kind: "json",
          status: 200,
          body: { ok: true },
        }),
      },
    });
    const response = await app.get("/v1/health");
    assert.equal(response.status, 200);
    assert.equal(
      response.headers["content-type"],
      "application/json; charset=utf-8",
    );
  });

  it("showBlobHandler returns the bytes variant as a plain Uint8Array", async () => {
    const operation = findOperation("blob.show");
    assert.ok(operation !== undefined);
    const handler = showBlobHandler({ showBlob: () => record });
    const context: HandlerContext = {
      operation,
      parameters: { hash },
      query: {},
      headers: {},
      body: undefined,
      actor: BOOTSTRAP_ACTOR_FIXTURE,
    };

    const full = await handler(context);
    if (full.kind !== "bytes") {
      throw new Error("the full answer is not the bytes variant");
    }
    assert.equal(full.status, 200);
    assert.equal(full.bytes.constructor, Uint8Array);
    assert.equal(Buffer.isBuffer(full.bytes), false);
    assert.deepEqual(full.bytes, Uint8Array.from(content));

    const ranged = await handler({
      ...context,
      headers: { range: "bytes=0-4" },
    });
    if (ranged.kind !== "bytes") {
      throw new Error("the range answer is not the bytes variant");
    }
    assert.equal(ranged.status, 206);
    assert.equal(ranged.bytes.constructor, Uint8Array);
    assert.equal(Buffer.isBuffer(ranged.bytes), false);
    assert.deepEqual(ranged.bytes, Uint8Array.from(content.subarray(0, 5)));
  });

  it("a bytes result serializes byte-exact with an exact content-length and the registry media type", async () => {
    const app = await createSocketTestApp({
      handlers: { "blob.show": showBlobHandler({ showBlob: () => record }) },
    });
    const response = await app.get(`/v1/blob/${hash}`).buffer();
    assert.equal(response.status, 200);
    assert.equal(response.headers["content-type"], blobMedia);
    assert.equal(response.headers["content-length"], String(content.length));
    assert.deepEqual(response.body, content);
  });

  it("a Range request answers 206 with an exact content-range and a byte-exact slice", async () => {
    const app = await createSocketTestApp({
      handlers: { "blob.show": showBlobHandler({ showBlob: () => record }) },
    });
    const response = await app
      .get(`/v1/blob/${hash}`)
      .set("Range", "bytes=0-4")
      .buffer();
    assert.equal(response.status, 206);
    assert.equal(
      response.headers["content-range"],
      `bytes 0-4/${content.length}`,
    );
    assert.equal(response.headers["content-length"], "5");
    assert.deepEqual(response.body, content.subarray(0, 5));
  });

  it("a 204 handler result carries no content-length on the socket", async () => {
    const app = await createSocketTestApp({
      handlers: { "system.status": () => ({ kind: "empty", status: 204 }) },
    });
    const response = await app.get("/v1/status");
    assert.equal(response.status, 204);
    assert.equal(response.text, "");
    assert.equal(response.headers["content-length"], undefined);
    assert.equal(response.headers["content-type"], undefined);
  });

  it("a 304 handler result carries no content-length on the socket", async () => {
    const app = await createSocketTestApp({
      handlers: { "system.status": () => ({ kind: "empty", status: 304 }) },
    });
    const response = await app.get("/v1/status");
    assert.equal(response.status, 304);
    assert.equal(response.text, "");
    assert.equal(response.headers["content-length"], undefined);
    assert.equal(response.headers["content-type"], undefined);
  });

  it("the preflight is the one empty-body answer", async () => {
    const app = await createSocketTestApp({
      allowedOrigins: ["http://localhost:8080"],
    });
    const response = await app.raw
      .options("/v1/status")
      .set("Host", "kanthord.test")
      .set("Origin", "http://localhost:8080");
    assert.equal(response.status, 204);
    assert.equal(response.text, "");
    assert.equal(response.headers["content-length"], undefined);
    assert.equal(response.headers["content-type"], undefined);
    assert.equal(response.headers["vary"], "Origin");
  });
});
