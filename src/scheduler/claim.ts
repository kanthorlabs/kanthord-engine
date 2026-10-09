import assert from "node:assert/strict";
import type { MachineIdentity } from "../kernel/caller.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  EXECUTION_IDENTITY_PREFIX,
  nodeFormatFieldSchema,
  traceIdSchema,
  spanIdSchema,
  type ExecutionRow,
  type WorkPull,
} from "./contract.ts";
import type { Dependencies } from "./service.ts";
import {
  countRunningOfGroup,
  insertExecution,
  readUnendedOfRuntime,
} from "./execution-store.ts";
import { settleNode, settleRuntime } from "./settlement.ts";

export const ClaimOutcome = {
  Running: "running",
  Claimed: "claimed",
  Refused: "refused",
  None: "none",
} as const;
export type ClaimOutcome = (typeof ClaimOutcome)[keyof typeof ClaimOutcome];
export interface ClaimResult {
  outcome: ClaimOutcome;
  row: ExecutionRow | null;
  settled: boolean;
}
const NO_INSTANCES = 0;
const MILLISECONDS_PER_SECOND = 1000;

type Binding = NonNullable<
  ReturnType<Dependencies["bindings"]["workerBindingOf"]>
>;
type Declaration = NonNullable<
  ReturnType<Dependencies["declarations"]["declarationOf"]>
>;

function selectJob(
  tx: Transaction,
  dependencies: Dependencies,
  identity: MachineIdentity,
  declaration: Declaration,
  executionId: string,
  now: number,
) {
  assert.ok(identity.runtimeIdentity);
  assert.ok(
    declaration.required_node_format.every(
      (field) => nodeFormatFieldSchema.safeParse(field).success,
    ),
  );
  const jobs = tx.database
    .prepare(
      "SELECT node_id FROM scheduler_job WHERE project_id = ? ORDER BY priority DESC, id ASC",
    )
    .all(identity.projectId) as { node_id: string }[];
  let settled = false;
  for (let index = 0; index < jobs.length; index++) {
    const nodeId = jobs[index]!.node_id;
    settled = settleNode(tx, dependencies, nodeId, now) || settled;
    const claim = dependencies.transitions.claim(
      tx,
      nodeId,
      declaration.declared_node_states,
      {
        kind: "execution",
        execution_id: executionId,
        client_id: identity.clientId,
        name: identity.name,
      },
      now,
    );
    if (claim) return { node_id: nodeId, claim, settled };
  }
  return { node_id: null, claim: null, settled };
}

function acquire(
  tx: Transaction,
  dependencies: Dependencies,
  identity: MachineIdentity,
  pull: WorkPull,
  binding: Binding,
  declaration: Declaration,
  now: number,
): ClaimResult {
  const executionId = createIdentity(EXECUTION_IDENTITY_PREFIX);
  const selected = selectJob(
    tx,
    dependencies,
    identity,
    declaration,
    executionId,
    now,
  );
  if (!selected.claim)
    return { outcome: ClaimOutcome.None, row: null, settled: selected.settled };
  assert.ok(selected.node_id);
  assert.equal(selected.claim.project_id, identity.projectId);
  const trace = dependencies.traceIdentity.mint();
  assert.ok(traceIdSchema.safeParse(trace.trace_id).success);
  assert.ok(spanIdSchema.safeParse(trace.root_span_id).success);
  const wallTimeMs =
    binding.resource_budget?.wall_time_ms ??
    declaration.resource_budget.wall_time_ms;
  const row: ExecutionRow = {
    execution_id: executionId,
    project_id: identity.projectId,
    node_id: selected.node_id,
    worker_binding_id: binding.binding_id,
    resource_identity: pull.resource_identity,
    runtime_identity: pull.runtime_identity,
    attempt: selected.claim.attempt,
    pinned_revision: selected.claim.node_revision,
    credentials: [],
    expired_at:
      now +
      wallTimeMs +
      MILLISECONDS_PER_SECOND * dependencies.config.release_reserve,
    ...trace,
    created_at: now,
    ended_at: null,
    stop: null,
  };
  insertExecution(tx, row);
  return { outcome: ClaimOutcome.Claimed, row, settled: selected.settled };
}

export function claimOnce(
  tx: Transaction,
  dependencies: Dependencies,
  identity: MachineIdentity,
  pull: WorkPull,
  now: number,
): ClaimResult {
  assert.equal(pull.runtime_identity, identity.runtimeIdentity);
  assert.equal(pull.resource_identity, identity.resourceIdentity);
  const settled = settleRuntime(tx, dependencies, pull.runtime_identity, now);
  const row = readUnendedOfRuntime(tx, pull.runtime_identity);
  if (row) return { outcome: ClaimOutcome.Running, row, settled };
  if (
    !dependencies.registrations.instanceHealthcheck(tx, pull.runtime_identity)
  )
    return { outcome: ClaimOutcome.Refused, row: null, settled };
  const binding = dependencies.bindings.workerBindingOf(
    tx,
    identity.projectId,
    identity.resourceIdentity,
  );
  if (!binding || binding.tombstone || binding.instance_count <= NO_INSTANCES)
    return { outcome: ClaimOutcome.None, row: null, settled };
  const declaration = dependencies.declarations.declarationOf(
    binding.worker_name,
  );
  assert.ok(declaration, "a worker binding must name a declared worker");
  assert.ok(
    declaration.required_node_format.every(
      (field) => nodeFormatFieldSchema.safeParse(field).success,
    ),
  );
  if (
    countRunningOfGroup(
      tx,
      identity.projectId,
      identity.resourceIdentity,
      now,
    ) >= binding.instance_count
  )
    return { outcome: ClaimOutcome.None, row: null, settled };
  const result = acquire(
    tx,
    dependencies,
    identity,
    pull,
    binding,
    declaration,
    now,
  );
  return { ...result, settled: result.settled || settled };
}
