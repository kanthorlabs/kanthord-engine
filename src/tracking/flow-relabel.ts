import assert from "node:assert/strict";
import { identityTime } from "../kernel/identity.ts";
import { CauseAssigner, type EffectiveCause } from "../kernel/cause.ts";
import type { Transaction } from "../kernel/store.ts";
import { FlowGrain } from "./contract.ts";
import {
  bucketsOf,
  contributionOf,
  FLOW_VECTOR_COLUMNS,
} from "./flow-model.ts";
import type { FlowVector } from "./flow-model.ts";
import {
  addFlowVector,
  deleteEmptyFlowRow,
  type RollupPlace,
} from "./flow-rollup.ts";
import {
  changedFlowColumns,
  flowColumnsOf,
  readFlowTrace,
  writeFlowColumns,
} from "./flow-trace.ts";

const NO_VALUE = "";
const NO_COUNT = 0;

function negated(vector: FlowVector): FlowVector {
  return Object.fromEntries(
    FLOW_VECTOR_COLUMNS.map((column) => [column, NO_COUNT - vector[column]]),
  ) as FlowVector;
}

export function relabelFlow(
  tx: Transaction,
  traceId: string,
  cause: EffectiveCause,
  isHostedWorker: (workerName: string) => boolean,
  now: number,
): void {
  assert.ok(traceId);
  const row = readFlowTrace(tx, traceId);
  assert.ok(row, "relabelFlow: trace is absent");
  if (row.kind === null) return;
  assert.ok(row.execution_id, "relabelFlow: a flow trace has an execution");
  const relabeled = {
    ...row,
    cause_category: cause.category,
    cause_detail: cause.subcategory ?? NO_VALUE,
    cause_assigner: CauseAssigner.Human,
  };
  writeFlowColumns(
    tx,
    traceId,
    changedFlowColumns(flowColumnsOf(row), flowColumnsOf(relabeled)),
  );
  const previous = contributionOf(row, isHostedWorker);
  const next = contributionOf(relabeled, isHostedWorker);
  if (JSON.stringify(previous.key) === JSON.stringify(next.key)) return;
  const buckets = bucketsOf(identityTime(row.execution_id));
  const places: RollupPlace[] = [
    { grain: FlowGrain.Hour, bucket_start: buckets.hour, now },
    { grain: FlowGrain.Day, bucket_start: buckets.day, now },
  ];
  for (const place of places) {
    addFlowVector(tx, place, previous.key, negated(previous.vector), false);
    deleteEmptyFlowRow(tx, place, previous.key);
    addFlowVector(tx, place, next.key, next.vector, false);
  }
}
