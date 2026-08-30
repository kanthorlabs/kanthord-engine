import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Hono } from "hono";

import { errorResponse, errorValue, materializeError } from "./envelope.ts";
import { headersMiddleware } from "./headers.ts";
import { renderMiddleware } from "./render.ts";
import { routeMiddleware } from "./route.ts";
import { demand } from "./variables.ts";
import type { AppEnv } from "./variables.ts";
import { fetchAgent } from "../../../test/helpers/agent.ts";
import { createTestApp, drive, driveRaw } from "../../../test/helpers/app.ts";
import { readRouteMatrix } from "../../../test/helpers/proposal.ts";
import { findOperation } from "../contract/registry.ts";

const postMvp = readRouteMatrix()
  .filter((row) => row.introducedIn === "post-mvp")
  .sort((a, b) =>
    Buffer.compare(Buffer.from(a.operationId), Buffer.from(b.operationId)),
  );

type OnInternalError = (error: unknown) => void;

function buildApp(onInternalError: OnInternalError = () => {}): Hono<AppEnv> {
  const hono = new Hono<AppEnv>();
  hono.onError((error, c) => {
    const value = errorValue(error);
    const materialized = materializeError(value);
    if (materialized.internal) {
      onInternalError(value);
    }
    return errorResponse(materialized, demand(c, "headers"));
  });
  hono.use("*", headersMiddleware());
  hono.use("*", renderMiddleware());
  hono.use("*", routeMiddleware());
  hono.all("*", async (c) => {
    const match = demand(c, "match");
    c.set("result", {
      kind: "json",
      status: 200,
      body: {
        reached: true,
        operation: match.operation,
        parameters: match.parameters,
      },
    });
  });
  return hono;
}

describe("src/http/server/route.test", () => {
  it("GET /v1/health leaves the match variable's operation.operationId equal to system.health", async () => {
    const response = await fetchAgent(buildApp()).get("/v1/health");
    assert.equal(response.status, 200);
    assert.equal(response.body.operation.operationId, "system.health");
  });

  it("GET /v1/node/task_01JQ8ZAN9P leaves the match variable's parameters deep-equal to the id", async () => {
    const response = await fetchAgent(buildApp()).get(
      "/v1/node/task_01JQ8ZAN9P",
    );
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.parameters, { id: "task_01JQ8ZAN9P" });
  });

  it("GET /v1/nope answers 404 with the no-operation envelope and never reaches the inspector", async () => {
    const response = await fetchAgent(buildApp()).get("/v1/nope");
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      error: { code: "not-found", message: "no operation for GET /v1/nope" },
    });
  });

  it("a query string does not reach matchRoute: GET /v1/health?x=1 resolves to system.health", async () => {
    const response = await fetchAgent(buildApp()).get("/v1/health?x=1");
    assert.equal(response.status, 200);
    assert.equal(response.body.operation.operationId, "system.health");
  });

  it("on every reached request the match variable holds an operation and its parameters", async () => {
    const reached = [
      await fetchAgent(buildApp()).get("/v1/health"),
      await fetchAgent(buildApp()).get("/v1/node/task_01JQ8ZAN9P"),
    ];
    for (const response of reached) {
      assert.equal(response.status, 200);
      assert.ok(
        response.body.operation.operationId,
        "match must name an operation",
      );
      assert.ok(response.body.parameters, "match must carry parameters");
    }
  });

  it("the proposal declares four post-mvp rows", () => {
    assert.deepEqual(
      postMvp.map((row) => row.operationId),
      [
        "binding.e2e.project",
        "binding.provider.agents",
        "binding.provider.project",
        "event.stream",
      ],
    );
    assert.deepEqual(
      postMvp.map((row) => `${row.method} ${row.path}`),
      [
        "PUT /v1/project/:id/binding/e2e",
        "PUT /v1/agent/:role/binding/provider",
        "PUT /v1/project/:id/binding/provider",
        "GET /v1/event/stream",
      ],
    );
    for (const row of postMvp) {
      assert.equal(row.status, "deferred", row.operationId);
    }
    for (const row of readRouteMatrix()) {
      if (row.status === "deferred") {
        assert.equal(row.introducedIn, "post-mvp", row.operationId);
      }
    }
  });

  it("every post-mvp path answers 404 and never 501", async () => {
    const app = await createTestApp();
    let driven = 0;
    for (const row of postMvp) {
      const path = row.path.replace(/:[^/]+/g, "x_01");
      const response = await drive(app, row.method, path);
      assert.equal(response.status, 404, row.operationId);
      assert.equal(response.body.error.code, "not-found", row.operationId);
      assert.match(
        response.body.error.message,
        new RegExp(`${row.method} ${path.replace(/\//g, "\\/")}`),
      );
      driven += 1;
    }
    assert.equal(driven, postMvp.length);
  });

  it("a post-mvp row has no registry entry, and the matrix has no third kind of row", () => {
    for (const row of postMvp) {
      assert.equal(findOperation(row.operationId), undefined, row.operationId);
    }
    const matrix = readRouteMatrix();
    const routedAndStubbed = matrix.filter(
      (row) => row.status === "routed" || row.status === "stubbed",
    ).length;
    assert.equal(matrix.length, 77);
    assert.equal(routedAndStubbed, 73);
    assert.equal(postMvp.length, 4);
    assert.equal(routedAndStubbed + postMvp.length, matrix.length);
  });

  it("a post-mvp path is unreadable without the token", async () => {
    const app = await createTestApp();
    for (const row of postMvp) {
      const path = row.path.replace(/:[^/]+/g, "x_01");
      const response = await driveRaw(app, row.method, path).set(
        "Host",
        "kanthord.test",
      );
      assert.equal(response.status, 401, row.operationId);
      assert.equal(
        response.body.error.code,
        "unauthenticated",
        row.operationId,
      );
    }
  });
});
