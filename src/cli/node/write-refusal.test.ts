import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { CallResult } from "../client.ts";
import { printNodeWriteRefusal } from "./write-refusal.ts";

type FailedCallResult = Extract<CallResult, { ok: false }>;

describe("src/cli/node/write-refusal.test", () => {
  it("prints one generic line for a non-plan-invalid refusal", () => {
    const result: FailedCallResult = {
      ok: false,
      status: 409,
      code: "stale-revision",
      message: "the write names an older revision",
      details: { guard: "node", expected: "revision_c", actual: "revision_b" },
    };
    let stderr = "";

    printNodeWriteRefusal(result, (text) => {
      stderr += text;
    });

    assert.equal(
      stderr,
      "kanthord: stale-revision: the write names an older revision\n",
    );
  });

  it("prints plan-invalid findings in response order and uses a dash for a null path", () => {
    const result: FailedCallResult = {
      ok: false,
      status: 422,
      code: "plan-invalid",
      message: "the plan is invalid",
      details: {
        findings: [
          {
            code: "parent-missing",
            path: null,
            id: "task_01JQ8Z7G3HZZZZZZZZZZZZZZZW",
            message: "the parent node is missing",
          },
          {
            code: "path-invalid",
            path: "plan/epic.md",
            id: null,
            message: "the path is invalid",
          },
        ],
      },
    };
    let stderr = "";

    printNodeWriteRefusal(result, (text) => {
      stderr += text;
    });

    assert.equal(
      stderr,
      "kanthord: plan-invalid: the plan is invalid\n" +
        "kanthord: plan-invalid: parent-missing - the parent node is missing\n" +
        "kanthord: plan-invalid: path-invalid plan/epic.md the path is invalid\n",
    );
  });

  it("throws a zod error after the generic line for malformed plan-invalid details", () => {
    const result: FailedCallResult = {
      ok: false,
      status: 422,
      code: "plan-invalid",
      message: "the plan is invalid",
      details: {
        findings: [
          {
            code: "not-a-finding",
            path: null,
            id: null,
            message: "not valid",
          },
        ],
      },
    };
    let stderr = "";
    let thrown: unknown;

    try {
      printNodeWriteRefusal(result, (text) => {
        stderr += text;
      });
    } catch (error) {
      thrown = error;
    }

    assert.ok(thrown instanceof Error);
    assert.equal(thrown.name, "ZodError");
    assert.equal(stderr, "kanthord: plan-invalid: the plan is invalid\n");
  });
});
