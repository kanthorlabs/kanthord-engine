import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createApp } from "./app.ts";
import type { Handler, TransportSettings } from "./app.ts";
import { registry } from "../contract/registry.ts";
import { renderPath } from "../contract/path.ts";
import { createTestApp, unimplementedFor } from "../../../test/helpers/app.ts";

const statusHandler: Handler = () => ({ status: 200, body: { ok: true } });
const healthHandler: Handler = () => ({
  status: 200,
  body: { status: "ok", dependencies: [] },
});
const handlers = {
  "system.status": statusHandler,
  "system.health": healthHandler,
};

describe("src/http/server/app.test", () => {
  it("the browser defences apply to system.health like every route", async () => {
    const app = await createTestApp({ handlers });
    const clean = await app.get("/v1/health");
    assert.equal(clean.status, 200);
    const withOrigin = await app
      .get("/v1/health")
      .set("Origin", "http://evil.example");
    assert.equal(withOrigin.status, 403);
    assert.equal(withOrigin.body.error.code, "origin-forbidden");
    const withHost = await app.get("/v1/health").set("Host", "evil.example");
    assert.equal(withHost.status, 403);
    assert.equal(withHost.body.error.code, "host-forbidden");
  });

  it("system.health requires the bearer token like every other route", async () => {
    const app = await createTestApp({ handlers });
    const response = await app.raw
      .get("/v1/health")
      .set("Host", "kanthord.test");
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "unauthenticated");
  });

  it("origin-forbidden wins over host-forbidden", async () => {
    const app = await createTestApp({ handlers });
    const response = await app.raw
      .get("/v1/status")
      .set("Host", "evil.example")
      .set("Origin", "http://evil.example");
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "origin-forbidden");
  });

  it("a browser check wins over the token", async () => {
    const app = await createTestApp({ handlers });
    const hostMiss = await app.raw
      .get("/v1/status")
      .set("Host", "evil.example");
    assert.equal(hostMiss.status, 403);
    assert.equal(hostMiss.body.error.code, "host-forbidden");
    const originMiss = await app.raw
      .get("/v1/status")
      .set("Origin", "http://x");
    assert.equal(originMiss.status, 403);
    assert.equal(originMiss.body.error.code, "origin-forbidden");
  });

  it("401 wins over 404", async () => {
    const app = await createTestApp({ handlers });
    const noToken = await app.raw.get("/v1/nope").set("Host", "kanthord.test");
    assert.equal(noToken.status, 401);
    assert.equal(noToken.body.error.code, "unauthenticated");
    const withToken = await app.get("/v1/nope");
    assert.equal(withToken.status, 404);
    assert.equal(withToken.body.error.code, "not-found");
  });

  it("every path answers identically without a token", async () => {
    const app = await createTestApp({ handlers });
    type Drive = { method: "get" | "post" | "put" | "del"; path: string };
    const requests: Drive[] = [];
    for (const entry of registry) {
      const path = renderPath(entry.path).replace(/:[^/]+/g, "x_01");
      const method =
        entry.method === "DELETE"
          ? "del"
          : (entry.method.toLowerCase() as "get" | "post" | "put");
      requests.push({ method, path });
    }
    requests.push({ method: "get", path: "/v1/nope" });
    requests.push({ method: "get", path: "/v1/" });
    assert.equal(requests.length, 55);

    const responses: Array<{ status: number; body: unknown }> = [];
    for (const { method, path } of requests) {
      const response = await app.raw[method](path).set("Host", "kanthord.test");
      responses.push({ status: response.status, body: response.body });
    }
    const first = responses[0];
    assert.ok(first, "the request set is not empty");
    assert.equal(first.status, 401);
    for (const response of responses) {
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, first.body);
    }
  });

  it("the token wins over 501", async () => {
    const app = await createTestApp({ handlers });
    const noToken = await app.raw
      .post("/v1/node/task_01/unblock")
      .set("Host", "kanthord.test");
    assert.equal(noToken.status, 401);
    assert.equal(noToken.body.error.code, "unauthenticated");
    const withToken = await app.post("/v1/node/task_01/unblock");
    assert.equal(withToken.status, 501);
    assert.equal(withToken.body.error.code, "not-implemented");
  });

  it("a clean request reaches the handler", async () => {
    const app = await createTestApp({ handlers });
    const response = await app.get("/v1/status");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true });
  });

  it("a body is parsed only after every check", async () => {
    let calls = 0;
    const app = await createTestApp({
      handlers: {
        ...handlers,
        "repository.register": () => {
          calls += 1;
          return { status: 200, body: { ok: true } };
        },
      },
    });
    const response = await app.raw
      .post("/v1/repository")
      .set("Host", "kanthord.test")
      .send({ url: "x" });
    assert.equal(response.status, 401);
    assert.equal(calls, 0);
  });

  it("app.proxy stays false on the app createApp returns", () => {
    const settings: TransportSettings = {
      token: "test-token",
      allowedHosts: ["kanthord.test"],
    };
    const app = createApp({
      settings,
      handlers: {},
      unimplemented: unimplementedFor({}),
      onInternalError: () => {},
    });
    assert.equal(app.proxy, false);
  });

  it("binding system.health and system.db leaves twenty-one unimplemented ids", () => {
    const bound = {
      "system.health": healthHandler,
      "system.db": statusHandler,
    };
    assert.equal(unimplementedFor(bound).length, 21);
  });
});
