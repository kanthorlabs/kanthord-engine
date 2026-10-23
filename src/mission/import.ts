import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { canonicalJSON, digest } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import { importAdmissible, isTerminal } from "./admission.ts";
import {
  commitTypeField,
  resolveNodeBindings,
  validateFilename,
  validateNodeContent,
  validatePlanContent,
  validateText,
} from "./content.ts";
import {
  ImportFormat,
  MissionErrorCode,
  NODE_IDENTITY_PREFIX,
  TASK_IDENTITY_PREFIX,
  Intent,
  planFileNameSchema,
  type Content,
  type Edge,
  type ImportEntry,
  type ImportPreview,
  type ImportSnapshot,
  type Mission,
  type MissionBindings,
  type TaskBody,
  type TaskContent,
  type Violation,
} from "./contract.ts";
import { ControlError } from "./control.ts";
import { dependencyEditGuarded } from "./dependency.ts";
import { hasDependencyCycle, type DepEdge } from "./graph.ts";
import { nodeRecord } from "./node-read.ts";
import {
  parsePlanFile,
  type ParsedNodeFile,
  type ParsedTaskFile,
} from "./parser.ts";
import { revisionFromRow } from "./revision.ts";
import {
  readCurrentRevision,
  readDependencies,
  readMissionNodes,
  readNode,
  taskOwnerOf,
  type NodeRow,
} from "./store.ts";

const EMPTY_FIELD_LENGTH = 0;
const MINIMUM_BYTES_LIMIT = 0;
const NO_VIOLATIONS = 0;
const MINIMUM_MISSION_VERSION = 0;
const SORT_EQUAL = 0;
const SORT_BEFORE = -1;
const SORT_AFTER = 1;
const REASON_FIELD = "reason";
const TEMPORARY_KEY_PREFIX = "file:";
const REFERENCE = { Node: "node", DependsOn: "depends_on" } as const;
const PLAN_REASON = {
  DependsOnRepeated: "depends_on_repeated",
  ReferenceInvalid: "reference_invalid",
  IdPrefixInvalid: "id_prefix_invalid",
} as const;
type Reference = (typeof REFERENCE)[keyof typeof REFERENCE];
type Locator = Pick<NormalizedEntry, "filename" | "id">;

export type NormalizedEntry =
  | ParsedTaskFile
  | (Omit<ParsedNodeFile, "intent" | "tags" | "commit_type"> &
      Pick<Content, "commit_type"> & {
        intent: Intent;
        tags: string[];
      });

export function isTaskEntry(
  entry: NormalizedEntry | ImportEntry,
): entry is ParsedTaskFile {
  return "node" in entry;
}

export interface NormalizedSnapshot {
  entries: NormalizedEntry[];
  violations: Violation[];
}

export type CurrentTask = TaskContent & { owner_id: string };

export interface ResolvedImportEntry {
  entry: NormalizedEntry;
  key: string;
  current: NodeRow | null;
  task: CurrentTask | null;
  owner_id: string | null;
  depends_on: Set<string>;
  binding_ids: string[];
}

export interface ResolvedImport {
  violations: Violation[];
  creates: string[];
  updates: string[];
  content_updates: string[];
  no_ops: string[];
  retirements: string[];
  removed_edges: Edge[];
  resolved_entries: ResolvedImportEntry[];
  current_nodes: Map<string, NodeRow>;
  current_tasks: Map<string, CurrentTask>;
  current_dependencies: DepEdge[];
  dependencies: Map<string, Set<string>>;
}

function violation(
  code: string,
  message: string,
  details: Violation["details"],
  entry?: Locator,
): Violation {
  assert.ok(code.length > EMPTY_FIELD_LENGTH, "Violations have an error code.");
  assert.ok(
    message.length > EMPTY_FIELD_LENGTH,
    "Violations explain their failure.",
  );
  return {
    code,
    message,
    details,
    filename: entry?.filename ?? null,
    node_id: entry?.id?.startsWith(`${NODE_IDENTITY_PREFIX}_`)
      ? entry.id
      : null,
  };
}

