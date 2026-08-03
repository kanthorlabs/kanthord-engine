import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  nodeKinds,
  nodeKind,
  nodeStates,
  nodeState,
  terminalStates,
  blockReasons,
  blockReason,
} from "./state.ts";

describe("src/domain/state.test", () => {
  it("nodeStates deep-equals the expected eight states in order", () => {
    assert.deepEqual(nodeStates, [
      "pending",
      "ready",
      "running",
      "blocked",
      "awaiting_approval",
      "done",
      "partial",
      "discarded",
    ]);
    assert.equal(nodeStates.length, 8);
  });

  it("blockReasons deep-equals the expected six reasons in order", () => {
    assert.deepEqual(blockReasons, [
      "attempt-limit",
      "dependency-discarded",
      "stale-base",
      "dirty-recovery",
      "e2e-failed",
      "abandoned",
    ]);
    assert.equal(blockReasons.length, 6);
  });

  it("nodeKinds deep-equals the expected three kinds", () => {
    assert.deepEqual(nodeKinds, ["initiative", "objective", "task"]);
  });

  it("terminalStates deep-equals [done, partial, discarded]", () => {
    assert.deepEqual(terminalStates, ["done", "partial", "discarded"]);
  });

  it("every terminal state is a member of nodeStates", () => {
    for (const state of terminalStates) {
      assert.ok(
        nodeStates.includes(state),
        `expected ${state} to appear in nodeStates`,
      );
    }
  });

  it("every nodeState and blockReason member appears in node.md DDL", () => {
    const ddl = readFileSync(
      resolve(import.meta.dirname!, "../../docs/proposal/database/node.md"),
      "utf-8",
    );
    for (const state of nodeStates) {
      assert.ok(
        ddl.includes(`'${state}'`),
        `expected '${state}' to appear in node.md`,
      );
    }
    for (const reason of blockReasons) {
      assert.ok(
        ddl.includes(`'${reason}'`),
        `expected '${reason}' to appear in node.md`,
      );
    }
  });

  it("nodeState rejects awaiting-approval (uses underscore)", () => {
    assert.equal(nodeState.safeParse("awaiting-approval").success, false);
  });
});
