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
    driver: "internal" as const,
    providerId: "provider_" + ULID_A,
    providerModel: "gpt-4",
    timeoutMs: 30000,
    baseOid: OID,
    headOid: null,
    outcome: null,
    endedAt: null,
  };

  const validExternalRow = {
    ...validRow,
    driver: "external" as const,
    providerId: null,
    providerModel: null,
    timeoutMs: null,
    baseOid: null,
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

  it("accepts an external attempt that holds no provider fact", () => {
    assert.equal(attemptRow.safeParse(validExternalRow).success, true);
  });

  it("refuses an external attempt that carries a provider fact", () => {
    assert.equal(
      attemptRow.safeParse({
        ...validExternalRow,
        providerId: "provider_" + ULID_A,
      }).success,
      false,
    );
    assert.equal(
      attemptRow.safeParse({ ...validExternalRow, providerModel: "gpt-4" })
        .success,
      false,
    );
    assert.equal(
      attemptRow.safeParse({ ...validExternalRow, timeoutMs: 30000 }).success,
      false,
    );
    assert.equal(
      attemptRow.safeParse({ ...validExternalRow, baseOid: OID }).success,
      false,
    );
  });

  it("refuses an internal attempt that omits a provider fact", () => {
    assert.equal(
      attemptRow.safeParse({ ...validRow, providerId: null }).success,
      false,
    );
    assert.equal(
      attemptRow.safeParse({ ...validRow, providerModel: null }).success,
      false,
    );
    assert.equal(
      attemptRow.safeParse({ ...validRow, timeoutMs: null }).success,
      false,
    );
    assert.equal(
      attemptRow.safeParse({ ...validRow, baseOid: null }).success,
      false,
    );
  });

  it("driver refine: message equals the DDL CHECK expression", () => {
    const result = attemptRow.safeParse({ ...validRow, providerId: null });
    assert.equal(result.success, false);
    assert.equal(
      result.error!.issues[0]!.message,
      "(driver = 'internal') = (provider_id IS NOT NULL AND provider_model IS NOT NULL AND timeout_ms IS NOT NULL AND base_oid IS NOT NULL)",
    );
  });

  it("refuses an unknown driver", () => {
    assert.equal(
      attemptRow.safeParse({ ...validRow, driver: "hybrid" }).success,
      false,
    );
  });
});
