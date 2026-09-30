import assert from "node:assert/strict";
import type { SQLInputValue } from "node:sqlite";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity, identitySchema } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import { isObject, isString } from "../kernel/values.ts";
import {
  BINDING_ID_PREFIX,
  BINDING_SET_INITIAL_VERSION,
  PROJECT_ID_PREFIX,
  BindingKind,
  BindingState,
  ChangeKind,
  EMPTY_LENGTH,
  LIST_LIMIT_MAX,
  ProjectErrorCode,
  REPOSITORY_PLATFORM,
  repositoryConfigSchema,
  STORAGE_PLATFORM,
  WORKER_PLATFORM,
  type BindingChange,
} from "./contract.ts";

const INITIAL_REVISION = 1;
const NO_REVISION = 0;
const REVISION_INCREMENT = 1;
const VERSION_INCREMENT = 1;
const MINIMUM_LIMIT = 1;
const EXTRA_ROW = 1;
const FIRST_ROW = 0;
const LAST_ROW_OFFSET = 1;
const RESOURCE_SEPARATOR = ":";
const CREDENTIAL_KEY = "credential";
const CURSOR_ENCODING = "base64url";
const TEXT_ENCODING = "utf8";
const REPOSITORY_ADDRESS_PATTERN =
  /^git@github\.com:([^/\s:]+)\/([^/\s:]+)\.git(?![\s\S])/;
const REVISION_PATTERN = /^[1-9][0-9]*(?![\s\S])/;
const bindingIdentitySchema = identitySchema(BINDING_ID_PREFIX);
const projectIdentitySchema = identitySchema(PROJECT_ID_PREFIX);
const latestRevisionQuery = `SELECT MAX(latest.revision) FROM project_binding latest
  WHERE latest.project_id = b.project_id
    AND latest.resource_identity = b.resource_identity`;
const latestBindingQuery = `SELECT b.* FROM project_binding b
  WHERE b.project_id = ? AND b.revision = (${latestRevisionQuery})`;
const followingTombstoneQuery = `SELECT removed.id FROM project_binding removed
  WHERE removed.project_id = b.project_id
    AND removed.resource_identity = b.resource_identity
    AND removed.revision > b.revision AND removed.removed_at IS NOT NULL`;

type ProjectRow = {
  id: string;
  name: string;
  binding_set_version: number;
  created_at: number;
};
export type StoredProject = {
  id: string;
  name: string;
  bindingSetVersion: number;
  createdAt: number;
};

function toProject(row: ProjectRow): StoredProject {
  assert.ok(projectIdentitySchema.safeParse(row.id).success);
  assert.ok(row.binding_set_version >= BINDING_SET_INITIAL_VERSION);
  return {
    id: row.id,
    name: row.name,
    bindingSetVersion: row.binding_set_version,
    createdAt: row.created_at,
  };
}

function requireAvailableName(
  tx: Transaction,
  name: string,
  projectId?: string,
): void {
  const holder = tx.database
    .prepare("SELECT id FROM project_project WHERE name = ?")
    .get(name);
  if (holder && holder.id !== projectId)
    throw new OperationError(
      HttpStatus.Conflict,
      ProjectErrorCode.NameConflict,
      "Project name is already taken.",
      { id: String(holder.id) },
    );
}

