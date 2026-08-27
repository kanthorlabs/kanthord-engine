import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../test/helpers/app.ts";
import type { HandlerContext } from "./app.ts";

async function recordingApp() {
  const calls: HandlerContext[] = [];
  const app = await createTestApp({
    handlers: {
      "repository.register": (context) => {
        calls.push(context);
        return { kind: "json", status: 200, body: { ok: true } };
      },
    },
  });
  return { app, calls };
}

describe("src/http/server/app.parity-body.test", () => {
  it("a POST with no body reaches the handler with an empty object body", async () => {
    const { app, calls } = await recordingApp();
    const response = await app.post("/v1/repository");
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.body, {});
  });

  it("a POST with text/plain reaches the handler with an empty object body", async () => {
    const { app, calls } = await recordingApp();
    const response = await app
      .post("/v1/repository")
      .set("Content-Type", "text/plain")
      .send("hello");
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.body, {});
    assert.equal(JSON.stringify(calls[0]?.body), "{}");
  });

  it("a POST with a zero-length JSON body reaches the handler with an empty object body", async () => {
    const { app, calls } = await recordingApp();
    const response = await app
      .post("/v1/repository")
      .set("Content-Type", "application/json")
      .send("");
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.body, {});
  });

  it("a routed operation with no bound handler answers 501 with a malformed body and records no call", async () => {
    const { app, calls } = await recordingApp();
    const response = await app
      .post("/v1/project")
      .set("Content-Type", "application/json")
      .send('{"oops');
    assert.equal(response.status, 501);
    assert.deepEqual(response.body, {
      error: {
        code: "not-implemented",
        message: "project.create is not implemented yet",
      },
    });
    assert.equal(calls.length, 0);
  });

  it("a routed operation with no bound handler answers 501 with a valid body and records no call", async () => {
    const { app, calls } = await recordingApp();
    const response = await app
      .post("/v1/project")
      .set("Content-Type", "application/json")
      .send('{"name":"a"}');
    assert.equal(response.status, 501);
    assert.deepEqual(response.body, {
      error: {
        code: "not-implemented",
        message: "project.create is not implemented yet",
      },
    });
    assert.equal(calls.length, 0);
  });
});
