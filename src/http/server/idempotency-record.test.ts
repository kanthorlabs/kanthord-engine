import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyOutcome } from "./idempotency-record.ts";
import type { ClassifyInput, OutcomeState } from "./idempotency-record.ts";

describe("src/http/server/idempotency-record.test", () => {
  const cases: ReadonlyArray<{
    input: ClassifyInput;
    expected: OutcomeState;
  }> = [
    {
      input: { replayable: [200], status: 200, internal: false },
      expected: "replayable",
    },
    {
      input: { replayable: [200], status: 409, internal: false },
      expected: "uncacheable",
    },
    {
      input: { replayable: [200], status: 404, internal: false },
      expected: "uncacheable",
    },
    {
      input: { replayable: [200], status: 422, internal: false },
      expected: "uncacheable",
    },
    {
      input: { replayable: [200], status: 400, internal: false },
      expected: "uncacheable",
    },
    {
      input: { replayable: [200], status: 501, internal: false },
      expected: "uncacheable",
    },
    {
      input: { replayable: [200], status: 500, internal: false },
      expected: "uncacheable",
    },
    {
      input: { replayable: [200], status: 500, internal: true },
      expected: "indeterminate",
    },
    {
      input: { replayable: [200], status: 200, internal: true },
      expected: "indeterminate",
    },
    {
      input: { replayable: undefined, status: 200, internal: false },
      expected: "uncacheable",
    },
    {
      input: { replayable: undefined, status: 500, internal: true },
      expected: "indeterminate",
    },
    {
      input: { replayable: [], status: 200, internal: false },
      expected: "uncacheable",
    },
  ];

  for (const { input, expected } of cases) {
    it(`classifies replayable=${JSON.stringify(input.replayable)} status=${input.status} internal=${input.internal} as ${expected}`, () => {
      assert.equal(classifyOutcome(input), expected);
    });
  }
});
