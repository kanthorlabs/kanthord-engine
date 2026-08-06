import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { objectId } from "./column.ts";
import {
  RECOVERY_STEP_ORDER,
  RecoveryError,
  ZERO_OID,
  renderFinding,
} from "./recovery.ts";

describe("src/domain/recovery.test", () => {
  it("RECOVERY_STEP_ORDER names the four steps in order", () => {
    assert.deepEqual(
      [...RECOVERY_STEP_ORDER],
      ["reap", "sweep", "reconcile", "leases"],
    );
  });

  it("ZERO_OID is a forty-character object id", () => {
    assert.equal(ZERO_OID.length, 40);
    assert.doesNotThrow(() => objectId.parse(ZERO_OID));
  });

  it("renderFinding without a repository names the step, the code and the detail", () => {
    assert.equal(
      renderFinding({
        step: "reap",
        code: "pid-reused",
        repositoryId: null,
        detail: "x",
      }),
      "reap: pid-reused: x",
    );
  });

  it("renderFinding with a repository places the id between the code and the detail", () => {
    assert.equal(
      renderFinding({
        step: "reap",
        code: "pid-reused",
        repositoryId: "repo_01",
        detail: "x",
      }),
      "reap: pid-reused: repo_01: x",
    );
  });

  it("RecoveryError carries its name and its code", () => {
    const error = new RecoveryError("orphan-alive", "m");
    assert.equal(error.name, "RecoveryError");
    assert.equal(error.code, "orphan-alive");
  });

  it("the module is pure: no node:, no clock, no randomness", () => {
    const source = readFileSync(
      new URL("./recovery.ts", import.meta.url),
      "utf8",
    );
    assert.equal(source.includes("node:"), false);
    assert.equal(source.includes("Date.now("), false);
    assert.equal(source.includes("new Date("), false);
    assert.equal(source.includes("Math.random("), false);
  });
});
