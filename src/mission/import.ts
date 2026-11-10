import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { canonicalJSON, digest } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import { importAdmissible, isTerminal } from "./admission.ts";
import { guardEnvironmentMix } from "./environment-mix.ts";
import {
  commitTypeField,
  resolveNodeBindings,
  validateExternalLinkBindings,
  validateFilename,
  validateNodeContent,
  validatePlanContent,
  validateText,
} from "./content.ts";
import {
  type Content,
  type Drift,
  type Edge,
  type ExternalLink,
  type ImportEntry,
  ImportFormat,
  type ImportPreview,
  type ImportSnapshot,
  Intent,
  type Mission,
  type MissionBindings,
  type MissionEnvironments,
  MissionErrorCode,
  NODE_IDENTITY_PREFIX,
  planFileNameSchema,
  TASK_IDENTITY_PREFIX,
  type TaskBody,
  type TaskContent,
  type Violation,
} from "./contract.ts";
import { ControlError } from "./control.ts";
import { dependencyEditGuarded } from "./dependency.ts";
import { type DepEdge, hasDependencyCycle } from "./graph.ts";
import {
  type ParsedNodeFile,
  type ParsedTaskFile,
  parsePlanFile,
} from "./parser.ts";
import { revisionFromRow } from "./revision.ts";
import {
  type NodeRow,
  readCurrentRevision,
  readDependencies,
  readMissionNodes,
  readNode,
  taskOwnerOf,
} from "./store.ts";

