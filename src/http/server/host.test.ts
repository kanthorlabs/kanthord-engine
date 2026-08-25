import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Hono } from "hono";
import type Koa from "koa";

import { errorResponse, errorValue, materializeError } from "./envelope.ts";
import { headersMiddleware } from "./headers.ts";
import { hostMiddleware } from "./host.ts";
import type { HostDependencies } from "./host.ts";
import { koaFromHono } from "./koa-bridge.ts";
import { renderMiddleware } from "./render.ts";
import { demand } from "./variables.ts";
import type { AppEnv } from "./variables.ts";
import { loopbackAgent } from "../../../test/helpers/agent.ts";

function buildApp(
  dependencies: HostDependencies,
  onInternalError: (error: unknown) => void = () => {},
): Koa {
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
  hono.use("*", hostMiddleware(dependencies));
  hono.all("*", async (c) => {
    c.set("result", { kind: "json", status: 200, body: { reached: true } });
  });
  return koaFromHono(hono);
}

describe("src/http/server/host.test", () => {
  it("answers 200 when the Host header is in the allow list", async () => {
    const app = buildApp({ allowedHosts: ["kanthord.test"] });
    const response = await (
      await loopbackAgent(app)
    )
      .get("/")
      .set("Host", "kanthord.test");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { reached: true });
  });

  it("answers 403 host-forbidden echoing the refused Host header", async () => {
    const app = buildApp({ allowedHosts: ["kanthord.test"] });
    const response = await (
      await loopbackAgent(app)
    )
      .get("/")
      .set("Host", "evil.example");
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, {
      error: {
        code: "host-forbidden",
        message: "the Host header evil.example is outside the allow list",
      },
    });
  });

  it("answers 403 when no Host header is overridden and supertest sends the loopback port", async () => {
    const app = buildApp({ allowedHosts: ["kanthord.test"] });
    const response = await (await loopbackAgent(app)).get("/");
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "host-forbidden");
    assert.match(
      response.body.error.message,
      /^the Host header 127\.0\.0\.1:\d+ is outside the allow list$/,
    );
  });

  it("compares the host case-insensitively in both directions", async () => {
    const mixedCaseList = buildApp({ allowedHosts: ["Kanthord.Test"] });
    const lowerList = buildApp({ allowedHosts: ["kanthord.test"] });
    const first = await (
      await loopbackAgent(mixedCaseList)
    )
      .get("/")
      .set("Host", "kanthord.test");
    assert.equal(first.status, 200);
    const second = await (
      await loopbackAgent(lowerList)
    )
      .get("/")
      .set("Host", "KANTHORD.TEST");
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, { reached: true });
  });

  it("treats a port as part of the comparison", async () => {
    const app = buildApp({ allowedHosts: ["kanthord.test:7421"] });
    const bare = await (
      await loopbackAgent(app)
    )
      .get("/")
      .set("Host", "kanthord.test");
    assert.equal(bare.status, 403);
    const withPort = await (
      await loopbackAgent(app)
    )
      .get("/")
      .set("Host", "kanthord.test:7421");
    assert.equal(withPort.status, 200);
    assert.deepEqual(withPort.body, { reached: true });
  });

  it("answers 403 on a trailing dot", async () => {
    const app = buildApp({ allowedHosts: ["kanthord.test"] });
    const response = await (
      await loopbackAgent(app)
    )
      .get("/")
      .set("Host", "kanthord.test.");
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "host-forbidden");
  });

  it("answers 200 for each entry of a multi-entry allow list and 403 for a stranger", async () => {
    const app = buildApp({ allowedHosts: ["a.test", "b.test"] });
    for (const host of ["a.test", "b.test"]) {
      const response = await (
        await loopbackAgent(app)
      )
        .get("/")
        .set("Host", host);
      assert.equal(response.status, 200, host);
      assert.deepEqual(response.body, { reached: true }, host);
    }
    const stranger = await (
      await loopbackAgent(app)
    )
      .get("/")
      .set("Host", "c.test");
    assert.equal(stranger.status, 403);
  });

  it("refuses everything when the allow list is empty", async () => {
    const app = buildApp({ allowedHosts: [] });
    const response = await (
      await loopbackAgent(app)
    )
      .get("/")
      .set("Host", "kanthord.test");
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "host-forbidden");
  });

  it("ignores X-Forwarded-Host", async () => {
    const app = buildApp({ allowedHosts: ["kanthord.test"] });
    const response = await (
      await loopbackAgent(app)
    )
      .get("/")
      .set("Host", "evil.example")
      .set("X-Forwarded-Host", "kanthord.test");
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "host-forbidden");
  });

  it("echoes the sent value and nothing else in the refusal message", async () => {
    const app = buildApp({ allowedHosts: ["kanthord.test"] });
    const response = await (
      await loopbackAgent(app)
    )
      .get("/")
      .set("Host", "evil.example:9999");
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, {
      error: {
        code: "host-forbidden",
        message: "the Host header evil.example:9999 is outside the allow list",
      },
    });
    assert.equal(response.text.includes("kanthord.test"), false);
  });
});
