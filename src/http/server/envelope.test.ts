import { describe, it } from "node:test";
import assert from "node:assert/strict";

import Koa from "koa";

import { httpError } from "../contract/errors.ts";
import { envelopeMiddleware } from "./envelope.ts";
import { loopbackAgent } from "../../../test/helpers/agent.ts";

describe("src/http/server/envelope.test", () => {
  it("answers a thrown HttpError with its status and envelope", async () => {
    const app = new Koa();
    app.use(envelopeMiddleware({ onInternalError: () => {} }));
    app.use(() => {
      throw httpError("host-forbidden", "bad host");
    });
    const response = await (await loopbackAgent(app)).get("/");
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, {
      error: { code: "host-forbidden", message: "bad host" },
    });
    assert.match(String(response.headers["content-type"]), /application\/json/);
  });

  it("carries precondition details in the envelope", async () => {
    const app = new Koa();
    app.use(envelopeMiddleware({ onInternalError: () => {} }));
    app.use(() => {
      throw httpError("lease-held", "held", { runId: "run_01" });
    });
    const response = await (await loopbackAgent(app)).get("/");
    assert.equal(response.status, 409);
    assert.deepEqual(response.body, {
      error: {
        code: "lease-held",
        message: "held",
        details: { runId: "run_01" },
      },
    });
  });

  it("answers an unexpected Error with internal-error and reports it once", async () => {
    const thrown = new Error("secret internal detail");
    const seen: unknown[] = [];
    const app = new Koa();
    app.use(
      envelopeMiddleware({
        onInternalError: (error) => {
          seen.push(error);
        },
      }),
    );
    app.use(() => {
      throw thrown;
    });
    const response = await (await loopbackAgent(app)).get("/");
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, {
      error: { code: "internal-error", message: "internal error" },
    });
    assert.equal(response.text.includes("secret internal detail"), false);
    assert.equal(seen.length, 1);
    assert.strictEqual(seen[0], thrown);
  });

  it("answers a thrown non-Error value with internal-error", async () => {
    const seen: unknown[] = [];
    const app = new Koa();
    app.use(
      envelopeMiddleware({
        onInternalError: (error) => {
          seen.push(error);
        },
      }),
    );
    app.use(() => {
      throw "boom";
    });
    const response = await (await loopbackAgent(app)).get("/");
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, {
      error: { code: "internal-error", message: "internal error" },
    });
    assert.deepEqual(seen, ["boom"]);
  });

  it("passes a successful response through untouched", async () => {
    const seen: unknown[] = [];
    const app = new Koa();
    app.use(
      envelopeMiddleware({
        onInternalError: (error) => {
          seen.push(error);
        },
      }),
    );
    app.use((context) => {
      context.body = { ok: true };
    });
    const response = await (await loopbackAgent(app)).get("/");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true });
    assert.deepEqual(seen, []);
  });
});
