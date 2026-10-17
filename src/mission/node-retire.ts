import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { digest } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import { importAdmissible, isTerminal } from "./admission.ts";
import { validateText } from "./content.ts";
import {
  EdgeKind,
  MissionErrorCode,
  type Edge,
  type HumanActor,
  type NodeChange,
  type Retire,
  type RetirePreview,
  type WorkQueue,
  type MissionBindings,
} from "./contract.ts";
import { requireNode } from "./node-read.ts";
import { claimableMap, reconcileMission, routeMission } from "./routing.ts";
import {
  deleteDependency,
  incrementMissionVersion,
  readDependencies,
  readMissionNodes,
  type NodeRow,
} from "./store.ts";
import { requireActive, requireMission } from "./write.ts";

const COUNTER_INCREMENT = 1;
const UPDATED_NODE_COUNT = 1;
const FIRST_NODE = 0;
const REASON_FIELD = "reason";
type DependencyEdge = Extract<Edge, { kind: typeof EdgeKind.Dependency }>;

function retirementSet(tx: Transaction, node: NodeRow): NodeRow[] {
  const nodes = readMissionNodes(tx, node.mission_id).filter(
    (item) => item.retired_at === null,
  );
  const children = new Map<string, NodeRow[]>();
  for (const child of nodes) {
    if (child.parent_id === null) continue;
    const siblings = children.get(child.parent_id) ?? [];
    siblings.push(child);
    children.set(child.parent_id, siblings);
  }
  const pending = [node];
  const ids = new Set([node.id]);
  for (
    let index = FIRST_NODE;
    index < pending.length && index < nodes.length;
    index++
  ) {
    const parent = pending[index]!;
    const descendants = children.get(parent.id) ?? [];
    for (const child of descendants) {
      assert.ok(!ids.has(child.id), "Containment must be acyclic.");
      ids.add(child.id);
      pending.push(child);
    }
  }
  assert.ok(
    pending.length <= nodes.length,
    "Retirement stays within the current mission.",
  );
  return [
    node,
    ...nodes.filter((item) => item.id !== node.id && ids.has(item.id)),
  ];
}

function checkRetirement(tx: Transaction, node: NodeRow): void {
  assert.equal(node.retired_at, null, "Only current nodes enter retirement.");
  if (!importAdmissible(node.state, node.attempt))
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.RetireRefused,
      "Node cannot be retired.",
      { node_id: node.id, state: node.state, attempt: node.attempt },
    );
}

function removedDependencies(
  tx: Transaction,
  missionId: string,
  ids: Set<string>,
  force: boolean,
): DependencyEdge[] {
  const nodes = new Map(
    readMissionNodes(tx, missionId).map((node) => [node.id, node]),
  );
  const removed: DependencyEdge[] = [];
  for (const edge of readDependencies(tx, missionId)) {
    if (!ids.has(edge.depends_on) || ids.has(edge.dependent)) continue;
    const dependent = nodes.get(edge.dependent);
    assert.ok(dependent, "Dependency source exists in its mission.");
    assert.equal(
      dependent.retired_at,
      null,
      "Inbound dependent must be current.",
    );
    if (isTerminal(dependent.state)) continue;
    removed.push({
      kind: EdgeKind.Dependency,
      dependent_id: edge.dependent,
      depends_on_id: edge.depends_on,
    });
  }
  if (!force && removed.length)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.RetireHasDependents,
      "Node has nonterminal dependents.",
      {
        dependents: [
          ...new Set(removed.map((edge) => edge.dependent_id)),
        ].sort(),
      },
    );
  return removed;
}

export function planRetirement(
  tx: Transaction,
  node: NodeRow,
  force: boolean,
): RetirePreview {
  requireActive(node);
  const mission = requireMission(tx, node.mission_id);
  const nodes = retirementSet(tx, node);
  assert.equal(nodes[FIRST_NODE]?.id, node.id, "Named node is checked first.");
  for (const retiring of nodes) checkRetirement(tx, retiring);
  const retiredNodeIds = nodes.map((item) => item.id).sort();
  assert.ok(
    retiredNodeIds.includes(node.id),
    "Retirement includes the named node.",
  );
  const removedEdges = removedDependencies(
    tx,
    mission.id,
    new Set(retiredNodeIds),
    force,
  );
  const preview = {
    node_id: node.id,
    force,
    mission_version: mission.version,
    retired_node_ids: retiredNodeIds,
    removed_edges: removedEdges,
  };
  return { ...preview, preview_digest: digest(preview) };
}

function retireRows(tx: Transaction, ids: Set<string>): void {
  const now = Date.now();
  for (const id of ids) {
    const result = tx.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(now, id);
    assert.equal(
      result.changes,
      UPDATED_NODE_COUNT,
      "Retirement retains and marks one node.",
    );
  }
}

export function retireNode(
  tx: Transaction,
  nodeId: string,
  body: Retire,
  actor: HumanActor,
  workQueue: WorkQueue,
  textMaxBytes: number,
  bindings: MissionBindings,
): NodeChange {
  const node = requireNode(tx, nodeId);
  requireActive(node);
  const mission = requireMission(
    tx,
    node.mission_id,
    body.expected_mission_version,
  );
  validateText(REASON_FIELD, body.reason, textMaxBytes);
  const plan = planRetirement(tx, node, body.force);
  if (body.preview_digest !== plan.preview_digest)
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.RetireMismatch,
      "Retirement preview changed.",
    );
  const before = claimableMap(tx, mission.id, bindings);
  for (const edge of plan.removed_edges) {
    assert.equal(
      edge.kind,
      EdgeKind.Dependency,
      "Retirement removes only dependency edges.",
    );
    if (edge.kind === EdgeKind.Dependency)
      deleteDependency(tx, edge.dependent_id, edge.depends_on_id);
  }
  retireRows(tx, new Set(plan.retired_node_ids));
  routeMission(tx, mission.id);
  reconcileMission(
    tx,
    workQueue,
    mission.id,
    mission.project_id,
    before,
    bindings,
  );
  const missionVersion = incrementMissionVersion(tx, mission.id);
  assert.equal(
    missionVersion,
    mission.version + COUNTER_INCREMENT,
    "Retirement increments mission once.",
  );
  assert.equal(
    plan.node_id,
    node.id,
    "Applied plan belongs to the named node.",
  );
  return {
    mission_version: missionVersion,
    revisions: [],
    retired_node_ids: plan.retired_node_ids,
    added_edges: [],
    removed_edges: plan.removed_edges,
    open_attempts_unchanged: [],
  };
}
