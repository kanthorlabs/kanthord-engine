import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { isObject } from "../kernel/values.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  EdgeKind,
  MissionErrorCode,
  NODE_IDENTITY_PREFIX,
  NodeKind,
  type Edge,
  type HumanActor,
  type ImportApply,
  type ImportPreview,
  type ImportResult,
  type Mission,
  type MissionBindings,
  type WorkQueue,
} from "./contract.ts";
import {
  prepareImport,
  type ResolvedImport,
  type ResolvedImportEntry,
} from "./import.ts";
import { importRevisions } from "./import-revisions.ts";
import { claimableMap, reconcileMission, routeMission } from "./routing.ts";
import { openAttemptsOf } from "./store.ts";
import {
  incrementMissionVersion,
  insertDependency,
  insertNode,
  insertRevision,
} from "./store.ts";
import { requireMission } from "./write.ts";

const ZERO = 0;
const ONE = 1;
const FIRST_VIOLATION = 0;
const TEMPORARY_FILENAME_PREFIX = "import:";
const INSERT_ORDER = [NodeKind.Initiative, NodeKind.Objective, NodeKind.Task];
const CONFLICT_CODES: ReadonlySet<string> = new Set([
  MissionErrorCode.ConditionFailed,
  MissionErrorCode.TerminalChange,
]);

function confirmImport(preview: ImportPreview, body: ImportApply): void {
  const violation = preview.violations[FIRST_VIOLATION];
  if (violation !== undefined)
    throw new OperationError(
      CONFLICT_CODES.has(violation.code)
        ? HttpStatus.Conflict
        : HttpStatus.BadRequest,
      violation.code,
      violation.message,
      {
        ...(isObject(violation.details) ? violation.details : {}),
        filename: violation.filename,
        nodeId: violation.nodeId,
      },
    );
  const confirmed = new Set(body.confirmedRetirements);
  if (
    preview.previewDigest !== body.previewDigest ||
    confirmed.size !== preview.retirements.length ||
    preview.retirements.some((id) => !confirmed.has(id))
  )
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.RetirementMismatch,
      "Import preview or confirmed retirements changed.",
    );
  assert.equal(preview.violations.length, ZERO);
  assert.equal(preview.expectedMissionVersion, body.missionVersion);
}

function assignIdentities(resolved: ResolvedImport): ResolvedImportEntry[] {
  const ids = new Map(
    resolved.resolvedEntries.map((item) => [
      item.key,
      item.current?.id ?? createIdentity(NODE_IDENTITY_PREFIX),
    ]),
  );
  assert.equal(ids.size, resolved.resolvedEntries.length);
  const identity = (key: string): string => {
    const id = ids.get(key);
    assert.ok(id, "Resolved references belong to the imported set.");
    assert.ok(id.startsWith(`${NODE_IDENTITY_PREFIX}_`));
    return id;
  };
  const entries = resolved.resolvedEntries.map((item) => ({
    ...item,
    key: identity(item.key),
    parentId: item.parentId === null ? null : identity(item.parentId),
    dependsOn: new Set([...item.dependsOn].map(identity)),
  }));
  assert.equal(new Set(entries.map((item) => item.key)).size, entries.length);
  return entries;
}

function addedEdges(
  resolved: ResolvedImport,
  entries: ResolvedImportEntry[],
): Edge[] {
  const containment: Extract<Edge, { kind: typeof EdgeKind.Containment }>[] =
    [];
  const dependencies: Extract<Edge, { kind: typeof EdgeKind.Dependency }>[] =
    [];
  const previous = new Map<string, Set<string>>();
  for (const edge of resolved.currentDependencies) {
    const targets = previous.get(edge.dependent) ?? new Set<string>();
    targets.add(edge.dependsOn);
    previous.set(edge.dependent, targets);
  }
  for (const item of entries) {
    if (item.parentId !== null && item.current?.parent_id !== item.parentId)
      containment.push({
        kind: EdgeKind.Containment,
        parentId: item.parentId,
        childId: item.key,
      });
    for (const target of item.dependsOn) {
      if (!previous.get(item.key)?.has(target))
        dependencies.push({
          kind: EdgeKind.Dependency,
          dependentId: item.key,
          dependsOnId: target,
        });
    }
  }
  assert.equal(entries.length, resolved.resolvedEntries.length);
  assert.equal(resolved.violations.length, ZERO);
  containment.sort(
    (a, b) =>
      a.parentId.localeCompare(b.parentId) ||
      a.childId.localeCompare(b.childId),
  );
  dependencies.sort(
    (a, b) =>
      a.dependentId.localeCompare(b.dependentId) ||
      a.dependsOnId.localeCompare(b.dependsOnId),
  );
  return [...containment, ...dependencies];
}

