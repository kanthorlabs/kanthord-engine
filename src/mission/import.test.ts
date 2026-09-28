import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { digest } from "../kernel/json.ts";
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import {
  ActorKind,
  EdgeKind,
  ImportFormat,
  MISSION_SERVICE_NAME,
  MissionErrorCode,
  NodeKind,
  NodeState,
  RevisionWrite,
  importApplySchema,
  importSnapshotSchema,
  nodeCreateSchema,
  planFileNameSchema,
  type Content,
  type ImportEntry,
  type ImportSnapshot,
  type Mission,
  type MissionBindings,
} from "./contract.ts";
import {
  checkImportCondition,
  importDigest,
  normalizeImportSnapshot,
  prepareImport,
  resolveImportSet,
  type NormalizedEntry,
} from "./import.ts";
import { missionMigrations } from "./migrations.ts";
import { parsePlanFile } from "./parser.ts";
import {
  insertDependency,
  insertMission,
  insertNode,
  insertRevision,
} from "./store.ts";

const TEXT_MAX_BYTES = 32768;
const VERSION = 1;
const CREATED_AT = 1000;
const RETIRED_AT = 2000;
const ZERO = 0;
const ONE = 1;
const MISSION_ID = "mission_00000000000000000000000000";
const PROJECT_ID = "project_00000000000000000000000000";
const OTHER_MISSION_ID = "mission_00000000000000000000000001";
const UNKNOWN_ID = "node_00000000000000000000000000";
const BINDING_ID = "binding_00000000000000000000000000";
const NEXT_BINDING_ID = "binding_00000000000000000000000001";
const REPOSITORY = "repo";
const MISSING_BINDING = "missing";
const INVALID_FILENAME = "../Bad.md";
const REASON = "Import plan";
const OBJECTIVE_FILENAME = "o.md";
const TASK_FILENAME = "t.md";
const TEMPORARY_A_KEY = "file:a.md";
const actor = { kind: ActorKind.Human, account: "test", name: "Test" } as const;
const content: Content = {
  name: "Node",
  requirement: "Requirement",
  criterion: "Criterion",
  verifications: ["true"],
  bindings: [],
};
const bindings: MissionBindings = {
  resolveBinding: (_tx, projectId, name) => {
    assert.equal(projectId, PROJECT_ID);
    return name === REPOSITORY
      ? { bindingId: BINDING_ID, resourceIdentity: "repository:example" }
      : null;
  },
  getBindingRevision: () =>
    assert.fail("Import resolves names, not historical bindings."),
};
const markdown = `---
kind: initiative
bindings: []
verifications: [true-command]
---
# Node
## Requirement
Requirement
## Criterion
Criterion
`;

function entry(
  filename = "a.md",
  extra: Partial<NormalizedEntry> = {},
): NormalizedEntry {
  return {
    filename,
    kind: NodeKind.Initiative,
    ...structuredClone(content),
    dependsOn: [],
    ...extra,
  };
}

function snapshot(
  entries: ImportEntry[],
  missionId = MISSION_ID,
): ImportSnapshot {
  return {
    format: ImportFormat.Json,
    missionId,
    missionVersion: VERSION,
    reason: REASON,
    entries,
  };
}

function normalize(entries: ImportEntry[]) {
  return normalizeImportSnapshot(snapshot(entries), MISSION_ID, TEXT_MAX_BYTES);
}

function contentOf(item: NormalizedEntry, pinned = false): Content {
  return {
    name: item.name,
    requirement: item.requirement,
    criterion: item.criterion,
    verifications: item.verifications,
    bindings: pinned ? item.bindings.map(() => BINDING_ID) : item.bindings,
  };
}

function seed(
  tx: Transaction,
  mission: Mission,
  inputs: NormalizedEntry[],
): NormalizedEntry[] {
  const entries = inputs.map((item) => ({
    ...item,
    id: item.id ?? createIdentity("node"),
  }));
  const ids = new Map(entries.map((item) => [item.filename, item.id]));
  for (const item of entries)
    insertNode(tx, {
      id: item.id,
      mission_id: mission.id,
      kind: item.kind,
      filename: item.filename,
      parent_id: item.parent === undefined ? null : ids.get(item.parent)!,
      created_at: CREATED_AT,
    });
  for (const item of entries) {
    for (const name of item.dependsOn)
      insertDependency(tx, mission.id, item.id, ids.get(name)!);
    if (item.kind === NodeKind.Task) continue;
    insertRevision(tx, {
      nodeId: item.id,
      filename: item.filename,
      revision: VERSION,
      reason: REASON,
      actor,
      createdAt: CREATED_AT,
      content: contentOf(item, true),
      ...(item.kind === NodeKind.Objective
        ? {
            tasks: entries
              .filter((task) => task.parent === item.filename)
              .map((task) => ({
                id: task.id,
                filename: task.filename,
                content: contentOf(task, true),
              })),
          }
        : {}),
      change: {
        write: RevisionWrite.Import,
        previousRevision: null,
        changedFields: [],
      },
      pinnedByAttempts: [],
    });
  }
  return entries;
}

