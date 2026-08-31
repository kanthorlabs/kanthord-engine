import { workerKinds } from "../../domain/worker.ts";
import { triggerTransition } from "../../domain/node-trigger.ts";
import { canTransition } from "../../domain/transition.ts";
import type { NodeKind, NodeState } from "../../domain/state.ts";
import type { Transaction } from "../storage/index.ts";
import type { Readiness } from "../readiness/index.ts";
import type { ReadinessTransition } from "../../domain/readiness.ts";
import type { RevisionOrigin } from "../../domain/plan-revision.ts";
import { executionBlockers } from "../../domain/plan-graph.ts";
import type {
  ContainmentFacts,
  StoredEdge,
  StoredNode,
  SubtreeExecutionFact,
  ValidationContext,
} from "../../domain/plan-graph.ts";
import type {
  EdgeWrite,
  MutateGraphInput,
  NodeWrite,
  PlanStore,
  RevisionRecord,
  SetNodeStateInput,
} from "./index.ts";

const NODE_COLUMNS =
  "id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at, deliverable, verify_json";

const SELECT_NODE = "SELECT " + NODE_COLUMNS + " FROM node";

const SELECT_REVISION =
  "SELECT id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob FROM plan_revision";

const UPDATE_NODE_STATE =
  "UPDATE node SET state = ?, block_reason = NULL, updated_at = ? WHERE id = ? AND state = ?";

const UPDATE_NODE_STATE_AND_REASON =
  "UPDATE node SET state = ?, block_reason = ?, updated_at = ? WHERE id = ? AND state = ?";

const DELETE_NODE = "DELETE FROM node WHERE id = ?";

const INSERT_NODE =
  "INSERT INTO node (" +
  NODE_COLUMNS +
  ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, parent_id = excluded.parent_id, title = excluded.title, instruction_blob = excluded.instruction_blob, acceptance_blob = excluded.acceptance_blob, worker = excluded.worker, repository_id = excluded.repository_id, revision = excluded.revision, updated_at = excluded.updated_at, deliverable = COALESCE(excluded.deliverable, deliverable), verify_json = COALESCE(excluded.verify_json, verify_json)";

type NodeRow = Readonly<{
  id: string;
  project_id: string;
  kind: NodeKind;
  parent_id: string | null;
  title: string;
  instruction_blob: string;
  acceptance_blob: string | null;
  worker: string | null;
  repository_id: string | null;
  state: NodeState;
  block_reason: string | null;
  discard_reason: string | null;
  revision: string;
  updated_at: number;
  deliverable: string | null;
  verify_json: string | null;
}>;

type EdgeRow = Readonly<{
  id: string;
  from_node: string;
  to_node: string;
  waived_at: number | null;
}>;

type RevisionRow = Readonly<{
  id: string;
  parent_id: string | null;
  origin: RevisionOrigin;
  import_id: string | null;
  submitted_blob: string | null;
  choices_blob: string | null;
  accepted_blob: string;
}>;

const toNode = (row: NodeRow, dependencies: readonly string[]): StoredNode => ({
  id: row.id,
  projectId: row.project_id,
  kind: row.kind,
  parentId: row.parent_id,
  title: row.title,
  instructionBlob: row.instruction_blob,
  acceptanceBlob: row.acceptance_blob,
  worker: row.worker,
  repositoryId: row.repository_id,
  state: row.state,
  blockReason: row.block_reason,
  discardReason: row.discard_reason,
  revision: row.revision,
  updatedAt: row.updated_at,
  deliverable: row.deliverable,
  verifyJson: row.verify_json,
  dependencies,
});

const toEdge = (row: EdgeRow): StoredEdge => ({
  id: row.id,
  fromNode: row.from_node,
  toNode: row.to_node,
  waivedAt: row.waived_at,
});

const dependencyMap = (
  edges: readonly EdgeRow[],
): ReadonlyMap<string, readonly string[]> => {
  const byNode = new Map<string, string[]>();
  for (const edge of edges) {
    const list = byNode.get(edge.from_node) ?? [];
    if (!list.includes(edge.to_node)) {
      list.push(edge.to_node);
    }
    byNode.set(edge.from_node, list);
  }
  for (const list of byNode.values()) {
    list.sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );
  }
  return byNode;
};

const buildNodes = (
  nodeRows: readonly NodeRow[],
  edgeRows: readonly EdgeRow[],
): readonly StoredNode[] => {
  const dependencies = dependencyMap(edgeRows);
  return nodeRows.map((row) => toNode(row, dependencies.get(row.id) ?? []));
};

export type SqlitePlanStoreDependencies = Readonly<{ readiness: Readiness }>;

export class SqlitePlanStore implements PlanStore {
  private readonly dependencies: SqlitePlanStoreDependencies;

