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
  READ_PAGE_LIMIT,
} from "./node-reads.ts";
import { NodeKind } from "./native-agent.ts";
import type { MethodClients } from "./method-clients.ts";

const INITIAL_ATTEMPT = 1;
function fixture(attempt = 1) {
  return new ExecutionRun({
    claim: {
      executionId: "execution",
      nodeId: "node",
      attempt,
      pinnedRevision: 1,
      createdAt: Date.now(),
      expiredAt: Date.now() + 60000,
      traceId: "trace",
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
      data: { items: cursor ? [2] : [1], nextCursor: cursor ? null : "second" },
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
        data: { items: [], nextCursor: "again" },
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