export function insertProject(tx: Transaction, name: string): StoredProject {
  requireAvailableName(tx, name);
  const row: ProjectRow = {
    id: createIdentity(PROJECT_ID_PREFIX),
    name,
    binding_set_version: BINDING_SET_INITIAL_VERSION,
    created_at: Date.now(),
  };
  tx.database
    .prepare(
      "INSERT INTO project_project (id, name, binding_set_version, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(row.id, row.name, row.binding_set_version, row.created_at);
  return toProject(row);
}

export function requireProject(tx: Transaction, id: string): StoredProject {
  const row = tx.database
    .prepare("SELECT * FROM project_project WHERE id = ?")
    .get(id) as ProjectRow | undefined;
  if (!row)
    throw new OperationError(
      HttpStatus.NotFound,
      ProjectErrorCode.ProjectNotFound,
      "Project not found.",
    );
  return toProject(row);
}

export function renameProject(
  tx: Transaction,
  id: string,
  name: string,
): StoredProject {
  const project = requireProject(tx, id);
  requireAvailableName(tx, name, id);
  tx.database
    .prepare("UPDATE project_project SET name = ? WHERE id = ?")
    .run(name, id);
  return { ...project, name };
}

export function listProjects(
  tx: Transaction,
  filter: PageFilter,
): { items: StoredProject[]; nextCursor: string | null } {
  const cursor =
    filter.cursor == null
      ? null
      : decodeCursor(
          filter.cursor,
          (value) => projectIdentitySchema.safeParse(value).success,
        );
  const rows = tx.database
    .prepare(
      "SELECT * FROM project_project WHERE (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?",
    )
    .all(cursor, cursor, filter.limit + EXTRA_ROW) as ProjectRow[];
  return page(rows, filter.limit, (row) => row.id, toProject);
}

export type StoredBinding = {
  id: string;
  projectId: string;
  name: string;
  resourceIdentity: string;
  revision: number;
  config: unknown;
  createdAt: number;
  removedAt: number | null;
};
type BindingRow = {
  id: string;
  project_id: string;
  name: string;
  resource_identity: string;
  revision: number;
  config: string;
  created_at: number;
  removed_at: number | null;
};
type Submission = Map<string, { kind: string; config: unknown }>;
type Insertion = { name: string; resourceIdentity: string; config: string };
type Outcome = {
  kind: BindingChange["kind"];
  previous?: StoredBinding;
  insertion?: Insertion;
  bindingId?: string;
};
type PageFilter = { limit: number; cursor?: string | null };
type BindingPage = { items: StoredBinding[]; nextCursor: string | null };

export function kindOf(
  resourceIdentity: string,
): (typeof BindingKind)[keyof typeof BindingKind] {
  const [kind] = resourceIdentity.split(RESOURCE_SEPARATOR);
  if (
    kind !== BindingKind.Repository &&
    kind !== BindingKind.Worker &&
    kind !== BindingKind.Storage
  )
    throw new Error(
      `Unknown binding kind in resource identity: ${resourceIdentity}`,
    );
  return kind;
}

export function deriveResourceIdentity(
  kind: string,
  bindingName: string,
  config: unknown,
): string {
  if (kind === BindingKind.Worker)
    return `${BindingKind.Worker}:${WORKER_PLATFORM}:${bindingName}`;
  if (kind === BindingKind.Repository) {
    const address =
      isObject(config) && "address" in config ? config.address : null;
    const match = isString(address)
      ? REPOSITORY_ADDRESS_PATTERN.exec(address)
      : null;
    if (!match)
      throw new OperationError(
        HttpStatus.BadRequest,
        ProjectErrorCode.RepositoryAddressInvalid,
        "Repository address must be a GitHub SSH address.",
      );
    const [, owner, repository] = match;
    return `${BindingKind.Repository}:${REPOSITORY_PLATFORM}:${owner}/${repository}`;
  }
  if (kind !== BindingKind.Storage)
    throw new Error(`Unknown binding kind: ${kind}`);
  if (
    !isObject(config) ||
    !("endpoint" in config) ||
    !isString(config.endpoint) ||
    !("bucket" in config) ||
    !isString(config.bucket)
  )
    throw new TypeError(
      "Storage configuration requires an endpoint and bucket.",
    );
  return `${BindingKind.Storage}:${STORAGE_PLATFORM}:${new URL(config.endpoint).host}/${config.bucket}`;
}

function toBinding(row: BindingRow): StoredBinding {
  assert.ok(
    Number.isSafeInteger(row.revision),
    "Stored revision must be an integer.",
  );
  assert.ok(
    row.revision >= INITIAL_REVISION,
    "Stored revision must be positive.",
  );
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    resourceIdentity: row.resource_identity,
    revision: row.revision,
    config: JSON.parse(row.config),
    createdAt: row.created_at,
    removedAt: row.removed_at,
  };
}

export function readCurrentBindingSet(
  tx: Transaction,
  projectId: string,
): Map<string, StoredBinding> {
  const rows = tx.database
    .prepare(`${latestBindingQuery} AND b.removed_at IS NULL`)
    .all(projectId) as BindingRow[];
  const bindings = rows.map(toBinding);
  const current = new Map(bindings.map((binding) => [binding.name, binding]));
  assert.equal(
    current.size,
    rows.length,
    "Current binding names must be unique.",
  );
  assert.ok(
    bindings.every((binding) => binding.projectId === projectId),
    "Bindings must belong to the requested project.",
  );
  return current;
}

export function readCurrentBindings(tx: Transaction): StoredBinding[] {
  const rows = tx.database
    .prepare(
      `SELECT b.* FROM project_binding b
      WHERE b.revision = (${latestRevisionQuery}) AND b.removed_at IS NULL`,
    )
    .all() as BindingRow[];
  assert.ok(tx.database.isTransaction);
  assert.ok(rows.every((row) => row.removed_at === null));
  return rows.map(toBinding);
}

