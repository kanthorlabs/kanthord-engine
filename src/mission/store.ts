import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  MISSION_IDENTITY_PREFIX,
  MISSION_INITIAL_VERSION,
  MissionErrorCode,
  NodeState,
  intentSchema,
  type Mission,
  type Revision,
  type Intent,
} from "./contract.ts";
import type { DepEdge } from "./graph.ts";

const VERSION_INCREMENT = 1;
const UPDATED_NODE_COUNT = 1;
const INITIAL_ATTEMPT = 0;
const FILENAME_UNIQUE_FAILURE =
  /UNIQUE constraint failed: mission_node\.mission_id, mission_node\.filename/;

export interface NodeRow {
  id: string;
  mission_id: string;
  filename: string;
  state: NodeState;
  attempt: number;
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
  intent: Intent;
  tags: string;
  tasks: string;
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
): { id: string; project_id: string; version: number } | null {
  const row = tx.database
    .prepare(
      "SELECT id, project_id, version FROM mission_mission WHERE project_id = ?",
    )
    .get(projectId) as
    { id: string; project_id: string; version: number } | undefined;
  return row
    ? { id: row.id, project_id: row.project_id, version: row.version }
    : null;
}

export function readMission(
  tx: Transaction,
  missionId: string,
): Mission | null {
  const row = tx.database
    .prepare("SELECT id, project_id, version FROM mission_mission WHERE id = ?")
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

export function usedFilenames(
  tx: Transaction,
  missionId: string,
  exceptNodeId: string | null,
): Set<string> {
  const rows = tx.database
    .prepare(
      `SELECT n.filename FROM mission_node n
     WHERE n.mission_id = ? AND n.retired_at IS NULL AND n.id IS NOT ?
     UNION ALL
     SELECT json_extract(task.value, '$.filename') FROM mission_node n
     JOIN mission_node_revision r ON r.node_id = n.id
       AND r.revision = (
         SELECT MAX(latest.revision) FROM mission_node_revision latest
         WHERE latest.node_id = n.id
       )
     JOIN json_each(r.tasks) task
     WHERE n.mission_id = ? AND n.retired_at IS NULL AND n.id IS NOT ?`,
    )
    .all(missionId, exceptNodeId, missionId, exceptNodeId) as {
    filename: string;
  }[];
  return new Set(rows.map((row) => row.filename));
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
  node: Pick<NodeRow, "id" | "mission_id" | "filename" | "created_at">,
): void {
  try {
    tx.database
      .prepare(
        `INSERT INTO mission_node
      (id, mission_id, filename, state, attempt, priority, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        node.id,
        node.mission_id,
        node.filename,
        NodeState.Pending,
        INITIAL_ATTEMPT,
        null,
        node.created_at,
      );
  } catch (error) {
    if (error instanceof Error && FILENAME_UNIQUE_FAILURE.test(error.message))
      throw filenameConflict(node.filename);
    throw error;
  }
}

export function updateNodePriority(
  tx: Transaction,
  nodeId: string,
  priority: number,
): void {
  const result = tx.database
    .prepare("UPDATE mission_node SET priority = ? WHERE id = ?")
    .run(priority, nodeId);
  assert.equal(
    result.changes,
    UPDATED_NODE_COUNT,
    "Priority update requires one node.",
  );
}

export function updateNodeFilename(
  tx: Transaction,
  nodeId: string,
  filename: string,
): void {
  try {
    const result = tx.database
      .prepare("UPDATE mission_node SET filename = ? WHERE id = ?")
      .run(filename, nodeId);
    assert.equal(
      result.changes,
      UPDATED_NODE_COUNT,
      "Filename update requires one node.",
    );
  } catch (error) {
    if (error instanceof Error && FILENAME_UNIQUE_FAILURE.test(error.message))
      throw filenameConflict(filename);
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

export interface NodeListFilter {
  intent?: Intent;
  state?: NodeState;
  include_retired: boolean;
  after?: string;
}

export function listNodes(
  tx: Transaction,
  missionId: string,
  filter: NodeListFilter,
  count: number,
): NodeRow[] {
  return tx.database
    .prepare(
      `SELECT n.* FROM mission_node n WHERE n.mission_id = ?
     AND (? = 1 OR n.retired_at IS NULL)
     AND (? IS NULL OR (
       SELECT r.intent FROM mission_node_revision r
       WHERE r.node_id = n.id AND r.revision = COALESCE(
         (SELECT a.node_revision FROM mission_attempt a
          WHERE a.node_id = n.id AND a.closed_at IS NULL),
         (SELECT MAX(latest.revision) FROM mission_node_revision latest
          WHERE latest.node_id = n.id)
       )
     ) = ?)
     AND (? IS NULL OR n.state = ?)
     AND (? IS NULL OR n.id < ?)
     ORDER BY n.id DESC LIMIT ?`,
    )
    .all(
      missionId,
      Number(filter.include_retired),
      filter.intent ?? null,
      filter.intent ?? null,
      filter.state ?? null,
      filter.state ?? null,
      filter.after ?? null,
      filter.after ?? null,
      count,
    ) as unknown as NodeRow[];
}

export function listRevisions(
  tx: Transaction,
  nodeId: string,
  after: number | undefined,
  count: number,
  upperBound?: number,
): RevisionRow[] {
  return tx.database
    .prepare(
      `SELECT * FROM mission_node_revision WHERE node_id = ?
     AND (? IS NULL OR revision < ?) AND (? IS NULL OR revision <= ?) ORDER BY revision DESC LIMIT ?`,
    )
    .all(
      nodeId,
      after ?? null,
      after ?? null,
      upperBound ?? null,
      upperBound ?? null,
      count,
    ) as unknown as RevisionRow[];
}

export function taskOwnerOf(
  tx: Transaction,
  missionId: string,
  taskId: string,
): { node_id: string; revision: number } | null {
  return (
    (tx.database
      .prepare(
        `SELECT r.node_id, r.revision FROM mission_node_revision r
     JOIN mission_node n ON n.id = r.node_id
     WHERE n.mission_id = ?
     AND EXISTS (SELECT 1 FROM json_each(r.tasks) WHERE json_extract(value, '$.id') = ?)
     ORDER BY r.rowid DESC LIMIT 1`,
      )
      .get(missionId, taskId) as
      { node_id: string; revision: number } | undefined) ?? null
  );
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
     bindings, intent, tags, tasks, change, reason, actor, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      revision.node_id,
      revision.revision,
      revision.filename,
      revision.content.name,
      revision.content.requirement,
      revision.content.criterion,
      JSON.stringify(revision.content.verifications),
      JSON.stringify(revision.content.bindings),
      revision.content.intent,
      JSON.stringify(revision.content.tags),
      JSON.stringify(revision.tasks),
      JSON.stringify(revision.change),
      revision.reason,
      JSON.stringify(revision.actor),
      revision.created_at,
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

export function readClaimRevisions(
  tx: Transaction,
  missionId: string,
): RevisionRow[] {
  return tx.database
    .prepare(
      `SELECT r.* FROM mission_node n
    JOIN mission_node_revision r ON r.node_id = n.id
    WHERE n.mission_id = ? AND n.retired_at IS NULL AND n.state NOT IN (?, ?) AND (
      r.revision = (SELECT MAX(latest.revision) FROM mission_node_revision latest
        WHERE latest.node_id = n.id)
      OR r.revision = (SELECT a.node_revision FROM mission_attempt a
        WHERE a.node_id = n.id AND a.closed_at IS NULL))
    ORDER BY n.id, r.revision DESC`,
    )
    .all(
      missionId,
      NodeState.Completed,
      NodeState.Discarded,
    ) as unknown as RevisionRow[];
}

export function claimRevisionOf(tx: Transaction, nodeId: string): RevisionRow {
  const row = tx.database
    .prepare(
      `SELECT r.* FROM mission_node_revision r
    WHERE r.node_id = ? AND r.revision = COALESCE(
      (SELECT a.node_revision FROM mission_attempt a
       WHERE a.node_id = r.node_id AND a.closed_at IS NULL),
      (SELECT MAX(latest.revision) FROM mission_node_revision latest
       WHERE latest.node_id = r.node_id)
    )`,
    )
    .get(nodeId) as unknown as RevisionRow | undefined;
  assert.ok(row, "A node has a claim revision.");
  return row;
}

export function intentOf(tx: Transaction, nodeId: string): Intent {
  return intentSchema.parse(claimRevisionOf(tx, nodeId).intent);
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
      `SELECT d.dependent_id AS dependent, d.depends_on_id AS depends_on
    FROM mission_dependency d
    JOIN mission_node source ON source.id = d.dependent_id
    JOIN mission_node target ON target.id = d.depends_on_id
    WHERE d.mission_id = ? AND source.retired_at IS NULL AND target.retired_at IS NULL
    ORDER BY d.dependent_id, d.depends_on_id`,
    )
    .all(missionId) as DepEdge[];
}

export function dependencyReaches(
  tx: Transaction,
  missionId: string,
  fromId: string,
  toId: string,
): boolean {
  return (
    tx.database
      .prepare(
        `WITH RECURSIVE reach(id) AS (
      SELECT ?
      UNION
      SELECT d.depends_on_id FROM reach
      JOIN mission_dependency d ON d.dependent_id = reach.id
      JOIN mission_node source ON source.id = d.dependent_id
      JOIN mission_node target ON target.id = d.depends_on_id
      WHERE reach.id != ? AND d.mission_id = ?
        AND source.retired_at IS NULL AND target.retired_at IS NULL
    )
    SELECT id FROM reach WHERE id = ? LIMIT 1`,
      )
      .get(fromId, toId, missionId, toId) !== undefined
  );
}

export function readDependsOnIds(tx: Transaction, nodeId: string): string[] {
  const rows = tx.database
    .prepare(
      "SELECT depends_on_id AS id FROM mission_dependency WHERE dependent_id = ? ORDER BY depends_on_id",
    )
    .all(nodeId) as { id: string }[];
  return rows.map((row) => row.id);
}

export interface EdgeListFilter {
  node_id?: string;
  after?: string;
}

export interface EdgeRow {
  first_id: string;
  second_id: string;
  key: string;
}

export function listEdges(
  tx: Transaction,
  missionId: string,
  filter: EdgeListFilter,
  count: number,
): EdgeRow[] {
  return tx.database
    .prepare(
      `WITH edges AS (
      SELECT d.dependent_id AS first_id, d.depends_on_id AS second_id
      FROM mission_dependency d
      JOIN mission_node source ON source.id = d.dependent_id
      JOIN mission_node target ON target.id = d.depends_on_id
      WHERE d.mission_id = ? AND source.retired_at IS NULL AND target.retired_at IS NULL
    ), keyed AS (
      SELECT *, first_id || '|' || second_id AS key FROM edges
    )
    SELECT * FROM keyed
    WHERE (? IS NULL OR first_id = ? OR second_id = ?)
      AND (? IS NULL OR key < ?)
    ORDER BY key DESC LIMIT ?`,
    )
    .all(
      missionId,
      filter.node_id ?? null,
      filter.node_id ?? null,
      filter.node_id ?? null,
      filter.after ?? null,
      filter.after ?? null,
      count,
    ) as unknown as EdgeRow[];
}

export function hasDependency(
  tx: Transaction,
  nodeId: string,
  dependsOnId: string,
): boolean {
  return (
    tx.database
      .prepare(
        "SELECT dependent_id FROM mission_dependency WHERE dependent_id = ? AND depends_on_id = ?",
      )
      .get(nodeId, dependsOnId) !== undefined
  );
}

export function insertDependency(
  tx: Transaction,
  missionId: string,
  nodeId: string,
  dependsOnId: string,
): void {
  tx.database
    .prepare(
      "INSERT INTO mission_dependency (mission_id, dependent_id, depends_on_id) VALUES (?, ?, ?)",
    )
    .run(missionId, nodeId, dependsOnId);
}

export function deleteDependency(
  tx: Transaction,
  nodeId: string,
  dependsOnId: string,
): void {
  tx.database
    .prepare(
      "DELETE FROM mission_dependency WHERE dependent_id = ? AND depends_on_id = ?",
    )
    .run(nodeId, dependsOnId);
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
          AND (EXISTS (
            SELECT 1 FROM json_each(r.bindings) binding
            WHERE binding.value = ?
          ) OR EXISTS (
            SELECT 1 FROM mission_attempt a
            JOIN mission_node_revision pin ON pin.node_id = a.node_id AND pin.revision = a.node_revision
            JOIN json_each(pin.bindings) binding
            WHERE a.node_id = n.id AND a.closed_at IS NULL AND binding.value = ?
          ))
       ORDER BY n.id ASC`,
    )
    .all(
      NodeState.Completed,
      NodeState.Discarded,
      bindingId,
      bindingId,
    ) as Array<{
    id: string;
  }>;
  return rows.map((row) => row.id);
}

export function openAttemptsOf(
  tx: Transaction,
  ownerIds: readonly string[],
): { node_id: string; attempt: number }[] {
  return tx.database
    .prepare(
      "SELECT node_id, attempt FROM mission_attempt WHERE closed_at IS NULL AND node_id IN (SELECT value FROM json_each(?)) ORDER BY node_id",
    )
    .all(JSON.stringify(ownerIds)) as unknown as {
    node_id: string;
    attempt: number;
  }[];
}