function collect<T>(
  violations: Violation[],
  entry: Locator,
  work: () => T,
): T | undefined {
  try {
    return work();
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    violations.push(violation(error.code, error.message, error.details, entry));
    return undefined;
  }
}

function planRules(entry: ImportEntry, violations: Violation[]): void {
  const reasons: string[] = [];
  const prefix = isTaskEntry(entry)
    ? TASK_IDENTITY_PREFIX
    : NODE_IDENTITY_PREFIX;
  if (entry.id !== undefined && !entry.id.startsWith(`${prefix}_`))
    reasons.push(PLAN_REASON.IdPrefixInvalid);
  const dependencies = isTaskEntry(entry) ? [] : (entry.depends_on ?? []);
  if (new Set(dependencies).size !== dependencies.length)
    reasons.push(PLAN_REASON.DependsOnRepeated);
  const references = isTaskEntry(entry) ? [entry.node] : dependencies;
  if (references.some((name) => !planFileNameSchema.safeParse(name).success))
    reasons.push(PLAN_REASON.ReferenceInvalid);
  for (const reason of reasons)
    violations.push(
      violation(
        MissionErrorCode.PlanInvalid,
        "Invalid plan structure.",
        { filename: entry.filename, reason },
        entry,
      ),
    );
}

function normalizeEntry(entry: ImportEntry): NormalizedEntry {
  const shared = {
    filename: entry.filename,
    ...(entry.id === undefined ? {} : { id: entry.id }),
    bindings: [...entry.bindings],
    name: entry.name,
    requirement: entry.requirement,
    criterion: entry.criterion,
    verifications: [...entry.verifications],
  };
  if (isTaskEntry(entry)) return { ...shared, node: entry.node };
  return {
    ...shared,
    intent: entry.intent as Intent,
    tags: Array.isArray(entry.tags) ? [...entry.tags] : [],
    ...commitTypeField(entry.commit_type),
    depends_on: [...(entry.depends_on ?? [])],
  };
}

export function normalizeImportSnapshot(
  snapshot: ImportSnapshot,
  routeMissionId: string,
  textMaxBytes: number,
): NormalizedSnapshot {
  assert.ok(Number.isSafeInteger(textMaxBytes), "Text limit is an integer.");
  assert.ok(textMaxBytes > MINIMUM_BYTES_LIMIT, "Text limit is positive.");
  validateText(REASON_FIELD, snapshot.reason, textMaxBytes);
  const result: NormalizedSnapshot = { entries: [], violations: [] };
  const { entries, violations } = result;
  if (snapshot.mission_id !== routeMissionId)
    violations.push(
      violation(
        MissionErrorCode.MissionMismatch,
        "Snapshot belongs to another mission.",
        { mission_id: snapshot.mission_id },
      ),
    );
  const seen = new Set<string>();
  const inputs =
    snapshot.format === ImportFormat.Markdown
      ? snapshot.files
      : snapshot.entries;
  for (const input of inputs) {
    collect(violations, input, () => validateFilename(input.filename));
    if (seen.has(input.filename))
      violations.push(
        violation(
          MissionErrorCode.DuplicateFile,
          "Plan filename is repeated.",
          { filename: input.filename },
          input,
        ),
      );
    seen.add(input.filename);
    const parsed =
      "content" in input
        ? collect(violations, input, () =>
            parsePlanFile(input.filename, input.content),
          )
        : input;
    if (parsed === undefined) continue;
    planRules(parsed, violations);
    collect(violations, parsed, () =>
      isTaskEntry(parsed)
        ? validatePlanContent(parsed, textMaxBytes)
        : validateNodeContent(parsed, textMaxBytes),
    );
    entries.push(normalizeEntry(parsed));
  }
  return result;
}