function updateRows(
  tx: Transaction,
  resolved: ResolvedImport,
  entries: ResolvedImportEntry[],
  now: number,
): void {
  assert.equal(resolved.violations.length, ZERO);
  assert.equal(entries.length, resolved.resolvedEntries.length);
  for (const id of resolved.retirements) {
    const result = tx.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(now, id);
    assert.equal(result.changes, ONE);
  }
  const updates = new Set(resolved.updates);
  const changed = entries.filter((item) => updates.has(item.key));
  for (const item of changed) {
    if (item.current!.filename !== item.entry.filename)
      tx.database
        .prepare("UPDATE mission_node SET filename = ? WHERE id = ?")
        .run(`${TEMPORARY_FILENAME_PREFIX}${item.key}`, item.key);
  }
  for (const item of changed) {
    const result = tx.database
      .prepare(
        "UPDATE mission_node SET filename = ?, parent_id = ? WHERE id = ?",
      )
      .run(item.entry.filename, item.parentId, item.key);
    assert.equal(result.changes, ONE);
  }
}

function writeDependencies(
  tx: Transaction,
  missionId: string,
  resolved: ResolvedImport,
  entries: ResolvedImportEntry[],
): void {
  assert.equal(resolved.violations.length, ZERO);
  assert.ok(entries.length <= resolved.resolvedEntries.length);
  const previous = new Map<string, Set<string>>();
  for (const edge of resolved.currentDependencies) {
    const targets = previous.get(edge.dependent) ?? new Set<string>();
    targets.add(edge.dependsOn);
    previous.set(edge.dependent, targets);
  }
  for (const item of entries) {
    const old = previous.get(item.key) ?? new Set<string>();
    if (
      old.size === item.dependsOn.size &&
      [...old].every((id) => item.dependsOn.has(id))
    )
      continue;
    tx.database
      .prepare("DELETE FROM mission_dependency WHERE dependent_id = ?")
      .run(item.key);
    for (const target of item.dependsOn)
      insertDependency(tx, missionId, item.key, target);
  }
}

function writeNodes(
  tx: Transaction,
  missionId: string,
  resolved: ResolvedImport,
  entries: ResolvedImportEntry[],
  now: number,
): void {
  assert.equal(resolved.violations.length, ZERO);
  assert.equal(entries.length, resolved.resolvedEntries.length);
  tx.database.exec("PRAGMA defer_foreign_keys = ON");
  updateRows(tx, resolved, entries, now);
  writeDependencies(
    tx,
    missionId,
    resolved,
    entries.filter((item) => item.current !== null),
  );
  const creates = entries.filter((item) => item.current === null);
  for (const kind of INSERT_ORDER) {
    for (const item of creates.filter((item) => item.entry.kind === kind))
      insertNode(tx, {
        id: item.key,
        mission_id: missionId,
        kind,
        filename: item.entry.filename,
        parent_id: item.parentId,
        created_at: now,
      });
  }
  writeDependencies(tx, missionId, resolved, creates);
}

function initialResult(
  mission: Mission,
  entries: ResolvedImportEntry[],
  actor: HumanActor,
  acceptedAt: number,
): ImportResult {
  assert.ok(mission.version > ZERO);
  assert.equal(new Set(entries.map((item) => item.key)).size, entries.length);
  return {
    missionId: mission.id,
    missionVersion: mission.version,
    assignedIds: entries
      .map((item) => ({ filename: item.entry.filename, nodeId: item.key }))
      .sort((a, b) => a.filename.localeCompare(b.filename)),
    changes: {
      missionVersion: mission.version,
      revisions: [],
      retiredNodeIds: [],
      addedEdges: [],
      removedEdges: [],
      openAttemptsUnchanged: [],
    },
    actor,
    acceptedAt,
  };
}

export function applyImport(
  tx: Transaction,
  missionId: string,
  body: ImportApply,
  actor: HumanActor,
  bindings: MissionBindings,
  workQueue: WorkQueue,
  textMaxBytes: number,
): ImportResult {
  const mission = requireMission(tx, missionId, body.missionVersion);
  const { preview, resolved } = prepareImport(
    tx,
    mission,
    body,
    missionId,
    bindings,
    textMaxBytes,
  );
  confirmImport(preview, body);
  assert.ok(resolved, "A valid import has a resolved graph.");
  const entries = assignIdentities(resolved);
  const acceptedAt = Date.now();
  const result = initialResult(mission, entries, actor, acceptedAt);
  if (
    resolved.creates.length +
      resolved.updates.length +
      resolved.retirements.length ===
    ZERO
  )
    return result;
  const before = claimableMap(tx, missionId, bindings);
  const revisions = importRevisions(
    tx,
    resolved,
    entries,
    actor,
    body.reason,
    acceptedAt,
  );
  writeNodes(tx, missionId, resolved, entries, acceptedAt);
  for (const revision of revisions) insertRevision(tx, revision);
  routeMission(tx, missionId);
  reconcileMission(
    tx,
    workQueue,
    missionId,
    mission.projectId,
    before,
    bindings,
  );
  const missionVersion = incrementMissionVersion(tx, missionId);
  assert.equal(missionVersion, mission.version + ONE);
  return {
    ...result,
    missionVersion,
    changes: {
      ...result.changes,
      missionVersion,
      revisions,
      openAttemptsUnchanged: openAttemptsOf(
        tx,
        revisions.map((revision) => revision.nodeId),
      ),
      retiredNodeIds: resolved.retirements,
      addedEdges: addedEdges(resolved, entries),
      removedEdges: resolved.removedEdges,
    },
  };
}
