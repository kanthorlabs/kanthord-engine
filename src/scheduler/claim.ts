import assert from "node:assert/strict";
import type { MachineIdentity } from "../kernel/caller.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  AgentChoiceKind,
  EXECUTION_IDENTITY_PREFIX,
  type AgentPin,
  type Claimant,
  traceIdSchema,
  spanIdSchema,
  type ExecutionRow,
  type WorkPull,
} from "./contract.ts";
import type { Dependencies } from "./service.ts";
import {
  countRunningOfGroup,
  countRunningOfRuntimes,
  insertExecution,
  readUnendedOfRuntime,
} from "./execution-store.ts";
import { settleNode, settleRuntime } from "./settlement.ts";
import { admits } from "./match.ts";
import type { InstanceQueue } from "./instance-queue.ts";

export const ClaimOutcome = {
  Running: "running",
  Claimed: "claimed",
  Refused: "refused",
  Queued: "queued",
  None: "none",
} as const;
export type ClaimOutcome = (typeof ClaimOutcome)[keyof typeof ClaimOutcome];
export interface ClaimResult {
  outcome: ClaimOutcome;
  row: ExecutionRow | null;
  settled: boolean;
}
export interface ClaimDependencies extends Dependencies {
  instances: InstanceQueue;
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
  claimant: Claimant,
  executionId: string,
  now: number,
) {
  assert.ok(identity.runtimeIdentity);
  const jobs = tx.database
    .prepare(
      "SELECT node_id FROM scheduler_job WHERE project_id = ? AND (available_at IS NULL OR available_at <= ?) ORDER BY priority DESC, id ASC",
    )
    .all(identity.projectId, now) as { node_id: string }[];
  let settled = false;
  for (let index = 0; index < jobs.length; index++) {
    const nodeId = jobs[index]!.node_id;
    if (settleNode(tx, dependencies, nodeId, now)) {
      settled = true;
      continue;
    }
    const facts = dependencies.facts.claimFacts(tx, nodeId);
    if (facts === null || !admits(claimant, facts)) continue;
    if (
      !dependencies.environments.environmentsClaimable(
        identity.projectId,
        facts.repositories,
      )
    )
      continue;
    const claim = dependencies.transitions.claim(
      tx,
      nodeId,
      claimant.declared_node_states,
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
  pins: AgentPin[],
  now: number,
): ClaimResult {
  const executionId = createIdentity(EXECUTION_IDENTITY_PREFIX);
  const selected = selectJob(
    tx,
    dependencies,
    identity,
    {
      declared_node_states: declaration.declared_node_states,
      declared_intents: declaration.declared_intents,
      tags: binding.tags,
      environment: binding.environment,
    },
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
    agent_pins: pins,
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

function admit(
  tx: Transaction,
  dependencies: ClaimDependencies,
  identity: MachineIdentity,
  pull: WorkPull,
  now: number,
): ClaimResult {
  assert.equal(pull.runtime_identity, identity.runtimeIdentity);
  assert.equal(pull.resource_identity, identity.resourceIdentity);
  const settled = settleRuntime(tx, dependencies, pull.runtime_identity, now);
  const row = readUnendedOfRuntime(tx, pull.runtime_identity);
  if (row) return { outcome: ClaimOutcome.Running, row, settled };
  if (dependencies.projects.projectPaused(tx, identity.projectId))
    return { outcome: ClaimOutcome.None, row: null, settled };
  if (
    !dependencies.registrations.registrationHealthcheck(
      tx,
      pull.runtime_identity,
    )
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
  if (!declaration) return { outcome: ClaimOutcome.None, row: null, settled };
  if (
    countRunningOfGroup(
      tx,
      identity.projectId,
      identity.resourceIdentity,
      now,
    ) >= binding.instance_count
  )
    return { outcome: ClaimOutcome.None, row: null, settled };
  const siblings = dependencies.registrations.registrationsOfInstance(
    tx,
    pull.runtime_identity,
  );
  if (
    countRunningOfRuntimes(tx, siblings, now) > NO_INSTANCES ||
    !dependencies.instances.turn(pull.runtime_identity, siblings)
  )
    return { outcome: ClaimOutcome.Queued, row: null, settled };
  const choice = dependencies.agentChains.select(
    tx,
    binding.binding_id,
    pull.runtime_identity,
  );
  if (choice.kind === AgentChoiceKind.Cooling)
    return { outcome: ClaimOutcome.None, row: null, settled };
  const result = acquire(
    tx,
    dependencies,
    identity,
    pull,
    binding,
    declaration,
    choice.pins,
    now,
  );
  return { ...result, settled: result.settled || settled };
}

export function claimOnce(
  tx: Transaction,
  dependencies: ClaimDependencies,
  identity: MachineIdentity,
  pull: WorkPull,
  now: number,
): ClaimResult {
  const { instances } = dependencies;
  const result = admit(tx, dependencies, identity, pull, now);
  if (result.outcome === ClaimOutcome.Queued)
    instances.wait(pull.runtime_identity);
  else if (
    result.outcome !== ClaimOutcome.Claimed &&
    instances.waits(pull.runtime_identity)
  )
    instances.pass(
      pull.runtime_identity,
      dependencies.registrations.registrationsOfInstance(
        tx,
        pull.runtime_identity,
      ),
    );
  return result;
}