function resolveIdentity(
  tx: Transaction,
  mission: Mission,
  entry: NormalizedEntry,
  seen: Set<string>,
  violations: Violation[],
  currentTasks: Map<string, CurrentTask>,
): Pick<ResolvedImportEntry, "current" | "task"> {
  const none = { current: null, task: null };
  if (entry.id === undefined) return none;
  const id = entry.id;
  if (seen.has(id))
    violations.push(
      violation(
        MissionErrorCode.DuplicateId,
        "Node identity is repeated.",
        { id },
        entry,
      ),
    );
  seen.add(id);
  if (isTaskEntry(entry)) {
    const task = currentTasks.get(id);
    if (task !== undefined) return { current: null, task };
    violations.push(
      taskOwnerOf(tx, mission.id, id) === null
        ? violation(
            MissionErrorCode.UnknownId,
            "Task identity does not exist.",
            { id },
            entry,
          )
        : violation(
            MissionErrorCode.RetiredId,
            "Task identity is retired.",
            { id },
            entry,
          ),
    );
    return none;
  }
  const current = readNode(tx, id);
  if (current === null) {
    violations.push(
      violation(
        MissionErrorCode.UnknownId,
        "Node identity does not exist.",
        { id },
        entry,
      ),
    );
    return none;
  }
  if (current.mission_id !== mission.id)
    violations.push(
      violation(
        MissionErrorCode.ForeignId,
        "Node belongs to another mission.",
        { id },
        entry,
      ),
    );
  if (current.retired_at !== null)
    violations.push(
      violation(
        MissionErrorCode.RetiredId,
        "Node identity is retired.",
        { id },
        entry,
      ),
    );
  return { current, task: null };
}

function resolveReference(
  entry: NormalizedEntry,
  name: string,
  reference: Reference,
  byFilename: Map<string, ResolvedImportEntry>,
  violations: Violation[],
): string | null {
  const target = byFilename.get(name);
  if (target === undefined) {
    violations.push(
      violation(
        MissionErrorCode.UnresolvedReference,
        "Plan reference is outside the import set.",
        { reference, name },
        entry,
      ),
    );
    return null;
  }
  const valid =
    !isTaskEntry(target.entry) &&
    (reference === REFERENCE.DependsOn ||
      target.entry.intent === Intent.Implement);
  if (!valid) {
    violations.push(
      violation(
        MissionErrorCode.ReferenceKindInvalid,
        "Plan reference names the wrong plan file form.",
        { reference, name },
        entry,
      ),
    );
    return null;
  }
  return target.key;
}

function resolveBindings(
  tx: Transaction,
  mission: Mission,
  entry: NormalizedEntry,
  bindings: MissionBindings,
  violations: Violation[],
): string[] {
  if (isTaskEntry(entry)) {
    if (entry.bindings.length > EMPTY_FIELD_LENGTH)
      violations.push(
        violation(
          MissionErrorCode.BindingsInvalid,
          "A task names no binding.",
          { filename: entry.filename },
          entry,
        ),
      );
    return [];
  }
  const intent = entry.intent as Intent;
  const resolved = collect(violations, entry, () =>
    resolveNodeBindings(
      tx,
      (inner, projectId, name) =>
        bindings.resolveBinding(inner, projectId, name),
      mission.project_id,
      intent,
      entry.bindings,
    ),
  );
  return (resolved ?? []).map((binding) => binding.binding_id);
}

function checkVerificationCoverage(result: ResolvedImport): void {
  const covered = new Map<string, Set<string>>();
  for (const item of result.resolved_entries) {
    if (!isTaskEntry(item.entry) || item.owner_id === null) continue;
    const commands = covered.get(item.owner_id) ?? new Set<string>();
    for (const command of item.entry.verifications) commands.add(command);
    covered.set(item.owner_id, commands);
  }
  for (const item of result.resolved_entries) {
    if (
      isTaskEntry(item.entry) ||
      item.entry.intent !== Intent.Implement ||
      !covered.has(item.key)
    )
      continue;
    for (const command of item.entry.verifications)
      if (!covered.get(item.key)?.has(command))
        result.violations.push(
          violation(
            MissionErrorCode.VerificationUncovered,
            "Node verification is not held by a task of the node.",
            { name: item.entry.filename, command },
            item.entry,
          ),
        );
  }
}

