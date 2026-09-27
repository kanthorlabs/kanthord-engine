import { createIdentity } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  MISSION_IDENTITY_PREFIX,
  MISSION_INITIAL_VERSION,
  NodeState,
} from "./contract.ts";

export function insertMission(
  tx: Transaction,
  projectId: string,
  createdAt: number,
): string {
  const id = createIdentity(MISSION_IDENTITY_PREFIX);
  tx.database
    .prepare(
      "INSERT INTO mission_mission (id, project_id, version, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(id, projectId, MISSION_INITIAL_VERSION, createdAt);
  return id;
}

export function readNodeState(tx: Transaction, nodeId: string): string | null {
  const row = tx.database
    .prepare("SELECT state FROM mission_node WHERE id = ?")
    .get(nodeId) as { state: string | null } | undefined;
  return row?.state ?? null;
}

export function readCurrentChildStates(
  tx: Transaction,
  parentId: string,
): Array<string | null> {
  const rows = tx.database
    .prepare(
      "SELECT state FROM mission_node WHERE parent_id = ? AND retired_at IS NULL",
    )
    .all(parentId) as Array<{ state: string | null }>;
  return rows.map((row) => row.state);
}

export function readLiveNodesPinning(
  tx: Transaction,
  bindingId: string,
): string[] {
  const rows = tx.database
    .prepare(
      `SELECT n.id FROM mission_node n
       JOIN mission_node_revision r ON r.node_id = n.id
         AND r.revision = (
           SELECT MAX(latest.revision) FROM mission_node_revision latest
           WHERE latest.node_id = n.id
         )
       WHERE n.retired_at IS NULL AND n.state NOT IN (?, ?)
         AND EXISTS (
           SELECT 1 FROM json_each(r.bindings) binding
           WHERE binding.value = ?
         )
       ORDER BY n.id ASC`,
    )
    .all(NodeState.Completed, NodeState.Discarded, bindingId) as Array<{
    id: string;
  }>;
  return rows.map((row) => row.id);
}