function fixture(t: TestContext, inputs = [entry()]) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: MISSION_SERVICE_NAME, migrations: missionMigrations },
  ]);
  const mission = store.transaction((tx) => ({
    id: insertMission(tx, PROJECT_ID, CREATED_AT),
    projectId: PROJECT_ID,
    version: VERSION,
  }));
  const entries = store.transaction((tx) => seed(tx, mission, inputs));
  const resolve = (set = entries, resolver = bindings) =>
    store.transaction((tx) => resolveImportSet(tx, mission, set, resolver));
  return { store, mission, entries, resolve };
}

function hierarchy(): NormalizedEntry[] {
  return [
    entry("a.md"),
    entry("b.md"),
    entry("o.md", {
      kind: NodeKind.Objective,
      parent: "a.md",
      bindings: [REPOSITORY],
    }),
    entry("p.md", {
      kind: NodeKind.Objective,
      parent: "b.md",
      bindings: [REPOSITORY],
    }),
    entry("t.md", { kind: NodeKind.Task, parent: "o.md" }),
  ];
}

function item(entries: NormalizedEntry[], filename: string): NormalizedEntry {
  const found = entries.find((value) => value.filename === filename);
  assert.ok(found);
  return found;
}

function change(
  entries: NormalizedEntry[],
  filename: string,
  patch: Partial<NormalizedEntry>,
): NormalizedEntry[] {
  return entries.map((value) =>
    value.filename === filename ? { ...value, ...patch } : value,
  );
}

test("Markdown is parsed and JSON content bypasses Markdown grammar", () => {
  const result = normalizeImportSnapshot(
    {
      format: ImportFormat.Markdown,
      missionId: MISSION_ID,
      missionVersion: VERSION,
      reason: REASON,
      files: [{ filename: "a.md", content: markdown }],
    },
    MISSION_ID,
    TEXT_MAX_BYTES,
  );
  assert.deepEqual(result, {
    entries: [parsePlanFile("a.md", markdown)],
    violations: [],
  });
  const json = entry("json.md", {
    name: "# not a Markdown heading",
    requirement: "## Arbitrary section",
  });
  assert.deepEqual(normalize([json]), { entries: [json], violations: [] });
});

test("malformed Markdown preserves parser details and omits the refused file", () => {
  const result = normalizeImportSnapshot(
    {
      format: ImportFormat.Markdown,
      missionId: MISSION_ID,
      missionVersion: VERSION,
      reason: REASON,
      files: [{ filename: "broken.md", content: "not a plan" }],
    },
    MISSION_ID,
    TEXT_MAX_BYTES,
  );
  assert.deepEqual(result.entries, []);
  assert.deepEqual(
    result.violations.map(({ code, filename, details }) => ({
      code,
      filename,
      details,
    })),
    [
      {
        code: MissionErrorCode.PlanInvalid,
        filename: "broken.md",
        details: { filename: "broken.md", reason: "front_matter_missing" },
      },
    ],
  );
});

test("import wire schemas accept malformed nonempty names but node writes remain strict", () => {
  const json = snapshot([
    entry(INVALID_FILENAME, {
      parent: INVALID_FILENAME,
      dependsOn: [INVALID_FILENAME],
    }),
  ]);
  const md = {
    format: ImportFormat.Markdown,
    missionId: MISSION_ID,
    missionVersion: VERSION,
    reason: REASON,
    files: [{ filename: INVALID_FILENAME, content: markdown }],
  };
  for (const value of [json, md]) {
    assert.ok(importSnapshotSchema.safeParse(value).success);
    assert.ok(
      importApplySchema.safeParse({
        ...value,
        previewDigest: "a".repeat(64),
        confirmedRetirements: [],
      }).success,
    );
  }
  assert.ok(!planFileNameSchema.safeParse(INVALID_FILENAME).success);
  assert.ok(
    !nodeCreateSchema.safeParse({
      filename: INVALID_FILENAME,
      kind: NodeKind.Initiative,
      content,
      reason: REASON,
      expectedMissionVersion: VERSION,
    }).success,
  );
  assert.ok(!importSnapshotSchema.safeParse(snapshot([entry("")])).success);
});

