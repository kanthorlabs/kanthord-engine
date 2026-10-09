import assert from "node:assert/strict";
import { test } from "node:test";
import { background } from "../kernel/context.ts";
import { OperationResultType } from "../kernel/operation.ts";
import { NodeState } from "../mission/contract.ts";
import { ExecutionRun, ExecutionStop } from "./execution-run.ts";
import {
  allTerminal,
  nodeKindOf,
  readAllPages,
  readClearedAssessment,
  readPriorRationale,
  readReworkAssessment,
  READ_PAGE_LIMIT,
} from "./node-reads.ts";
import { NodeKind } from "./native-agent.ts";
import type { MethodClients } from "./method-clients.ts";

function fixture() {
  return new ExecutionRun({
    claim: {
      execution_id: "execution",
      node_id: "node",
      attempt: 1,
      pinned_revision: 1,
      created_at: Date.now(),
      expired_at: Date.now() + 60000,
      trace_id: "trace",
    },
    clients: {} as MethodClients,
    credentials: { release: async () => {} },
    context: background,
  });
}

test("reads concatenate ordered pages and enforce their finite limit", async (t) => {
  const run = fixture();
  t.after(() => run.dispose());
  const seen: (string | null)[] = [];
  const items = await readAllPages(run, async (cursor) => {
    seen.push(cursor);
    return {
      type: OperationResultType.Completed,
      status: 200,
      data: {
        items: cursor ? [2] : [1],
        next_cursor: cursor ? null : "second",
      },
    };
  });
  assert.deepEqual(items, [1, 2]);
  assert.deepEqual(seen, [null, "second"]);
  let calls = 0;
  await assert.rejects(
    readAllPages(run, async () => {
      calls++;
      return {
        type: OperationResultType.Completed,
        status: 200,
        data: { items: [], next_cursor: "again" },
      };
    }),
    ExecutionStop,
  );
  assert.equal(calls, READ_PAGE_LIMIT);
});

test("node kind and terminal states follow the pinned revision", () => {
  assert.equal(nodeKindOf({ tasks: [] }), NodeKind.Objective);
  assert.equal(nodeKindOf({}), NodeKind.Initiative);
  assert.equal(allTerminal([{ id: "node", state: NodeState.Blocked }]), false);
  assert.equal(
    allTerminal([
      { id: "node", state: NodeState.Completed },
      { id: "other", state: NodeState.Discarded },
    ]),
    true,
  );
});

test("the assessment reads answer null only on a record not found", async (t) => {
  const assessment = { id: "assessment", rationale: "unmet" };
  const failure = (status: number, code: string) => ({
    type: OperationResultType.Failure,
    status,
    error: {
      request_id: "request",
      error: { code, message: "failed", details: null },
    },
  });
  for (const [operation, read] of [
    ["execution.reworkAssessment.get", readReworkAssessment],
    ["execution.clearedAssessment.get", readClearedAssessment],
  ] as const) {
    for (const [answer, expected] of [
      [
        { type: OperationResultType.Completed, status: 200, data: assessment },
        assessment,
      ],
      [failure(404, "mission.record.not_found"), null],
      [failure(404, "mission.execution.revision_above_pin"), ExecutionStop],
    ] as const) {
      const run = fixture();
      t.after(() => run.dispose());
      run.clients.mission = {
        [operation]: async () => answer,
      } as unknown as MethodClients["mission"];
      if (expected === ExecutionStop)
        await assert.rejects(read(run), ExecutionStop);
      else assert.deepEqual(await read(run), expected);
    }
  }
});

test("the prior rationale is the rework rationale, else the cleared rationale, else null", async (t) => {
  const notFound = {
    type: OperationResultType.Failure,
    status: 404,
    error: {
      request_id: "request",
      error: {
        code: "mission.record.not_found",
        message: "failed",
        details: null,
      },
    },
  };
  const answered = (rationale: string) => ({
    type: OperationResultType.Completed,
    status: 200,
    data: { id: "assessment", rationale },
  });
  for (const [rework, cleared, expected] of [
    [answered("rework"), answered("cleared"), "rework"],
    [notFound, answered("cleared"), "cleared"],
    [answered("rework"), notFound, "rework"],
    [notFound, notFound, null],
  ] as const) {
    const run = fixture();
    t.after(() => run.dispose());
    run.clients.mission = {
      "execution.reworkAssessment.get": async () => rework,
      "execution.clearedAssessment.get": async () => cleared,
    } as unknown as MethodClients["mission"];
    assert.equal(await readPriorRationale(run), expected);
  }
});