function resolveGraph(result: ResolvedImport): void {
  const byFilename = new Map(
    result.resolved_entries.map((item) => [item.entry.filename, item]),
  );
  for (const item of result.resolved_entries) {
    const { entry } = item;
    if (isTaskEntry(entry)) {
      item.owner_id = resolveReference(
        entry,
        entry.node,
        REFERENCE.Node,
        byFilename,
        result.violations,
      );
      continue;
    }
    for (const name of entry.depends_on) {
      const key = resolveReference(
        entry,
        name,
        REFERENCE.DependsOn,
        byFilename,
        result.violations,
      );
      if (key !== null) item.depends_on.add(key);
    }
    result.dependencies.set(item.key, item.depends_on);
  }
  checkVerificationCoverage(result);
  const keys = new Set(result.resolved_entries.map((item) => item.key));
  if (keys.size !== result.resolved_entries.length) return;
  const edges = result.resolved_entries.flatMap((item) =>
    [...item.depends_on].map((dependsOn) => ({
      dependent: item.key,
      depends_on: dependsOn,
    })),
  );
  if (hasDependencyCycle(edges))
    result.violations.push(
      violation(
        MissionErrorCode.Cycle,
        "Import dependency closure contains a cycle.",
        null,
      ),
    );
}

function entryChanged(
  tx: Transaction,
  item: ResolvedImportEntry,
  bindings: MissionBindings,
): boolean {
  const { entry, current } = item;
  assert.ok(current, "Only an existing identity can be compared.");
  assert.equal(current.retired_at, null, "Compared identity is current.");
  assert.ok(!isTaskEntry(entry), "Only a node file is compared to a node.");
  const content: Content = {
    name: entry.name,
    requirement: entry.requirement,
    criterion: entry.criterion,
    verifications: entry.verifications,
    bindings: item.binding_ids,
    intent: entry.intent as Intent,
    tags: entry.tags,
    ...commitTypeField(entry.commit_type),
  };
  return (
    current.filename !== entry.filename ||
    canonicalJSON(nodeRecord(tx, current, bindings).content) !==
      canonicalJSON(content)
  );
}

function taskChanged(item: ResolvedImportEntry): boolean {
  const { entry, task } = item;
  assert.ok(task, "Only an existing task can be compared.");
  const content: TaskBody = {
    name: entry.name,
    requirement: entry.requirement,
    criterion: entry.criterion,
    verifications: entry.verifications,
    bindings: item.binding_ids,
  };
  return (
    task.filename !== entry.filename ||
    task.owner_id !== item.owner_id ||
    canonicalJSON(task.content) !== canonicalJSON(content)
  );
}

function droppedEdges(result: ResolvedImport): Edge[] {
  const dependencies = result.current_dependencies
    .filter(
      (edge) => !result.dependencies.get(edge.dependent)?.has(edge.depends_on),
    )
    .map((edge) => ({
      dependent_id: edge.dependent,
      depends_on_id: edge.depends_on,
    }));
  dependencies.sort(
    (a, b) =>
      a.dependent_id.localeCompare(b.dependent_id) ||
      a.depends_on_id.localeCompare(b.depends_on_id),
  );
  return dependencies;
}