test("malformed filename becomes a located content violation", () => {
  const result = normalize([entry(INVALID_FILENAME)]);
  assert.deepEqual(
    result.violations.map(({ code, filename, details }) => ({
      code,
      filename,
      details,
    })),
    [
      {
        code: MissionErrorCode.ContentInvalid,
        filename: INVALID_FILENAME,
        details: { field: "filename" },
      },
    ],
  );
  assert.equal(result.entries.length, ONE);
});

test("every repeated filename after the first is a duplicate", () => {
  const result = normalize([entry(), entry(), entry()]);
  assert.deepEqual(
    result.violations.map(({ code, details }) => ({ code, details })),
    Array.from({ length: 2 }, () => ({
      code: MissionErrorCode.DuplicateFile,
      details: { filename: "a.md" },
    })),
  );
});

test("body mission mismatch has no file or node locator", () => {
  const result = normalizeImportSnapshot(
    snapshot([], OTHER_MISSION_ID),
    MISSION_ID,
    TEXT_MAX_BYTES,
  );
  assert.deepEqual(
    result.violations.map(({ code, filename, nodeId, details }) => ({
      code,
      filename,
      nodeId,
      details,
    })),
    [
      {
        code: MissionErrorCode.MissionMismatch,
        filename: null,
        nodeId: null,
        details: { missionId: OTHER_MISSION_ID },
      },
    ],
  );
});

for (const [label, patch, code] of [
  ["blank name", { name: "  " }, MissionErrorCode.ContentInvalid],
  [
    "empty verifications",
    { verifications: [] },
    MissionErrorCode.VerificationsMissing,
  ],
  [
    "oversized content",
    { criterion: "x".repeat(TEXT_MAX_BYTES + ONE) },
    MissionErrorCode.ContentInvalid,
  ],
] satisfies Array<[string, Partial<NormalizedEntry>, string]>) {
  test(`normalization rejects ${label}`, () => {
    const result = normalize([entry("a.md", patch)]);
    assert.deepEqual(
      result.violations.map((value) => value.code),
      [code],
    );
    assert.deepEqual(
      result.violations.map((value) => value.filename),
      ["a.md"],
    );
  });
}

for (const [label, patch, reason] of [
  ["initiative parent", { parent: "a.md" }, "parent_forbidden"],
  ["objective without parent", { kind: NodeKind.Objective }, "parent_required"],
  [
    "task without parent",
    { kind: NodeKind.Task, dependsOn: undefined },
    "parent_required",
  ],
  [
    "task dependency list",
    { kind: NodeKind.Task, parent: "a.md" },
    "depends_on_forbidden",
  ],
  [
    "repeated dependency",
    { dependsOn: ["a.md", "a.md"] },
    "depends_on_repeated",
  ],
  [
    "malformed parent",
    { kind: NodeKind.Objective, parent: INVALID_FILENAME },
    "reference_invalid",
  ],
  [
    "malformed dependency",
    { dependsOn: [INVALID_FILENAME] },
    "reference_invalid",
  ],
] satisfies Array<[string, Partial<ImportEntry>, string]>) {
  test(`JSON plan rules reject ${label}`, () => {
    const result = normalize([{ ...entry(), ...patch }]);
    assert.deepEqual(
      result.violations.map(({ code, details }) => ({ code, details })),
      [
        {
          code: MissionErrorCode.PlanInvalid,
          details: { filename: "a.md", reason },
        },
      ],
    );
  });
}

test("Markdown task's normalized empty dependencies are not a forbidden input field", () => {
  const task = markdown.replace(
    "kind: initiative",
    "kind: task\nparent: objective.md",
  );
  const result = normalizeImportSnapshot(
    {
      format: ImportFormat.Markdown,
      missionId: MISSION_ID,
      missionVersion: VERSION,
      reason: REASON,
      files: [{ filename: "task.md", content: task }],
    },
    MISSION_ID,
    TEXT_MAX_BYTES,
  );
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.entries[ZERO]?.dependsOn, []);
});

test("stage one collects violations from every file, including duplicate refused files", () => {
  const result = normalizeImportSnapshot(
    {
      format: ImportFormat.Markdown,
      missionId: OTHER_MISSION_ID,
      missionVersion: VERSION,
      reason: REASON,
      files: [
        { filename: INVALID_FILENAME, content: "bad" },
        { filename: INVALID_FILENAME, content: "bad" },
        {
          filename: "empty.md",
          content: markdown.replace("[true-command]", "[]"),
        },
      ],
    },
    MISSION_ID,
    TEXT_MAX_BYTES,
  );
  assert.deepEqual(
    result.violations.map((value) => value.code),
    [
      MissionErrorCode.MissionMismatch,
      MissionErrorCode.ContentInvalid,
      MissionErrorCode.PlanInvalid,
      MissionErrorCode.ContentInvalid,
      MissionErrorCode.DuplicateFile,
      MissionErrorCode.PlanInvalid,
      MissionErrorCode.VerificationsMissing,
    ],
  );
  assert.deepEqual(
    result.entries.map((value) => value.filename),
    ["empty.md"],
  );
  assert.deepEqual(
    normalize([
      entry("blank.md", { name: " " }),
      entry("empty.md", { verifications: [] }),
    ]).violations.map((value) => value.code),
    [MissionErrorCode.ContentInvalid, MissionErrorCode.VerificationsMissing],
  );
});

