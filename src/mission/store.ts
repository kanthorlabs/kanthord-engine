import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  MISSION_IDENTITY_PREFIX,
  MISSION_INITIAL_VERSION,
  MissionErrorCode,
  NodeKind,
  NodeState,
  type Mission,
  type Revision,
} from "./contract.ts";
import type { DepEdge } from "./graph.ts";

const VERSION_INCREMENT = 1;
const INITIAL_ATTEMPT = 0;
const FILENAME_UNIQUE_FAILURE =
  /UNIQUE constraint failed: mission_node\.mission_id, mission_node\.filename/;

export interface NodeRow {
  id: string;
  mission_id: string;
  kind: NodeKind;
  filename: string;
  parent_id: string | null;
  state: NodeState | null;
  attempt: number | null;
  priority: number | null;
  retired_at: number | null;
  created_at: number;
}

export interface RevisionRow {
  node_id: string;
  revision: number;
  filename: string;
  name: string;
  requirement: string;
  criterion: string;
  verifications: string;
  bindings: string;
  tasks: string | null;
  change: string;
  reason: string;
  actor: string;
  created_at: number;
}

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

export function readMissionByProject(
  tx: Transaction,
  projectId: string,
): { id: string; projectId: string; version: number } | null {
  const row = tx.database
    .prepare(
      "SELECT id, project_id, version FROM mission_mission WHERE project_id = ?",
    )
    .get(projectId) as
    { id: string; project_id: string; version: number } | undefined;
  return row
    ? { id: row.id, projectId: row.project_id, version: row.version }
    : null;
}

export function readMission(
  tx: Transaction,
  missionId: string,
): Mission | null {
  const row = tx.database
    .prepare(
      "SELECT id, project_id AS projectId, version FROM mission_mission WHERE id = ?",
    )
    .get(missionId) as Mission | undefined;
  return row ?? null;
}

export function incrementMissionVersion(
  tx: Transaction,
  missionId: string,
): number {
  const row = tx.database
    .prepare(
      "UPDATE mission_mission SET version = version + ? WHERE id = ? RETURNING version",
    )
    .get(VERSION_INCREMENT, missionId) as { version: number } | undefined;
  assert.ok(row, "Version increment requires an existing mission.");
  assert.ok(
    Number.isSafeInteger(row.version),
    "Mission version must remain a safe integer.",
  );
  return row.version;
}

export function filenameTaken(
  tx: Transaction,
  missionId: string,
  filename: string,
): boolean {
  return (
    tx.database
      .prepare(
        "SELECT id FROM mission_node WHERE mission_id = ? AND filename = ? AND retired_at IS NULL",
      )
      .get(missionId, filename) !== undefined
  );
}

export function filenameConflict(filename: string): OperationError {
  return new OperationError(
    HttpStatus.Conflict,
    MissionErrorCode.FilenameConflict,
    "Node filename is already in use.",
    { filename },
  );
}

export function insertNode(
  tx: Transaction,
  node: Pick<
    NodeRow,
    "id" | "mission_id" | "kind" | "filename" | "parent_id" | "created_at"
  >,
): void {
  const task = node.kind === NodeKind.Task;
  try {
    tx.database
      .prepare(
        `INSERT INTO mission_node
      (id, mission_id, kind, filename, parent_id, state, attempt, priority, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        node.id,
        node.mission_id,
        node.kind,
        node.filename,
        node.parent_id,
        task ? null : NodeState.Pending,
        task ? null : INITIAL_ATTEMPT,
        null,
        node.created_at,
      );
  } catch (error) {
    if (error instanceof Error && FILENAME_UNIQUE_FAILURE.test(error.message))
      throw filenameConflict(node.filename);
    throw error;
  }
}

export function readNode(tx: Transaction, nodeId: string): NodeRow | null {
  return (
    (tx.database
      .prepare("SELECT * FROM mission_node WHERE id = ?")
      .get(nodeId) as NodeRow | undefined) ?? null
  );
}

export function readMissionNodes(
  tx: Transaction,
  missionId: string,
): NodeRow[] {
  return tx.database
    .prepare("SELECT * FROM mission_node WHERE mission_id = ? ORDER BY id")
    .all(missionId) as unknown as NodeRow[];
}

export function setNodeState(
  tx: Transaction,
  nodeId: string,
  state: NodeState,
): void {
  tx.database
    .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
    .run(state, nodeId);
}

export function insertRevision(tx: Transaction, revision: Revision): void {
  tx.database
    .prepare(
      `INSERT INTO mission_node_revision
    (node_id, revision, filename, name, requirement, criterion, verifications,
     bindings, tasks, change, reason, actor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      revision.nodeId,
      revision.revision,
      revision.filename,
      revision.content.name,
      revision.content.requirement,
      revision.content.criterion,
      JSON.stringify(revision.content.verifications),
      JSON.stringify(revision.content.bindings),
      revision.tasks === undefined ? null : JSON.stringify(revision.tasks),
      JSON.stringify(revision.change),
      revision.reason,
      JSON.stringify(revision.actor),
      revision.createdAt,
    );
}

export function readCurrentRevision(
  tx: Transaction,
  nodeId: string,
): RevisionRow | null {
  return (
    (tx.database
      .prepare(
        `SELECT * FROM mission_node_revision
    WHERE node_id = ? ORDER BY revision DESC LIMIT 1`,
      )
      .get(nodeId) as unknown as RevisionRow | undefined) ?? null
  );
}

export function readRevision(
  tx: Transaction,
  nodeId: string,
  revision: number,
): RevisionRow | null {
  return (
    (tx.database
      .prepare(
        "SELECT * FROM mission_node_revision WHERE node_id = ? AND revision = ?",
      )
      .get(nodeId, revision) as unknown as RevisionRow | undefined) ?? null
  );
}

export function readDependencies(
  tx: Transaction,
  missionId: string,
): DepEdge[] {
  return tx.database
    .prepare(
      `SELECT d.dependent_id AS dependent, d.depends_on_id AS dependsOn
    FROM mission_dependency d
    JOIN mission_node source ON source.id = d.dependent_id
    JOIN mission_node target ON target.id = d.depends_on_id
    WHERE d.mission_id = ? AND source.retired_at IS NULL AND target.retired_at IS NULL
    ORDER BY d.dependent_id, d.depends_on_id`,
    )
    .all(missionId) as DepEdge[];
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