function classify(
  tx: Transaction,
  result: ResolvedImport,
  bindings: MissionBindings,
): void {
  assert.equal(
    result.violations.length,
    NO_VIOLATIONS,
    "Classification requires a valid resolved graph.",
  );
  const kept = new Set<string>();
  const keptTasks = new Set<string>();
  const owners = new Set<string>();
  for (const item of result.resolved_entries) {
    if (!isTaskEntry(item.entry)) continue;
    if (item.owner_id !== null && item.task?.owner_id !== item.owner_id)
      owners.add(item.owner_id);
    if (item.task === null) continue;
    keptTasks.add(item.task.id);
    if (taskChanged(item)) {
      owners.add(item.task.owner_id);
      if (item.owner_id !== null) owners.add(item.owner_id);
    }
  }
  for (const task of result.current_tasks.values())
    if (!keptTasks.has(task.id)) owners.add(task.owner_id);
  for (const item of result.resolved_entries) {
    if (item.entry.id === undefined) {
      result.creates.push(item.entry.filename);
      continue;
    }
    if (isTaskEntry(item.entry)) continue;
    assert.ok(
      item.current,
      "Supplied identities resolve before classification.",
    );
    kept.add(item.current.id);
    const contentChanged =
      entryChanged(tx, item, bindings) || owners.has(item.current.id);
    if (contentChanged) result.content_updates.push(item.current.id);
    const previous = result.current_dependencies
      .filter((edge) => edge.dependent === item.key)
      .map((edge) => edge.depends_on)
      .sort();
    const target =
      contentChanged ||
      canonicalJSON(previous) !== canonicalJSON([...item.depends_on].sort())
        ? result.updates
        : result.no_ops;
    target.push(item.current.id);
  }
  result.retirements = [...result.current_nodes.keys()]
    .filter((id) => !kept.has(id))
    .sort();
  result.creates.sort();
  result.updates.sort();
  result.no_ops.sort();
  result.removed_edges = droppedEdges(result);
}

export function resolveImportSet(
  tx: Transaction,
  mission: Mission,
  entries: NormalizedEntry[],
  bindings: MissionBindings,
): ResolvedImport {
  assert.ok(
    Number.isSafeInteger(mission.version),
    "Mission version is an integer.",
  );
  assert.ok(
    mission.version > MINIMUM_MISSION_VERSION,
    "Mission has a persisted version.",
  );
  const currentNodes = new Map(
    readMissionNodes(tx, mission.id)
      .filter((node) => node.retired_at === null)
      .map((node) => [node.id, node]),
  );
  const currentTasks = new Map<string, CurrentTask>();
  for (const node of currentNodes.values()) {
    const row = readCurrentRevision(tx, node.id);
    assert.ok(row, "A current node has a revision.");
    for (const task of revisionFromRow(tx, row).tasks)
      currentTasks.set(task.id, { ...task, owner_id: node.id });
  }
  const result: ResolvedImport = {
    violations: [],
    creates: [],
    updates: [],
    content_updates: [],
    no_ops: [],
    retirements: [],
    removed_edges: [],
    resolved_entries: [],
    current_nodes: currentNodes,
    current_tasks: currentTasks,
    current_dependencies: readDependencies(tx, mission.id).filter(
      (edge) =>
        currentNodes.has(edge.dependent) && currentNodes.has(edge.depends_on),
    ),
    dependencies: new Map(),
  };
  const seen = new Set<string>();
  for (const entry of entries) {
    result.resolved_entries.push({
      entry,
      key: entry.id ?? `${TEMPORARY_KEY_PREFIX}${entry.filename}`,
      ...resolveIdentity(
        tx,
        mission,
        entry,
        seen,
        result.violations,
        currentTasks,
      ),
      owner_id: null,
      depends_on: new Set(),
      binding_ids: resolveBindings(
        tx,
        mission,
        entry,
        bindings,
        result.violations,
      ),
    });
  }
  resolveGraph(result);
  if (result.violations.length === NO_VIOLATIONS)
    classify(tx, result, bindings);
  return result;
}

function modifiedNodes(resolved: ResolvedImport): Set<string> {
  assert.equal(resolved.violations.length, NO_VIOLATIONS);
  const modified = new Set<string>();
  const updates = new Set(resolved.content_updates);
  const retiring = new Set(resolved.retirements);
  const add = (id: string | null): void => {
    if (id !== null && resolved.current_nodes.has(id)) modified.add(id);
  };
  const keptTasks = new Set<string>();
  for (const item of resolved.resolved_entries) {
    const { current, task } = item;
    if (task !== null) {
      keptTasks.add(task.id);
      if (!taskChanged(item)) continue;
      add(task.owner_id);
      add(item.owner_id);
      continue;
    }
    if (current === null) {
      add(item.owner_id);
      continue;
    }
    if (updates.has(current.id)) add(current.id);
  }
  for (const id of retiring) {
    const node = resolved.current_nodes.get(id);
    assert.ok(node, "Retirements name current nodes.");
    add(node.id);
  }
  for (const task of resolved.current_tasks.values())
    if (!keptTasks.has(task.id)) add(task.owner_id);
  return modified;
}