test("oversized reason is an operation failure, not a violation", () => {
  assert.throws(
    () =>
      normalizeImportSnapshot(
        { ...snapshot([]), reason: "x".repeat(TEXT_MAX_BYTES + ONE) },
        MISSION_ID,
        TEXT_MAX_BYTES,
      ),
    (error: unknown) =>
      error instanceof OperationError &&
      error.code === MissionErrorCode.ContentInvalid &&
      error.status === HttpStatus.BadRequest,
  );
});

test("unknown identity is a violation, never a create", (t) => {
  const { resolve } = fixture(t);
  const result = resolve([entry("unknown.md", { id: UNKNOWN_ID })]);
  assert.deepEqual(
    result.violations.map(({ code, details }) => ({ code, details })),
    [{ code: MissionErrorCode.UnknownId, details: { id: UNKNOWN_ID } }],
  );
  assert.deepEqual(
    [
      result.creates,
      result.updates,
      result.noOps,
      result.retirements,
      result.removedEdges,
    ],
    [[], [], [], [], []],
  );
});

test("foreign and retired identities retain exact identity details", (t) => {
  const { store, mission, entries, resolve } = fixture(t);
  const retired = entries[ZERO]!;
  const foreign = store.transaction((tx) => {
    tx.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(RETIRED_AT, retired.id!);
    const other = {
      ...mission,
      id: insertMission(tx, createIdentity("project"), CREATED_AT),
    };
    return seed(tx, other, [entry("foreign.md")])[ZERO]!;
  });
  const result = resolve([retired, foreign]);
  assert.deepEqual(
    result.violations.map(({ code, details }) => ({ code, details })),
    [
      { code: MissionErrorCode.RetiredId, details: { id: retired.id! } },
      { code: MissionErrorCode.ForeignId, details: { id: foreign.id! } },
    ],
  );
});

test("duplicate id and kind changes are collected", (t) => {
  const { entries, resolve } = fixture(t);
  const existing = entries[ZERO]!;
  const result = resolve([
    existing,
    {
      ...existing,
      filename: "changed.md",
      kind: NodeKind.Objective,
      parent: existing.filename,
      bindings: [REPOSITORY],
    },
  ]);
  assert.ok(
    result.violations.some(
      (value) => value.code === MissionErrorCode.DuplicateId,
    ),
  );
  assert.deepEqual(
    result.violations.find(
      (value) => value.code === MissionErrorCode.KindChanged,
    )?.details,
    {
      id: existing.id,
      kind: NodeKind.Objective,
      currentKind: NodeKind.Initiative,
    },
  );
});

test("unresolved parent and dependencies identify the submitted references", (t) => {
  const { resolve } = fixture(t);
  const result = resolve([
    entry("o.md", {
      kind: NodeKind.Objective,
      parent: "missing-parent.md",
      dependsOn: ["missing-dep.md"],
      bindings: [REPOSITORY],
    }),
  ]);
  assert.deepEqual(
    result.violations.map(({ code, details, filename }) => ({
      code,
      details,
      filename,
    })),
    [
      {
        code: MissionErrorCode.UnresolvedReference,
        details: { reference: "parent", name: "missing-parent.md" },
        filename: "o.md",
      },
      {
        code: MissionErrorCode.UnresolvedReference,
        details: { reference: "dependsOn", name: "missing-dep.md" },
        filename: "o.md",
      },
    ],
  );
});

test("references cannot resolve against current filenames outside the submitted set", (t) => {
  const { resolve } = fixture(t);
  const result = resolve([entry("new.md", { dependsOn: ["a.md"] })]);
  assert.deepEqual(
    result.violations.map((value) => value.code),
    [MissionErrorCode.UnresolvedReference],
  );
});

