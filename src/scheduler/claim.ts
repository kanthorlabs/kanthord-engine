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
  type EndedExecution,
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
import { executionOpening } from "./telemetry.ts";
import {
  executionKindSchema,
  type ExecutionOpening,
} from "../tracking/contract.ts";

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
  opening: ExecutionOpening | null;
  settled: boolean;
  lost: EndedExecution[];
}
export interface ClaimDependencies extends Dependencies {
  instances: InstanceQueue;
}
const NO_INSTANCES = 0;
const NO_LOSSES = 0;
const MILLISECONDS_PER_SECOND = 1000;
const RESOURCE_IDENTITY_SEPARATOR = ":";
const INSTANCE_KEY_SEPARATOR = "/";

function claimResult(
  outcome: ClaimOutcome,
  row: ExecutionRow | null,
  lost: EndedExecution[],
  opening: ExecutionOpening | null = null,
): ClaimResult {
  return { outcome, row, opening, settled: lost.length > NO_LOSSES, lost };
}

export function instanceKeyOf(identity: MachineIdentity): string {
  if (identity.instanceId) return identity.name;
  const bindingName = identity.resourceIdentity
    .split(RESOURCE_IDENTITY_SEPARATOR)
    .at(-1)!;
  return `${bindingName}${INSTANCE_KEY_SEPARATOR}${identity.name}`;
}

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
  workerName: string,
  placement: string | null,
  executionId: string,
  now: number,
) {
  assert.ok(identity.runtimeIdentity);
  const jobs = tx.database
    .prepare(
      "SELECT node_id, queued_at FROM scheduler_job WHERE project_id = ? AND (available_at IS NULL OR available_at <= ?) ORDER BY priority DESC, id ASC",
    )
    .all(identity.projectId, now) as { node_id: string; queued_at: number }[];
  const lost: EndedExecution[] = [];
  for (let index = 0; index < jobs.length; index++) {
    const { node_id: nodeId, queued_at: queuedAt } = jobs[index]!;
    const ended = settleNode(tx, dependencies, nodeId, now);
    if (ended !== null) {
      lost.push(ended);
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
    const openingFacts = dependencies.facts.openingFacts(tx, nodeId);
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
    if (claim)
      return {
        node_id: nodeId,
        claim,
        opening: executionOpening(
          executionKindSchema.parse(claim.kind),
          workerName,
          queuedAt,
          now,
          {
            worker_instance: instanceKeyOf(identity),
            placement,
            revision_turn: openingFacts?.revision_turn ?? null,
            dependency_count: openingFacts?.dependency_count ?? null,
            node_name: openingFacts?.node_name ?? null,
          },
        ),
        lost,
      };
  }
  return { node_id: null, claim: null, opening: null, lost };
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
    binding.worker_name,
    binding.placement,
    executionId,
    now,
  );
  if (!selected.claim)
    return claimResult(ClaimOutcome.None, null, selected.lost);
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
  return claimResult(
    ClaimOutcome.Claimed,
    row,
    selected.lost,
    selected.opening,
  );
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
  const ended = settleRuntime(tx, dependencies, pull.runtime_identity, now);
  const lost = ended === null ? [] : [ended];
  const row = readUnendedOfRuntime(tx, pull.runtime_identity);
  if (row) return claimResult(ClaimOutcome.Running, row, lost);
  if (dependencies.projects.projectPaused(tx, identity.projectId))
    return claimResult(ClaimOutcome.None, null, lost);
  if (
    !dependencies.registrations.registrationHealthcheck(
      tx,
      pull.runtime_identity,
    )
  )
    return claimResult(ClaimOutcome.Refused, null, lost);
  const binding = dependencies.bindings.workerBindingOf(
    tx,
    identity.projectId,
    identity.resourceIdentity,
  );
  if (!binding || binding.tombstone || binding.instance_count <= NO_INSTANCES)
    return claimResult(ClaimOutcome.None, null, lost);
  const declaration = dependencies.declarations.declarationOf(
    binding.worker_name,
  );
  if (!declaration) return claimResult(ClaimOutcome.None, null, lost);
  if (
    countRunningOfGroup(
      tx,
      identity.projectId,
      identity.resourceIdentity,
      now,
    ) >= binding.instance_count
  )
    return claimResult(ClaimOutcome.None, null, lost);
  const siblings = dependencies.registrations.registrationsOfInstance(
    tx,
    pull.runtime_identity,
  );
  if (
    countRunningOfRuntimes(tx, siblings, now) > NO_INSTANCES ||
    !dependencies.instances.turn(pull.runtime_identity, siblings)
  )
    return claimResult(ClaimOutcome.Queued, null, lost);
  const choice = dependencies.agentChains.select(
    tx,
    binding.binding_id,
    pull.runtime_identity,
  );
  if (choice.kind === AgentChoiceKind.Cooling)
    return claimResult(ClaimOutcome.None, null, lost);
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
  return claimResult(
    result.outcome,
    result.row,
    [...lost, ...result.lost],
    result.opening,
  );
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
