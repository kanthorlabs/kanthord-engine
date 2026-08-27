import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { httpError } from "../contract/errors.ts";
import {
  errorResponse,
  errorValue,
  materializeError,
  ThrownValueError,
} from "./envelope.ts";

describe("src/http/server/envelope.test", () => {
  const genericInternal = {
    status: 500,
    body: { error: { code: "internal-error", message: "internal error" } },
    internal: true,
  };

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
      assert.deepEqual(materialized, genericInternal);
      assert.equal(JSON.stringify(materialized.body).includes("boom"), false);
    });

    it("materializes a thrown string the same as an Error", () => {
      assert.deepEqual(materializeError("a string"), genericInternal);
    });

    it("materializes a thrown undefined the same as an Error", () => {
      assert.deepEqual(materializeError(undefined), genericInternal);
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

  describe("errorResponse", () => {
    it("answers the materialized status and exact json text with the default content type", async () => {
      const materialized = materializeError(httpError("not-found", "gone"));
      const response = errorResponse(materialized, new Headers());
      assert.equal(response.status, 404);
      assert.equal(
        await response.text(),
        '{"error":{"code":"not-found","message":"gone"}}',
      );
      assert.equal(
        response.headers.get("content-type"),
        "application/json; charset=utf-8",
      );
    });

    it("preserves a seeded content type and cors headers in the accumulator", async () => {
      const headers = new Headers([
        ["content-type", "application/problem+json"],
        ["access-control-allow-origin", "https://allowed.example"],
        ["vary", "Origin"],
      ]);
      const response = errorResponse(genericInternal, headers);
      assert.equal(response.status, 500);
      assert.equal(
        await response.text(),
        '{"error":{"code":"internal-error","message":"internal error"}}',
      );
      assert.equal(
        response.headers.get("content-type"),
        "application/problem+json",
      );
      assert.equal(
        response.headers.get("access-control-allow-origin"),
        "https://allowed.example",
      );
      assert.equal(response.headers.get("vary"), "Origin");
    });
  });

  describe("ThrownValueError", () => {
    it("carries a thrown string as an Error with the wrapper message", () => {
      const thrown = new ThrownValueError("boom");
      assert.ok(thrown instanceof Error);
      assert.equal(thrown.message, "a non-Error value was thrown");
      assert.strictEqual(thrown.value, "boom");
    });

    it("carries a thrown undefined with the wrapper message", () => {
      const thrown = new ThrownValueError(undefined);
      assert.equal(thrown.message, "a non-Error value was thrown");
      assert.strictEqual(thrown.value, undefined);
    });
  });

  describe("errorValue", () => {
    it("unwraps a ThrownValueError holding a string", () => {
      assert.strictEqual(errorValue(new ThrownValueError("boom")), "boom");
    });

    it("unwraps a ThrownValueError holding undefined", () => {
      assert.strictEqual(
        errorValue(new ThrownValueError(undefined)),
        undefined,
      );
    });

    it("returns a plain Error by identity", () => {
      const thrown = new Error("plain");
      assert.strictEqual(errorValue(thrown), thrown);
    });
  });
});