export function checkImportCondition(
  tx: Transaction,
  resolved: ResolvedImport,
): Violation[] {
  assert.equal(resolved.violations.length, NO_VIOLATIONS);
  const violations: Violation[] = [];
  const modified = modifiedNodes(resolved);
  for (const id of [...new Set([...modified, ...resolved.updates])].sort()) {
    const node = readNode(tx, id);
    assert.ok(node, "Modified nodes exist in the transaction.");
    const locator = { id, filename: node.filename };
    if (isTerminal(node.state)) {
      violations.push(
        violation(
          MissionErrorCode.TerminalChange,
          "Import cannot change a terminal node.",
          { node_id: id },
          locator,
        ),
      );
      continue;
    }
    if (modified.has(id) && !importAdmissible(node.state, node.attempt)) {
      violations.push(
        violation(
          MissionErrorCode.ConditionFailed,
          "Node does not satisfy the import condition.",
          { state: node.state, attempt: node.attempt },
          locator,
        ),
      );
      continue;
    }
    const previous = new Set(
      resolved.current_dependencies
        .filter((edge) => edge.dependent === id)
        .map((edge) => edge.depends_on),
    );
    const next = resolved.dependencies.get(id) ?? new Set<string>();
    const adding = [...next].some((target) => !previous.has(target));
    const removing = [...previous].some((target) => !next.has(target));
    if ((adding || removing) && dependencyEditGuarded(tx, node, adding))
      violations.push(
        violation(
          ControlError.StateConflict,
          "Node state refuses a dependency edit.",
          { state: node.state, attempt: node.attempt },
          locator,
        ),
      );
  }
  return violations;
}

export interface PreparedImport {
  preview: ImportPreview;
  resolved: ResolvedImport | null;
}

export function prepareImport(
  tx: Transaction,
  mission: Mission,
  snapshot: ImportSnapshot,
  routeMissionId: string,
  bindings: MissionBindings,
  textMaxBytes: number,
): PreparedImport {
  assert.equal(mission.id, routeMissionId, "Route mission was loaded.");
  assert.equal(
    mission.version,
    snapshot.mission_version,
    "Version was checked.",
  );
  const normalized = normalizeImportSnapshot(
    snapshot,
    routeMissionId,
    textMaxBytes,
  );
  const resolved =
    normalized.violations.length === NO_VIOLATIONS
      ? resolveImportSet(tx, mission, normalized.entries, bindings)
      : null;
  const violations =
    resolved === null
      ? normalized.violations
      : resolved.violations.length > NO_VIOLATIONS
        ? resolved.violations
        : checkImportCondition(tx, resolved);
  const retirements = resolved?.retirements ?? [];
  return {
    resolved,
    preview: {
      mission_id: mission.id,
      expected_mission_version: snapshot.mission_version,
      preview_digest: importDigest(
        mission.id,
        snapshot.mission_version,
        normalized.entries,
        retirements,
      ),
      creates: resolved?.creates ?? [],
      updates: resolved?.updates ?? [],
      retirements,
      removed_edges: resolved?.removed_edges ?? [],
      no_ops: resolved?.no_ops ?? [],
      violations,
    },
  };
}

export function importDigest(
  missionId: string,
  missionVersion: number,
  entries: NormalizedEntry[],
  retirements: string[],
): string {
  assert.ok(
    Number.isSafeInteger(missionVersion),
    "Digest version is an integer.",
  );
  assert.ok(
    missionVersion > MINIMUM_MISSION_VERSION,
    "Digest covers a persisted mission version.",
  );
  return digest({
    mission_id: missionId,
    mission_version: missionVersion,
    entries: [...entries].sort((a, b) =>
      a.filename === b.filename
        ? SORT_EQUAL
        : a.filename < b.filename
          ? SORT_BEFORE
          : SORT_AFTER,
    ),
    retirements: [...retirements].sort(),
  });
}
