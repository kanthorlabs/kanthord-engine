import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { z } from "zod";

import { invalidRequest, requestIssues } from "./invalid-request.ts";
import { invalidRequestDetails } from "../contract/error-details.ts";

const schema = z.strictObject({
  name: z.string().min(1),
  payload: z.strictObject({
    username: z.string().min(1),
    count: z.number(),
  }),
});

describe("src/http/server/invalid-request.ts", () => {
  it("names the property that failed with a dotted path", () => {
    const parsed = schema.safeParse({
      name: "kanthord",
      payload: { username: "", count: 1 },
    });
    assert.equal(parsed.success, false);
    assert.deepEqual(requestIssues(parsed.error), [
      {
        path: "payload.username",
        code: "too_small",
        message: "Too small: expected string to have >=1 characters",
      },
    ]);
  });

  it("names each unrecognized key as its own property", () => {
    const parsed = schema.safeParse({
      name: "kanthord",
      payload: { username: "atlas", count: 1 },
      zeta: 1,
      alpha: 2,
    });
    assert.equal(parsed.success, false);
    assert.deepEqual(
      requestIssues(parsed.error).map((issue) => issue.path),
      ["alpha", "zeta"],
    );
  });

  it("orders issues bytewise by path", () => {
    const parsed = schema.safeParse({ payload: { username: "", count: "x" } });
    assert.equal(parsed.success, false);
    assert.deepEqual(
      requestIssues(parsed.error).map((issue) => issue.path),
      ["name", "payload.count", "payload.username"],
    );
  });

  it("builds a 400 whose details match the contract", () => {
    const parsed = schema.safeParse({ name: "", payload: null });
    assert.equal(parsed.success, false);
    const error = invalidRequest(
      "body-schema",
      "the body is invalid",
      parsed.error,
    );
    assert.equal(error.code, "invalid-request");
    assert.equal(error.status, 400);
    assert.equal(error.message, "the body is invalid");
    assert.deepEqual(invalidRequestDetails.parse(error.details), error.details);
  });

  it("does not echo the rejected value", () => {
    const parsed = schema.safeParse({
      name: "kanthord",
      payload: { username: "", count: 1 },
    });
    assert.equal(parsed.success, false);
    const serialized = JSON.stringify(
      invalidRequest("body-schema", "the body is invalid", parsed.error)
        .details,
    );
    assert.equal(serialized.includes("kanthord"), false);
  });
});
