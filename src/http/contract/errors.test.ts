import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildErrorEnvelope,
  daemonErrorEnvelopeSchema,
  errorEnvelope,
  errorEnvelopeSchema,
  errorStatuses,
  httpError,
} from "./errors.ts";
import { baselineErrors } from "./error-baseline.ts";
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

  it("pins the codes in table order", () => {
    assert.deepEqual(Object.keys(errorStatuses), [
      "invalid-request",
      "unauthenticated",
      "origin-forbidden",
      "host-forbidden",
      "actor-forbidden",
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

  it("the ordered list rejects a code at any position", () => {
    const keys = Object.keys(errorStatuses);
    const appended = [...keys, "invented-last"];
    const middle = Math.floor(keys.length / 2);
    const spliced = [
      ...keys.slice(0, middle),
      "invented-middle",
      ...keys.slice(middle),
    ];
    const withoutHostKey = keys.filter((code) => code !== "host-key-mismatch");
    const planInvalid = withoutHostKey.indexOf("plan-invalid");
    const movedInto422 = [
      ...withoutHostKey.slice(0, planInvalid + 1),
      "host-key-mismatch",
      ...withoutHostKey.slice(planInvalid + 1),
    ];

    for (const variant of [appended, spliced, movedInto422]) {
      assert.throws(
        () => assert.deepEqual(variant, keys),
        (error: unknown) => {
          assert.ok(error instanceof assert.AssertionError);
          const actual = error.actual as readonly string[];
          const expected = error.expected as readonly string[];
          const differing = actual.findIndex(
            (value, index) => value !== expected[index],
          );
          assert.notEqual(
            differing,
            -1,
            "the failure names the differing position",
          );
          return true;
        },
      );
    }
  });

  it("groups the codes by status", () => {
    const groups: Record<number, string[]> = {};
    for (const [code, status] of Object.entries(errorStatuses)) {
      (groups[status] ??= []).push(code);
    }
    assert.deepEqual(groups[400], ["invalid-request"]);
    assert.deepEqual(groups[401], ["unauthenticated"]);
    assert.deepEqual(groups[403], [
      "origin-forbidden",
      "host-forbidden",
      "actor-forbidden",
    ]);
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
  });

  it("service-unavailable is 503 and carries no details", () => {
    assert.equal(errorStatuses["service-unavailable"], 503);
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
        current: "revision_b",
      }),
    );
    assert.deepEqual(envelope, {
      error: {
        code: "stale-revision",
        message: "moved",
        details: { expected: "revision_a", current: "revision_b" },
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
          code: "invalid-request",
          message: "m",
          details: { refusal: "name-taken" },
        },
      }),
      {
        error: {
          code: "invalid-request",
          message: "m",
          details: { refusal: "name-taken" },
        },
      },
    );
  });

  it("buildErrorEnvelope(baselineErrors) is the errorEnvelopeSchema baseline, and rejects a code outside it", () => {
    const envelope = buildErrorEnvelope(baselineErrors);
    assert.deepEqual(
      envelope.parse({ error: { code: "not-found", message: "gone" } }),
      { error: { code: "not-found", message: "gone" } },
    );
    assert.deepEqual(
      envelope.parse({
        error: {
          code: "invalid-request",
          message: "m",
          details: { refusal: "name-taken" },
        },
      }),
      {
        error: {
          code: "invalid-request",
          message: "m",
          details: { refusal: "name-taken" },
        },
      },
    );
    assert.doesNotThrow(() =>
      envelope.parse({ error: { code: "not-implemented", message: "nope" } }),
    );
    assert.throws(() =>
      envelope.parse({
        error: {
          code: "plan-invalid",
          message: "m",
          details: { findings: [] },
        },
      }),
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

  describe("daemonErrorEnvelopeSchema", () => {
    it("parses an invented future code unchanged", () => {
      const parsed = daemonErrorEnvelopeSchema.parse({
        error: { code: "invented-future-code", message: "later" },
      });
      assert.equal(parsed.error.code, "invented-future-code");
    });

    it("parses a 409 stale-revision envelope with its real details intact", () => {
      const parsed = daemonErrorEnvelopeSchema.parse({
        error: {
          code: "stale-revision",
          message: "moved",
          details: { expected: "rev-1", current: "rev-2" },
        },
      });
      assert.deepEqual(parsed, {
        error: {
          code: "stale-revision",
          message: "moved",
          details: { expected: "rev-1", current: "rev-2" },
        },
      });
    });

    it("parses an unknown extra key inside error without dropping code, message or details", () => {
      const parsed = daemonErrorEnvelopeSchema.parse({
        error: {
          code: "not-found",
          message: "gone",
          details: { id: "x" },
          hint: "a future daemon field",
        },
      });
      assert.equal(parsed.error.code, "not-found");
      assert.equal(parsed.error.message, "gone");
      assert.deepEqual(parsed.error.details, { id: "x" });
    });

    it("accepts an envelope with no details at all", () => {
      const parsed = daemonErrorEnvelopeSchema.parse({
        error: { code: "not-implemented", message: "nope" },
      });
      assert.equal(parsed.error.code, "not-implemented");
      assert.equal(parsed.error.message, "nope");
    });

    it("rejects a non-object body", () => {
      assert.throws(() => daemonErrorEnvelopeSchema.parse("not-an-object"));
      assert.throws(() => daemonErrorEnvelopeSchema.parse(null));
      assert.throws(() => daemonErrorEnvelopeSchema.parse(42));
    });

    it("rejects an object with no error key", () => {
      assert.throws(() =>
        daemonErrorEnvelopeSchema.parse({ code: "x", message: "y" }),
      );
    });

    it("rejects an error field that is not an object", () => {
      assert.throws(() =>
        daemonErrorEnvelopeSchema.parse({ error: "not-an-object" }),
      );
    });

    it("rejects a non-string code", () => {
      assert.throws(() =>
        daemonErrorEnvelopeSchema.parse({
          error: { code: 42, message: "y" },
        }),
      );
    });

    it("rejects a non-string message", () => {
      assert.throws(() =>
        daemonErrorEnvelopeSchema.parse({
          error: { code: "not-found", message: 42 },
        }),
      );
    });
  });

  it("errorEnvelopeSchema stays distinct from daemonErrorEnvelopeSchema and rejects a non-baseline code", () => {
    assert.throws(() =>
      errorEnvelopeSchema.parse({
        error: { code: "stale-revision", message: "moved" },
      }),
    );
    assert.doesNotThrow(() =>
      daemonErrorEnvelopeSchema.parse({
        error: { code: "stale-revision", message: "moved" },
      }),
    );
  });
});
