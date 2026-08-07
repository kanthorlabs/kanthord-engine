import { describe, it } from "node:test";
import assert from "node:assert/strict";

import Koa from "koa";

import { httpError } from "../contract/errors.ts";
import { envelopeMiddleware, materializeError } from "./envelope.ts";
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

  describe("materializeError", () => {
    it("materializes a not-found HttpError with no details", () => {
      assert.deepEqual(materializeError(httpError("not-found", "gone")), {
        status: 404,
        body: { error: { code: "not-found", message: "gone" } },
        internal: false,
      });
    });

    it("materializes a precondition HttpError carrying details", () => {
      const materialized = materializeError(
        httpError("stale-revision", "moved", { a: "b" }),
      );
      assert.equal(materialized.status, 409);
      assert.equal(materialized.internal, false);
      assert.deepEqual(materialized.body, {
        error: {
          code: "stale-revision",
          message: "moved",
          details: { a: "b" },
        },
      });
    });

    it("materializes an unexpected Error as an internal-error, hiding its message", () => {
      const materialized = materializeError(new Error("boom"));
      assert.deepEqual(materialized, {
        status: 500,
        body: { error: { code: "internal-error", message: "internal error" } },
        internal: true,
      });
      assert.equal(JSON.stringify(materialized.body).includes("boom"), false);
    });

    it("materializes a thrown string the same as an Error", () => {
      assert.deepEqual(materializeError("a string"), {
        status: 500,
        body: { error: { code: "internal-error", message: "internal error" } },
        internal: true,
      });
    });

    it("materializes a thrown undefined the same as an Error", () => {
      assert.deepEqual(materializeError(undefined), {
        status: 500,
        body: { error: { code: "internal-error", message: "internal error" } },
        internal: true,
      });
    });

    it("a declared internal-error HttpError is not indeterminate", () => {
      const materialized = materializeError(
        httpError("internal-error", "internal error"),
      );
      assert.equal(materialized.status, 500);
      assert.equal(materialized.internal, false);
      assert.deepEqual(materialized.body, {
        error: { code: "internal-error", message: "internal error" },
      });
    });
  });
});
