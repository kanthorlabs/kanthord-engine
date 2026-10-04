import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { identitySchema } from "../kernel/identity.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  MissionErrorCode,
  NODE_IDENTITY_PREFIX,
  NODE_LIST_LIMIT_DEFAULT,
  NodeKind,
  NodeState,
  type MissionBindings,
  type Node,
  type Revision,
} from "./contract.ts";
import { revisionFromRow } from "./revision.ts";
import { blockedContextOf } from "./record-read.ts";
import {
  listNodes,
  listRevisions,
  readCurrentRevision,
  readDependsOnIds,
  readLastTaskSnapshot,
  readMission,
  readNode,
  readRevision,
  type NodeListFilter,
  type NodeRow,
} from "./store.ts";

const CURSOR_ENCODING = "base64url";
const TEXT_ENCODING = "utf8";
const FIRST_ROW = 0;
const EXTRA_ROW = 1;
const MIN_REVISION = 1;

function notFound(code: string): never {
  throw new OperationError(
    HttpStatus.NotFound,
    code,
    "Mission node not found.",
  );
}

export function invalidCursor(): never {
  throw new OperationError(
    HttpStatus.BadRequest,
    MissionErrorCode.CursorInvalid,
    "Cursor is invalid.",
  );
}

export function decode(cursor: string): string {
  const value = Buffer.from(cursor, CURSOR_ENCODING).toString(TEXT_ENCODING);
  if (Buffer.from(value, TEXT_ENCODING).toString(CURSOR_ENCODING) !== cursor)
    invalidCursor();
  return value;
}

export function encode(value: string): string {
  return Buffer.from(value, TEXT_ENCODING).toString(CURSOR_ENCODING);
}

export function nodeCursor(cursor: string): string {
  const value = decode(cursor);
  if (!identitySchema(NODE_IDENTITY_PREFIX).safeParse(value).success)
    invalidCursor();
  return value;
}

export function revisionCursor(cursor: string): number {
  const value = decode(cursor);
  const revision = Number(value);
  if (
    !Number.isSafeInteger(revision) ||
    revision < MIN_REVISION ||
    String(revision) !== value
  )
    invalidCursor();
  return revision;
}

export function requireNode(tx: Transaction, nodeId: string): NodeRow {
  const node = readNode(tx, nodeId);
  if (!node) notFound(MissionErrorCode.NodeNotFound);
  return node;
}

function ownerId(node: NodeRow): string {
  if (node.kind !== NodeKind.Task) return node.id;
  assert.ok(node.parent_id, "Task must have an objective parent.");
  return node.parent_id;
}

export function nodeRecord(
  tx: Transaction,
  node: NodeRow,
  bindings: MissionBindings,
): Node {
  const owner = ownerId(node);
  const current = readCurrentRevision(tx, owner);
  assert.ok(current, "Content owner must have a revision.");
  const revision = revisionFromRow(tx, current);
  const base = {
    id: node.id,
    filename: node.filename,
    missionId: node.mission_id,
    parentId: node.parent_id,
    visibleRevision: revision.revision,
    retiredAt: node.retired_at,
    pinnedByAttempts: revision.pinnedByAttempts,
  };
  if (node.kind !== NodeKind.Task) {
    assert.ok(node.state, "Runnable node must have a state.");
    return {
      ...base,
      kind: node.kind,
      content: revision.content,
      state: node.state,
      attempt: node.attempt ?? 0,
      priority: node.priority ?? 0,
      dependsOn: readDependsOnIds(tx, node.id),
      ...(node.state === NodeState.Blocked
        ? { blockedContext: blockedContextOf(tx, bindings, node) }
        : {}),
    };
  }
  const snapshot = revision.tasks?.find((task) => task.id === node.id);
  const historical =
    snapshot === undefined && node.retired_at !== null
      ? readLastTaskSnapshot(tx, owner, node.id)
      : null;
  const task =
    snapshot ??
    (historical === null
      ? undefined
      : revisionFromRow(tx, historical).tasks?.find(
          (item) => item.id === node.id,
        ));
  assert.ok(task, "Task content must exist in current or retired snapshot.");
  return { ...base, kind: NodeKind.Task, content: task.content };
}

export function getNode(
  tx: Transaction,
  nodeId: string,
  bindings: MissionBindings,
): Node {
  return nodeRecord(tx, requireNode(tx, nodeId), bindings);
}

export function getRevision(
  tx: Transaction,
  nodeId: string,
  revision: number,
): Revision {
  const row = readRevision(tx, ownerId(requireNode(tx, nodeId)), revision);
  if (!row) notFound(MissionErrorCode.NodeNotFound);
  return revisionFromRow(tx, row);
}

export function nodePage(
  tx: Transaction,
  bindings: MissionBindings,
  missionId: string,
  filter: NodeListFilter,
  limit = NODE_LIST_LIMIT_DEFAULT,
) {
  if (!readMission(tx, missionId)) notFound(MissionErrorCode.MissionNotFound);
  const rows = listNodes(tx, missionId, filter, limit + EXTRA_ROW);
  const items = rows
    .slice(FIRST_ROW, limit)
    .map((row) => nodeRecord(tx, row, bindings));
  return {
    items,
    nextCursor: rows.length > limit ? encode(items.at(-1)!.id) : null,
  };
}

export function revisionPage(
  tx: Transaction,
  nodeId: string,
  after?: number,
  limit = NODE_LIST_LIMIT_DEFAULT,
  upperBound?: number,
) {
  const rows = listRevisions(
    tx,
    ownerId(requireNode(tx, nodeId)),
    after,
    limit + EXTRA_ROW,
    upperBound,
  );
  const items = rows
    .slice(FIRST_ROW, limit)
    .map((row) => revisionFromRow(tx, row));
  return {
    items,
    nextCursor:
      rows.length > limit ? encode(String(items.at(-1)!.revision)) : null,
  };
}