test("wrong-kind parents and task dependency targets are rejected", (t) => {
  const { resolve } = fixture(t, []);
  const entries = hierarchy();
  const result = resolve(
    change(
      change(change(entries, "o.md", { parent: "p.md" }), "t.md", {
        parent: "a.md",
      }),
      "b.md",
      { dependsOn: ["t.md"] },
    ),
  );
  assert.deepEqual(
    result.violations.map((value) => value.code),
    Array.from({ length: 3 }, () => MissionErrorCode.ReferenceKindInvalid),
  );
  assert.deepEqual(
    result.violations.map((value) => value.details),
    [
      { reference: "dependsOn", name: "t.md" },
      { reference: "parent", name: "p.md" },
      { reference: "parent", name: "a.md" },
    ],
  );
});

test("binding resolution collects every missing name and applies the kind rule table", (t) => {
  const { resolve } = fixture(t, []);
  const result = resolve([
    entry("a.md", { bindings: [MISSING_BINDING, "also-missing"] }),
    entry("b.md", { bindings: [REPOSITORY] }),
  ]);
  assert.deepEqual(
    result.violations.map((value) => value.code),
    Array.from({ length: 3 }, () => MissionErrorCode.BindingsInvalid),
  );
  assert.deepEqual(
    result.violations.map((value) => value.details),
    [
      { binding: MISSING_BINDING },
      { binding: "also-missing" },
      { kind: NodeKind.Initiative, bindingKind: "repository", count: ONE },
    ],
  );
});

test("binding collaborator operation errors become violations but unexpected failures propagate", (t) => {
  const { resolve } = fixture(t, []);
  const inputs = [entry("a.md", { bindings: [REPOSITORY] })];
  const operationError = new OperationError(
    HttpStatus.BadRequest,
    MissionErrorCode.BindingsInvalid,
    "Binding failed.",
    { binding: REPOSITORY },
  );
  const result = resolve(inputs, {
    ...bindings,
    resolveBinding: () => {
      throw operationError;
    },
  });
  assert.deepEqual(
    result.violations.map((value) => value.code),
    [operationError.code],
  );
  const unexpected = new Error("Database unavailable");
  assert.throws(
    () =>
      resolve(inputs, {
        ...bindings,
        resolveBinding: () => {
          throw unexpected;
        },
      }),
    (error) => error === unexpected,
  );
});

test("closure detects a cycle inherited from an initiative dependency on its objective", (t) => {
  const { resolve } = fixture(t, []);
  const result = resolve(change(hierarchy(), "a.md", { dependsOn: ["o.md"] }));
  assert.deepEqual(
    result.violations.map(({ code, filename, nodeId }) => ({
      code,
      filename,
      nodeId,
    })),
    [{ code: MissionErrorCode.Cycle, filename: null, nodeId: null }],
  );
  assert.deepEqual(result.creates, []);
});

test("import rejects an objective depending on its own initiative without creates", (t) => {
  const { resolve } = fixture(t, []);
  const result = resolve(change(hierarchy(), "o.md", { dependsOn: ["a.md"] }));
  assert.deepEqual(
    result.violations.map(({ code, filename, nodeId }) => ({
      code,
      filename,
      nodeId,
    })),
    [{ code: MissionErrorCode.Cycle, filename: null, nodeId: null }],
  );
  assert.deepEqual(result.creates, []);
});

test("direct dependency cycles are rejected", (t) => {
  const { resolve } = fixture(t, []);
  const result = resolve([
    entry("a.md", { dependsOn: ["b.md"] }),
    entry("b.md", { dependsOn: ["a.md"] }),
  ]);
  assert.deepEqual(
    result.violations.map((value) => value.code),
    [MissionErrorCode.Cycle],
  );
});

test("unchanged hierarchy, including tasks and terminal nodes, is entirely noOps", (t) => {
  const { store, entries, resolve } = fixture(t, hierarchy());
  store.database
    .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
    .run(NodeState.Completed, entries[ZERO]!.id!);
  const result = resolve();
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.noOps, entries.map((value) => value.id!).sort());
  assert.deepEqual(
    [result.creates, result.updates, result.retirements, result.removedEdges],
    [[], [], [], []],
  );
  assert.deepEqual(
    result.resolvedEntries.find(
      (value) => value.entry.filename === OBJECTIVE_FILENAME,
    )?.bindingIds,
    [BINDING_ID],
  );
});

for (const [label, filename, patch] of [
  ["name", "a.md", { name: "Changed" }],
  ["requirement", "a.md", { requirement: "Changed" }],
  ["criterion", "a.md", { criterion: "Changed" }],
  ["verifications", "a.md", { verifications: ["echo changed"] }],
  ["filename", "b.md", { filename: "renamed.md" }],
  ["parent", "o.md", { parent: "b.md" }],
  ["dependsOn", "b.md", { dependsOn: ["a.md"] }],
  ["task content", "t.md", { name: "Changed task" }],
  ["task parent", "t.md", { parent: "p.md" }],
] satisfies Array<[string, string, Partial<NormalizedEntry>]>) {
  test(`changed ${label} is an update by identity`, (t) => {
    const { entries, resolve } = fixture(t, hierarchy());
    let input = change(entries, filename, patch);
    if (patch.filename)
      input = change(input, "p.md", { parent: patch.filename });
    const result = resolve(input);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.updates, [item(entries, filename).id]);
    assert.deepEqual(result.retirements, []);
  });
}

