import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../test/helpers/app.ts";
import { httpError } from "../contract/errors.ts";

const ORIGIN = "http://localhost:8080";
const EXPOSED = "etag, accept-ranges, content-range";

async function corsApp() {
  return createTestApp({
    allowedOrigins: [ORIGIN],
    handlers: {
      "system.health": () => {
        throw new Error("boom");
      },
      "system.status": () => {
        throw httpError("lease-held", "held", { holder: "actor_01" });
      },
      "system.db": () => ({ status: 200, body: { ok: true } }),
    },
  });
}

describe("src/http/server/app.parity-cors.test", () => {
  it("CORS headers survive an authentication failure", async () => {
    const app = await corsApp();
    const response = await app.raw
      .get("/v1/status")
      .set("Host", "kanthord.test")
      .set("Origin", ORIGIN);
    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, "unauthenticated");
    assert.equal(response.headers["access-control-allow-origin"], ORIGIN);
    assert.equal(response.headers["access-control-expose-headers"], EXPOSED);
    assert.equal(response.headers["vary"], "Origin");
  });

  it("CORS headers survive a routing failure", async () => {
    const app = await corsApp();
    const response = await app.get("/v1/nope/nope").set("Origin", ORIGIN);
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "not-found");
    assert.equal(response.headers["access-control-allow-origin"], ORIGIN);
    assert.equal(response.headers["access-control-expose-headers"], EXPOSED);
    assert.equal(response.headers["vary"], "Origin");
  });

  it("CORS headers survive an internal error", async () => {
    const app = await corsApp();
    const response = await app.get("/v1/health").set("Origin", ORIGIN);
    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, "internal-error");
    assert.equal(response.headers["access-control-allow-origin"], ORIGIN);
    assert.equal(response.headers["access-control-expose-headers"], EXPOSED);
    assert.equal(response.headers["vary"], "Origin");
    assert.equal(app.internalErrors().length, 1);
    assert.equal(response.text.includes("boom"), false);
  });

  it("CORS headers survive a handler refusal", async () => {
    const app = await corsApp();
    const response = await app.get("/v1/status").set("Origin", ORIGIN);
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, "lease-held");
    assert.equal(response.body.error.details.holder, "actor_01");
    assert.equal(response.headers["access-control-allow-origin"], ORIGIN);
    assert.equal(response.headers["access-control-expose-headers"], EXPOSED);
    assert.equal(response.headers["vary"], "Origin");
    assert.equal(app.internalErrors().length, 0);
  });

  it("Vary is Origin on a completed answer", async () => {
    const app = await corsApp();
    const response = await app.get("/v1/db/status").set("Origin", ORIGIN);
    assert.equal(response.status, 200);
    assert.equal(response.headers["vary"], "Origin");
    assert.equal(response.headers["access-control-allow-origin"], ORIGIN);
    assert.equal(response.headers["access-control-expose-headers"], EXPOSED);
  });

  it("Vary is Origin on a request that carries no Origin", async () => {
    const app = await corsApp();
    const response = await app.get("/v1/db/status");
    assert.equal(response.status, 200);
    assert.equal(response.headers["vary"], "Origin");
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    assert.equal(response.headers["access-control-expose-headers"], undefined);
  });

  it("the origin-forbidden refusal carries neither allow-origin nor Vary", async () => {
    const app = await corsApp();
    const response = await app
      .get("/v1/db/status")
      .set("Origin", "http://evil.test");
    assert.equal(response.status, 403);
    assert.equal(response.body.error.code, "origin-forbidden");
    assert.equal(response.headers["access-control-allow-origin"], undefined);
    assert.equal(response.headers["access-control-expose-headers"], undefined);
    assert.equal(response.headers["vary"], undefined);
  });
});
