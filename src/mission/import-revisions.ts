import assert from "node:assert/strict";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import { CONTENT_FIELDS, ContentField, TASKS_FIELD } from "./content.ts";
import {
  NodeKind,
  RevisionWrite,
  TaskChange,
  type HumanActor,
  type Revision,
  type RevisionChange,
  type TaskContent,
} from "./contract.ts";
import type { ResolvedImport, ResolvedImportEntry } from "./import.ts";
import { revisionFromRow } from "./revision.ts";
import { readCurrentRevision } from "./store.ts";

const EMPTY_LENGTH = 0;
const NO_CHANGED_FIELDS = 0;
const NO_VIOLATIONS = 0;
const FIRST_REVISION = 1;
const REVISION_INCREMENT = 1;
type TaskChanges = NonNullable<RevisionChange["tasks"]>;

export function importContent(item: ResolvedImportEntry): TaskContent {
  const { entry } = item;
  assert.ok(
    item.key.length > EMPTY_LENGTH,
    "Resolved content has an identity.",
  );
  assert.equal(item.binding_ids.length, entry.bindings.length);
  return {
    id: item.key,
    filename: entry.filename,
    content: {
      name: entry.name,
      requirement: entry.requirement,
      criterion: entry.criterion,
      verifications: entry.verifications,
      bindings: item.binding_ids,
    },
  };
}

function changedFields(
  next: Pick<TaskContent, "filename" | "content">,
  previous: Pick<TaskContent, "filename" | "content"> | undefined,
): string[] {
  assert.ok(next.filename.length > EMPTY_LENGTH);
  assert.ok(next.content.verifications.length > EMPTY_LENGTH);
  if (previous === undefined) return [...CONTENT_FIELDS];
  return CONTENT_FIELDS.filter((field) =>
    field === ContentField.Filename
      ? next.filename !== previous.filename
      : canonicalJSON(next.content[field]) !==
        canonicalJSON(previous.content[field]),
  );
}

function taskList(
  ownerId: string,
  previous: TaskContent[],
  entries: ResolvedImportEntry[],
): { tasks: TaskContent[]; changes: TaskChanges } {
  const incoming = entries.filter(
    (item) => item.entry.kind === NodeKind.Task && item.parent_id === ownerId,
  );
  const kept = new Map(incoming.map((item) => [item.key, item]));
  const present = new Set(entries.map((item) => item.key));
  const tasks: TaskContent[] = [];
  const changes: TaskChanges = [];
  for (const task of previous) {
    const item = kept.get(task.id);
    if (item === undefined) {
      changes.push({
        id: task.id,
        change: present.has(task.id) ? TaskChange.MovedOut : TaskChange.Retired,
        changed_fields: [],
      });
      continue;
    }
    const next = importContent(item);
    tasks.push(next);
    const fields = changedFields(next, task);
    if (fields.length > NO_CHANGED_FIELDS)
      changes.push({
        id: task.id,
        change: TaskChange.Updated,
        changed_fields: fields,
      });
    kept.delete(task.id);
  }
  for (const item of kept.values()) {
    tasks.push(importContent(item));
    changes.push({
      id: item.key,
      change: item.current === null ? TaskChange.Created : TaskChange.MovedIn,
      changed_fields: [...CONTENT_FIELDS],
    });
  }
  assert.equal(
    tasks.length,
    incoming.length,
    "Every incoming task is stored once.",
  );
  assert.equal(new Set(tasks.map((task) => task.id)).size, tasks.length);
  return { tasks, changes };
}

function ownerRevision(
  ownerId: string,
  kind: NodeKind,
  previous: Revision | undefined,
  item: ResolvedImportEntry | undefined,
  entries: ResolvedImportEntry[],
  actor: HumanActor,
  reason: string,
  now: number,
): Revision | null {
  assert.notEqual(kind, NodeKind.Task, "Tasks do not own revisions.");
  assert.ok(previous !== undefined || item !== undefined);
  const next = item === undefined ? previous! : importContent(item);
  const fields = changedFields(next, previous);
  const objective = kind === NodeKind.Objective;
  const list = objective
    ? taskList(ownerId, previous?.tasks ?? [], entries)
    : null;
  if (
    list !== null &&
    (previous === undefined || list.changes.length > NO_CHANGED_FIELDS)
  )
    fields.push(TASKS_FIELD);
  if (fields.length === NO_CHANGED_FIELDS) return null;
  return {
    node_id: ownerId,
    filename: next.filename,
    content: next.content,
    revision:
      previous === undefined
        ? FIRST_REVISION
        : previous.revision + REVISION_INCREMENT,
    reason,
    actor,
    created_at: now,
    pinned_by_attempts: [],
    ...(list === null ? {} : { tasks: list.tasks }),
    change: {
      write: RevisionWrite.Import,
      previous_revision: previous?.revision ?? null,
      changed_fields: fields,
      ...(list === null ? {} : { tasks: list.changes }),
    },
  };
}

export function importRevisions(
  tx: Transaction,
  resolved: ResolvedImport,
  entries: ResolvedImportEntry[],
  actor: HumanActor,
  reason: string,
  now: number,
): Revision[] {
  assert.equal(resolved.violations.length, NO_VIOLATIONS);
  assert.equal(entries.length, resolved.resolved_entries.length);
  const owners = new Map(
    [...resolved.current_nodes.values()]
      .filter((node) => node.kind !== NodeKind.Task)
      .map((node) => [node.id, node.kind]),
  );
  const byId = new Map(entries.map((item) => [item.key, item]));
  for (const item of entries) {
    if (item.entry.kind !== NodeKind.Task)
      owners.set(item.key, item.entry.kind);
  }
  const revisions: Revision[] = [];
  for (const [id, kind] of owners) {
    const row = readCurrentRevision(tx, id);
    assert.equal(row === null, !resolved.current_nodes.has(id));
    const previous = row === null ? undefined : revisionFromRow(tx, row);
    if (previous !== undefined && kind === NodeKind.Objective)
      assert.ok(previous.tasks, "Stored objectives contain a task list.");
    const revision = ownerRevision(
      id,
      kind,
      previous,
      byId.get(id),
      entries,
      actor,
      reason,
      now,
    );
    if (revision !== null) revisions.push(revision);
  }
  return revisions.sort(
    (a, b) => a.node_id.localeCompare(b.node_id) || a.revision - b.revision,
  );
}