test("binding names compare as resolved revision identities", (t) => {
  const { entries, resolve } = fixture(t, hierarchy());
  const alias = "alias";
  const aliased = change(entries, "o.md", { bindings: [alias] });
  const same = resolve(aliased, {
    ...bindings,
    resolveBinding: () => ({
      bindingId: BINDING_ID,
      resourceIdentity: "repository:example",
    }),
  });
  assert.deepEqual(same.updates, []);
  const changed = resolve(entries, {
    ...bindings,
    resolveBinding: () => ({
      bindingId: NEXT_BINDING_ID,
      resourceIdentity: "repository:example",
    }),
  });
  assert.deepEqual(
    changed.updates,
    [item(entries, "o.md").id, item(entries, "p.md").id].sort(),
  );
});

test("dependency order is ignored while verification order remains content", (t) => {
  const { entries, resolve } = fixture(t, [
    entry("a.md"),
    entry("b.md"),
    entry("c.md", {
      dependsOn: ["a.md", "b.md"],
      verifications: ["first", "second"],
    }),
  ]);
  const reordered = change(entries, "c.md", { dependsOn: ["b.md", "a.md"] });
  assert.deepEqual(resolve(reordered).updates, []);
  assert.deepEqual(
    resolve(change(reordered, "c.md", { verifications: ["second", "first"] }))
      .updates,
    [item(entries, "c.md").id],
  );
});

test("empty set retires every current node but excludes already retired nodes", (t) => {
  const { store, entries, resolve } = fixture(t, hierarchy());
  const retiredId = item(entries, "b.md").id!;
  store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, retiredId);
  const result = resolve([]);
  assert.deepEqual(
    result.retirements,
    entries
      .map((value) => value.id!)
      .filter((id) => id !== retiredId)
      .sort(),
  );
  assert.deepEqual(result.violations, []);
  assert.ok(!result.currentNodes.has(retiredId));
});

test("same filename without identity creates a new node and retires the old node", (t) => {
  const { entries, resolve } = fixture(t);
  const result = resolve([entry()]);
  assert.deepEqual(result.creates, ["a.md"]);
  assert.deepEqual(result.retirements, [entries[ZERO]!.id]);
  assert.deepEqual(result.updates, []);
  assert.equal(result.resolvedEntries[ZERO]?.key, TEMPORARY_A_KEY);
  assert.equal(result.resolvedEntries[ZERO]?.current, null);
});

test("filename replacement does not retire an identity retained under a new filename", (t) => {
  const { entries, resolve } = fixture(t);
  const result = resolve([
    entry(),
    { ...entries[ZERO]!, filename: "renamed.md" },
  ]);
  assert.deepEqual(result.creates, ["a.md"]);
  assert.deepEqual(result.updates, [entries[ZERO]!.id]);
  assert.deepEqual(result.retirements, []);
});

test("new parent keys, current rows and resulting dependency sets are exposed without writes", (t) => {
  const { store, entries, resolve } = fixture(t, hierarchy());
  const original = structuredClone(entries);
  const created = entry("new.md");
  const input = [
    ...change(entries, "o.md", {
      parent: created.filename,
      dependsOn: ["b.md"],
    }),
    created,
  ];
  const before = store.database
    .prepare("SELECT total_changes() AS count")
    .get();
  const result = resolve(input);
  const objective = item(entries, "o.md");
  assert.equal(result.parentMap.get(objective.id!), `file:${created.filename}`);
  assert.deepEqual(
    result.dependencies.get(objective.id!),
    new Set([item(entries, "b.md").id]),
  );
  assert.equal(
    result.currentNodes.get(objective.id!)?.parent_id,
    item(entries, "a.md").id,
  );
  assert.deepEqual(
    store.database.prepare("SELECT total_changes() AS count").get(),
    before,
  );
  assert.deepEqual(entries, original);
});