  constructor(dependencies: SqlitePlanStoreDependencies) {
    this.dependencies = dependencies;
  }

  readGraph(
    transaction: Transaction,
    projectId: string,
  ): Readonly<{ nodes: readonly StoredNode[]; edges: readonly StoredEdge[] }> {
    const nodeRows = transaction.all(
      SELECT_NODE + " WHERE project_id = ? ORDER BY id ASC",
      [projectId],
    ) as readonly NodeRow[];
    const edgeRows = transaction.all(
      "SELECT e.id, e.from_node, e.to_node, e.waived_at FROM edge e JOIN node n ON n.id = e.from_node WHERE n.project_id = ? ORDER BY e.from_node ASC, e.to_node ASC",
      [projectId],
    ) as readonly EdgeRow[];
    return {
      nodes: buildNodes(nodeRows, edgeRows),
      edges: edgeRows.map(toEdge),
    };
  }

  readNode(transaction: Transaction, id: string): StoredNode | null {
    const row = transaction.get(SELECT_NODE + " WHERE id = ?", [id]) as
      NodeRow | undefined;
    if (row === undefined) {
      return null;
    }
    const edgeRows = transaction.all(
      "SELECT to_node FROM edge WHERE from_node = ? ORDER BY to_node ASC",
      [id],
    ) as readonly Readonly<{ to_node: string }>[];
    const dependencies: string[] = [];
    for (const edge of edgeRows) {
      if (!dependencies.includes(edge.to_node)) {
        dependencies.push(edge.to_node);
      }
    }
    return toNode(row, dependencies);
  }

  readAllNodes(transaction: Transaction): readonly StoredNode[] {
    const nodeRows = transaction.all(
      SELECT_NODE + " ORDER BY id ASC",
    ) as readonly NodeRow[];
    const edgeRows = transaction.all(
      "SELECT id, from_node, to_node, waived_at FROM edge ORDER BY from_node ASC, to_node ASC",
    ) as readonly EdgeRow[];
    return buildNodes(nodeRows, edgeRows);
  }

  newestRevision(transaction: Transaction, projectId: string): string | null {
    const row = transaction.get(
      "SELECT id FROM plan_revision WHERE project_id = ? ORDER BY id DESC LIMIT 1",
      [projectId],
    ) as Readonly<{ id: string }> | undefined;
    return row === undefined ? null : row.id;
  }

