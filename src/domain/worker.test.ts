import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { workerKinds, workerKind } from "./worker.ts";

describe("src/domain/worker.test", () => {
  it("workerKinds deep-equals the expected array", () => {
    assert.deepEqual(workerKinds, [
      "general@1",
      "tdd@1",
      "git@1",
      "claude.swe@1",
      "claude.te@1",
      "opencode.swe@1",
      "opencode.te@1",
    ]);
  });

  it("workerKind.options deep-equals the expected array", () => {
    assert.deepEqual(workerKind.options, [
      "general@1",
      "tdd@1",
      "git@1",
      "claude.swe@1",
      "claude.te@1",
      "opencode.swe@1",
      "opencode.te@1",
    ]);
  });

  for (const kind of [
    "general@1",
    "tdd@1",
    "git@1",
    "claude.swe@1",
    "claude.te@1",
    "opencode.swe@1",
    "opencode.te@1",
  ] as const) {
    it(`workerKind.safeParse accepts "${kind}"`, () => {
      assert.equal(workerKind.safeParse(kind).success, true);
    });
  }

  for (const value of [
    "general",
    "general@2",
    "re@1",
    "mr@1",
    "",
    "GENERAL@1",
    "swe@1",
    "te@1",
    "claude.swe",
    "claude.swe@2",
  ] as const) {
    it(`workerKind.safeParse rejects "${value}"`, () => {
      assert.equal(workerKind.safeParse(value).success, false);
    });
  }
});
