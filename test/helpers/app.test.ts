import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "./app.ts";
import type { Handler } from "../../src/http/server/app.ts";

const healthLike: Handler = () => ({
  status: 200,
  body: { status: "ok", dependencies: [] },
});
const statusLike: Handler = () => ({ status: 200, body: { ok: true } });

describe("test/helpers/app.test", () => {
  it("the typed helpers preset Host and the bearer token, and raw presets nothing", async () => {
    const app = await createTestApp({
      handlers: { "system.health": healthLike },
    });
    const withPresets = await app.get("/v1/health");
    assert.equal(withPresets.status, 200);
    assert.deepEqual(withPresets.body, { status: "ok", dependencies: [] });
    const raw = await app.raw.get("/v1/health");
    assert.equal(raw.status, 403);
    assert.equal(raw.body.error.code, "host-forbidden");
  });

  it("an allowedHosts override changes the preset Host", async () => {
    const app = await createTestApp({
      allowedHosts: ["other.test"],
      handlers: { "system.health": healthLike },
    });
    const response = await app.get("/v1/health");
    assert.equal(response.status, 200);
  });

  it("a token override changes the preset bearer", async () => {
    const app = await createTestApp({
      token: "custom",
      handlers: { "system.status": statusLike },
    });
    const response = await app.get("/v1/status");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true });
  });

  it("internalErrors collects a thrown non-HttpError and is empty when onInternalError is supplied", async () => {
    const boom = new Error("boom");
    const app = await createTestApp({
      handlers: {
        "system.status": () => {
          throw boom;
        },
      },
    });
    const response = await app.get("/v1/status");
    assert.equal(response.status, 500);
    assert.equal(app.internalErrors().length, 1);
    assert.equal(app.internalErrors()[0], boom);

    const silent = await createTestApp({
      onInternalError: () => {},
      handlers: {
        "system.status": () => {
          throw boom;
        },
      },
    });
    await silent.get("/v1/status");
    assert.deepEqual(silent.internalErrors(), []);
  });
});