export function readCurrentRepositories(
  tx: Transaction,
): Array<{ projectName: string; name: string; address: string }> {
  const rows = tx.database
    .prepare(
      `SELECT b.*, p.name AS project_name FROM project_binding b
      JOIN project_project p ON p.id = b.project_id
      WHERE b.resource_identity LIKE ?
        AND b.revision = (${latestRevisionQuery}) AND b.removed_at IS NULL`,
    )
    .all(`${BindingKind.Repository}${RESOURCE_SEPARATOR}%`) as Array<
    BindingRow & { project_name: string }
  >;
  assert.ok(tx.database.isTransaction);
  assert.ok(rows.every((row) => row.removed_at === null));
  return rows.map((row) => ({
    projectName: row.project_name,
    name: row.name,
    address: repositoryConfigSchema.parse(JSON.parse(row.config)).address,
  }));
}

export function readCurrentBindingByName(
  tx: Transaction,
  projectId: string,
  name: string,
): StoredBinding | null {
  const row = tx.database
    .prepare(`${latestBindingQuery} AND b.removed_at IS NULL AND b.name = ?`)
    .get(projectId, name) as BindingRow | undefined;
  if (!row) return null;
  assert.equal(row.project_id, projectId);
  assert.equal(row.name, name);
  return toBinding(row);
}

export function readCredentialBindings(
  tx: Transaction,
  credentialName: string,
): Array<{ binding: StoredBinding; current: boolean }> {
  const rows = tx.database
    .prepare(
      `SELECT b.*, (${latestRevisionQuery}) AS latest_revision
      FROM project_binding b
      WHERE b.removed_at IS NULL
        AND NOT EXISTS (${followingTombstoneQuery})
        AND EXISTS (
          SELECT 1 FROM json_tree(b.config) reference
          WHERE reference.key = ? AND reference.atom = ?
        )`,
    )
    .all(CREDENTIAL_KEY, credentialName) as Array<
    BindingRow & { latest_revision: number }
  >;
  return rows.map((row) => {
    assert.equal(row.removed_at, null);
    assert.ok(row.latest_revision >= row.revision);
    return {
      binding: toBinding(row),
      current: row.revision === row.latest_revision,
    };
  });
}

export function hasBindingTombstone(
  tx: Transaction,
  binding: StoredBinding,
): boolean {
  assert.ok(binding.revision >= INITIAL_REVISION);
  assert.ok(tx.database.isTransaction);
  if (binding.removedAt !== null) return true;
  return (
    tx.database
      .prepare(
        `SELECT b.id FROM project_binding b
      WHERE b.id = ? AND EXISTS (${followingTombstoneQuery})`,
      )
      .get(binding.id) !== undefined
  );
}

function classify(
  name: string,
  entry: { kind: string; config: unknown },
  previous?: StoredBinding,
): Outcome {
  const resourceIdentity = deriveResourceIdentity(
    entry.kind,
    name,
    entry.config,
  );
  const config = canonicalJSON(entry.config);
  if (!previous)
    return {
      kind: ChangeKind.Created,
      insertion: { name, resourceIdentity, config },
    };
  if (kindOf(previous.resourceIdentity) === BindingKind.Worker) {
    const stored = previous.config as { worker: string };
    const submitted = entry.config as { worker: string };
    if (stored.worker !== submitted.worker)
      throw new OperationError(
        HttpStatus.Conflict,
        ProjectErrorCode.WorkerResourceChanged,
        "A binding cannot change its worker.",
      );
  }
  if (previous.resourceIdentity !== resourceIdentity)
    return {
      kind: ChangeKind.Created,
      previous,
      insertion: { name, resourceIdentity, config },
    };
  if (canonicalJSON(previous.config) === config)
    return { kind: ChangeKind.Unchanged, bindingId: previous.id };
  return {
    kind: ChangeKind.Revised,
    insertion: { name, resourceIdentity, config },
  };
}

function bindingDiff(
  current: Map<string, StoredBinding>,
  submission: Submission,
): Outcome[] {
  const outcomes = Array.from(submission, ([name, entry]) =>
    classify(name, entry, current.get(name)),
  );
  const omitted = Array.from(current.values()).filter(
    (binding) => !submission.has(binding.name),
  );
  outcomes.push(
    ...omitted.map((previous) => ({ kind: ChangeKind.Removed, previous })),
  );
  assert.equal(
    outcomes.length,
    submission.size + omitted.length,
    "Every submitted or omitted name needs one outcome.",
  );
  assert.ok(
    outcomes.every(
      (outcome) => outcome.previous || outcome.insertion || outcome.bindingId,
    ),
    "Every outcome needs a binding.",
  );
  return outcomes;
}