test("removedEdges contains dropped containment and dependency edges in stable order", (t) => {
  const base = change(hierarchy(), "b.md", { dependsOn: ["a.md"] });
  const { entries, resolve } = fixture(t, base);
  const a = item(entries, "a.md").id!;
  const b = item(entries, "b.md").id!;
  const o = item(entries, "o.md").id!;
  const task = item(entries, "t.md").id!;
  const result = resolve(
    change(
      change(
        entries.filter((value) => value.filename !== TASK_FILENAME),
        "o.md",
        { parent: "b.md" },
      ),
      "b.md",
      { dependsOn: [] },
    ),
  );
  assert.deepEqual(result.removedEdges, [
    ...[
      { kind: EdgeKind.Containment, parentId: a, childId: o },
      { kind: EdgeKind.Containment, parentId: o, childId: task },
    ].sort((left, right) => left.parentId.localeCompare(right.parentId)),
    { kind: EdgeKind.Dependency, dependentId: b, dependsOnId: a },
  ]);
  assert.deepEqual(result.retirements, [task]);
});

test("retiring an endpoint removes incoming dependencies, and same-name replacement drops identity edges", (t) => {
  const { entries, resolve } = fixture(t, [
    entry("a.md"),
    entry("b.md", { dependsOn: ["a.md"] }),
  ]);
  const result = resolve([entry("a.md"), item(entries, "b.md")]);
  assert.deepEqual(result.updates, [item(entries, "b.md").id]);
  assert.deepEqual(result.removedEdges, [
    {
      kind: EdgeKind.Dependency,
      dependentId: item(entries, "b.md").id,
      dependsOnId: item(entries, "a.md").id,
    },
  ]);
});

test("digest is canonical, input-order independent, nonmutating and retirement-sensitive", () => {
  const entries = [entry("a_.md"), entry("a.md"), entry("a-.md")];
  const retired = [createIdentity("node"), createIdentity("node")].reverse();
  const before = structuredClone({ entries, retired });
  const actual = importDigest(MISSION_ID, VERSION, entries, retired);
  assert.equal(
    actual,
    importDigest(
      MISSION_ID,
      VERSION,
      [...entries].reverse(),
      [...retired].reverse(),
    ),
  );
  assert.equal(
    actual,
    digest({
      missionId: MISSION_ID,
      missionVersion: VERSION,
      entries: [...entries].reverse(),
      retirements: [...retired].sort(),
    }),
  );
  assert.notEqual(actual, importDigest(MISSION_ID, VERSION, entries, []));
  assert.notEqual(
    actual,
    importDigest(MISSION_ID, VERSION + ONE, entries, retired),
  );
  assert.notEqual(
    actual,
    importDigest(OTHER_MISSION_ID, VERSION, entries, retired),
  );
  assert.notEqual(
    actual,
    importDigest(
      MISSION_ID,
      VERSION,
      change(entries, "a.md", { name: "Changed" }),
      retired,
    ),
  );
  assert.deepEqual({ entries, retired }, before);
  assert.match(actual, /^[0-9a-f]{64}$/);
});

const CONDITION_CASES: Array<{
  label: string;
  transform: (entries: NormalizedEntry[]) => NormalizedEntry[];
  checked: string[];
}> = [
  {
    label: "updated initiative",
    transform: (entries) => change(entries, "a.md", { name: "Changed" }),
    checked: ["a.md"],
  },
  {
    label: "updated objective does not modify its initiative",
    transform: (entries) => change(entries, "o.md", { name: "Changed" }),
    checked: ["o.md"],
  },
  {
    label: "updated task checks its objective",
    transform: (entries) => change(entries, "t.md", { name: "Changed" }),
    checked: ["o.md"],
  },
  {
    label: "moved task checks both objectives",
    transform: (entries) => change(entries, "t.md", { parent: "p.md" }),
    checked: ["o.md", "p.md"],
  },
  {
    label: "moved objective checks itself and both initiatives",
    transform: (entries) => change(entries, "o.md", { parent: "b.md" }),
    checked: ["a.md", "b.md", "o.md"],
  },
  {
    label: "dependency changes check the dependent only",
    transform: (entries) => change(entries, "b.md", { dependsOn: ["a.md"] }),
    checked: ["b.md"],
  },
  {
    label: "created objective checks its current initiative",
    transform: (entries) => [
      ...entries,
      entry("new.md", {
        kind: NodeKind.Objective,
        parent: "a.md",
        bindings: [REPOSITORY],
      }),
    ],
    checked: ["a.md"],
  },
  {
    label: "created task checks its current objective",
    transform: (entries) => [
      ...entries,
      entry("new.md", {
        kind: NodeKind.Task,
        parent: "o.md",
      }),
    ],
    checked: ["o.md"],
  },
  {
    label: "created initiative and new parent need no current-node check",
    transform: (entries) => [
      ...entries,
      entry("new.md"),
      entry("new-objective.md", {
        kind: NodeKind.Objective,
        parent: "new.md",
        bindings: [REPOSITORY],
      }),
    ],
    checked: [],
  },
  {
    label: "retired task checks its surviving objective",
    transform: (entries) =>
      entries.filter((value) => value.filename !== TASK_FILENAME),
    checked: ["o.md"],
  },
  {
    label: "retired objective checks itself and its surviving initiative",
    transform: (entries) =>
      entries.filter((value) => !["o.md", "t.md"].includes(value.filename)),
    checked: ["a.md", "o.md"],
  },
  {
    label: "entire retirement deduplicates task owners",
    transform: () => [],
    checked: ["a.md", "b.md", "o.md", "p.md"],
  },
  {
    label: "multiple changes to one content owner are deduplicated",
    transform: (entries) =>
      change(change(entries, "o.md", { name: "Changed" }), "t.md", {
        name: "Changed",
      }),
    checked: ["o.md"],
  },
];

