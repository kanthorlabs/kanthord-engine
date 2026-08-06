import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  errorEnvelope,
  errorEnvelopeSchema,
  errorStatuses,
  httpError,
} from "./errors.ts";
import { readErrorCodeMatrix } from "../../../test/helpers/proposal.ts";

describe("src/http/contract/errors.test", () => {
  it("matches the proposal code table", () => {
    const proposal = readErrorCodeMatrix();

    assert.deepEqual(
      Object.keys(proposal).sort(),
      Object.keys(errorStatuses).sort(),
    );
    for (const [code, status] of Object.entries(errorStatuses)) {
      assert.equal(proposal[code], status, `${code} status drifted`);
    }
  });

  it("pins the twenty-two codes in table order", () => {
    assert.deepEqual(Object.keys(errorStatuses), [
      "invalid-request",
      "unauthenticated",
      "origin-forbidden",
      "host-forbidden",
      "not-found",
      "stale-revision",
      "illegal-transition",
      "binding-in-use",
      "needs-reconcile",
      "acknowledgement-required",
      "lease-held",
      "idempotency-mismatch",
      "choices-stale",
      "choices-changed",
      "host-key-mismatch",
      "plan-invalid",
      "choices-invalid",
      "identity-kind-mismatch",
      "credential-rejected",
      "internal-error",
      "not-implemented",
      "service-unavailable",
    ]);
  });

  it("groups the codes by status", () => {
    const groups: Record<number, string[]> = {};
    for (const [code, status] of Object.entries(errorStatuses)) {
      (groups[status] ??= []).push(code);
    }
    assert.deepEqual(groups[400], ["invalid-request"]);
    assert.deepEqual(groups[401], ["unauthenticated"]);
    assert.deepEqual(groups[403], ["origin-forbidden", "host-forbidden"]);
    assert.deepEqual(groups[404], ["not-found"]);
    assert.deepEqual(groups[409], [
      "stale-revision",
      "illegal-transition",
      "binding-in-use",
      "needs-reconcile",
      "acknowledgement-required",
      "lease-held",
      "idempotency-mismatch",
      "choices-stale",
      "choices-changed",
      "host-key-mismatch",
    ]);
    assert.deepEqual(groups[422], [
      "plan-invalid",
      "choices-invalid",
      "identity-kind-mismatch",
      "credential-rejected",
    ]);
    assert.deepEqual(groups[500], ["internal-error"]);
    assert.deepEqual(groups[501], ["not-implemented"]);
    assert.deepEqual(groups[503], ["service-unavailable"]);
    const sum = Object.values(groups).reduce(
      (total, codes) => total + codes.length,
      0,
    );
    assert.equal(sum, 22);
  });

  it("service-unavailable is 503 and carries no details", () => {
    assert.equal(errorStatuses["service-unavailable"], 503);
    assert.equal(Object.keys(errorStatuses).length, 22);
    const error = httpError("service-unavailable", "declined");
    assert.equal(error.status, 503);
    assert.deepEqual(errorEnvelope(error), {
      error: { code: "service-unavailable", message: "declined" },
    });
  });

  it("keeps every code kebab-case", () => {
    for (const code of Object.keys(errorStatuses)) {
      assert.match(code, /^[a-z]+(-[a-z]+)*$/);
    }
  });

  it("constructs an HttpError from a non-precondition code", () => {
    const error = httpError("not-found", "no such repository");
    assert.equal(error.status, 404);
    assert.equal(error.code, "not-found");
    assert.equal(error.details, undefined);
    assert.equal(error.name, "HttpError");
    assert.ok(error instanceof Error);
  });

  it("omits the details key when there are none", () => {
    const envelope = errorEnvelope(httpError("not-found", "gone"));
    assert.deepEqual(envelope, {
      error: { code: "not-found", message: "gone" },
    });
    assert.equal(Object.hasOwn(envelope.error, "details"), false);
  });

  it("carries details on a precondition error", () => {
    const envelope = errorEnvelope(
      httpError("stale-revision", "moved", {
        expected: "revision_a",
        actual: "revision_b",
      }),
    );
    assert.deepEqual(envelope, {
      error: {
        code: "stale-revision",
        message: "moved",
        details: { expected: "revision_a", actual: "revision_b" },
      },
    });
  });

  it("validates both envelope shapes", () => {
    assert.deepEqual(
      errorEnvelopeSchema.parse({
        error: { code: "not-found", message: "gone" },
      }),
      { error: { code: "not-found", message: "gone" } },
    );
    assert.deepEqual(
      errorEnvelopeSchema.parse({
        error: {
          code: "stale-revision",
          message: "moved",
          details: { expected: "revision_a", actual: "revision_b" },
        },
      }),
      {
        error: {
          code: "stale-revision",
          message: "moved",
          details: { expected: "revision_a", actual: "revision_b" },
        },
      },
    );
  });

  it("rejects an envelope without a message or without a wrapper", () => {
    assert.throws(() => errorEnvelopeSchema.parse({ error: { code: "x" } }));
    assert.throws(() => errorEnvelopeSchema.parse({ code: "x", message: "y" }));
  });

  it("requires details on a 409 code, by construction", () => {
    // @ts-expect-error a 409 code requires a details argument
    httpError("stale-revision", "moved");
  });

  it("accepts an empty details object", () => {
    const error = httpError("stale-revision", "moved", {});
    assert.deepEqual(error.details, {});
  });
});
