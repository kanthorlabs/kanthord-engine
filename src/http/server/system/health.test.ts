import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { healthHandler } from "./health.ts";
import type { ReadHealthResult } from "../../../queries/system/read-health.ts";
import { findOperation } from "../../contract/registry.ts";
import { systemHealthResponse } from "../../contract/system.ts";
import type { HandlerContext } from "../app.ts";
import {
  createTestApp,
  BOOTSTRAP_ACTOR_FIXTURE,
} from "../../../../test/helpers/app.ts";

const okResult: ReadHealthResult = {
  status: "ok",
  version: "27.8.1",
  capabilities: ["external-drive", "per-node-write", "project-graph"],
  dependencies: [{ name: "storage", status: "ok" }],
};

describe("src/http/server/system/health.test", () => {
  it("a clean request answers 200 with the query result", async () => {
    const app = await createTestApp({
      handlers: {
        "system.health": healthHandler({ readHealth: () => okResult }),
      },
    });
    const response = await app.get("/v1/health");

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, okResult);
    assert.equal(systemHealthResponse.safeParse(response.body).success, true);
  });

  it("a degraded result also answers 200", async () => {
    const degraded: ReadHealthResult = {
      status: "degraded",
      version: "27.8.1",
      capabilities: ["external-drive", "per-node-write", "project-graph"],
      dependencies: [{ name: "storage", status: "failed" }],
    };
    const app = await createTestApp({
      handlers: {
        "system.health": healthHandler({ readHealth: () => degraded }),
      },
    });
    const response = await app.get("/v1/health");

    assert.equal(response.status, 200);
    assert.equal(response.body.status, "degraded");
  });

  it("a request without a token answers 401", async () => {
    const app = await createTestApp({
      handlers: {
        "system.health": healthHandler({ readHealth: () => okResult }),
      },
    });
    const response = await app.raw
      .get("/v1/health")
      .set("Host", "kanthord.test");

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "unauthenticated");
  });

  it("an Origin header answers 403 origin-forbidden", async () => {
    const app = await createTestApp({
      handlers: {
        "system.health": healthHandler({ readHealth: () => okResult }),
      },
    });
    const response = await app
      .get("/v1/health")
      .set("Origin", "http://evil.example");

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "origin-forbidden");
  });

  it("a Host outside the allow list answers 403 host-forbidden", async () => {
    const app = await createTestApp({
      handlers: {
        "system.health": healthHandler({ readHealth: () => okResult }),
      },
    });
    const response = await app.get("/v1/health").set("Host", "evil.example");

    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "host-forbidden");
  });

  it("the mock query is called once per 200 and never on a refusal", async () => {
    let calls = 0;
    const app = await createTestApp({
      handlers: {
        "system.health": healthHandler({
          readHealth: () => {
            calls += 1;
            return okResult;
          },
        }),
      },
    });

    const clean = await app.get("/v1/health");
    assert.equal(clean.status, 200);
    assert.equal(calls, 1);

    const noToken = await app.raw
      .get("/v1/health")
      .set("Host", "kanthord.test");
    assert.equal(noToken.status, 401);
    const origin = await app
      .get("/v1/health")
      .set("Origin", "http://evil.example");
    assert.equal(origin.status, 403);
    const host = await app.get("/v1/health").set("Host", "evil.example");
    assert.equal(host.status, 403);

    assert.equal(calls, 1);
  });

  it("the handler formats the query result directly", () => {
    const handler = healthHandler({ readHealth: () => okResult });
    const context: HandlerContext = {
      operation: findOperation("system.health")!,
      parameters: {},
      query: {},
      headers: {},
      body: undefined,
      actor: BOOTSTRAP_ACTOR_FIXTURE,
    };

    assert.deepEqual(handler(context), { status: 200, body: okResult });
  });
});
