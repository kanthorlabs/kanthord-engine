import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { isObject } from "../kernel/values.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  MissionErrorCode,
  NODE_IDENTITY_PREFIX,
  TASK_IDENTITY_PREFIX,
  type Edge,
  type HumanActor,
  type ImportApply,
  type ImportPreview,
  type ImportResult,
  type Mission,
  type MissionBindings,
  type Revision,
  type Violation,
  type WorkQueue,
  type SchedulerClaims,
} from "./contract.ts";
import { addedPairs, UNMATCHED_MESSAGE } from "./coverage.ts";
import type { Dependencies } from "./service.ts";
import {
  isTaskEntry,
  prepareImport,
  type PreparedImport,
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
import { ControlError } from "./control.ts";
import { requireNoLiveClaim } from "./dependency.ts";

const NO_VIOLATIONS = 0;
const MINIMUM_MISSION_VERSION = 0;
const NO_IMPORT_CHANGES = 0;
const EXPECTED_ROW_CHANGE = 1;
const VERSION_INCREMENT = 1;
const FIRST_VIOLATION = 0;
const TEMPORARY_FILENAME_PREFIX = "import:";
const PROBE_QUEUE: WorkQueue = {
  insert: () => undefined,
  delete: () => undefined,
  priorityUpdate: () => undefined,
};
const CONFLICT_CODES: ReadonlySet<string> = new Set([
  MissionErrorCode.ConditionFailed,
  MissionErrorCode.TerminalChange,
  ControlError.StateConflict,
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
        node_id: violation.node_id,
      },
    );
  const confirmed = new Set(body.confirmed_retirements);
  if (
    preview.preview_digest !== body.preview_digest ||
    confirmed.size !== preview.retirements.length ||
    preview.retirements.some((id) => !confirmed.has(id))
  )
    throw new OperationError(
      HttpStatus.Conflict,
      MissionErrorCode.RetirementMismatch,
      "Import preview or confirmed retirements changed.",
    );
  assert.equal(preview.violations.length, NO_VIOLATIONS);
  assert.equal(preview.expected_mission_version, body.mission_version);
}

function assignIdentities(resolved: ResolvedImport): ResolvedImportEntry[] {
  const ids = new Map(
    resolved.resolved_entries.map((item) => [
      item.key,
      item.current?.id ??
        item.task?.id ??
        createIdentity(
          isTaskEntry(item.entry) ? TASK_IDENTITY_PREFIX : NODE_IDENTITY_PREFIX,
        ),
    ]),
  );
  assert.equal(ids.size, resolved.resolved_entries.length);
  const identity = (key: string): string => {
    const id = ids.get(key);
    assert.ok(id, "Resolved references belong to the imported set.");
    return id;
  };
  const entries = resolved.resolved_entries.map((item) => ({
    ...item,
    key: identity(item.key),
    owner_id: item.owner_id === null ? null : identity(item.owner_id),
    depends_on: new Set([...item.depends_on].map(identity)),
  }));
  assert.equal(new Set(entries.map((item) => item.key)).size, entries.length);
  return entries;
}

function addedEdges(
  resolved: ResolvedImport,
  entries: ResolvedImportEntry[],
): Edge[] {
  const dependencies: Edge[] = [];
  const previous = new Map<string, Set<string>>();
  for (const edge of resolved.current_dependencies) {
    const targets = previous.get(edge.dependent) ?? new Set<string>();
    targets.add(edge.depends_on);
    previous.set(edge.dependent, targets);
  }
  for (const item of entries) {
    for (const target of item.depends_on) {
      if (!previous.get(item.key)?.has(target))
        dependencies.push({
          dependent_id: item.key,
          depends_on_id: target,
        });
    }
  }
  assert.equal(entries.length, resolved.resolved_entries.length);
  assert.equal(resolved.violations.length, NO_VIOLATIONS);
  dependencies.sort(
    (a, b) =>
      a.dependent_id.localeCompare(b.dependent_id) ||
      a.depends_on_id.localeCompare(b.depends_on_id),
  );
  return dependencies;
}

function updateRows(
  tx: Transaction,
  resolved: ResolvedImport,
  entries: ResolvedImportEntry[],
  now: number,
): void {
  assert.equal(resolved.violations.length, NO_VIOLATIONS);
  assert.equal(entries.length, resolved.resolved_entries.length);
  for (const id of resolved.retirements) {
    const result = tx.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(now, id);
    assert.equal(result.changes, EXPECTED_ROW_CHANGE);
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
      .prepare("UPDATE mission_node SET filename = ? WHERE id = ?")
      .run(item.entry.filename, item.key);
    assert.equal(result.changes, EXPECTED_ROW_CHANGE);
  }
}