function insertRevision(
  tx: Transaction,
  projectId: string,
  insertion: Insertion,
  removedAt: number | null,
  now: number,
): string {
  const row = tx.database
    .prepare(
      "SELECT MAX(revision) AS revision FROM project_binding WHERE project_id = ? AND resource_identity = ?",
    )
    .get(projectId, insertion.resourceIdentity)!;
  const revision = Number(row.revision ?? NO_REVISION) + REVISION_INCREMENT;
  assert.ok(
    Number.isSafeInteger(revision),
    "Next revision must be a safe integer.",
  );
  assert.ok(revision >= INITIAL_REVISION, "Next revision must be positive.");
  const id = createIdentity(BINDING_ID_PREFIX);
  tx.database
    .prepare(
      `INSERT INTO project_binding
    (id, project_id, name, resource_identity, revision, config, created_at, removed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      projectId,
      insertion.name,
      insertion.resourceIdentity,
      revision,
      insertion.config,
      now,
      removedAt,
    );
  return id;
}

function insertTombstones(
  tx: Transaction,
  projectId: string,
  outcomes: Outcome[],
  now: number,
): void {
  for (const outcome of outcomes) {
    if (!outcome.previous) continue;
    const previous = outcome.previous;
    assert.equal(
      previous.projectId,
      projectId,
      "Tombstone must remain in the same project.",
    );
    assert.equal(
      previous.removedAt,
      null,
      "Only a current binding can be removed.",
    );
    outcome.bindingId = insertRevision(
      tx,
      projectId,
      {
        name: previous.name,
        resourceIdentity: previous.resourceIdentity,
        config: canonicalJSON(previous.config),
      },
      now,
      now,
    );
  }
}

export function writeBindingSet(
  tx: Transaction,
  projectId: string,
  submittedVersion: number,
  submission: Submission,
): { newVersion: number; changes: BindingChange[] } {
  const project = tx.database
    .prepare("SELECT binding_set_version FROM project_project WHERE id = ?")
    .get(projectId);
  if (!project)
    throw new OperationError(
      HttpStatus.NotFound,
      ProjectErrorCode.ProjectNotFound,
      "Project not found.",
    );
  const bindingSetVersion = Number(project.binding_set_version);
  if (bindingSetVersion !== submittedVersion)
    throw new OperationError(
      HttpStatus.Conflict,
      ProjectErrorCode.VersionConflict,
      "Binding set version is stale.",
      { bindingSetVersion },
    );
  const outcomes = bindingDiff(
    readCurrentBindingSet(tx, projectId),
    submission,
  );
  const now = Date.now();
  insertTombstones(tx, projectId, outcomes, now);
  const changes = outcomes.map((outcome): BindingChange => {
    const bindingId = outcome.insertion
      ? insertRevision(tx, projectId, outcome.insertion, null, now)
      : outcome.bindingId;
    assert.ok(
      bindingId,
      "Every outcome must identify its retained or inserted revision.",
    );
    assert.ok(
      bindingIdentitySchema.safeParse(bindingId).success,
      "A change must identify a binding revision.",
    );
    return { kind: outcome.kind, bindingId };
  });
  tx.database
    .prepare(
      "UPDATE project_project SET binding_set_version = binding_set_version + ? WHERE id = ?",
    )
    .run(VERSION_INCREMENT, projectId);
  return { newVersion: submittedVersion + VERSION_INCREMENT, changes };
}

export function readBindingRevision(
  tx: Transaction,
  id: string,
): StoredBinding | null {
  const row = tx.database
    .prepare("SELECT * FROM project_binding WHERE id = ?")
    .get(id) as BindingRow | undefined;
  if (!row) return null;
  assert.equal(row.id, id, "Revision read must preserve identity.");
  assert.ok(
    bindingIdentitySchema.safeParse(row.id).success,
    "Stored binding identity must be valid.",
  );
  return toBinding(row);
}

export function readLatestBinding(
  tx: Transaction,
  projectId: string,
  resourceIdentity: string,
): StoredBinding | null {
  const row = tx.database
    .prepare(
      "SELECT * FROM project_binding WHERE project_id = ? AND resource_identity = ? ORDER BY revision DESC LIMIT 1",
    )
    .get(projectId, resourceIdentity) as BindingRow | undefined;
  if (!row) return null;
  assert.equal(row.project_id, projectId);
  assert.equal(row.resource_identity, resourceIdentity);
  return toBinding(row);
}

export function readLatestTombstone(
  tx: Transaction,
  projectId: string,
  resourceIdentity: string,
): StoredBinding | null {
  const row = tx.database
    .prepare(
      "SELECT * FROM project_binding WHERE project_id = ? AND resource_identity = ? AND removed_at IS NOT NULL ORDER BY revision DESC LIMIT 1",
    )
    .get(projectId, resourceIdentity) as BindingRow | undefined;
  if (!row) return null;
  assert.equal(row.project_id, projectId);
  assert.equal(row.resource_identity, resourceIdentity);
  return toBinding(row);
}

function decodeCursor(
  cursor: string,
  valid: (value: string) => boolean,
): string {
  const decoded = Buffer.from(cursor, CURSOR_ENCODING).toString(TEXT_ENCODING);
  if (
    Buffer.from(decoded, TEXT_ENCODING).toString(CURSOR_ENCODING) !== cursor ||
    !valid(decoded)
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      ProjectErrorCode.CursorInvalid,
      "Cursor is invalid.",
    );
  return decoded;
}

function validRevision(value: string): boolean {
  return REVISION_PATTERN.test(value) && Number.isSafeInteger(Number(value));
}

function page<Row, Item>(
  rows: Row[],
  limit: number,
  key: (row: Row) => string,
  convert: (row: Row) => Item,
): { items: Item[]; nextCursor: string | null } {
  assert.ok(
    Number.isInteger(limit) &&
      limit >= MINIMUM_LIMIT &&
      limit <= LIST_LIMIT_MAX,
    "Page limit must be in range.",
  );
  assert.ok(
    rows.length <= limit + EXTRA_ROW,
    "A page query must fetch at most one extra row.",
  );
  const selected = rows.slice(FIRST_ROW, limit);
  const last = selected.at(-LAST_ROW_OFFSET);
  const nextCursor =
    rows.length > limit && last
      ? Buffer.from(key(last), TEXT_ENCODING).toString(CURSOR_ENCODING)
      : null;
  return { items: selected.map(convert), nextCursor };
}

export function listBindings(
  tx: Transaction,
  projectId: string,
  filter: PageFilter & { kind?: string[]; state?: string },
): BindingPage {
  const conditions: string[] = [];
  const parameters: SQLInputValue[] = [projectId];
  const state = filter.state ?? BindingState.Current;
  if (state === BindingState.Current) conditions.push("b.removed_at IS NULL");
  else if (state === BindingState.Removed)
    conditions.push("b.removed_at IS NOT NULL");
  else if (state !== BindingState.All)
    throw new TypeError(`Unknown binding state: ${state}`);
  if (filter.kind && filter.kind.length > EMPTY_LENGTH) {
    conditions.push(
      `substr(b.resource_identity, 1, instr(b.resource_identity, ':') - 1) IN (${filter.kind.map(() => "?").join(", ")})`,
    );
    parameters.push(...filter.kind);
  }
  if (filter.cursor != null) {
    conditions.push("b.id < ?");
    parameters.push(
      decodeCursor(
        filter.cursor,
        (value) => bindingIdentitySchema.safeParse(value).success,
      ),
    );
  }
  const where =
    conditions.length > EMPTY_LENGTH ? ` AND ${conditions.join(" AND ")}` : "";
  const rows = tx.database
    .prepare(`${latestBindingQuery}${where} ORDER BY b.id DESC LIMIT ?`)
    .all(...parameters, filter.limit + EXTRA_ROW) as BindingRow[];
  return page(rows, filter.limit, (row) => row.id, toBinding);
}

export function listRevisions(
  tx: Transaction,
  bindingId: string,
  filter: PageFilter,
): BindingPage {
  const revision =
    filter.cursor == null
      ? null
      : Number(decodeCursor(filter.cursor, validRevision));
  const binding = readBindingRevision(tx, bindingId);
  if (!binding)
    throw new OperationError(
      HttpStatus.NotFound,
      ProjectErrorCode.BindingNotFound,
      "Binding not found.",
    );
  const cursorCondition = revision === null ? "" : " AND revision < ?";
  const parameters: SQLInputValue[] = [
    binding.projectId,
    binding.resourceIdentity,
  ];
  if (revision !== null) parameters.push(revision);
  const rows = tx.database
    .prepare(
      `SELECT * FROM project_binding WHERE project_id = ? AND resource_identity = ?${cursorCondition} ORDER BY revision DESC LIMIT ?`,
    )
    .all(...parameters, filter.limit + EXTRA_ROW) as BindingRow[];
  return page(rows, filter.limit, (row) => String(row.revision), toBinding);
}
