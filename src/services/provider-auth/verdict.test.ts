import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toVerdict } from "./verdict.ts";

describe("src/services/provider-auth/verdict", () => {
  it("maps a successful completion", () => {
    const result = toVerdict({ kind: "success" });

    assert.deepEqual(result, {
      reachability: "reachable",
      authentication: "accepted",
      completed: true,
      refusal: null,
    });
    assert.equal("detail" in result, false);
  });

  it("maps an aborted probe", () => {
    assert.deepEqual(toVerdict({ kind: "abort" }), {
      reachability: "unreachable",
      authentication: "unknown",
      completed: false,
      refusal: "endpoint-unreachable",
      detail: "timeout-or-abort",
    });
  });

  it("maps an authentication HTTP failure", () => {
    assert.deepEqual(toVerdict({ kind: "http-auth", status: 401 }), {
      reachability: "reachable",
      authentication: "rejected",
      completed: false,
      refusal: "credential-rejected",
      detail: "HTTP 401",
    });
  });

  it("maps a forbidden HTTP failure", () => {
    assert.deepEqual(toVerdict({ kind: "http-auth", status: 403 }), {
      reachability: "reachable",
      authentication: "rejected",
      completed: false,
      refusal: "credential-rejected",
      detail: "HTTP 403",
    });
  });

  it("maps a missing model HTTP failure", () => {
    assert.deepEqual(toVerdict({ kind: "http-not-found", status: 404 }), {
      reachability: "reachable",
      authentication: "accepted",
      completed: false,
      refusal: "model-unavailable",
      detail: "HTTP 404",
    });
  });

  it("maps a quota HTTP failure", () => {
    assert.deepEqual(toVerdict({ kind: "http-quota", status: 429 }), {
      reachability: "reachable",
      authentication: "accepted",
      completed: false,
      refusal: "quota-exceeded",
      detail: "HTTP 429",
    });
  });

  it("maps another HTTP failure", () => {
    assert.deepEqual(toVerdict({ kind: "http-other", status: 500 }), {
      reachability: "reachable",
      authentication: "unknown",
      completed: false,
      refusal: "endpoint-rejected",
      detail: "HTTP 500",
    });
  });

  it("maps a transport failure", () => {
    assert.deepEqual(toVerdict({ kind: "transport-error" }), {
      reachability: "unreachable",
      authentication: "unknown",
      completed: false,
      refusal: "endpoint-unreachable",
      detail: "transport-error",
    });
  });
});
