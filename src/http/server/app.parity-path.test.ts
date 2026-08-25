import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createTestApp } from "../../../test/helpers/app.ts";
import type { HandlerContext } from "./app.ts";

async function recordingApp() {
  const calls: HandlerContext[] = [];
  const app = await createTestApp({
    handlers: {
      "blob.show": (context) => {
        calls.push(context);
        return { status: 200, body: { ok: true } };
      },
    },
  });
  return { app, calls };
}

describe("src/http/server/app.parity-path.test", () => {
  it("a percent-escaped path segment reaches the handler undecoded", async () => {
    const { app, calls } = await recordingApp();
    const response = await app.get("/v1/blob/aa%2Fbb");
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.parameters, { hash: "aa%2Fbb" });
  });

  it("a malformed percent escape reaches route matching intact", async () => {
    const { app, calls } = await recordingApp();
    const response = await app.get("/v1/blob/aa%zz");
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.parameters, { hash: "aa%zz" });
  });

  it("a duplicate request header reaches the handler joined with a comma and a space", async () => {
    const { app, calls } = await recordingApp();
    const response = await app
      .get("/v1/blob/aa")
      .set("X-Kanthord-Client", ["one", "two"] as unknown as string);
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.headers["x-kanthord-client"], "one, two");
  });

  it("a request carrying a client header records five sorted lower-cased header names", async () => {
    const { app, calls } = await recordingApp();
    const response = await app
      .get("/v1/blob/aa")
      .set("X-Kanthord-Client", ["one", "two"] as unknown as string);
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(calls[0]?.headers ?? {}), [
      "accept-encoding",
      "authorization",
      "connection",
      "host",
      "x-kanthord-client",
    ]);
  });

  it("a plain GET records four sorted lower-cased header names", async () => {
    const first = await recordingApp();
    await first.app.get("/v1/blob/aa%2Fbb");
    assert.deepEqual(Object.keys(first.calls[0]?.headers ?? {}), [
      "accept-encoding",
      "authorization",
      "connection",
      "host",
    ]);

    const second = await recordingApp();
    await second.app.get("/v1/blob/aa%zz");
    assert.deepEqual(Object.keys(second.calls[0]?.headers ?? {}), [
      "accept-encoding",
      "authorization",
      "connection",
      "host",
    ]);
  });
});
