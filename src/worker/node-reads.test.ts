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
  readClearedOutcome,
  readReworkAssessment,
  READ_PAGE_LIMIT,
} from "./node-reads.ts";
import { NodeKind } from "./native-agent.ts";
import type { MethodClients } from "./method-clients.ts";

const INITIAL_ATTEMPT = 1;
function fixture(attempt = 1) {
  return new ExecutionRun({
    claim: {
      execution_id: "execution",
      node_id: "node",
      attempt,
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

test("node kind, terminal states and cleared outcome follow the pinned attempt", async (t) => {
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
  let calls = 0;
  const outcome = { id: "outcome" };
  for (const attempt of [1, 2]) {
    const run = fixture(attempt);
    t.after(() => run.dispose());
    run.clients.mission = {
      "execution.clearedOutcome.get": async () => {
        calls++;
        return {
          type: OperationResultType.Completed,
          status: 200,
          data: outcome,
        };
      },
    } as unknown as MethodClients["mission"];
    assert.equal(
      await readClearedOutcome(run),
      attempt === INITIAL_ATTEMPT ? null : outcome,
    );
  }
  assert.equal(calls, INITIAL_ATTEMPT);
});

test("the rework assessment read answers null only on a record not found", async (t) => {
  const assessment = { id: "assessment", rationale: "unmet" };
  const failure = (status: number, code: string) => ({
    type: OperationResultType.Failure,
    status,
    error: {
      request_id: "request",
      error: { code, message: "failed", details: null },
    },
  });
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
      "execution.reworkAssessment.get": async () => answer,
    } as unknown as MethodClients["mission"];
    if (expected === ExecutionStop)
      await assert.rejects(readReworkAssessment(run), ExecutionStop);
    else assert.deepEqual(await readReworkAssessment(run), expected);
  }
});