for (const scenario of CONDITION_CASES) {
  test(`import condition: ${scenario.label}`, (t) => {
    const { store, entries, resolve } = fixture(t, hierarchy());
    store.database
      .prepare("UPDATE mission_node SET state = ? WHERE kind != ?")
      .run(NodeState.Executing, NodeKind.Task);
    const resolved = resolve(scenario.transform(entries));
    assert.deepEqual(resolved.violations, []);
    const violations = store.transaction((tx) =>
      checkImportCondition(tx, resolved),
    );
    assert.deepEqual(
      violations.map((value) => value.nodeId),
      scenario.checked.map((filename) => item(entries, filename).id!).sort(),
    );
    for (const value of violations) {
      assert.equal(value.code, MissionErrorCode.ConditionFailed);
      assert.deepEqual(value.details, {
        state: NodeState.Executing,
        attempt: ZERO,
      });
    }
  });
}

for (const state of [NodeState.Completed, NodeState.Discarded]) {
  test(`import condition permits ${state} noOps but rejects changes and retirement`, (t) => {
    const { store, entries, resolve } = fixture(t);
    const id = entries[ZERO]!.id!;
    store.database
      .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
      .run(state, id);
    const unchanged = resolve();
    assert.deepEqual(
      store.transaction((tx) => checkImportCondition(tx, unchanged)),
      [],
    );
    for (const input of [change(entries, "a.md", { name: "Changed" }), []]) {
      const resolved = resolve(input);
      const violations = store.transaction((tx) =>
        checkImportCondition(tx, resolved),
      );
      assert.deepEqual(
        violations.map(({ code, nodeId, details }) => ({
          code,
          nodeId,
          details,
        })),
        [
          {
            code: MissionErrorCode.TerminalChange,
            nodeId: id,
            details: { nodeId: id },
          },
        ],
      );
    }
  });
}

for (const state of [NodeState.Pending, NodeState.Available]) {
  test(`import condition admits ${state} only at attempt zero`, (t) => {
    const { store, entries, resolve } = fixture(t);
    const id = entries[ZERO]!.id!;
    const input = change(entries, "a.md", { name: "Changed" });
    store.database
      .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
      .run(state, id);
    const valid = resolve(input);
    assert.deepEqual(
      store.transaction((tx) => checkImportCondition(tx, valid)),
      [],
    );
    store.database
      .prepare("UPDATE mission_node SET attempt = ? WHERE id = ?")
      .run(ONE, id);
    const invalid = resolve(input);
    const violations = store.transaction((tx) =>
      checkImportCondition(tx, invalid),
    );
    assert.equal(violations[ZERO]?.code, MissionErrorCode.ConditionFailed);
    assert.deepEqual(violations[ZERO]?.details, { state, attempt: ONE });
  });
}

test("prepared import exposes the resolved state without resolving bindings twice", (t) => {
  const { store, mission, entries } = fixture(t, hierarchy());
  let resolutions = ZERO;
  const wireEntries = entries.map((value) =>
    value.kind === NodeKind.Task ? { ...value, dependsOn: undefined } : value,
  );
  const prepared = store.transaction((tx) =>
    prepareImport(
      tx,
      mission,
      snapshot(wireEntries, mission.id),
      mission.id,
      {
        ...bindings,
        resolveBinding: (...args) => {
          resolutions++;
          return bindings.resolveBinding(...args);
        },
      },
      TEXT_MAX_BYTES,
    ),
  );
  assert.equal(
    resolutions,
    hierarchy().filter((value) => value.kind === NodeKind.Objective).length,
  );
  assert.ok(prepared.resolved);
  assert.deepEqual(prepared.preview.violations, []);
  assert.equal(prepared.preview.noOps, prepared.resolved.noOps);
  assert.equal(prepared.resolved.resolvedEntries.length, entries.length);
});
