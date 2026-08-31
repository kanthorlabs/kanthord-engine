import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseWorkerId, WorkerIdError } from "./worker-id.ts";

function assertInvalidWorkerId(raw: string): void {
  assert.throws(
    () => parseWorkerId(raw),
    (error) => {
      assert.ok(error instanceof WorkerIdError);
      assert.equal(error.code, "worker-id-invalid");
      return true;
    },
  );
}

describe("src/domain/worker-id", () => {
  for (const [raw, expected] of [
    ["general@1", { name: "general", version: 1, id: "general@1" }],
    ["tdd@1", { name: "tdd", version: 1, id: "tdd@1" }],
    ["opencode@1", { name: "opencode", version: 1, id: "opencode@1" }],
  ] as const) {
    it(`parses ${raw} to its exact worker identity`, () => {
      assert.deepEqual(parseWorkerId(raw), expected);
    });
  }

  for (const raw of [
    "claude.swe@1",
    "general",
    "general@",
    "general@0",
    "General@1",
    "general@9007199254740993",
  ]) {
    it(`refuses invalid worker id ${raw}`, () => {
      assertInvalidWorkerId(raw);
    });
  }
});