function writeDependencies(
  tx: Transaction,
  missionId: string,
  resolved: ResolvedImport,
  entries: ResolvedImportEntry[],
): void {
  assert.equal(resolved.violations.length, NO_VIOLATIONS);
  assert.ok(entries.length <= resolved.resolved_entries.length);
  const previous = new Map<string, Set<string>>();
  for (const edge of resolved.current_dependencies) {
    const targets = previous.get(edge.dependent) ?? new Set<string>();
    targets.add(edge.depends_on);
    previous.set(edge.dependent, targets);
  }
  for (const item of entries) {
    const old = previous.get(item.key) ?? new Set<string>();
    if (
      old.size === item.depends_on.size &&
      [...old].every((id) => item.depends_on.has(id))
    )
      continue;
    tx.database
      .prepare("DELETE FROM mission_dependency WHERE dependent_id = ?")
      .run(item.key);
    for (const target of item.depends_on)
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
  assert.equal(resolved.violations.length, NO_VIOLATIONS);
  assert.equal(entries.length, resolved.resolved_entries.length);
  tx.database.exec("PRAGMA defer_foreign_keys = ON");
  updateRows(tx, resolved, entries, now);
  writeDependencies(
    tx,
    missionId,
    resolved,
    entries.filter((item) => item.current !== null),
  );
  const creates = entries.filter(
    (item) => item.current === null && !isTaskEntry(item.entry),
  );
  for (const item of creates)
    insertNode(tx, {
      id: item.key,
      mission_id: missionId,
      filename: item.entry.filename,
      created_at: now,
    });
  writeDependencies(tx, missionId, resolved, creates);
}

function initialResult(
  mission: Mission,
  entries: ResolvedImportEntry[],
  actor: HumanActor,
  acceptedAt: number,
): ImportResult {
  assert.ok(mission.version > MINIMUM_MISSION_VERSION);
  assert.equal(new Set(entries.map((item) => item.key)).size, entries.length);
  return {
    mission_id: mission.id,
    mission_version: mission.version,
    assigned_ids: entries
      .map((item) =>
        isTaskEntry(item.entry)
          ? { filename: item.entry.filename, task_id: item.key }
          : { filename: item.entry.filename, node_id: item.key },
      )
      .sort((a, b) => a.filename.localeCompare(b.filename)),
    changes: {
      mission_version: mission.version,
      revisions: [],
      retired_node_ids: [],
      added_edges: [],
      removed_edges: [],
      open_attempts_unchanged: [],
    },
    actor,
    accepted_at: acceptedAt,
  };
}

function changesMission(resolved: ResolvedImport): boolean {
  return (
    resolved.creates.length +
      resolved.updates.length +
      resolved.retirements.length >
    NO_IMPORT_CHANGES
  );
}

function writeImport(
  tx: Transaction,
  mission: Mission,
  resolved: ResolvedImport,
  entries: ResolvedImportEntry[],
  actor: HumanActor,
  reason: string,
  acceptedAt: number,
  bindings: MissionBindings,
  workQueue: WorkQueue,
): Revision[] {
  const before = claimableMap(tx, mission.id, bindings);
  const revisions = importRevisions(
    tx,
    resolved,
    entries,
    actor,
    reason,
    acceptedAt,
  );
  writeNodes(tx, mission.id, resolved, entries, acceptedAt);
  for (const revision of revisions) insertRevision(tx, revision);
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
  assert.equal(missionVersion, mission.version + VERSION_INCREMENT);
  return revisions;
}

export function probeCoverage(
  tx: Transaction,
  mission: Mission,
  { preview, resolved }: PreparedImport,
  reason: string,
  actor: HumanActor,
  dependencies: Pick<Dependencies, "bindings" | "schedulerMatch">,
): Violation[] {
  assert.equal(preview.violations.length, NO_VIOLATIONS);
  assert.ok(resolved, "A valid import has a resolved graph.");
  if (!changesMission(resolved)) return [];
  const entries = assignIdentities(resolved);
  const added = addedPairs(tx, dependencies, mission.project_id, () =>
    writeImport(
      tx,
      mission,
      resolved,
      entries,
      actor,
      reason,
      Date.now(),
      dependencies.bindings,
      PROBE_QUEUE,
    ),
  );
  return entries.flatMap((item): Violation[] => {
    const claims = added.filter(({ node_id }) => node_id === item.key);
    if (claims.length === NO_VIOLATIONS) return [];
    const nodeId = item.current?.id ?? null;
    return [
      {
        code: MissionErrorCode.TagsUnmatched,
        message: UNMATCHED_MESSAGE,
        filename: item.entry.filename,
        node_id: nodeId,
        details: {
          claims: claims.map(({ revision, claim }) => ({
            node_id: nodeId,
            revision,
            claim,
          })),
        },
      },
    ];
  });
}

export function applyImport(
  tx: Transaction,
  missionId: string,
  body: ImportApply,
  actor: HumanActor,
  bindings: MissionBindings,
  workQueue: WorkQueue,
  textMaxBytes: number,
  schedulerClaims: SchedulerClaims,
): ImportResult {
  const mission = requireMission(tx, missionId, body.mission_version);
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
  for (const item of entries) {
    if (item.current === null) continue;
    const previous = new Set(
      resolved.current_dependencies
        .filter((edge) => edge.dependent === item.key)
        .map((edge) => edge.depends_on),
    );
    if ([...item.depends_on].some((target) => !previous.has(target)))
      requireNoLiveClaim(tx, item.current.id, schedulerClaims, acceptedAt);
  }
  const result = initialResult(mission, entries, actor, acceptedAt);
  if (!changesMission(resolved)) return result;
  const revisions = writeImport(
    tx,
    mission,
    resolved,
    entries,
    actor,
    body.reason,
    acceptedAt,
    bindings,
    workQueue,
  );
  const missionVersion = mission.version + VERSION_INCREMENT;
  return {
    ...result,
    mission_version: missionVersion,
    changes: {
      ...result.changes,
      mission_version: missionVersion,
      revisions,
      open_attempts_unchanged: openAttemptsOf(
        tx,
        revisions.map((revision) => revision.node_id),
      ),
      retired_node_ids: resolved.retirements,
      added_edges: addedEdges(resolved, entries),
      removed_edges: resolved.removed_edges,
    },
  };
}
