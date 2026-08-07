import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { statusHandler } from "./status.ts";
import type { ReadStatusResult } from "../../../queries/system/read-status.ts";
import { findOperation } from "../../contract/registry.ts";
import { systemStatusResponse } from "../../contract/system.ts";
import type { HandlerContext } from "../app.ts";
import { createTestApp } from "../../../../test/helpers/app.ts";

const fixture: ReadStatusResult = {
  version: "27.8.1",
  bind: "127.0.0.1:7421",
  startedAt: "2026-08-06T00:00:00.000Z",
  status: "ok",
  dependencies: [{ name: "storage", status: "ok" }],
  nodes: [{ kind: "task", state: "pending", blockReason: null, count: 1 }],
  repositories: [
    {
      id: "repo_a",
      name: "kanthord-verify",
      divergedLandingOid: "a".repeat(40),
      divergedUpstreamOid: "b".repeat(40),
    },
  ],
  leases: [
    {
      subjectKind: "node",
      subjectId: "task_a",
      owner: null,
      fence: 1,
      expiresAt: 1700000000,
    },
  ],
};

describe("src/http/server/system/status.test", () => {
  it("a clean request answers 200 with the query result", async () => {
    const app = await createTestApp({
      handlers: {
        "system.status": statusHandler({ readStatus: () => fixture }),
      },
    });
    const response = await app.get("/v1/status");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, fixture);
    assert.equal(systemStatusResponse.safeParse(response.body).success, true);
  });

  it("a request without a token answers 401", async () => {
    const app = await createTestApp({
      handlers: {
        "system.status": statusHandler({ readStatus: () => fixture }),
      },
    });
    const response = await app.raw
      .get("/v1/status")
      .set("Host", "kanthord.test");

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "unauthenticated");
  });

  it("an Origin header answers 403 origin-forbidden", async () => {
    const app = await createTestApp({
      handlers: {
        "system.status": statusHandler({ readStatus: () => fixture }),
      },
    });
    const response = await app
      .get("/v1/status")
      .set("Origin", "http://evil.example");

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "origin-forbidden");
  });

  it("the mock query is called once per 200 and never on a refusal", async () => {
    let calls = 0;
    const app = await createTestApp({
      handlers: {
        "system.status": statusHandler({
          readStatus: () => {
            calls += 1;
            return fixture;
          },
        }),
      },
    });

    const clean = await app.get("/v1/status");
    assert.equal(clean.status, 200);
    assert.equal(calls, 1);

    const noToken = await app.raw
      .get("/v1/status")
      .set("Host", "kanthord.test");
    assert.equal(noToken.status, 401);
    const origin = await app
      .get("/v1/status")
      .set("Origin", "http://evil.example");
    assert.equal(origin.status, 403);

    assert.equal(calls, 1);
  });

  it("the handler formats the query result directly and reads neither body nor parameters", () => {
    const handler = statusHandler({ readStatus: () => fixture });
    const context: HandlerContext = {
      operation: findOperation("system.status")!,
      parameters: { id: "unused" },
      body: { unused: true },
    };

    assert.deepEqual(handler(context), { status: 200, body: fixture });
  });
});
