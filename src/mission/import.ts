import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { canonicalJSON, digest } from "../kernel/json.ts";
import type { Transaction } from "../kernel/store.ts";
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
  type ImportSnapshot,
  type Mission,
  type MissionBindings,
  type Violation,
} from "./contract.ts";
import { closureEdges, detectCycle, type DepEdge } from "./graph.ts";
import { nodeRecord } from "./node-read.ts";
import { parsePlanFile, type ParsedPlanFile } from "./parser.ts";
import {
  readDependencies,
  readMissionNodes,
  readNode,
  type NodeRow,
} from "./store.ts";

const ZERO = 0;
const SORT_BEFORE = -1;
const SORT_AFTER = 1;
const REASON_FIELD = "reason";
const TEMPORARY_KEY_PREFIX = "file:";
const REFERENCE = { Parent: "parent", DependsOn: "dependsOn" } as const;
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
  parentId: string | null;
  dependsOn: Set<string>;
  bindingIds: string[];
}

export interface ResolvedImport {
  violations: Violation[];
  creates: string[];
  updates: string[];
  noOps: string[];
  retirements: string[];
  removedEdges: Edge[];
  resolvedEntries: ResolvedImportEntry[];
  currentNodes: Map<string, NodeRow>;
  currentDependencies: DepEdge[];
  parentMap: Map<string, string>;
  dependencies: Map<string, Set<string>>;
}

