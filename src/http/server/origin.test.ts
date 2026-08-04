import { describe, it } from "node:test";
import assert from "node:assert/strict";

import Koa, { type Middleware } from "koa";

import { envelopeMiddleware } from "./envelope.ts";
import { originMiddleware } from "./origin.ts";
import { loopbackAgent } from "../../../test/helpers/agent.ts";

function buildApp(middleware: Middleware): Koa {
  const app = new Koa();
  app.use(envelopeMiddleware({ onInternalError: () => {} }));
  app.use(middleware);
  app.use((context) => {
    context.body = { reached: true };
  });
  return app;
}

const refusedBody = {
  error: {
    code: "origin-forbidden",
    message: "the request carried an Origin header",
  },
};

describe("src/http/server/origin.test", () => {
  it("answers 200 and reaches downstream when the request carries no Origin header", async () => {
    const app = buildApp(originMiddleware());
    const response = await (await loopbackAgent(app)).get("/");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { reached: true });
  });

  it("answers 403 origin-forbidden and never reaches the downstream middleware", async () => {
    const app = buildApp(originMiddleware());
    const response = await (
      await loopbackAgent(app)
    )
      .get("/")
      .set("Origin", "http://evil.example");
    assert.equal(response.status, 403);
    assert.equal(response.body.reached, undefined);
    assert.deepEqual(response.body, refusedBody);
  });

  it("refuses every Origin value in the table with the same 403 and body", async () => {
    const app = buildApp(originMiddleware());
    const values = [
      "null",
      "",
      "http://127.0.0.1",
      "http://localhost:7421",
      "https://kanthord.test",
    ];
    for (const value of values) {
      const response = await (
        await loopbackAgent(app)
      )
        .get("/")
        .set("Origin", value);
      assert.equal(response.status, 403, `Origin ${JSON.stringify(value)}`);
      assert.deepEqual(
        response.body,
        refusedBody,
        `Origin ${JSON.stringify(value)}`,
      );
    }
  });

  it("refuses an Origin header on every method", async () => {
    const app = buildApp(originMiddleware());
    for (const method of ["get", "post", "put", "delete"] as const) {
      const response = await (
        await loopbackAgent(app)
      )
        [method]("/")
        .set("Origin", "http://evil.example");
      assert.equal(response.status, 403, method);
      assert.deepEqual(response.body, refusedBody, method);
    }
  });

  it("does not confuse a neighbouring header for Origin", async () => {
    const app = buildApp(originMiddleware());
    const response = await (
      await loopbackAgent(app)
    )
      .get("/")
      .set("Referer", "http://evil.example");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { reached: true });
  });
});