  listRevisions(
    transaction: Transaction,
    projectId: string,
  ): readonly RevisionRecord[] {
    const rows = transaction.all(
      SELECT_REVISION + " WHERE project_id = ? ORDER BY id DESC",
      [projectId],
    ) as readonly RevisionRow[];
    return rows.map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      origin: row.origin,
      importId: row.import_id,
      submittedBlob: row.submitted_blob,
      choicesBlob: row.choices_blob,
      acceptedBlob: row.accepted_blob,
    }));
  }

  findByImportId(
    transaction: Transaction,
    projectId: string,
    importId: string,
  ): RevisionRecord | null {
    const row = transaction.get(
      SELECT_REVISION + " WHERE project_id = ? AND import_id = ?",
      [projectId, importId],
    ) as RevisionRow | undefined;
    if (row === undefined) {
      return null;
    }
    return {
      id: row.id,
      parentId: row.parent_id,
      origin: row.origin,
      importId: row.import_id,
      submittedBlob: row.submitted_blob,
      choicesBlob: row.choices_blob,
      acceptedBlob: row.accepted_blob,
    };
  }

  readValidationContext(
    transaction: Transaction,
    projectId: string,
  ): ValidationContext {
    const boundRows = transaction.all(
      "SELECT r.name AS name FROM project_binding b JOIN repository r ON r.id = b.target_id WHERE b.project_id = ? AND b.kind = 'git' ORDER BY r.name ASC",
      [projectId],
    ) as readonly Readonly<{ name: string }>[];
    const knownRows = transaction.all(
      "SELECT name FROM repository ORDER BY name ASC",
    ) as readonly Readonly<{ name: string }>[];
    return {
      workerKinds: [...workerKinds],
      boundRepositories: boundRows.map((row) => row.name),
      knownRepositories: knownRows.map((row) => row.name),
    };
  }

  readRepositoryName(
    transaction: Transaction,
    repositoryId: string,
  ): string | null {
    const row = transaction.get("SELECT name FROM repository WHERE id = ?", [
      repositoryId,
    ]) as Readonly<{ name: string }> | undefined;
    return row === undefined ? null : row.name;
  }

  readContainmentFacts(
    transaction: Transaction,
    nodeId: string,
  ): ContainmentFacts {
    return {
      lease: this.leaseHeld(transaction, [nodeId]),
      workspace: this.anyRow(
        transaction,
        "SELECT 1 FROM workspace WHERE node_id = ? LIMIT 1",
        [nodeId],
      ),
      attemptCommit: this.anyRow(
        transaction,
        "SELECT 1 FROM attempt a JOIN run r ON r.id = a.run_id WHERE r.node_id = ? AND a.head_oid IS NOT NULL LIMIT 1",
        [nodeId],
      ),
      retainedCommit: this.anyRow(
        transaction,
        "SELECT 1 FROM candidate WHERE node_id = ? LIMIT 1",
        [nodeId],
      ),
    };
  }

  readSubtreeContainmentFacts(
    transaction: Transaction,
    nodeId: string,
  ): ContainmentFacts {
    const rows = transaction.all(
      "WITH RECURSIVE descendant(id) AS (SELECT ? UNION ALL SELECT n.id FROM node n JOIN descendant d ON n.parent_id = d.id) SELECT id FROM descendant ORDER BY id ASC",
      [nodeId],
    ) as readonly Readonly<{ id: string }>[];
    const ids = rows.map((row) => row.id);
    const inClause = "IN (" + ids.map(() => "?").join(", ") + ")";
    return {
      lease: this.leaseHeld(transaction, ids),
      workspace: this.anyRow(
        transaction,
        "SELECT 1 FROM workspace WHERE node_id " + inClause + " LIMIT 1",
        ids,
      ),
      attemptCommit: this.anyRow(
        transaction,
        "SELECT 1 FROM attempt a JOIN run r ON r.id = a.run_id WHERE r.node_id " +
          inClause +
          " AND a.head_oid IS NOT NULL LIMIT 1",
        ids,
      ),
      retainedCommit: this.anyRow(
        transaction,
        "SELECT 1 FROM candidate WHERE node_id " + inClause + " LIMIT 1",
        ids,
      ),
    };
  }

  readSubtree(transaction: Transaction, nodeId: string): readonly string[] {
    const rows = transaction.all(
      "WITH RECURSIVE descendant(id, depth) AS (SELECT ?, 0 UNION ALL SELECT n.id, d.depth + 1 FROM node n JOIN descendant d ON n.parent_id = d.id) SELECT id FROM descendant ORDER BY depth DESC, id ASC",
      [nodeId],
    ) as readonly Readonly<{ id: string }>[];
    return rows.map((row) => row.id);
  }

  readSubtreeExecutionFacts(
    transaction: Transaction,
    nodeId: string,
  ): readonly SubtreeExecutionFact[] {
    const rows = transaction.all(
      "WITH RECURSIVE descendant(id) AS (SELECT ? UNION ALL SELECT n.id FROM node n JOIN descendant d ON n.parent_id = d.id) SELECT id FROM descendant",
      [nodeId],
    ) as readonly Readonly<{ id: string }>[];
    const ids = rows.map((row) => row.id);
    const inClause = "IN (" + ids.map(() => "?").join(", ") + ")";
    const queries: readonly Readonly<{
      blocker: SubtreeExecutionFact["blocker"];
      sql: string;
    }>[] = [
      {
        blocker: "lease",
        sql:
          "SELECT subject_id AS node_id FROM lease WHERE subject_kind = 'node' AND subject_id " +
          inClause,
      },
      {
        blocker: "workspace",
        sql: "SELECT node_id FROM workspace WHERE node_id " + inClause,
      },
      {
        blocker: "run",
        sql: "SELECT node_id FROM run WHERE node_id " + inClause,
      },
      {
        blocker: "attempt",
        sql:
          "SELECT r.node_id AS node_id FROM attempt a JOIN run r ON r.id = a.run_id WHERE r.node_id " +
          inClause,
      },
      {
        blocker: "commit",
        sql: "SELECT node_id FROM candidate WHERE node_id " + inClause,
      },
      {
        blocker: "check-result",
        sql: "SELECT node_id FROM check_result WHERE node_id " + inClause,
      },
      {
        blocker: "git-operation",
        sql: "SELECT node_id FROM git_operation WHERE node_id " + inClause,
      },
    ];
    const facts: SubtreeExecutionFact[] = [];
    const seen = new Set<string>();
    for (const { blocker, sql } of queries) {
      const found = transaction.all(sql, ids) as readonly Readonly<{
        node_id: string;
      }>[];
      for (const row of found) {
        const key = row.node_id + "\u0000" + blocker;
        if (seen.has(key)) continue;
        seen.add(key);
        facts.push({ nodeId: row.node_id, blocker });
      }
    }
    facts.sort((left, right) => {
      const byNode = Buffer.compare(
        Buffer.from(left.nodeId, "utf8"),
        Buffer.from(right.nodeId, "utf8"),
      );
      if (byNode !== 0) return byNode;
      return (
        executionBlockers.indexOf(left.blocker) -
        executionBlockers.indexOf(right.blocker)
      );
    });
    return facts;
  }

  insertRevision(
    transaction: Transaction,
    record: RevisionRecord & Readonly<{ projectId: string }>,
  ): void {
    transaction.run(
      "INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        record.id,
        record.projectId,
        record.parentId,
        record.origin,
        record.importId,
        record.submittedBlob,
        record.choicesBlob,
        record.acceptedBlob,
      ],
    );
  }

  private insertNode(
    transaction: Transaction,
    node: NodeWrite & Partial<Pick<StoredNode, "deliverable" | "verifyJson">>,
  ): void {
    transaction.run(INSERT_NODE, [
      node.id,
      node.projectId,
      node.kind,
      node.parentId,
      node.title,
      node.instructionBlob,
      node.acceptanceBlob,
      node.worker,
      node.repositoryId,
      node.revision,
      node.updatedAt,
      node.deliverable ?? null,
      node.verifyJson ?? null,
    ]);
  }

  private addEdge(transaction: Transaction, edge: EdgeWrite): void {
    transaction.run(
      "INSERT INTO edge (id, from_node, to_node, waived_at) VALUES (?, ?, ?, NULL)",
      [edge.id, edge.fromNode, edge.toNode],
    );
  }

  private removeEdge(transaction: Transaction, id: string): void {
    transaction.run("DELETE FROM edge WHERE id = ?", [id]);
  }

  mutateGraph(
    transaction: Transaction,
    input: MutateGraphInput,
  ): readonly ReadinessTransition[] {
    for (const node of input.nodes) {
      this.insertNode(transaction, node);
    }
    for (const id of input.deleteEdgeIds) {
      this.removeEdge(transaction, id);
    }
    for (const id of input.nodeDeletes) {
      transaction.run(DELETE_NODE, [id]);
    }
    for (const edge of input.insertEdges) {
      this.addEdge(transaction, edge);
    }
    const graph = this.readGraph(transaction, input.projectId);
    const transitions = this.dependencies.readiness.apply(transaction, {
      projectId: input.projectId,
      nodes: graph.nodes.map(({ id, state }) => ({ id, state })),
      edges: graph.edges,
      at: input.at,
      cause: input.cause,
    });
    for (const transition of transitions) {
      transaction.run(UPDATE_NODE_STATE, [
        transition.to,
        input.at,
        transition.nodeId,
        transition.from,
      ]);
    }
    return transitions;
  }

  setNodeState(
    transaction: Transaction,
    input: SetNodeStateInput,
  ): readonly ReadinessTransition[] {
    const before = this.readNode(transaction, input.id);
    if (before === null) {
      return [];
    }
    if (!canTransition(before.kind, input.from, input.to)) {
      throw new Error(
        `${before.kind} ${input.from} -> ${input.to} is not in the transition matrix`,
      );
    }
    const declared = triggerTransition(input.trigger);
    if (declared.from !== input.from || declared.to !== input.to) {
      throw new Error(
        `trigger ${input.trigger} declares ${declared.from} -> ${declared.to}, the write names ${input.from} -> ${input.to}`,
      );
    }
    if (!declared.levels.includes(before.kind)) {
      throw new Error(
        `trigger ${input.trigger} declares levels ${declared.levels.join(",")}, the node is a ${before.kind}`,
      );
    }
    if (before.state !== input.from) {
      return [];
    }
    if (input.blockReason === null) {
      transaction.run(UPDATE_NODE_STATE, [
        input.to,
        input.at,
        input.id,
        input.from,
      ]);
    } else {
      transaction.run(UPDATE_NODE_STATE_AND_REASON, [
        input.to,
        input.blockReason,
        input.at,
        input.id,
        input.from,
      ]);
    }
    const graph = this.readGraph(transaction, before.projectId);
    const transitions = this.dependencies.readiness.apply(transaction, {
      projectId: before.projectId,
      nodes: graph.nodes.map(({ id, state }) => ({ id, state })),
      edges: graph.edges,
      focusNodeId: input.id,
      at: input.at,
      cause: input.cause,
    });
    for (const transition of transitions) {
      transaction.run(UPDATE_NODE_STATE, [
        transition.to,
        input.at,
        transition.nodeId,
        transition.from,
      ]);
    }
    return transitions;
  }

  private leaseHeld(transaction: Transaction, ids: readonly string[]): boolean {
    const inClause = "IN (" + ids.map(() => "?").join(", ") + ")";
    return this.anyRow(
      transaction,
      "SELECT 1 FROM lease WHERE subject_kind = 'node' AND subject_id " +
        inClause +
        " AND owner IS NOT NULL LIMIT 1",
      ids,
    );
  }

  private anyRow(
    transaction: Transaction,
    sql: string,
    parameters: readonly unknown[],
  ): boolean {
    return transaction.get(sql, parameters) !== undefined;
  }
}