function violation(
  code: string,
  message: string,
  details: Violation["details"],
  entry?: Locator,
): Violation {
  assert.ok(code.length > ZERO, "Violations have an error code.");
  assert.ok(message.length > ZERO, "Violations explain their failure.");
  return {
    code,
    message,
    details,
    filename: entry?.filename ?? null,
    nodeId: entry?.id ?? null,
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
  if (entry.kind === NodeKind.Task && entry.dependsOn !== undefined)
    reasons.push(PLAN_REASON.DependsOnForbidden);
  const dependencies = entry.dependsOn ?? [];
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
    dependsOn: [...(entry.dependsOn ?? [])],
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
  assert.ok(textMaxBytes > ZERO, "Text limit is positive.");
  validateText(REASON_FIELD, snapshot.reason, textMaxBytes);
  const result: NormalizedSnapshot = { entries: [], violations: [] };
  const { entries, violations } = result;
  if (snapshot.missionId !== routeMissionId)
    violations.push(
      violation(
        MissionErrorCode.MissionMismatch,
        "Snapshot belongs to another mission.",
        { missionId: snapshot.missionId },
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
        ? { ...parsed, dependsOn: undefined }
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
        { id, kind: entry.kind, currentKind: current.kind },
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
      bindings.resolveBinding(tx, mission.projectId, name),
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
  return resolved.map((binding) => binding.bindingId);
}

function resolveGraph(result: ResolvedImport): void {
  const byFilename = new Map(
    result.resolvedEntries.map((item) => [item.entry.filename, item]),
  );
  for (const item of result.resolvedEntries) {
    const { entry } = item;
    if (entry.parent !== undefined)
      item.parentId = resolveReference(
        entry,
        entry.parent,
        REFERENCE.Parent,
        byFilename,
        result.violations,
      );
    if (item.parentId !== null) result.parentMap.set(item.key, item.parentId);
    for (const name of entry.dependsOn) {
      const key = resolveReference(
        entry,
        name,
        REFERENCE.DependsOn,
        byFilename,
        result.violations,
      );
      if (key !== null) item.dependsOn.add(key);
    }
    result.dependencies.set(item.key, item.dependsOn);
  }
  const keys = new Set(result.resolvedEntries.map((item) => item.key));
  if (keys.size !== result.resolvedEntries.length) return;
  const edges = result.resolvedEntries.flatMap((item) =>
    [...item.dependsOn].map((dependsOn) => ({
      dependent: item.key,
      dependsOn,
    })),
  );
  const runnable = result.resolvedEntries
    .filter((item) => item.entry.kind !== NodeKind.Task)
    .map((item) => item.key);
  if (detectCycle(closureEdges(runnable, edges, result.parentMap)))
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
  dependencies: DepEdge[],
): boolean {
  const { entry, current } = item;
  assert.ok(current, "Only an existing identity can be compared.");
  assert.equal(current.retired_at, null, "Compared identity is current.");
  const content: Content = {
    name: entry.name,
    requirement: entry.requirement,
    criterion: entry.criterion,
    verifications: entry.verifications,
    bindings: item.bindingIds,
  };
  const previous = dependencies
    .filter((edge) => edge.dependent === current.id)
    .map((edge) => edge.dependsOn)
    .sort();
  return (
    current.filename !== entry.filename ||
    current.parent_id !== item.parentId ||
    canonicalJSON(nodeRecord(tx, current).content) !== canonicalJSON(content) ||
    canonicalJSON(previous) !== canonicalJSON([...item.dependsOn].sort())
  );
}

function droppedEdges(result: ResolvedImport): Edge[] {
  const containment: Extract<Edge, { kind: typeof EdgeKind.Containment }>[] =
    [];
  for (const node of result.currentNodes.values()) {
    if (node.parent_id === null || !result.currentNodes.has(node.parent_id))
      continue;
    if (result.parentMap.get(node.id) === node.parent_id) continue;
    containment.push({
      kind: EdgeKind.Containment,
      parentId: node.parent_id,
      childId: node.id,
    });
  }
  containment.sort(
    (a, b) =>
      a.parentId.localeCompare(b.parentId) ||
      a.childId.localeCompare(b.childId),
  );
  const dependencies = result.currentDependencies
    .filter(
      (edge) => !result.dependencies.get(edge.dependent)?.has(edge.dependsOn),
    )
    .map((edge) => ({
      kind: EdgeKind.Dependency,
      dependentId: edge.dependent,
      dependsOnId: edge.dependsOn,
    }));
  dependencies.sort(
    (a, b) =>
      a.dependentId.localeCompare(b.dependentId) ||
      a.dependsOnId.localeCompare(b.dependsOnId),
  );
  return [...containment, ...dependencies];
}

function classify(tx: Transaction, result: ResolvedImport): void {
  assert.equal(
    result.violations.length,
    ZERO,
    "Classification requires a valid resolved graph.",
  );
  const kept = new Set<string>();
  for (const item of result.resolvedEntries) {
    if (item.entry.id === undefined) {
      result.creates.push(item.entry.filename);
      continue;
    }
    assert.ok(
      item.current,
      "Supplied identities resolve before classification.",
    );
    kept.add(item.current.id);
    const target = entryChanged(tx, item, result.currentDependencies)
      ? result.updates
      : result.noOps;
    target.push(item.current.id);
  }
  result.retirements = [...result.currentNodes.keys()]
    .filter((id) => !kept.has(id))
    .sort();
  result.creates.sort();
  result.updates.sort();
  result.noOps.sort();
  result.removedEdges = droppedEdges(result);
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
  assert.ok(mission.version > ZERO, "Mission has a persisted version.");
  const currentNodes = new Map(
    readMissionNodes(tx, mission.id)
      .filter((node) => node.retired_at === null)
      .map((node) => [node.id, node]),
  );
  const result: ResolvedImport = {
    violations: [],
    creates: [],
    updates: [],
    noOps: [],
    retirements: [],
    removedEdges: [],
    resolvedEntries: [],
    currentNodes,
    currentDependencies: readDependencies(tx, mission.id).filter(
      (edge) =>
        currentNodes.has(edge.dependent) && currentNodes.has(edge.dependsOn),
    ),
    parentMap: new Map(),
    dependencies: new Map(),
  };
  const seen = new Set<string>();
  for (const entry of entries) {
    result.resolvedEntries.push({
      entry,
      key: entry.id ?? `${TEMPORARY_KEY_PREFIX}${entry.filename}`,
      current: resolveIdentity(tx, mission, entry, seen, result.violations),
      parentId: null,
      dependsOn: new Set(),
      bindingIds: resolveBindings(
        tx,
        mission,
        entry,
        bindings,
        result.violations,
      ),
    });
  }
  resolveGraph(result);
  if (result.violations.length === ZERO) classify(tx, result);
  return result;
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
    missionVersion > ZERO,
    "Digest covers a persisted mission version.",
  );
  return digest({
    missionId,
    missionVersion,
    entries: [...entries].sort((a, b) =>
      a.filename === b.filename
        ? ZERO
        : a.filename < b.filename
          ? SORT_BEFORE
          : SORT_AFTER,
    ),
    retirements: [...retirements].sort(),
  });
}
