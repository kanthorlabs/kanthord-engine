import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import type Koa from "koa";
import type request from "supertest";

import { errorResponse, errorValue, materializeError } from "./envelope.ts";
import { headersMiddleware } from "./headers.ts";
import { koaFromHono } from "./koa-bridge.ts";
import { preflightMiddleware } from "./preflight.ts";
import { renderMiddleware } from "./render.ts";
import { originMiddleware } from "./origin.ts";
import { httpError } from "../contract/errors.ts";
import { registry } from "../contract/registry.ts";
import { demand } from "./variables.ts";
import type { AppEnv } from "./variables.ts";
import { loopbackAgent } from "../../../test/helpers/agent.ts";

function authStage(resolved: string[]): MiddlewareHandler<AppEnv> {
  return async (c) => {
    resolved.push(c.req.header("authorization") ?? "");
    throw httpError("unauthenticated", "no bearer token");
  };
}

function routeStage(): MiddlewareHandler<AppEnv> {
  return async () => {
    throw httpError("not-found", "no operation matches the request path");
  };
}

function buildApp(
  allowedOrigins: readonly string[],
  ...middleware: MiddlewareHandler<AppEnv>[]
): Koa {
  const hono = new Hono<AppEnv>();
  hono.onError((error, c) =>
    errorResponse(materializeError(errorValue(error)), demand(c, "headers")),
  );
  hono.use("*", headersMiddleware());
  hono.use("*", renderMiddleware());
  hono.use("*", originMiddleware({ allowedOrigins }));
  hono.use("*", preflightMiddleware());
  for (const one of middleware) {
    hono.use("*", one);
  }
  hono.all("*", async (c) => {
    c.set("result", { kind: "json", status: 200, body: { reached: true } });
  });
  return koaFromHono(hono);
}

function answerOf(response: request.Response) {
  return {
    status: response.status,
    text: response.text,
    headers: {
      "access-control-allow-origin":
        response.headers["access-control-allow-origin"],
      "access-control-allow-methods":
        response.headers["access-control-allow-methods"],
      "access-control-allow-headers":
        response.headers["access-control-allow-headers"],
      "access-control-max-age": response.headers["access-control-max-age"],
      "access-control-expose-headers":
        response.headers["access-control-expose-headers"],
      "access-control-allow-credentials":
        response.headers["access-control-allow-credentials"],
      vary: response.headers["vary"],
      "content-type": response.headers["content-type"],
      etag: response.headers["etag"],
    },
  };
}

describe("src/http/server/preflight.test", () => {
  it("answers 204 with the full CORS header set and never reaches downstream", async () => {
    const app = buildApp(["http://localhost:8080"]);
    const response = await (
      await loopbackAgent(app)
    )
      .options("/")
      .set("Origin", "http://localhost:8080");
    assert.equal(response.status, 204);
    assert.equal(response.text, "");
    assert.equal(
      response.headers["access-control-allow-origin"],
      "http://localhost:8080",
    );
    assert.equal(
      response.headers["access-control-allow-methods"],
      "DELETE, GET, POST, PUT",
    );
    assert.equal(
      response.headers["access-control-allow-headers"],
      "authorization, content-type, idempotency-key, if-none-match, x-kanthord-client",
    );
    assert.equal(response.headers["access-control-max-age"], "86400");
    assert.equal(response.headers["vary"], "Origin");
    assert.equal(
      response.headers["access-control-allow-credentials"],
      undefined,
    );
  });

  it("answers 204 with no Authorization header", async () => {
    const app = buildApp(["http://localhost:8080"]);
    const response = await (
      await loopbackAgent(app)
    )
      .options("/")
      .set("Origin", "http://localhost:8080");
    assert.equal(response.status, 204);
  });

  it("refuses an OPTIONS from a disallowed origin with 403 origin-forbidden and no allow-origin header", async () => {
    const app = buildApp(["http://localhost:8080"]);
    const response = await (
      await loopbackAgent(app)
    )
      .options("/")
      .set("Origin", "http://evil.test");
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "origin-forbidden");
    assert.equal(response.headers["access-control-allow-origin"], undefined);
  });

  it("passes an OPTIONS with no Origin header through to downstream", async () => {
    const app = buildApp(["http://localhost:8080"]);
    const response = await (await loopbackAgent(app)).options("/");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { reached: true });
    assert.equal(response.headers["access-control-allow-methods"], undefined);
    assert.equal(response.headers["access-control-allow-headers"], undefined);
    assert.equal(response.headers["access-control-max-age"], undefined);
  });

  it("does not answer the preflight constant for a GET, only for OPTIONS", async () => {
    const app = buildApp(["http://localhost:8080"]);
    const response = await (
      await loopbackAgent(app)
    )
      .get("/")
      .set("Origin", "http://localhost:8080");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { reached: true });
    assert.equal(response.headers["access-control-allow-methods"], undefined);
    assert.equal(response.headers["access-control-allow-headers"], undefined);
    assert.equal(response.headers["access-control-max-age"], undefined);
  });

  it("still answers 204 for an OPTIONS from an allowed origin with no Access-Control-Request-Method header", async () => {
    const app = buildApp(["http://localhost:8080"]);
    const response = await (
      await loopbackAgent(app)
    )
      .options("/")
      .set("Origin", "http://localhost:8080");
    assert.equal(response.status, 204);
  });

  it("answers the identical byte-for-byte 204 for a path that matches no operation", async () => {
    const app = buildApp(["http://localhost:8080"]);
    const agent = await loopbackAgent(app);
    const known = await agent
      .options("/")
      .set("Origin", "http://localhost:8080");
    const unknown = await agent
      .options("/nothing/here/at/all")
      .set("Origin", "http://localhost:8080");
    assert.deepEqual(answerOf(known), answerOf(unknown));
    assert.equal(known.text, "");
  });

  it("answers the identical 204 for a real registry path and an absent one", async () => {
    const app = buildApp(["http://localhost:8080"]);
    const agent = await loopbackAgent(app);
    const known = await agent
      .options("/v1/status")
      .set("Origin", "http://localhost:8080");
    const unknown = await agent
      .options("/v1/no/such/thing")
      .set("Origin", "http://localhost:8080");
    assert.deepEqual(answerOf(known), answerOf(unknown));
  });

  it("ALLOWED_METHODS matches the sorted unique set of registry methods", async () => {
    const app = buildApp(["http://localhost:8080"]);
    const response = await (
      await loopbackAgent(app)
    )
      .options("/")
      .set("Origin", "http://localhost:8080");
    const expected = [...new Set(registry.map((entry) => entry.method))]
      .sort()
      .join(", ");
    assert.equal(response.headers["access-control-allow-methods"], expected);
  });

  it("a preflight from an allowed origin with no Authorization header on an unknown path bypasses authentication and route matching", async () => {
    const resolved: string[] = [];
    const app = buildApp(
      ["http://localhost:8080"],
      authStage(resolved),
      routeStage(),
    );
    const response = await (
      await loopbackAgent(app)
    )
      .options("/v1/no/such/thing")
      .set("Origin", "http://localhost:8080");
    assert.equal(response.status, 204);
    assert.equal(response.text, "");
    assert.equal(response.headers["content-type"], undefined);
    assert.deepEqual(resolved, []);
  });
});
