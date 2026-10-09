import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { canonicalJSON, digest } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
import { importAdmissible, isTerminal } from "./admission.ts";
import {
  checkBindingRuleTable,
  validateFilename,
  validateNodeContent,
  validateText,
  type ResolvedBinding,
} from "./content.ts";
import {
  EdgeKind,
  ImportFormat,
  MissionErrorCode,
  NodeKind,
  planFileNameSchema,
  type Content,
  type Edge,
  type ImportEntry,
  type ImportPreview,
  type ImportSnapshot,
  type Mission,
  type MissionBindings,
  type Violation,
} from "./contract.ts";
import { hasDependencyCycle, type DepEdge } from "./graph.ts";
import { nodeRecord } from "./node-read.ts";
import { parsePlanFile, type ParsedPlanFile } from "./parser.ts";
import {
  readDependencies,
  readMissionNodes,
  readNode,
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
const REFERENCE = { Parent: "parent", DependsOn: "depends_on" } as const;
const PLAN_REASON = {
  ParentRequired: "parent_required",
  ParentForbidden: "parent_forbidden",
  DependsOnForbidden: "depends_on_forbidden",
  DependsOnRepeated: "depends_on_repeated",
  ReferenceInvalid: "reference_invalid",
} as const;
type Reference = (typeof REFERENCE)[keyof typeof REFERENCE];
type Locator = Pick<NormalizedEntry, "filename" | "id">;

export type NormalizedEntry = ParsedPlanFile;

export interface NormalizedSnapshot {
  entries: NormalizedEntry[];
  violations: Violation[];
}

export interface ResolvedImportEntry {
  entry: NormalizedEntry;
  key: string;
  current: NodeRow | null;
  parent_id: string | null;
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
  current_dependencies: DepEdge[];
  parent_map: Map<string, string>;
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
    node_id: entry?.id ?? null,
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
  if (entry.kind === NodeKind.Initiative && entry.parent !== undefined)
    reasons.push(PLAN_REASON.ParentForbidden);
  if (entry.kind !== NodeKind.Initiative && entry.parent === undefined)
    reasons.push(PLAN_REASON.ParentRequired);
  if (entry.kind === NodeKind.Task && entry.depends_on !== undefined)
    reasons.push(PLAN_REASON.DependsOnForbidden);
  const dependencies = entry.depends_on ?? [];
  if (new Set(dependencies).size !== dependencies.length)
    reasons.push(PLAN_REASON.DependsOnRepeated);
  const references =
    entry.parent === undefined ? dependencies : [entry.parent, ...dependencies];
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
  return {
    filename: entry.filename,
    ...(entry.id === undefined ? {} : { id: entry.id }),
    kind: entry.kind,
    ...(entry.parent === undefined ? {} : { parent: entry.parent }),
    depends_on: [...(entry.depends_on ?? [])],
    bindings: [...entry.bindings],
    name: entry.name,
    requirement: entry.requirement,
    criterion: entry.criterion,
    verifications: [...entry.verifications],
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
    const rules =
      "content" in input && parsed.kind === NodeKind.Task
        ? { ...parsed, depends_on: undefined }
        : parsed;
    planRules(rules, violations);
    collect(violations, parsed, () =>
      validateNodeContent(parsed.kind, parsed, textMaxBytes),
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
): NodeRow | null {
  if (entry.id === undefined) return null;
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
    return null;
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
  if (current.kind !== entry.kind)
    violations.push(
      violation(
        MissionErrorCode.KindChanged,
        "Node kind cannot change.",
        { id, kind: entry.kind, current_kind: current.kind },
        entry,
      ),
    );
  return current;
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
  const expectedParent =
    entry.kind === NodeKind.Task ? NodeKind.Objective : NodeKind.Initiative;
  const valid =
    reference === REFERENCE.Parent
      ? target.entry.kind === expectedParent
      : target.entry.kind !== NodeKind.Task;
  if (!valid) {
    violations.push(
      violation(
        MissionErrorCode.ReferenceKindInvalid,
        "Plan reference names the wrong node kind.",
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
  const resolved: ResolvedBinding[] = [];
  for (const name of entry.bindings) {
    const binding = collect(violations, entry, () =>
      bindings.resolveBinding(tx, mission.project_id, name),
    );
    if (binding === undefined) continue;
    if (binding === null) {
      violations.push(
        violation(
          MissionErrorCode.BindingsInvalid,
          "Binding name could not be resolved.",
          { binding: name },
          entry,
        ),
      );
      continue;
    }
    resolved.push(binding);
  }
  if (resolved.length === entry.bindings.length)
    collect(violations, entry, () =>
      checkBindingRuleTable(entry.kind, resolved),
    );
  return resolved.map((binding) => binding.binding_id);
}

function checkVerificationCoverage(result: ResolvedImport): void {
  const covered = new Map<string, Set<string>>();
  for (const item of result.resolved_entries) {
    if (item.entry.kind !== NodeKind.Task || item.parent_id === null) continue;
    const commands = covered.get(item.parent_id) ?? new Set<string>();
    for (const command of item.entry.verifications) commands.add(command);
    covered.set(item.parent_id, commands);
  }
  for (const item of result.resolved_entries) {
    if (item.entry.kind !== NodeKind.Objective) continue;
    for (const command of item.entry.verifications)
      if (!covered.get(item.key)?.has(command))
        result.violations.push(
          violation(
            MissionErrorCode.VerificationUncovered,
            "Objective verification is not held by a task of the objective.",
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
    if (entry.parent !== undefined)
      item.parent_id = resolveReference(
        entry,
        entry.parent,
        REFERENCE.Parent,
        byFilename,
        result.violations,
      );
    if (item.parent_id !== null)
      result.parent_map.set(item.key, item.parent_id);
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
  const runnable = result.resolved_entries
    .filter((item) => item.entry.kind !== NodeKind.Task)
    .map((item) => item.key);
  if (hasDependencyCycle(runnable, edges, result.parent_map))
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
  const content: Content = {
    name: entry.name,
    requirement: entry.requirement,
    criterion: entry.criterion,
    verifications: entry.verifications,
    bindings: item.binding_ids,
  };
  return (
    current.filename !== entry.filename ||
    current.parent_id !== item.parent_id ||
    canonicalJSON(nodeRecord(tx, current, bindings).content) !==
      canonicalJSON(content)
  );
}

function droppedEdges(result: ResolvedImport): Edge[] {
  const containment: Extract<Edge, { kind: typeof EdgeKind.Containment }>[] =
    [];
  for (const node of result.current_nodes.values()) {
    if (node.parent_id === null || !result.current_nodes.has(node.parent_id))
      continue;
    if (result.parent_map.get(node.id) === node.parent_id) continue;
    containment.push({
      kind: EdgeKind.Containment,
      parent_id: node.parent_id,
      child_id: node.id,
    });
  }
  containment.sort(
    (a, b) =>
      a.parent_id.localeCompare(b.parent_id) ||
      a.child_id.localeCompare(b.child_id),
  );
  const dependencies = result.current_dependencies
    .filter(
      (edge) => !result.dependencies.get(edge.dependent)?.has(edge.depends_on),
    )
    .map((edge) => ({
      kind: EdgeKind.Dependency,
      dependent_id: edge.dependent,
      depends_on_id: edge.depends_on,
    }));
  dependencies.sort(
    (a, b) =>
      a.dependent_id.localeCompare(b.dependent_id) ||
      a.depends_on_id.localeCompare(b.depends_on_id),
  );
  return [...containment, ...dependencies];
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
  for (const item of result.resolved_entries) {
    if (item.entry.id === undefined) {
      result.creates.push(item.entry.filename);
      continue;
    }
    assert.ok(
      item.current,
      "Supplied identities resolve before classification.",
    );
    kept.add(item.current.id);
    const contentChanged = entryChanged(tx, item, bindings);
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
    current_dependencies: readDependencies(tx, mission.id).filter(
      (edge) =>
        currentNodes.has(edge.dependent) && currentNodes.has(edge.depends_on),
    ),
    parent_map: new Map(),
    dependencies: new Map(),
  };
  const seen = new Set<string>();
  for (const entry of entries) {
    result.resolved_entries.push({
      entry,
      key: entry.id ?? `${TEMPORARY_KEY_PREFIX}${entry.filename}`,
      current: resolveIdentity(tx, mission, entry, seen, result.violations),
      parent_id: null,
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
  for (const item of resolved.resolved_entries) {
    const { current } = item;
    if (current === null) {
      add(item.parent_id);
      continue;
    }
    if (!updates.has(current.id)) continue;
    if (current.kind !== NodeKind.Task) add(current.id);
    if (
      current.kind === NodeKind.Task ||
      current.parent_id !== item.parent_id
    ) {
      add(current.parent_id);
      add(item.parent_id);
    }
  }
  for (const id of retiring) {
    const node = resolved.current_nodes.get(id);
    assert.ok(node, "Retirements name current nodes.");
    add(node.kind === NodeKind.Task ? node.parent_id : node.id);
    if (node.parent_id !== null && !retiring.has(node.parent_id))
      add(node.parent_id);
  }
  return modified;
}

export function checkImportCondition(
  tx: Transaction,
  resolved: ResolvedImport,
): Violation[] {
  assert.equal(resolved.violations.length, NO_VIOLATIONS);
  const violations: Violation[] = [];
  const modified = modifiedNodes(resolved);
  const dependents = resolved.updates.filter(
    (id) => resolved.current_nodes.get(id)?.kind !== NodeKind.Task,
  );
  for (const id of [...new Set([...modified, ...dependents])].sort()) {
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
    if (modified.has(id) && !importAdmissible(node.state, node.attempt))
      violations.push(
        violation(
          MissionErrorCode.ConditionFailed,
          "Node does not satisfy the import condition.",
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

export function previewImport(
  tx: Transaction,
  mission: Mission,
  snapshot: ImportSnapshot,
  routeMissionId: string,
  bindings: MissionBindings,
  textMaxBytes: number,
): ImportPreview {
  return prepareImport(
    tx,
    mission,
    snapshot,
    routeMissionId,
    bindings,
    textMaxBytes,
  ).preview;
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
