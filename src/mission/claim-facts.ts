import assert from "node:assert/strict";
import type { Transaction } from "../kernel/store.ts";
import { isTerminal } from "./admission.ts";
import {
  ClaimableState,
  requiresSchema,
  workSchema,
  type ClaimFacts,
  type ClaimFactsRow,
  type MissionBindings,
} from "./contract.ts";
import { actionsOfRevision } from "./frozen-action.ts";
import {
  claimRevisionOf,
  readClaimRevisions,
  readMissionByProject,
  readNode,
  type NodeRow,
  type RevisionRow,
} from "./store.ts";

const NO_ACTIONS = 0;

function claimable(node: NodeRow | null): node is NodeRow {
  return node !== null && node.retired_at === null && !isTerminal(node.state);
}

function factsOf(revision: RevisionRow): ClaimFacts {
  return {
    work: workSchema.parse(revision.work),
    requires: requiresSchema.parse(JSON.parse(revision.requires)),
  };
}

function rowOf(
  tx: Transaction,
  bindings: MissionBindings,
  revision: RevisionRow,
): ClaimFactsRow {
  const claims: ClaimableState[] = [
    ClaimableState.Available,
    ClaimableState.Waiting,
  ];
  if (actionsOfRevision(tx, bindings, revision).length > NO_ACTIONS)
    claims.push(ClaimableState.ExternalRequested);
  return {
    node_id: revision.node_id,
    revision: revision.revision,
    ...factsOf(revision),
    claims,
  };
}

export function claimFacts(tx: Transaction, nodeId: string): ClaimFacts | null {
  assert.ok(tx.database.isTransaction);
  if (!claimable(readNode(tx, nodeId))) return null;
  return factsOf(claimRevisionOf(tx, nodeId));
}

export function claimFactsOf(
  tx: Transaction,
  bindings: MissionBindings,
  projectId: string,
): ClaimFactsRow[] {
  assert.ok(tx.database.isTransaction);
  const mission = readMissionByProject(tx, projectId);
  if (!mission) return [];
  return readClaimRevisions(tx, mission.id)
    .filter(({ node_state }) => !isTerminal(node_state))
    .map((revision) => rowOf(tx, bindings, revision));
}
