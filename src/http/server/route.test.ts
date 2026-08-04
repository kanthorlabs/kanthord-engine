import { describe, it } from "node:test";
import assert from "node:assert/strict";

import Koa from "koa";

import { envelopeMiddleware } from "./envelope.ts";
import { routeMiddleware, type RoutedState } from "./route.ts";
import { loopbackAgent } from "../../../test/helpers/agent.ts";

function buildApp(): Koa {
  const app = new Koa();
  app.use(envelopeMiddleware({ onInternalError: () => {} }));
  app.use(routeMiddleware());
  app.use((context) => {
    context.body = (context.state as RoutedState).match;
  });
  return app;
}

describe("src/http/server/route.test", () => {
  it("GET /v1/health leaves state.match.operation.operationId equal to system.health", async () => {
    const app = buildApp();
    const response = await (await loopbackAgent(app)).get("/v1/health");
    assert.equal(response.status, 200);
    assert.equal(response.body.operation.operationId, "system.health");
  });

  it("GET /v1/node/task_01JQ8ZAN9P leaves state.match.parameters deep-equal to the id", async () => {
    const app = buildApp();
    const response = await (
      await loopbackAgent(app)
    ).get("/v1/node/task_01JQ8ZAN9P");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.parameters, { id: "task_01JQ8ZAN9P" });
  });

  it("GET /v1/nope answers 404 with the no-operation envelope and never reaches the inspector", async () => {
    const app = buildApp();
    const response = await (await loopbackAgent(app)).get("/v1/nope");
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      error: { code: "not-found", message: "no operation for GET /v1/nope" },
    });
  });

  it("a query string does not reach matchRoute: GET /v1/health?x=1 resolves to system.health", async () => {
    const app = buildApp();
    const response = await (await loopbackAgent(app)).get("/v1/health?x=1");
    assert.equal(response.status, 200);
    assert.equal(response.body.operation.operationId, "system.health");
  });

  it("on every reached request state.match is not null", async () => {
    const app = buildApp();
    const reached = [
      await (await loopbackAgent(app)).get("/v1/health"),
      await (await loopbackAgent(app)).get("/v1/node/task_01JQ8ZAN9P"),
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
});
