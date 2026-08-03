import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { agentInvocationRow } from "./agent-invocation.ts";

const ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const HASH = "sha256:" + "0".repeat(64);

describe("src/domain/agent-invocation.test", () => {
  const validRow = {
    id: "invocation_" + ULID_A,
    attemptId: "attempt_" + ULID_A,
    agent: "general@1" as const,
    adapterVersion: "1",
    promptBlob: HASH,
    sourcesJson: "{}",
    toolDefinitionsBlob: HASH,
    toolTraceBlob: null,
    diffBlob: null,
    verdict: null,
    reasonBlob: null,
    usageJson: null,
    errorBlob: null,
    endedAt: null,
  };

  it("accepts a valid row", () => {
    assert.equal(agentInvocationRow.safeParse(validRow).success, true);
  });

  it("rejects missing required keys", () => {
    for (const key of Object.keys(validRow)) {
      const copy = { ...validRow };
      delete (copy as Record<string, unknown>)[key];
      assert.equal(
        agentInvocationRow.safeParse(copy).success,
        false,
        `expected rejection when ${key} is missing`,
      );
    }
  });

  it("rejects wrong identity kind for id", () => {
    assert.equal(
      agentInvocationRow.safeParse({
        ...validRow,
        id: "repo_" + ULID_A,
      }).success,
      false,
    );
  });

  it("rejects wrong identity kind for attemptId", () => {
    assert.equal(
      agentInvocationRow.safeParse({
        ...validRow,
        attemptId: "repo_" + ULID_A,
      }).success,
      false,
    );
  });

  it("rejects tdd@1 agent", () => {
    assert.equal(
      agentInvocationRow.safeParse({ ...validRow, agent: "tdd@1" }).success,
      false,
    );
  });

  it("accepts each agent kind", () => {
    for (const agent of ["general@1", "swe@1", "te@1", "re@1"] as const) {
      assert.equal(
        agentInvocationRow.safeParse({ ...validRow, agent }).success,
        true,
        `expected ${agent} to be accepted`,
      );
    }
  });

  it("accepts verdict accept", () => {
    assert.equal(
      agentInvocationRow.safeParse({ ...validRow, verdict: "accept" }).success,
      true,
    );
  });

  it("accepts verdict reject", () => {
    assert.equal(
      agentInvocationRow.safeParse({ ...validRow, verdict: "reject" }).success,
      true,
    );
  });

  it("rejects invalid verdict", () => {
    assert.equal(
      agentInvocationRow.safeParse({ ...validRow, verdict: "invalid" }).success,
      false,
    );
  });
});