const EMPTY_FIELD_LENGTH = 0;
const MINIMUM_BYTES_LIMIT = 0;
const NO_VIOLATIONS = 0;
const MINIMUM_MISSION_VERSION = 0;
const SORT_EQUAL = 0;
const SORT_BEFORE = -1;
const SORT_AFTER = 1;
const REASON_FIELD = "reason";
const EXPORT_REMEDY = "mission export";
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
  | (Omit<
      ParsedNodeFile,
      "intent" | "tags" | "external_links" | "commit_type"
    > &
      Pick<Content, "commit_type"> & {
        intent: Intent;
        tags: string[];
        external_links: ExternalLink[];
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
  intent: Intent | null;
  terminal: boolean;
}

export interface ResolvedImport {
  violations: Violation[];
  creates: string[];
  updates: string[];
  content_updates: string[];
  no_ops: string[];
  retirements: string[];
  removed_edges: Edge[];
  drifts: Drift[];
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
    external_links: Array.isArray(entry.external_links)
      ? [...entry.external_links]
      : [],
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
    (reference === REFERENCE.DependsOn || target.intent === Intent.Implement);
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

function pinnedBindingOf(
  tx: Transaction,
  bindings: MissionBindings,
  current: NodeRow | null,
): (name: string, resourceIdentity: string) => string | null {
  if (current === null) return () => null;
  const row = readCurrentRevision(tx, current.id);
  assert.ok(row, "A current node has a revision.");
  const pinned = revisionFromRow(tx, row).content.bindings.map((id) => {
    const revision = bindings.getBindingRevision(tx, id);
    assert.ok(revision, "A pinned binding has a revision.");
    return revision;
  });
  return (name, resourceIdentity) =>
    pinned.find(
      (revision) =>
        !revision.tombstone &&
        revision.name === name &&
        revision.resource_identity === resourceIdentity,
    )?.binding_id ?? null;
}

function resolveBindings(
  tx: Transaction,
  mission: Mission,
  entry: NormalizedEntry,
  current: NodeRow | null,
  bindings: MissionBindings,
  environments: MissionEnvironments,
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
  const resolved = collect(violations, entry, () => {
    const named = resolveNodeBindings(
      tx,
      (inner, projectId, name) =>
        bindings.resolveBinding(inner, projectId, name),
      mission.project_id,
      intent,
      entry.bindings,
    );
    validateExternalLinkBindings(entry.external_links, named);
    guardEnvironmentMix(
      tx,
      { bindings, environments },
      mission.project_id,
      named.map((binding) => binding.binding_id),
    );
    return named;
  });
  const pinnedBinding = pinnedBindingOf(tx, bindings, current);
  return (resolved ?? []).map(
    (binding, index) =>
      pinnedBinding(entry.bindings[index]!, binding.resource_identity) ??
      binding.binding_id,
  );
}

function terminalOwner(
  identity: Pick<ResolvedImportEntry, "current" | "task">,
  currentNodes: Map<string, NodeRow>,
): boolean {
  const ownerId = identity.task?.owner_id ?? identity.current?.id;
  const owner = ownerId === undefined ? undefined : currentNodes.get(ownerId);
  return owner !== undefined && isTerminal(owner.state);
}

function currentContentOf(tx: Transaction, nodeId: string): Content {
  const row = readCurrentRevision(tx, nodeId);
  assert.ok(row, "A current node has a revision.");
  return revisionFromRow(tx, row).content;
}

function storedContent(
  tx: Transaction,
  identity: Pick<ResolvedImportEntry, "current" | "task">,
): Pick<ResolvedImportEntry, "binding_ids" | "intent"> {
  if (identity.task !== null)
    return { binding_ids: identity.task.content.bindings, intent: null };
  assert.ok(identity.current, "A terminal entry has an identity.");
  const content = currentContentOf(tx, identity.current.id);
  return { binding_ids: content.bindings, intent: content.intent };
}

function verificationsByOwner(
  result: ResolvedImport,
): Map<string, Set<string>> {
  const covered = new Map<string, Set<string>>();
  for (const item of result.resolved_entries) {
    if (!isTaskEntry(item.entry) || item.owner_id === null) continue;
    const commands = covered.get(item.owner_id) ?? new Set<string>();
    for (const command of item.entry.verifications) commands.add(command);
    covered.set(item.owner_id, commands);
  }
  return covered;
}

function needsVerificationCoverage(
  item: ResolvedImportEntry,
  covered: Map<string, Set<string>>,
): boolean {
  return (
    !isTaskEntry(item.entry) &&
    !item.terminal &&
    item.entry.intent === Intent.Implement &&
    covered.has(item.key)
  );
}

function checkVerificationCoverage(result: ResolvedImport): void {
  const covered = verificationsByOwner(result);
  for (const item of result.resolved_entries) {
    if (!needsVerificationCoverage(item, covered)) continue;
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
    const targets = item.terminal
      ? result.current_dependencies
          .filter((edge) => edge.dependent === item.key)
          .map((edge) => edge.depends_on)
      : entry.depends_on.map((name) =>
          resolveReference(
            entry,
            name,
            REFERENCE.DependsOn,
            byFilename,
            result.violations,
          ),
        );
    for (const key of targets) if (key !== null) item.depends_on.add(key);
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

function contentDiffers(tx: Transaction, item: ResolvedImportEntry): boolean {
  const { entry, current } = item;
  assert.ok(current, "Only an existing identity can be compared.");
  assert.ok(!isTaskEntry(entry), "Only a node file is compared to a node.");
  const content: Content = {
    name: entry.name,
    requirement: entry.requirement,
    criterion: entry.criterion,
    verifications: entry.verifications,
    bindings: item.binding_ids,
    intent: entry.intent as Intent,
    tags: entry.tags,
    external_links: entry.external_links,
    ...commitTypeField(entry.commit_type),
  };
  return (
    canonicalJSON(currentContentOf(tx, current.id)) !== canonicalJSON(content)
  );
}

function entryChanged(tx: Transaction, item: ResolvedImportEntry): boolean {
  const { entry, current } = item;
  assert.ok(current, "Only an existing identity can be compared.");
  assert.equal(current.retired_at, null, "Compared identity is current.");
  assert.ok(!isTaskEntry(entry), "Only a node file is compared to a node.");
  if (item.terminal) return current.filename !== entry.filename;
  return current.filename !== entry.filename || contentDiffers(tx, item);
}

type NodeEntry = Exclude<NormalizedEntry, ParsedTaskFile>;

function serverEntry(entry: NodeEntry, server: Content): NodeEntry {
  const base = { ...entry };
  delete base.commit_type;
  return {
    ...base,
    name: server.name,
    requirement: server.requirement,
    criterion: server.criterion,
    verifications: server.verifications,
    intent: server.intent,
    tags: server.tags,
    external_links: server.external_links,
    ...commitTypeField(server.commit_type),
  };
}

function digestEntries(
  tx: Transaction,
  resolved: ResolvedImport,
): NormalizedEntry[] {
  const drifted = new Set(resolved.drifts.map((drift) => drift.node_id));
  return resolved.resolved_entries.map((item) =>
    item.current !== null &&
    drifted.has(item.current.id) &&
    !isTaskEntry(item.entry)
      ? serverEntry(item.entry, currentContentOf(tx, item.current.id))
      : item.entry,
  );
}

function driftOf(tx: Transaction, item: ResolvedImportEntry): Drift | null {
  const { entry, current } = item;
  if (!item.terminal || current === null || isTaskEntry(entry)) return null;
  if (!contentDiffers(tx, item)) return null;
  const row = readCurrentRevision(tx, current.id);
  assert.ok(row, "A current node has a revision.");
  return {
    node_id: current.id,
    filename: current.filename,
    visible_revision: row.revision,
  };
}

function taskChanged(item: ResolvedImportEntry): boolean {
  const { entry, task } = item;
  assert.ok(task, "Only an existing task can be compared.");
  if (item.terminal)
    return task.filename !== entry.filename || task.owner_id !== item.owner_id;
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

function addMovedOwner(item: ResolvedImportEntry, owners: Set<string>): void {
  if (item.owner_id !== null && item.task?.owner_id !== item.owner_id)
    owners.add(item.owner_id);
}

function changedTaskOwners(result: ResolvedImport): Set<string> {
  const keptTasks = new Set<string>();
  const owners = new Set<string>();
  for (const item of result.resolved_entries) {
    if (!isTaskEntry(item.entry)) continue;
    addMovedOwner(item, owners);
    if (item.task === null) continue;
    keptTasks.add(item.task.id);
    if (taskChanged(item)) {
      owners.add(item.task.owner_id);
      if (item.owner_id !== null) owners.add(item.owner_id);
    }
  }
  for (const task of result.current_tasks.values())
    if (!keptTasks.has(task.id)) owners.add(task.owner_id);
  return owners;
}

function dependsOnChanged(
  result: ResolvedImport,
  item: ResolvedImportEntry,
): boolean {
  const previous = result.current_dependencies
    .filter((edge) => edge.dependent === item.key)
    .map((edge) => edge.depends_on)
    .sort();
  return canonicalJSON(previous) !== canonicalJSON([...item.depends_on].sort());
}

interface ClassifyScope {
  tx: Transaction;
  result: ResolvedImport;
  owners: Set<string>;
  kept: Set<string>;
}

function classifyEntry(scope: ClassifyScope, item: ResolvedImportEntry): void {
  const { tx, result, owners, kept } = scope;
  if (item.entry.id === undefined) {
    result.creates.push(item.entry.filename);
    return;
  }
  if (isTaskEntry(item.entry)) return;
  assert.ok(item.current, "Supplied identities resolve before classification.");
  kept.add(item.current.id);
  const contentChanged = entryChanged(tx, item) || owners.has(item.current.id);
  if (contentChanged) result.content_updates.push(item.current.id);
  const target =
    contentChanged || dependsOnChanged(result, item)
      ? result.updates
      : result.no_ops;
  target.push(item.current.id);
}

function classify(tx: Transaction, result: ResolvedImport): void {
  assert.equal(
    result.violations.length,
    NO_VIOLATIONS,
    "Classification requires a valid resolved graph.",
  );
  const scope: ClassifyScope = {
    tx,
    result,
    owners: changedTaskOwners(result),
    kept: new Set<string>(),
  };
  for (const item of result.resolved_entries) classifyEntry(scope, item);
  result.drifts = result.resolved_entries
    .flatMap((item) => driftOf(tx, item) ?? [])
    .sort((a, b) => a.filename.localeCompare(b.filename));
  result.retirements = [...result.current_nodes.keys()]
    .filter((id) => !scope.kept.has(id))
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
  environments: MissionEnvironments,
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
    drifts: [],
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
    const identity = resolveIdentity(
      tx,
      mission,
      entry,
      seen,
      result.violations,
      currentTasks,
    );
    const terminal = terminalOwner(identity, currentNodes);
    result.resolved_entries.push({
      entry,
      key: entry.id ?? `${TEMPORARY_KEY_PREFIX}${entry.filename}`,
      ...identity,
      owner_id: null,
      depends_on: new Set(),
      ...(terminal
        ? storedContent(tx, identity)
        : {
            binding_ids: resolveBindings(
              tx,
              mission,
              entry,
              identity.current,
              bindings,
              environments,
              result.violations,
            ),
            intent: isTaskEntry(entry) ? null : (entry.intent as Intent),
          }),
      terminal,
    });
  }
  resolveGraph(result);
  if (result.violations.length === NO_VIOLATIONS) classify(tx, result);
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

function visibleRevisionOf(
  tx: Transaction,
  nodeId: string,
): { visible_revision: number; reason: string } {
  const row = readCurrentRevision(tx, nodeId);
  assert.ok(row, "A current node has a revision.");
  return { visible_revision: row.revision, reason: row.reason };
}

interface ConditionScope {
  tx: Transaction;
  resolved: ResolvedImport;
  modified: Set<string>;
  retiring: Set<string>;
}

function locatorOf(node: NodeRow): Locator {
  return { id: node.id, filename: node.filename };
}

function terminalChangeViolation(
  scope: ConditionScope,
  node: NodeRow,
): Violation {
  return violation(
    MissionErrorCode.TerminalChange,
    scope.retiring.has(node.id)
      ? "Import cannot retire a terminal node. Keep its unchanged file in the plan."
      : "Import cannot change a terminal node.",
    { node_id: node.id },
    locatorOf(node),
  );
}

function heldAttemptViolation(scope: ConditionScope, node: NodeRow): Violation {
  const retiring = scope.retiring.has(node.id);
  return violation(
    MissionErrorCode.ConditionFailed,
    retiring
      ? "Import cannot retire a node that holds an attempt. Discard the node, then keep its unchanged file in the plan."
      : "Node holds an attempt and its server revision differs. Run mission export and copy this node file into the plan.",
    retiring
      ? { state: node.state, attempt: node.attempt }
      : {
          state: node.state,
          attempt: node.attempt,
          ...visibleRevisionOf(scope.tx, node.id),
          remedy: EXPORT_REMEDY,
        },
    locatorOf(node),
  );
}

function dependencyEditViolation(
  scope: ConditionScope,
  node: NodeRow,
): Violation | null {
  const { tx, resolved } = scope;
  const previous = new Set(
    resolved.current_dependencies
      .filter((edge) => edge.dependent === node.id)
      .map((edge) => edge.depends_on),
  );
  const next = resolved.dependencies.get(node.id) ?? new Set<string>();
  const adding = [...next].some((target) => !previous.has(target));
  const removing = [...previous].some((target) => !next.has(target));
  if (!(adding || removing) || !dependencyEditGuarded(tx, node, adding))
    return null;
  return violation(
    ControlError.StateConflict,
    "Node state refuses a dependency edit.",
    { state: node.state, attempt: node.attempt },
    locatorOf(node),
  );
}

function nodeConditionViolation(
  scope: ConditionScope,
  node: NodeRow,
): Violation | null {
  if (isTerminal(node.state)) return terminalChangeViolation(scope, node);
  if (
    scope.modified.has(node.id) &&
    !importAdmissible(node.state, node.attempt)
  )
    return heldAttemptViolation(scope, node);
  return dependencyEditViolation(scope, node);
}

export function checkImportCondition(
  tx: Transaction,
  resolved: ResolvedImport,
): Violation[] {
  assert.equal(resolved.violations.length, NO_VIOLATIONS);
  const violations: Violation[] = [];
  const modified = modifiedNodes(resolved);
  const scope: ConditionScope = {
    tx,
    resolved,
    modified,
    retiring: new Set(resolved.retirements),
  };
  for (const id of [...new Set([...modified, ...resolved.updates])].sort()) {
    const node = readNode(tx, id);
    assert.ok(node, "Modified nodes exist in the transaction.");
    const found = nodeConditionViolation(scope, node);
    if (found !== null) violations.push(found);
  }
  return violations;
}

export interface PreparedImport {
  preview: ImportPreview;
  resolved: ResolvedImport | null;
}

type PreviewClassification = Pick<
  ImportPreview,
  "creates" | "updates" | "retirements" | "removed_edges" | "no_ops" | "drifts"
>;

interface PreviewSource {
  mission: Mission;
  snapshot: ImportSnapshot;
  normalized: NormalizedSnapshot;
  resolved: ResolvedImport | null;
}

function classificationOf(
  resolved: ResolvedImport | null,
): PreviewClassification {
  if (resolved === null)
    return {
      creates: [],
      updates: [],
      retirements: [],
      removed_edges: [],
      no_ops: [],
      drifts: [],
    };
  return {
    creates: resolved.creates,
    updates: resolved.updates,
    retirements: resolved.retirements,
    removed_edges: resolved.removed_edges,
    no_ops: resolved.no_ops,
    drifts: resolved.drifts,
  };
}

function previewViolations(
  tx: Transaction,
  source: PreviewSource,
): Violation[] {
  const { normalized, resolved } = source;
  if (resolved === null) return normalized.violations;
  if (resolved.violations.length > NO_VIOLATIONS) return resolved.violations;
  return checkImportCondition(tx, resolved);
}

function previewOf(tx: Transaction, source: PreviewSource): ImportPreview {
  const { mission, snapshot, normalized, resolved } = source;
  const violations = previewViolations(tx, source);
  const classification = classificationOf(resolved);
  return {
    mission_id: mission.id,
    expected_mission_version: snapshot.mission_version,
    preview_digest: importDigest(
      mission.id,
      snapshot.mission_version,
      resolved === null ? normalized.entries : digestEntries(tx, resolved),
      classification,
    ),
    ...classification,
    violations,
  };
}

export function prepareImport(
  tx: Transaction,
  mission: Mission,
  snapshot: ImportSnapshot,
  routeMissionId: string,
  bindings: MissionBindings,
  environments: MissionEnvironments,
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
      ? resolveImportSet(
          tx,
          mission,
          normalized.entries,
          bindings,
          environments,
        )
      : null;
  return {
    resolved,
    preview: previewOf(tx, { mission, snapshot, normalized, resolved }),
  };
}

export function importDigest(
  missionId: string,
  missionVersion: number,
  entries: NormalizedEntry[],
  classification: Pick<ImportPreview, "creates" | "updates" | "retirements">,
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
    creates: [...classification.creates].sort(),
    updates: [...classification.updates].sort(),
    retirements: [...classification.retirements].sort(),
  });
}
