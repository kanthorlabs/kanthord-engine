import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { attemptRow, attemptOutcomes, attemptOutcome } from "./attempt.ts";

const ULID_A = "01HZY8QF3M4N5P6R7S8T9V0W1X";
const OID = "a".repeat(40);

describe("src/domain/attempt.test", () => {
  const validRow = {
    id: "attempt_" + ULID_A,
    runId: "run_" + ULID_A,
    attemptNo: 1,
    providerId: "provider_" + ULID_A,
    providerModel: "gpt-4",
    timeoutMs: 30000,
    baseOid: OID,
    headOid: null,
    outcome: null,
    endedAt: null,
  };

  it("accepts a valid row", () => {
    assert.equal(attemptRow.safeParse(validRow).success, true);
  });

  it("rejects missing required keys", () => {
    for (const key of Object.keys(validRow)) {
      const copy = { ...validRow };
      delete (copy as Record<string, unknown>)[key];
      assert.equal(
        attemptRow.safeParse(copy).success,
        false,
        `expected rejection when ${key} is missing`,
      );
    }
  });

  it("rejects wrong identity kind for id", () => {
    assert.equal(
      attemptRow.safeParse({ ...validRow, id: "repo_" + ULID_A }).success,
      false,
    );
  });

  it("rejects wrong identity kind for runId", () => {
    assert.equal(
      attemptRow.safeParse({ ...validRow, runId: "repo_" + ULID_A }).success,
      false,
    );
  });

  it("rejects wrong identity kind for providerId", () => {
    assert.equal(
      attemptRow.safeParse({
        ...validRow,
        providerId: "repo_" + ULID_A,
      }).success,
      false,
    );
  });

  it("attemptOutcomes deep-equals the expected array", () => {
    assert.deepEqual(attemptOutcomes, [
      "accepted",
      "rejected",
      "failed",
      "timed-out",
      "cancelled",
    ]);
  });

  it("accepts each attempt outcome", () => {
    for (const outcome of attemptOutcomes) {
      assert.equal(
        attemptRow.safeParse({ ...validRow, outcome }).success,
        true,
        `expected ${outcome} to be accepted`,
      );
    }
  });

  it("rejects invalid outcome", () => {
    assert.equal(
      attemptRow.safeParse({ ...validRow, outcome: "invalid" }).success,
      false,
    );
  });
});
