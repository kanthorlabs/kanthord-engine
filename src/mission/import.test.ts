import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { CommitType } from "../kernel/commit-message.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { digest } from "../kernel/json.ts";
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import {
  ActorKind,
  ClaimableState,
  type Content,
  importApplySchema,
  type ImportEntry,
  ImportFormat,
  type ImportSnapshot,
  importSnapshotSchema,
  Intent,
  type Mission,
  MISSION_SERVICE_NAME,
  type MissionBindings,
  type MissionEnvironments,
  MissionErrorCode,
  nodeCreateSchema,
  NodeState,
  planFileNameSchema,
  RevisionWrite,
  type SchedulerClaims,
  type TaskBody,
  TaskChange,
  type WorkQueue,
} from "./contract.ts";
import { exportMission } from "./export.ts";
import { applyImport } from "./import-apply.ts";
import { executionEnds } from "./control.ts";
import {
  checkImportCondition,
  importDigest,
  isTaskEntry,
  type NormalizedEntry,
  normalizeImportSnapshot,
  prepareImport,
  resolveImportSet,
} from "./import.ts";
import { missionMigrations } from "./migrations.ts";
import {
  databaseSnapshot,
  lostHold,
  lostTransition,
  missionHarness,
} from "./test-support.ts";
import { type ParsedNodeFile, parsePlanFile } from "./parser.ts";
import { revisionFromRow } from "./revision.ts";
import {
  insertDependency,
  insertMission,
  insertNode,
  insertRevision,
  readCurrentRevision,
  readMission,
  readMissionNodes,
  readNode,
} from "./store.ts";
import { stopAfter } from "../kernel/test-support.ts";

const TEXT_MAX_BYTES = 32768;
const VERSION = 1;
const CREATED_AT = 1000;
const RETIRED_AT = 2000;
const NO_ATTEMPT = 0;
const FIRST_ENTRY_INDEX = 0;
const INITIAL_RESOLUTION_COUNT = 0;
const SINGLE_ENTRY = 1;
const TEXT_OVERFLOW = 1;
const NO_BINDING_COUNT = 0;
const NEXT_VERSION_INCREMENT = 1;
const FIRST_ATTEMPT = 1;
const MISSION_ID = "mission_00000000000000000000000000";
const PROJECT_ID = "project_00000000000000000000000000";
const OTHER_MISSION_ID = "mission_00000000000000000000000001";
const UNKNOWN_ID = "node_00000000000000000000000000";
const BINDING_ID = "binding_00000000000000000000000000";
const NEXT_BINDING_ID = "binding_00000000000000000000000001";
const REVISED_BINDING_ID = "binding_00000000000000000000000002";
const REPOSITORY = "repo";
const MISSING_BINDING = "missing";
const INVALID_FILENAME = "../Bad.md";
const REASON = "Import plan";
const IMPLEMENT_FILENAME = "o.md";
const TASK_FILENAME = "t.md";
const SIBLING_TASK_FILENAME = "s.md";
const ROOT_FILENAME = "a.md";
const PEER_FILENAME = "p.md";
const TEMPORARY_A_KEY = "file:a.md";
const actor = { kind: ActorKind.Human, account: "test", name: "Test" } as const;
const content: TaskBody = {
  name: "Node",
  requirement: "Requirement",
  criterion: "Criterion",
  verifications: ["true"],
  bindings: [],
};
const SECOND_REPOSITORY = "repo_two";
const IDENTITIES: Record<string, string> = {
  [BINDING_ID]: "repository:example",
  [NEXT_BINDING_ID]: "repository:other",
};
const BINDING_NAMES: Record<string, string> = {
  [BINDING_ID]: REPOSITORY,
  [NEXT_BINDING_ID]: SECOND_REPOSITORY,
};
let mixedAnswer = false;
const environments: MissionEnvironments = {
  environmentsMixed: (_tx, projectId, identities) => {
    assert.equal(projectId, PROJECT_ID);
    return (
      mixedAnswer &&
      identities.includes(IDENTITIES[BINDING_ID]!) &&
      identities.includes(IDENTITIES[NEXT_BINDING_ID]!)
    );
  },
};
const bindings: MissionBindings = {
  storageBindingOf: () =>
    assert.fail("Import does not read storage configuration."),
  repositoryPolicyOf: () =>
    assert.fail("Import does not derive repository policies."),
  resolveBinding: (_tx, projectId, name) => {
    assert.equal(projectId, PROJECT_ID);
    if (name === SECOND_REPOSITORY)
      return {
        binding_id: NEXT_BINDING_ID,
        resource_identity: IDENTITIES[NEXT_BINDING_ID]!,
      };
    return name === REPOSITORY
      ? { binding_id: BINDING_ID, resource_identity: "repository:example" }
      : null;
  },
  resolveBindingIdentity: () =>
    assert.fail("Import resolves names, not binding identities."),
  getBindingRevision: (_tx, bindingId) => {
    const name = BINDING_NAMES[bindingId];
    const resourceIdentity = IDENTITIES[bindingId];
    assert.ok(name);
    assert.ok(resourceIdentity);
    return {
      binding_id: bindingId,
      project_id: PROJECT_ID,
      name,
      resource_identity: resourceIdentity,
      revision: VERSION,
      tombstone: false,
      disabled: false,
    };
  },
};
const markdown = `---
intent: examine
bindings: []
verifications: [true-command]
---
# Node
## Requirement
Requirement
## Criterion
Criterion
`;

type EntryPatch = Partial<ParsedNodeFile> & { node?: string };

function entry(filename = "a.md", extra: EntryPatch = {}): NormalizedEntry {
  return {
    filename,
    intent: Intent.Examine,
    tags: [],
    ...structuredClone(content),
    depends_on: [],
    ...extra,
  } as NormalizedEntry;
}

function implement(filename: string, extra: EntryPatch = {}): NormalizedEntry {
  return entry(filename, {
    intent: Intent.Implement,
    bindings: [REPOSITORY],
    ...extra,
  });
}

function task(
  filename: string,
  node: string,
  extra: EntryPatch = {},
): NormalizedEntry {
  return {
    filename,
    node,
    ...structuredClone(content),
    ...extra,
  } as NormalizedEntry;
}

function snapshot(
  entries: ImportEntry[],
  missionId = MISSION_ID,
): ImportSnapshot {
  return {
    format: ImportFormat.Json,
    mission_id: missionId,
    mission_version: VERSION,
    reason: REASON,
    entries,
  };
}

function normalize(entries: ImportEntry[]) {
  return normalizeImportSnapshot(snapshot(entries), MISSION_ID, TEXT_MAX_BYTES);
}

function bodyOf(item: NormalizedEntry): TaskBody {
  return {
    name: item.name,
    requirement: item.requirement,
    criterion: item.criterion,
    verifications: item.verifications,
    bindings: item.bindings.map((name) => {
      const found = Object.entries(BINDING_NAMES).find(
        ([, value]) => value === name,
      );
      assert.ok(found);
      return found[0];
    }),
  };
}

function contentOf(item: NormalizedEntry): Content {
  assert.ok(!isTaskEntry(item));
  return {
    ...bodyOf(item),
    intent: item.intent as Intent,
    tags: item.tags,
  };
}

function seed(
  tx: Transaction,
  mission: Mission,
  inputs: NormalizedEntry[],
): NormalizedEntry[] {
  const entries = inputs.map((item) => ({
    ...item,
    id: item.id ?? createIdentity(isTaskEntry(item) ? "task" : "node"),
  }));
  const ids = new Map(entries.map((item) => [item.filename, item.id]));
  for (const item of entries)
    if (!isTaskEntry(item))
      insertNode(tx, {
        id: item.id,
        mission_id: mission.id,
        filename: item.filename,
        created_at: CREATED_AT,
      });
  for (const item of entries) {
    if (isTaskEntry(item)) continue;
    for (const name of item.depends_on)
      insertDependency(tx, mission.id, item.id, ids.get(name)!);
    insertRevision(tx, {
      node_id: item.id,
      filename: item.filename,
      revision: VERSION,
      reason: REASON,
      actor,
      created_at: CREATED_AT,
      content: contentOf(item),
      tasks: entries
        .filter((value) => isTaskEntry(value) && value.node === item.filename)
        .map((value) => ({
          id: value.id,
          filename: value.filename,
          content: bodyOf(value),
        })),
      change: {
        write: RevisionWrite.Import,
        previous_revision: null,
        changed_fields: [],
      },
      pinned_by_attempts: [],
    });
  }
  return entries;
}

function fixture(t: TestContext, inputs = [entry()]) {
  const store = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => store.close());
  store.migrate([
    { service: MISSION_SERVICE_NAME, migrations: missionMigrations },
  ]);
  const mission = store.transaction((tx) => ({
    id: insertMission(tx, PROJECT_ID, CREATED_AT),
    project_id: PROJECT_ID,
    version: VERSION,
  }));
  const entries = store.transaction((tx) => seed(tx, mission, inputs));
  const resolve = (set = entries, resolver = bindings) =>
    store.transaction((tx) =>
      resolveImportSet(tx, mission, set, resolver, environments),
    );
  return { store, mission, entries, resolve };
}

function hierarchy(): NormalizedEntry[] {
  return [
    entry("a.md"),
    entry("b.md"),
    implement("o.md"),
    implement("p.md"),
    task("t.md", "o.md"),
    task("s.md", "o.md"),
    task("u.md", "p.md"),
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
  patch: EntryPatch,
): NormalizedEntry[] {
  return entries.map((value) =>
    value.filename === filename
      ? ({ ...value, ...patch } as NormalizedEntry)
      : value,
  );
}

test("Markdown is parsed and JSON content bypasses Markdown grammar", () => {
  const result = normalizeImportSnapshot(
    {
      format: ImportFormat.Markdown,
      mission_id: MISSION_ID,
      mission_version: VERSION,
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
      mission_id: MISSION_ID,
      mission_version: VERSION,
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
    entry(INVALID_FILENAME, { depends_on: [INVALID_FILENAME] }),
    task("t.md", INVALID_FILENAME),
  ]);
  const md = {
    format: ImportFormat.Markdown,
    mission_id: MISSION_ID,
    mission_version: VERSION,
    reason: REASON,
    files: [{ filename: INVALID_FILENAME, content: markdown }],
  };
  for (const value of [json, md]) {
    assert.ok(importSnapshotSchema.safeParse(value).success);
    assert.ok(
      importApplySchema.safeParse({
        ...value,
        preview_digest: "a".repeat(64),
        confirmed_retirements: [],
      }).success,
    );
  }
  assert.ok(!planFileNameSchema.safeParse(INVALID_FILENAME).success);
  assert.ok(
    !nodeCreateSchema.safeParse({
      filename: INVALID_FILENAME,
      content: { ...content, intent: Intent.Examine },
      tasks: [],
      reason: REASON,
      expected_mission_version: VERSION,
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
  assert.equal(result.entries.length, SINGLE_ENTRY);
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
    result.violations.map(({ code, filename, node_id, details }) => ({
      code,
      filename,
      node_id,
      details,
    })),
    [
      {
        code: MissionErrorCode.MissionMismatch,
        filename: null,
        node_id: null,
        details: { mission_id: OTHER_MISSION_ID },
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
    { criterion: "x".repeat(TEXT_MAX_BYTES + TEXT_OVERFLOW) },
    MissionErrorCode.ContentInvalid,
  ],
  ["unknown intent", { intent: "task" }, MissionErrorCode.ContentInvalid],
  [
    "repeated tag",
    { tags: ["platform.macos", "platform.macos"] },
    MissionErrorCode.ContentInvalid,
  ],
  [
    "malformed tag",
    { tags: ["platform.macOS"] },
    MissionErrorCode.ContentInvalid,
  ],
] satisfies Array<[string, EntryPatch, string]>) {
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

for (const [label, value, reason] of [
  [
    "repeated dependency",
    entry("a.md", { depends_on: ["b.md", "b.md"] }),
    "depends_on_repeated",
  ],
  [
    "malformed dependency",
    entry("a.md", { depends_on: [INVALID_FILENAME] }),
    "reference_invalid",
  ],
  [
    "malformed node reference",
    task("a.md", INVALID_FILENAME),
    "reference_invalid",
  ],
  [
    "a node entry with the task prefix",
    entry("a.md", { id: createIdentity("task") }),
    "id_prefix_invalid",
  ],
] satisfies Array<[string, NormalizedEntry, string]>) {
  test(`JSON plan rules reject ${label}`, () => {
    const result = normalize([value]);
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

test("a Markdown task file normalizes to a task entry that names its node", () => {
  const taskFile = markdown.replace("intent: examine", "node: implement.md");
  const result = normalizeImportSnapshot(
    {
      format: ImportFormat.Markdown,
      mission_id: MISSION_ID,
      mission_version: VERSION,
      reason: REASON,
      files: [{ filename: "task.md", content: taskFile }],
    },
    MISSION_ID,
    TEXT_MAX_BYTES,
  );
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.entries, [
    {
      filename: "task.md",
      node: "implement.md",
      bindings: [],
      verifications: ["true-command"],
      name: "Node",
      requirement: "Requirement",
      criterion: "Criterion",
    },
  ]);
});

test("stage one collects violations from every file, including duplicate refused files", () => {
  const result = normalizeImportSnapshot(
    {
      format: ImportFormat.Markdown,
      mission_id: OTHER_MISSION_ID,
      mission_version: VERSION,
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

for (const [label, line, field, value] of [
  ["a nontext intent", "intent: [implement]", "intent", ["implement"]],
  ["an unknown intent", "intent: build", "intent", "build"],
  ["a nonlist tags field", "intent: examine\ntags: x", "tags", "x"],
  ["a nontext tag", "intent: examine\ntags: [7]", "tags", [7]],
  [
    "an unknown commit type",
    "intent: examine\ncommit_type: build",
    "commit_type",
    "build",
  ],
  [
    "a nontext commit type",
    "intent: examine\ncommit_type: [feat]",
    "commit_type",
    ["feat"],
  ],
] as const) {
  test(`markdown and JSON imports answer ${label} with mission.node.content_invalid`, () => {
    const file = markdown.replace("intent: examine", line);
    const snapshots: ImportSnapshot[] = [
      {
        format: ImportFormat.Markdown,
        mission_id: MISSION_ID,
        mission_version: VERSION,
        reason: REASON,
        files: [{ filename: "a.md", content: file }],
      },
      snapshot([{ ...entry("a.md"), [field]: value } as ImportEntry]),
    ];
    for (const input of snapshots) {
      const parsed = importSnapshotSchema.parse(input);
      assert.deepEqual(
        normalizeImportSnapshot(parsed, MISSION_ID, TEXT_MAX_BYTES).violations,
        [
          {
            code: MissionErrorCode.ContentInvalid,
            message: `Invalid node content: ${field}.`,
            details: { field },
            filename: "a.md",
            node_id: null,
          },
        ],
      );
    }
  });
}

test("a node file keeps commit_type only when the file sets it", () => {
  const normalizeFile = (content: string) =>
    normalizeImportSnapshot(
      importSnapshotSchema.parse({
        format: ImportFormat.Markdown,
        mission_id: MISSION_ID,
        mission_version: VERSION,
        reason: REASON,
        files: [{ filename: "a.md", content }],
      }),
      MISSION_ID,
      TEXT_MAX_BYTES,
    );
  const absent = normalizeFile(markdown);
  assert.deepEqual(absent.violations, []);
  assert.equal("commit_type" in absent.entries[0]!, false);
  const set = normalizeFile(
    markdown.replace("intent: examine", "intent: examine\ncommit_type: fix"),
  );
  assert.deepEqual(set.violations, []);
  assert.equal(
    (set.entries[0] as { commit_type?: string }).commit_type,
    CommitType.Fix,
  );
});

test("oversized reason is an operation failure, not a violation", () => {
  assert.throws(
    () =>
      normalizeImportSnapshot(
        { ...snapshot([]), reason: "x".repeat(TEXT_MAX_BYTES + TEXT_OVERFLOW) },
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
      result.no_ops,
      result.retirements,
      result.removed_edges,
    ],
    [[], [], [], [], []],
  );
});

test("foreign and retired identities retain exact identity details", (t) => {
  const { store, mission, entries, resolve } = fixture(t);
  const retired = entries[FIRST_ENTRY_INDEX]!;
  const foreign = store.transaction((tx) => {
    tx.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(RETIRED_AT, retired.id!);
    const other = {
      ...mission,
      id: insertMission(tx, createIdentity("project"), CREATED_AT),
    };
    return seed(tx, other, [entry("foreign.md")])[FIRST_ENTRY_INDEX]!;
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

test("a duplicate id is collected and an intent change of a current node is an update", (t) => {
  const { entries, resolve } = fixture(t);
  const existing = entries[FIRST_ENTRY_INDEX]!;
  const duplicated = resolve([
    existing,
    { ...existing, filename: "changed.md" },
  ]);
  assert.deepEqual(
    duplicated.violations.map(({ code, details }) => ({ code, details })),
    [{ code: MissionErrorCode.DuplicateId, details: { id: existing.id! } }],
  );
  const changed = resolve(
    change(entries, "a.md", {
      intent: Intent.Implement,
      bindings: [REPOSITORY],
    }),
  );
  assert.deepEqual(changed.violations, []);
  assert.deepEqual(changed.updates, [existing.id]);
});

test("unresolved node and dependencies identify the submitted references", (t) => {
  const { resolve } = fixture(t);
  const result = resolve([
    implement("o.md", { depends_on: ["missing-dep.md"] }),
    task("t.md", "missing-node.md"),
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
        details: { reference: "depends_on", name: "missing-dep.md" },
        filename: "o.md",
      },
      {
        code: MissionErrorCode.UnresolvedReference,
        details: { reference: "node", name: "missing-node.md" },
        filename: "t.md",
      },
    ],
  );
});

test("references cannot resolve against current filenames outside the submitted set", (t) => {
  const { resolve } = fixture(t);
  const result = resolve([entry("new.md", { depends_on: ["a.md"] })]);
  assert.deepEqual(
    result.violations.map((value) => value.code),
    [MissionErrorCode.UnresolvedReference],
  );
});

test("a task naming an examine node or a task, and a dependency on a task, are rejected", (t) => {
  const { resolve } = fixture(t, []);
  const entries = hierarchy();
  const result = resolve(
    change(
      change(change(entries, "t.md", { node: "a.md" }), "u.md", {
        node: "s.md",
      }),
      "b.md",
      { depends_on: ["t.md"] },
    ),
  );
  assert.deepEqual(
    result.violations.map((value) => value.code),
    Array.from({ length: 3 }, () => MissionErrorCode.ReferenceKindInvalid),
  );
  assert.deepEqual(
    result.violations.map((value) => value.details),
    [
      { reference: "depends_on", name: "t.md" },
      { reference: "node", name: "a.md" },
      { reference: "node", name: "s.md" },
    ],
  );
});

test("binding resolution answers one violation for each entry and applies the intent rule table", (t) => {
  const { resolve } = fixture(t, []);
  const result = resolve([
    entry("a.md", { bindings: [MISSING_BINDING, "also-missing"] }),
    implement("b.md", { bindings: [] }),
    entry("c.md", { bindings: [REPOSITORY, REPOSITORY] }),
  ]);
  assert.deepEqual(
    result.violations.map((value) => [value.filename, value.code]),
    [
      ["a.md", MissionErrorCode.BindingsInvalid],
      ["b.md", MissionErrorCode.BindingsInvalid],
      ["c.md", MissionErrorCode.BindingsInvalid],
    ],
  );
  assert.deepEqual(
    result.violations.map((value) => value.details),
    [
      { binding: MISSING_BINDING },
      {
        intent: Intent.Implement,
        binding_kind: "repository",
        count: NO_BINDING_COUNT,
      },
      null,
    ],
  );
});

test("import refuses a task file that names a binding with mission.node.bindings_invalid", (t) => {
  const { resolve } = fixture(t, []);
  const result = resolve([
    entry("a.md"),
    implement("o.md"),
    task("t.md", "o.md", { bindings: [REPOSITORY] }),
  ]);
  assert.deepEqual(
    result.violations.map((value) => [value.code, value.details]),
    [[MissionErrorCode.BindingsInvalid, { filename: "t.md" }]],
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

test("direct dependency cycles are rejected", (t) => {
  const { resolve } = fixture(t, []);
  const result = resolve([
    entry("a.md", { depends_on: ["b.md"] }),
    entry("b.md", { depends_on: ["a.md"] }),
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
    .run(NodeState.Completed, entries[FIRST_ENTRY_INDEX]!.id!);
  const result = resolve();
  assert.deepEqual(result.violations, []);
  assert.deepEqual(
    result.no_ops,
    entries
      .filter((value) => !isTaskEntry(value))
      .map((value) => value.id!)
      .sort(),
  );
  assert.deepEqual(
    [result.creates, result.updates, result.retirements, result.removed_edges],
    [[], [], [], []],
  );
  assert.deepEqual(
    result.resolved_entries.find(
      (value) => value.entry.filename === IMPLEMENT_FILENAME,
    )?.binding_ids,
    [BINDING_ID],
  );
});

for (const [label, filename, patch, owners] of [
  ["name", "a.md", { name: "Changed" }, ["a.md"]],
  ["requirement", "a.md", { requirement: "Changed" }, ["a.md"]],
  ["criterion", "a.md", { criterion: "Changed" }, ["a.md"]],
  ["verifications", "a.md", { verifications: ["echo changed"] }, ["a.md"]],
  ["filename", "b.md", { filename: "renamed.md" }, ["b.md"]],
  [
    "intent",
    "a.md",
    { intent: Intent.Implement, bindings: [REPOSITORY] },
    ["a.md"],
  ],
  ["tags", "a.md", { tags: ["platform.macos"] }, ["a.md"]],
  ["commit_type", "a.md", { commit_type: "fix" }, ["a.md"]],
  ["depends_on", "b.md", { depends_on: ["a.md"] }, ["b.md"]],
  ["task content", "t.md", { name: "Changed task" }, ["o.md"]],
  ["task node", "t.md", { node: "p.md" }, ["o.md", "p.md"]],
] satisfies Array<[string, string, EntryPatch, string[]]>) {
  test(`changed ${label} is an update of its content owner`, (t) => {
    const { entries, resolve } = fixture(t, hierarchy());
    const result = resolve(change(entries, filename, patch));
    assert.deepEqual(result.violations, []);
    assert.deepEqual(
      result.updates,
      owners.map((name) => item(entries, name).id).sort(),
    );
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
      binding_id: BINDING_ID,
      resource_identity: "repository:example",
    }),
  });
  assert.deepEqual(same.updates, []);
  const changed = resolve(entries, {
    ...bindings,
    resolveBinding: () => ({
      binding_id: NEXT_BINDING_ID,
      resource_identity: IDENTITIES[NEXT_BINDING_ID]!,
    }),
  });
  assert.deepEqual(
    changed.updates,
    [item(entries, "o.md").id, item(entries, "p.md").id].sort(),
  );
});

const revisedBindings: MissionBindings = {
  ...bindings,
  resolveBinding: (tx, projectId, name) =>
    name === REPOSITORY
      ? {
          binding_id: REVISED_BINDING_ID,
          resource_identity: IDENTITIES[BINDING_ID]!,
        }
      : bindings.resolveBinding(tx, projectId, name),
  getBindingRevision: (tx, bindingId) => {
    if (bindingId !== REVISED_BINDING_ID)
      return bindings.getBindingRevision(tx, bindingId);
    const pinned = bindings.getBindingRevision(tx, BINDING_ID);
    assert.ok(pinned);
    return {
      ...pinned,
      binding_id: REVISED_BINDING_ID,
      revision: VERSION + NEXT_VERSION_INCREMENT,
    };
  },
};

test("a new binding revision under the same name changes no node", (t) => {
  const { store, entries, resolve } = fixture(t, hierarchy());
  store.database
    .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
    .run(NodeState.Completed, item(entries, "o.md").id!);
  const resolved = resolve(
    [...entries, implement("n.md"), task("n-task.md", "n.md")],
    revisedBindings,
  );
  assert.deepEqual(resolved.violations, []);
  assert.deepEqual(resolved.updates, []);
  assert.deepEqual(
    resolved.no_ops,
    entries
      .filter((value) => !isTaskEntry(value))
      .map((value) => value.id!)
      .sort(),
  );
  assert.deepEqual(resolved.creates, ["n-task.md", "n.md"]);
  const bindingIds = (filename: string) =>
    resolved.resolved_entries.find((value) => value.entry.filename === filename)
      ?.binding_ids;
  assert.deepEqual(bindingIds("o.md"), [BINDING_ID]);
  assert.deepEqual(bindingIds("p.md"), [BINDING_ID]);
  assert.deepEqual(bindingIds("n.md"), [REVISED_BINDING_ID]);
  assert.deepEqual(
    store.transaction((tx) => checkImportCondition(tx, resolved)),
    [],
  );
});

test("another binding name updates a nonterminal node and is a no-op for a terminal node", (t) => {
  const { store, entries, resolve } = fixture(t, hierarchy());
  const id = item(entries, "o.md").id!;
  const renamed = change(entries, "o.md", { bindings: [SECOND_REPOSITORY] });
  const pending = resolve(renamed, revisedBindings);
  assert.deepEqual(pending.violations, []);
  assert.deepEqual(pending.updates, [id]);
  store.database
    .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
    .run(NodeState.Completed, id);
  const terminal = resolve(renamed, revisedBindings);
  assert.deepEqual(terminal.violations, []);
  assert.deepEqual(terminal.updates, []);
  assert.ok(terminal.no_ops.includes(id));
  assert.deepEqual(
    store.transaction((tx) => checkImportCondition(tx, terminal)),
    [],
  );
});

for (const state of [NodeState.Pending, NodeState.Completed]) {
  test(`a ${state} node with two bindings and one new revision changes no node`, (t) => {
    const { store, entries, resolve } = fixture(t, [
      implement("o.md", { bindings: [REPOSITORY, SECOND_REPOSITORY] }),
    ]);
    const id = item(entries, "o.md").id!;
    store.database
      .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
      .run(state, id);
    const resolved = resolve(entries, revisedBindings);
    assert.deepEqual(resolved.violations, []);
    assert.deepEqual(resolved.no_ops, [id]);
    assert.deepEqual(
      resolved.resolved_entries[FIRST_ENTRY_INDEX]?.binding_ids,
      [BINDING_ID, NEXT_BINDING_ID],
    );
    assert.deepEqual(
      store.transaction((tx) => checkImportCondition(tx, resolved)),
      [],
    );
  });
}

const removedBindings: MissionBindings = {
  ...revisedBindings,
  getBindingRevision: (tx, bindingId) => {
    const revision = revisedBindings.getBindingRevision(tx, bindingId);
    assert.ok(revision);
    return bindingId === BINDING_ID
      ? { ...revision, tombstone: true }
      : revision;
  },
};

test("a pin from before a removal of its binding resolves to the current revision on a nonterminal node", (t) => {
  const { store, entries, resolve } = fixture(t, hierarchy());
  const completed = item(entries, "o.md").id!;
  const pending = item(entries, "p.md").id!;
  store.database
    .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
    .run(NodeState.Completed, completed);
  const resolved = resolve(entries, removedBindings);
  assert.deepEqual(resolved.violations, []);
  assert.deepEqual(resolved.updates, [pending]);
  assert.ok(resolved.no_ops.includes(completed));
  assert.deepEqual(
    resolved.resolved_entries.find(
      (value) => value.entry.filename === PEER_FILENAME,
    )?.binding_ids,
    [REVISED_BINDING_ID],
  );
  assert.deepEqual(
    resolved.resolved_entries.find(
      (value) => value.entry.filename === IMPLEMENT_FILENAME,
    )?.binding_ids,
    [BINDING_ID],
  );
  assert.deepEqual(
    store.transaction((tx) => checkImportCondition(tx, resolved)),
    [],
  );
});

const RENAMED_BINDING_ID = "binding_00000000000000000000000003";
const RENAMED_REPOSITORY = "repo_renamed";

const renamedBindings: MissionBindings = {
  ...bindings,
  resolveBinding: (tx, projectId, name) => {
    if (name === REPOSITORY) return null;
    return name === RENAMED_REPOSITORY
      ? {
          binding_id: RENAMED_BINDING_ID,
          resource_identity: IDENTITIES[BINDING_ID]!,
        }
      : bindings.resolveBinding(tx, projectId, name);
  },
  getBindingRevision: (tx, bindingId) => {
    if (bindingId !== RENAMED_BINDING_ID)
      return bindings.getBindingRevision(tx, bindingId);
    const pinned = bindings.getBindingRevision(tx, BINDING_ID);
    assert.ok(pinned);
    return { ...pinned, binding_id: bindingId, name: RENAMED_REPOSITORY };
  },
};

const tombstonedBindings: MissionBindings = {
  ...bindings,
  resolveBinding: (tx, projectId, name) =>
    name === REPOSITORY ? null : bindings.resolveBinding(tx, projectId, name),
  getBindingRevision: (tx, bindingId) => {
    const revision = bindings.getBindingRevision(tx, bindingId);
    assert.ok(revision);
    return bindingId === BINDING_ID
      ? { ...revision, tombstone: true }
      : revision;
  },
};

for (const [label, resolver] of [
  ["renamed", renamedBindings],
  ["removed", tombstonedBindings],
] as const) {
  test(`a nonterminal node that names a ${label} binding keeps mission.node.bindings_invalid`, (t) => {
    const { entries, resolve } = fixture(t, hierarchy());
    const resolved = resolve(entries, resolver);
    assert.deepEqual(
      resolved.violations.map(({ code, filename }) => ({ code, filename })),
      [
        {
          code: MissionErrorCode.BindingsInvalid,
          filename: IMPLEMENT_FILENAME,
        },
        { code: MissionErrorCode.BindingsInvalid, filename: PEER_FILENAME },
      ],
    );
  });

  test(`a terminal node that names a ${label} binding is a no-op with its pins`, (t) => {
    const { store, entries, resolve } = fixture(t, hierarchy());
    store.database
      .prepare("UPDATE mission_node SET state = ? WHERE id IN (?, ?)")
      .run(
        NodeState.Completed,
        item(entries, "o.md").id!,
        item(entries, "p.md").id!,
      );
    const resolved = resolve(entries, resolver);
    assert.deepEqual(resolved.violations, []);
    assert.deepEqual(resolved.updates, []);
    assert.deepEqual(
      resolved.resolved_entries
        .filter((value) => !isTaskEntry(value.entry))
        .map((value) => value.binding_ids),
      entries
        .filter((value) => !isTaskEntry(value))
        .map((value) =>
          value.bindings.length === NO_BINDING_COUNT ? [] : [BINDING_ID],
        ),
    );
    assert.deepEqual(
      store.transaction((tx) => checkImportCondition(tx, resolved)),
      [],
    );
  });
}

test("a task names a terminal node by its stored intent", (t) => {
  const { store, entries, resolve } = fixture(t, hierarchy());
  store.database
    .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
    .run(NodeState.Completed, item(entries, "a.md").id!);
  const edited = change(entries, "a.md", {
    intent: Intent.Implement,
    bindings: [REPOSITORY],
  });
  const resolved = resolve([...edited, task("n-task.md", "a.md")]);
  assert.deepEqual(
    resolved.violations.map(({ code, filename }) => ({ code, filename })),
    [{ code: MissionErrorCode.ReferenceKindInvalid, filename: "n-task.md" }],
  );
  const stored = change(entries, "o.md", { intent: Intent.Examine });
  store.database
    .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
    .run(NodeState.Completed, item(entries, "o.md").id!);
  assert.deepEqual(resolve(stored).violations, []);
});

test("a nonterminal node that names its terminal dependent forms a cycle", (t) => {
  const { store, entries, resolve } = fixture(t, [
    entry("n.md"),
    entry("t.md", { depends_on: ["n.md"] }),
  ]);
  store.database
    .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
    .run(NodeState.Discarded, item(entries, "t.md").id!);
  const resolved = resolve(change(entries, "n.md", { depends_on: ["t.md"] }));
  assert.deepEqual(
    resolved.violations.map(({ code }) => code),
    [MissionErrorCode.Cycle],
  );
});

test("a terminal node ignores its own dependency names", (t) => {
  const { store, entries, resolve } = fixture(t, hierarchy());
  const id = item(entries, "b.md").id!;
  store.database
    .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
    .run(NodeState.Completed, id);
  for (const depends_on of [["a.md"], ["missing.md"]]) {
    const resolved = resolve(change(entries, "b.md", { depends_on }));
    assert.deepEqual(resolved.violations, []);
    assert.deepEqual(resolved.updates, []);
    assert.deepEqual(resolved.removed_edges, []);
    assert.ok(resolved.no_ops.includes(id));
  }
});

for (const [label, transform] of [
  [
    "a renamed task file",
    (entries: NormalizedEntry[]) =>
      change(entries, "t.md", { filename: "renamed.md" }),
  ],
  [
    "a task moved to another node",
    (entries: NormalizedEntry[]) => change(entries, "t.md", { node: "p.md" }),
  ],
  [
    "an omitted task",
    (entries: NormalizedEntry[]) =>
      entries.filter((value) => value.filename !== SIBLING_TASK_FILENAME),
  ],
  [
    "a new task",
    (entries: NormalizedEntry[]) => [...entries, task("n-task.md", "o.md")],
  ],
] as const) {
  test(`${label} of a terminal node is a terminal change`, (t) => {
    const { store, entries, resolve } = fixture(t, hierarchy());
    const id = item(entries, "o.md").id!;
    store.database
      .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
      .run(NodeState.Completed, id);
    const resolved = resolve(transform(entries));
    assert.deepEqual(resolved.violations, []);
    assert.deepEqual(
      store
        .transaction((tx) => checkImportCondition(tx, resolved))
        .filter(({ code }) => code === MissionErrorCode.TerminalChange)
        .map(({ node_id }) => node_id),
      [id],
    );
  });
}

test("an edited task file of a terminal node is a no-op", (t) => {
  const { store, entries, resolve } = fixture(t, hierarchy());
  const id = item(entries, "o.md").id!;
  store.database
    .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
    .run(NodeState.Completed, id);
  const resolved = resolve(
    change(entries, "t.md", { name: "Changed task", bindings: [REPOSITORY] }),
  );
  assert.deepEqual(resolved.violations, []);
  assert.deepEqual(resolved.updates, []);
  assert.ok(resolved.no_ops.includes(id));
  assert.deepEqual(
    store.transaction((tx) => checkImportCondition(tx, resolved)),
    [],
  );
});

test("dependency order is ignored while verification order remains content", (t) => {
  const { entries, resolve } = fixture(t, [
    entry("a.md"),
    entry("b.md"),
    entry("c.md", {
      depends_on: ["a.md", "b.md"],
      verifications: ["first", "second"],
    }),
  ]);
  const reordered = change(entries, "c.md", { depends_on: ["b.md", "a.md"] });
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
      .filter((value) => !isTaskEntry(value))
      .map((value) => value.id!)
      .filter((id) => id !== retiredId)
      .sort(),
  );
  assert.deepEqual(result.violations, []);
  assert.ok(!result.current_nodes.has(retiredId));
});

test("same filename without identity creates a new node and retires the old node", (t) => {
  const { entries, resolve } = fixture(t);
  const result = resolve([entry()]);
  assert.deepEqual(result.creates, ["a.md"]);
  assert.deepEqual(result.retirements, [entries[FIRST_ENTRY_INDEX]!.id]);
  assert.deepEqual(result.updates, []);
  assert.equal(
    result.resolved_entries[FIRST_ENTRY_INDEX]?.key,
    TEMPORARY_A_KEY,
  );
  assert.equal(result.resolved_entries[FIRST_ENTRY_INDEX]?.current, null);
});

test("filename replacement does not retire an identity retained under a new filename", (t) => {
  const { entries, resolve } = fixture(t);
  const result = resolve([
    entry(),
    { ...entries[FIRST_ENTRY_INDEX]!, filename: "renamed.md" },
  ]);
  assert.deepEqual(result.creates, ["a.md"]);
  assert.deepEqual(result.updates, [entries[FIRST_ENTRY_INDEX]!.id]);
  assert.deepEqual(result.retirements, []);
});

test("new dependency keys, current rows and resulting dependency sets are exposed without writes", (t) => {
  const { store, entries, resolve } = fixture(t, hierarchy());
  const original = structuredClone(entries);
  const created = entry("new.md");
  const input = [
    ...change(entries, "o.md", { depends_on: ["b.md", created.filename] }),
    created,
  ];
  const before = store.database
    .prepare("SELECT total_changes() AS count")
    .get();
  const result = resolve(input);
  const node = item(entries, "o.md");
  assert.deepEqual(
    result.dependencies.get(node.id!),
    new Set([item(entries, "b.md").id, `file:${created.filename}`]),
  );
  assert.equal(
    result.current_nodes.get(node.id!)?.filename,
    IMPLEMENT_FILENAME,
  );
  assert.deepEqual(
    store.database.prepare("SELECT total_changes() AS count").get(),
    before,
  );
  assert.deepEqual(entries, original);
});

test("removedEdges contains dropped dependency edges in stable order", (t) => {
  const base = change(
    change(hierarchy(), "b.md", { depends_on: ["a.md"] }),
    "o.md",
    { depends_on: ["a.md", "b.md"] },
  );
  const { entries, resolve } = fixture(t, base);
  const a = item(entries, "a.md").id!;
  const b = item(entries, "b.md").id!;
  const o = item(entries, "o.md").id!;
  const result = resolve(
    change(
      change(
        entries.filter((value) => value.filename !== TASK_FILENAME),
        "o.md",
        { depends_on: [] },
      ),
      "b.md",
      { depends_on: [] },
    ),
  );
  assert.deepEqual(
    result.removed_edges,
    [
      { dependent_id: b, depends_on_id: a },
      { dependent_id: o, depends_on_id: a },
      { dependent_id: o, depends_on_id: b },
    ].sort(
      (left, right) =>
        left.dependent_id.localeCompare(right.dependent_id) ||
        left.depends_on_id.localeCompare(right.depends_on_id),
    ),
  );
  assert.deepEqual(result.retirements, []);
  assert.deepEqual(result.updates, [b, o].sort());
});

test("retiring an endpoint removes incoming dependencies, and same-name replacement drops identity edges", (t) => {
  const { entries, resolve } = fixture(t, [
    entry("a.md"),
    entry("b.md", { depends_on: ["a.md"] }),
  ]);
  const result = resolve([entry("a.md"), item(entries, "b.md")]);
  assert.deepEqual(result.updates, [item(entries, "b.md").id]);
  assert.deepEqual(result.removed_edges, [
    {
      dependent_id: item(entries, "b.md").id,
      depends_on_id: item(entries, "a.md").id,
    },
  ]);
});

test("digest is canonical, input-order independent, nonmutating and classification-sensitive", () => {
  const entries = [entry("a_.md"), entry("a.md"), entry("a-.md")];
  const retired = [createIdentity("node"), createIdentity("node")].reverse();
  const updated = [createIdentity("node"), createIdentity("node")].reverse();
  const classification = {
    creates: ["a.md", "a_.md"],
    updates: updated,
    retirements: retired,
  };
  const before = structuredClone({ entries, classification });
  const actual = importDigest(MISSION_ID, VERSION, entries, classification);
  assert.equal(
    actual,
    importDigest(MISSION_ID, VERSION, [...entries].reverse(), {
      creates: [...classification.creates].reverse(),
      updates: [...updated].reverse(),
      retirements: [...retired].reverse(),
    }),
  );
  assert.equal(
    actual,
    digest({
      mission_id: MISSION_ID,
      mission_version: VERSION,
      entries: [...entries].reverse(),
      creates: [...classification.creates].sort(),
      updates: [...updated].sort(),
      retirements: [...retired].sort(),
    }),
  );
  for (const changed of [
    { ...classification, retirements: [] },
    { ...classification, updates: [] },
    { ...classification, creates: [] },
  ])
    assert.notEqual(
      actual,
      importDigest(MISSION_ID, VERSION, entries, changed),
    );
  assert.notEqual(
    actual,
    importDigest(
      MISSION_ID,
      VERSION + NEXT_VERSION_INCREMENT,
      entries,
      classification,
    ),
  );
  assert.notEqual(
    actual,
    importDigest(OTHER_MISSION_ID, VERSION, entries, classification),
  );
  assert.notEqual(
    actual,
    importDigest(
      MISSION_ID,
      VERSION,
      change(entries, "a.md", { name: "Changed" }),
      classification,
    ),
  );
  assert.deepEqual({ entries, classification }, before);
  assert.match(actual, /^[0-9a-f]{64}$/);
});

const CONDITION_CASES: Array<{
  label: string;
  transform: (entries: NormalizedEntry[]) => NormalizedEntry[];
  checked: string[];
}> = [
  {
    label: "updated examine node",
    transform: (entries) => change(entries, "a.md", { name: "Changed" }),
    checked: ["a.md"],
  },
  {
    label: "updated implement node checks itself alone",
    transform: (entries) => change(entries, "o.md", { name: "Changed" }),
    checked: ["o.md"],
  },
  {
    label: "updated task checks its implement node",
    transform: (entries) => change(entries, "t.md", { name: "Changed" }),
    checked: ["o.md"],
  },
  {
    label: "moved task checks both implement nodes",
    transform: (entries) => change(entries, "t.md", { node: "p.md" }),
    checked: ["o.md", "p.md"],
  },
  {
    label:
      "dependency-only changes use live-claim admission instead of the import condition",
    transform: (entries) => change(entries, "b.md", { depends_on: ["a.md"] }),
    checked: [],
  },
  {
    label: "created implement node with a task needs no current-node check",
    transform: (entries) => [
      ...entries,
      implement("new.md"),
      task("new-task.md", "new.md"),
    ],
    checked: [],
  },
  {
    label: "created task checks its current implement node",
    transform: (entries) => [...entries, task("new.md", "o.md")],
    checked: ["o.md"],
  },
  {
    label: "retired task checks its surviving implement node",
    transform: (entries) =>
      entries.filter((value) => value.filename !== TASK_FILENAME),
    checked: ["o.md"],
  },
  {
    label: "retired implement node checks itself alone",
    transform: (entries) =>
      entries.filter(
        (value) => !["o.md", "s.md", "t.md"].includes(value.filename),
      ),
    checked: ["o.md"],
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
      .prepare("UPDATE mission_node SET state = ?")
      .run(NodeState.Executing);
    const resolved = resolve(scenario.transform(entries));
    assert.deepEqual(resolved.violations, []);
    const violations = store.transaction((tx) =>
      checkImportCondition(tx, resolved),
    );
    assert.deepEqual(
      violations.map((value) => value.node_id),
      scenario.checked.map((filename) => item(entries, filename).id!).sort(),
    );
    for (const value of violations) {
      assert.equal(value.code, MissionErrorCode.ConditionFailed);
      assert.deepEqual(value.details, {
        state: NodeState.Executing,
        attempt: NO_ATTEMPT,
      });
    }
  });
}

for (const state of [NodeState.Completed, NodeState.Discarded]) {
  test(`import condition permits ${state} content edits as noOps but rejects a new filename and retirement`, (t) => {
    const { store, entries, resolve } = fixture(t);
    const id = entries[FIRST_ENTRY_INDEX]!.id!;
    store.database
      .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
      .run(state, id);
    for (const input of [
      entries,
      change(entries, "a.md", { name: "Changed", tags: ["platform.macos"] }),
    ]) {
      const resolved = resolve(input);
      assert.deepEqual(resolved.no_ops, [id]);
      assert.deepEqual(
        store.transaction((tx) => checkImportCondition(tx, resolved)),
        [],
      );
    }
    for (const input of [
      change(entries, "a.md", { filename: "renamed.md" }),
      [],
    ]) {
      const resolved = resolve(input);
      const violations = store.transaction((tx) =>
        checkImportCondition(tx, resolved),
      );
      assert.deepEqual(
        violations.map(({ code, node_id, details }) => ({
          code,
          node_id,
          details,
        })),
        [
          {
            code: MissionErrorCode.TerminalChange,
            node_id: id,
            details: { node_id: id },
          },
        ],
      );
    }
  });
}

for (const state of [NodeState.Pending, NodeState.Available]) {
  test(`import condition admits ${state} only at attempt zero`, (t) => {
    const { store, entries, resolve } = fixture(t);
    const id = entries[FIRST_ENTRY_INDEX]!.id!;
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
      .run(FIRST_ATTEMPT, id);
    const invalid = resolve(input);
    const violations = store.transaction((tx) =>
      checkImportCondition(tx, invalid),
    );
    assert.equal(
      violations[FIRST_ENTRY_INDEX]?.code,
      MissionErrorCode.ConditionFailed,
    );
    assert.deepEqual(violations[FIRST_ENTRY_INDEX]?.details, {
      state,
      attempt: FIRST_ATTEMPT,
    });
  });
}

function messagesAfter(
  t: Parameters<typeof fixture>[0],
  state: NodeState,
  attempt: number,
  transform: (entries: NormalizedEntry[]) => NormalizedEntry[],
): string[] {
  const { store, entries, resolve } = fixture(t);
  const id = entries[FIRST_ENTRY_INDEX]!.id!;
  store.database
    .prepare("UPDATE mission_node SET state = ?, attempt = ? WHERE id = ?")
    .run(state, attempt, id);
  const resolved = resolve(transform(entries));
  assert.deepEqual(resolved.violations, []);
  return store
    .transaction((tx) => checkImportCondition(tx, resolved))
    .map(({ message }) => message);
}

test("retiring an executing node names the discard exit", (t) => {
  assert.deepEqual(
    messagesAfter(t, NodeState.Executing, NO_ATTEMPT, () => []),
    [
      "Import cannot retire a node that holds an attempt. Discard the node, then keep its unchanged file in the plan.",
    ],
  );
});

test("retiring a discarded node names the keep-file exit", (t) => {
  assert.deepEqual(
    messagesAfter(t, NodeState.Discarded, FIRST_ATTEMPT, () => []),
    [
      "Import cannot retire a terminal node. Keep its unchanged file in the plan.",
    ],
  );
});

test("a content change of a node at attempt one keeps the condition message", (t) => {
  assert.deepEqual(
    messagesAfter(t, NodeState.Pending, FIRST_ATTEMPT, (entries) =>
      change(entries, "a.md", { name: "Changed" }),
    ),
    ["Node does not satisfy the import condition."],
  );
});

test("a new filename of a terminal node keeps the change message", (t) => {
  assert.deepEqual(
    messagesAfter(t, NodeState.Completed, FIRST_ATTEMPT, (entries) =>
      change(entries, "a.md", { filename: "renamed.md" }),
    ),
    ["Import cannot change a terminal node."],
  );
});

test("prepared import exposes the resolved state without resolving bindings twice", (t) => {
  const { store, mission, entries } = fixture(t, hierarchy());
  let resolutions = INITIAL_RESOLUTION_COUNT;
  const prepared = store.transaction((tx) =>
    prepareImport(
      tx,
      mission,
      snapshot(entries, mission.id),
      mission.id,
      {
        ...bindings,
        resolveBinding: (...args) => {
          resolutions++;
          return bindings.resolveBinding(...args);
        },
      },
      environments,
      TEXT_MAX_BYTES,
    ),
  );
  assert.equal(
    resolutions,
    hierarchy().filter(
      (value) => !isTaskEntry(value) && value.intent === Intent.Implement,
    ).length,
  );
  assert.ok(prepared.resolved);
  assert.deepEqual(prepared.preview.violations, []);
  assert.equal(prepared.preview.no_ops, prepared.resolved.no_ops);
  assert.equal(prepared.resolved.resolved_entries.length, entries.length);
});

function uncovered(
  violations: ReturnType<typeof resolveImportSet>["violations"],
) {
  return violations
    .filter((value) => value.code === MissionErrorCode.VerificationUncovered)
    .map(({ filename, details }) => ({ filename, details }));
}

test("node verifications held by tasks of the implement node pass", (t) => {
  const { resolve } = fixture(t, []);
  const entries = change(
    change(hierarchy(), "o.md", { verifications: ["first", "second"] }),
    "t.md",
    { verifications: ["first", "other"] },
  );
  const result = resolve(
    change(entries, "s.md", { verifications: ["second"] }),
  );
  assert.deepEqual(result.violations, []);
});

test("each uncovered node verification is one located violation", (t) => {
  const { resolve } = fixture(t, []);
  const entries = change(hierarchy(), "o.md", {
    verifications: ["first", "second", "third"],
  });
  const result = resolve(
    change(entries, "t.md", { verifications: ["second"] }),
  );
  assert.deepEqual(uncovered(result.violations), [
    { filename: "o.md", details: { name: "o.md", command: "first" } },
    { filename: "o.md", details: { name: "o.md", command: "third" } },
  ]);
});

test("import accepts an implement node with no task file", (t) => {
  const { resolve } = fixture(t, []);
  const entries = change(
    hierarchy().filter(
      (value) => !isTaskEntry(value) || value.node !== IMPLEMENT_FILENAME,
    ),
    "o.md",
    { verifications: ["first", "second"] },
  );
  assert.deepEqual(resolve(entries).violations, []);
});

test("a verification that differs by whitespace is uncovered", (t) => {
  const { resolve } = fixture(t, []);
  const entries = change(hierarchy(), "o.md", { verifications: ["pnpm test"] });
  const result = resolve(
    change(change(entries, "t.md", { verifications: ["pnpm  test"] }), "s.md", {
      verifications: ["pnpm test "],
    }),
  );
  assert.deepEqual(uncovered(result.violations), [
    { filename: "o.md", details: { name: "o.md", command: "pnpm test" } },
  ]);
});

test("a task of another implement node does not cover a node verification", (t) => {
  const { resolve } = fixture(t, []);
  const entries = change(
    change(hierarchy(), "o.md", { verifications: ["only-p"] }),
    "p.md",
    { verifications: ["only-p"] },
  );
  const result = resolve(
    change(entries, "u.md", { verifications: ["only-p"] }),
  );
  assert.deepEqual(uncovered(result.violations), [
    { filename: "o.md", details: { name: "o.md", command: "only-p" } },
  ]);
});

const TASK_IDENTITY = /^task_[0-9A-HJKMNP-TV-Z]{26}$/;
const workQueue: WorkQueue = {
  insert: () => undefined,
  delete: () => undefined,
  priorityUpdate: () => undefined,
  firstQueuedAt: () => null,
};
const schedulerClaims: SchedulerClaims = {
  revoke: () => null,
  executionRevoked: () => undefined,
  executionsLost: () => undefined,
  settle: () => [],
  liveExecutionOf: () => null,
};
const exportBindings: MissionBindings = {
  ...bindings,
  getBindingRevision: (_tx, bindingId) => ({
    binding_id: bindingId,
    project_id: PROJECT_ID,
    name: REPOSITORY,
    resource_identity: "repository:example",
    revision: VERSION,
    tombstone: false,
    disabled: false,
  }),
};

function plan(): NormalizedEntry[] {
  return [
    entry("a.md", { depends_on: ["o.md", "p.md"] }),
    implement("o.md"),
    implement("p.md", { depends_on: ["o.md"] }),
    task("t.md", "o.md"),
    task("s.md", "o.md"),
  ];
}

function importer(t: TestContext, claims: SchedulerClaims = schedulerClaims) {
  const { store, mission } = fixture(t, []);
  const apply = (
    entries: ImportEntry[],
    ends = executionEnds(),
    resolver = bindings,
  ) =>
    store.transaction((tx) => {
      const current = readMission(tx, mission.id);
      assert.ok(current);
      const body = {
        ...snapshot(entries, mission.id),
        mission_version: current.version,
      };
      const { preview } = prepareImport(
        tx,
        current,
        body,
        mission.id,
        resolver,
        environments,
        TEXT_MAX_BYTES,
      );
      return applyImport(
        tx,
        mission.id,
        {
          ...body,
          preview_digest: preview.preview_digest,
          confirmed_retirements: preview.retirements,
        },
        actor,
        resolver,
        environments,
        workQueue,
        TEXT_MAX_BYTES,
        claims,
        ends,
        () => undefined,
      );
    });
  const assigned = (result: ReturnType<typeof apply>, filename: string) => {
    const found = result.assigned_ids.find(
      (value) => value.filename === filename,
    );
    assert.ok(found);
    return "task_id" in found ? found.task_id : found.node_id;
  };
  const identified = (result: ReturnType<typeof apply>) =>
    plan().map((value) => ({ ...value, id: assigned(result, value.filename) }));
  return { store, mission, apply, assigned, identified };
}

test("import mints task identities", (t) => {
  const { store, apply, assigned } = importer(t);
  const result = apply(plan());
  const implementId = assigned(result, "o.md");
  assert.match(assigned(result, "t.md"), TASK_IDENTITY);
  assert.match(assigned(result, "s.md"), TASK_IDENTITY);
  assert.deepEqual(
    result.assigned_ids.find((value) => value.filename === TASK_FILENAME),
    { filename: TASK_FILENAME, task_id: assigned(result, TASK_FILENAME) },
  );
  const revision = result.changes.revisions.find(
    (value) => value.node_id === implementId,
  );
  assert.ok(revision);
  assert.deepEqual(
    revision.tasks.map((value) => value.id),
    [assigned(result, "t.md"), assigned(result, "s.md")],
  );
  assert.deepEqual(
    revision.change.tasks?.map((value) => value.change),
    [TaskChange.Created, TaskChange.Created],
  );
  assert.equal(
    store.transaction((tx) => readNode(tx, assigned(result, "t.md"))),
    null,
  );
  assert.ok(
    result.changes.added_edges.every(
      (value) =>
        value.dependent_id !== assigned(result, "t.md") &&
        value.depends_on_id !== assigned(result, "t.md"),
    ),
  );
});

test("import refuses a node prefix on a task file", () => {
  const taskEntry = task("t.md", "o.md", { id: createIdentity("node") });
  const node = entry("a.md", { id: createIdentity("task") });
  const markdownTask = `---
id: ${createIdentity("node")}
node: o.md
bindings: []
verifications: [true-command]
---
# Task
## Requirement
Requirement
## Criterion
Criterion
`;
  const json = normalize([taskEntry, node]);
  const markdown = normalizeImportSnapshot(
    {
      format: ImportFormat.Markdown,
      mission_id: MISSION_ID,
      mission_version: VERSION,
      reason: REASON,
      files: [{ filename: "t.md", content: markdownTask }],
    },
    MISSION_ID,
    TEXT_MAX_BYTES,
  );
  for (const [result, filenames] of [
    [json, ["t.md", "a.md"]],
    [markdown, ["t.md"]],
  ] as const)
    assert.deepEqual(
      result.violations.map(({ code, filename, details }) => ({
        code,
        filename,
        details,
      })),
      filenames.map((filename) => ({
        code: MissionErrorCode.PlanInvalid,
        filename,
        details: { filename, reason: "id_prefix_invalid" },
      })),
    );
});

test("an import that adds a dependency to a node settles its expired execution and collects the end", (t) => {
  const executionId = createIdentity("execution");
  const { apply, assigned, identified } = importer(t, {
    ...schedulerClaims,
    settle: (_tx, nodeId, now) => [
      {
        execution_id: executionId,
        trace: {
          execution_id: executionId,
          project_id: createIdentity("project"),
          node_id: nodeId,
          attempt: 1,
          trace_id: "a".repeat(32),
          root_span_id: "b".repeat(16),
        },
        ended_at: now,
        transition: lostTransition(),
        hold: lostHold(),
      },
    ],
  });
  const first = apply(plan());
  const ends = executionEnds();
  const added = apply(
    [
      ...change(identified(first), ROOT_FILENAME, {
        depends_on: ["o.md", PEER_FILENAME, "q.md"],
      }),
      entry("q.md"),
    ],
    ends,
  );
  assert.ok(assigned(added, "q.md"));
  assert.deepEqual(
    ends.lost.map((lost) => [lost.execution_id, lost.trace.node_id]),
    [[executionId, assigned(first, ROOT_FILENAME)]],
  );
  assert.deepEqual(ends.revoked, []);
});

test("import refuses a removed task identity with mission.import.retired_id", (t) => {
  const { mission, store, apply, identified } = importer(t);
  const entries = identified(apply(plan()));
  apply(entries.filter((value) => value.filename !== TASK_FILENAME));
  const removed = item(entries, TASK_FILENAME);
  const unknown = { ...removed, filename: "u.md", id: createIdentity("task") };
  const result = store.transaction((tx) =>
    resolveImportSet(
      tx,
      readMission(tx, mission.id)!,
      [...entries, unknown],
      bindings,
      environments,
    ),
  );
  assert.deepEqual(
    result.violations.map(({ code, details }) => ({ code, details })),
    [
      { code: MissionErrorCode.RetiredId, details: { id: removed.id } },
      { code: MissionErrorCode.UnknownId, details: { id: unknown.id } },
    ],
  );
});

test("an import that retires a node keeps its tasks in the last revision", (t) => {
  const { mission, store, apply, assigned, identified } = importer(t);
  const first = apply(plan());
  const retiredId = assigned(first, "o.md");
  const taskFilenames = [TASK_FILENAME, SIBLING_TASK_FILENAME];
  const taskIds = taskFilenames.map((filename) => assigned(first, filename));
  const lastRevision = () =>
    store.transaction((tx) => {
      const row = readCurrentRevision(tx, retiredId);
      assert.ok(row);
      return revisionFromRow(tx, row);
    });
  const before = lastRevision();
  const survivors = identified(first)
    .filter(
      (value) =>
        value.filename !== IMPLEMENT_FILENAME &&
        !taskFilenames.includes(value.filename),
    )
    .map((value) =>
      value.filename === ROOT_FILENAME
        ? { ...value, depends_on: [PEER_FILENAME] }
        : value.filename === PEER_FILENAME
          ? { ...value, depends_on: [] }
          : value,
    );
  const retired = apply(survivors);
  assert.deepEqual(retired.changes.retired_node_ids, [retiredId]);
  assert.ok(
    retired.changes.revisions.every((value) => value.node_id !== retiredId),
  );
  assert.ok(
    retired.changes.revisions.every((value) =>
      value.change.tasks?.every((change) => !taskIds.includes(change.id)),
    ),
  );
  const after = lastRevision();
  assert.equal(after.revision, before.revision);
  assert.deepEqual(
    after.tasks.map((value) => value.id),
    taskIds,
  );
  assert.ok(store.transaction((tx) => readNode(tx, retiredId))?.retired_at);
  const named = taskFilenames.map((filename, index) => ({
    ...item(plan(), filename),
    node: PEER_FILENAME,
    id: taskIds[index]!,
  }));
  const result = store.transaction((tx) =>
    resolveImportSet(
      tx,
      readMission(tx, mission.id)!,
      [...survivors, ...named],
      bindings,
      environments,
    ),
  );
  assert.deepEqual(
    result.violations.map(({ code, details }) => ({ code, details })),
    taskIds.map((id) => ({
      code: MissionErrorCode.RetiredId,
      details: { id },
    })),
  );
});

test("export and import both formats unchanged", (t) => {
  const { mission, store, apply } = importer(t);
  const first = apply(change(plan(), "o.md", { tags: ["platform.macos"] }));
  for (const format of [ImportFormat.Json, ImportFormat.Markdown]) {
    const exported = store.transaction((tx) =>
      exportMission(tx, mission.id, format, exportBindings),
    );
    if ("files" in exported)
      for (const file of exported.files) {
        const isTask = ["t.md", "s.md"].includes(file.filename);
        assert.equal(/^node: /m.test(file.content), isTask, file.filename);
        assert.equal(/^intent: /m.test(file.content), !isTask, file.filename);
        assert.equal(/^tags:/m.test(file.content), !isTask, file.filename);
        assert.equal(
          /^depends_on:/m.test(file.content),
          !isTask,
          file.filename,
        );
      }
    else
      assert.deepEqual(
        exported.entries.map((value) =>
          "node" in value
            ? [value.filename, value.node]
            : [value.filename, value.intent, value.tags, value.depends_on],
        ),
        [
          ["a.md", Intent.Examine, [], ["o.md", "p.md"]],
          ["o.md", Intent.Implement, ["platform.macos"], []],
          ["p.md", Intent.Implement, [], ["o.md"]],
          ["s.md", "o.md"],
          ["t.md", "o.md"],
        ],
      );
    const entries =
      "entries" in exported
        ? exported.entries
        : exported.files.map((file) =>
            parsePlanFile(file.filename, file.content),
          );
    const again = apply(entries);
    assert.deepEqual(again.assigned_ids, first.assigned_ids);
    assert.deepEqual(again.changes.revisions, []);
    assert.equal(again.mission_version, first.mission_version);
  }
});

test("a re-import matches a node by the id of its plan file, never by its file name", (t) => {
  const editedFile = "p.md";
  const { mission, store, apply, assigned } = importer(t);
  const first = apply(plan());
  const exported = store.transaction((tx) =>
    exportMission(tx, mission.id, ImportFormat.Markdown, exportBindings),
  );
  assert.ok("files" in exported);
  const edited = exported.files.map((file) =>
    file.filename === editedFile
      ? { ...file, content: file.content.replace('- "true"', '- "false"') }
      : file,
  );
  assert.notDeepEqual(edited, exported.files);
  const preview = (files: typeof edited) =>
    store.transaction((tx) => {
      const current = readMission(tx, mission.id);
      assert.ok(current);
      return prepareImport(
        tx,
        current,
        {
          format: ImportFormat.Markdown,
          mission_id: mission.id,
          mission_version: current.version,
          reason: REASON,
          files,
        },
        mission.id,
        bindings,
        environments,
        TEXT_MAX_BYTES,
      ).preview;
    });
  const kept = preview(edited);
  assert.deepEqual(kept.violations, []);
  assert.deepEqual(kept.updates, [assigned(first, editedFile)]);
  assert.deepEqual(kept.retirements, []);
  assert.deepEqual(kept.creates, []);
  const replacing = preview(
    edited.map((file) => ({
      ...file,
      content: file.content.replace(/^id: .*\n/m, ""),
    })),
  );
  assert.deepEqual(replacing.creates, ["a.md", "o.md", "p.md", "s.md", "t.md"]);
  assert.deepEqual(
    replacing.retirements,
    ["a.md", "o.md", "p.md"].map((name) => assigned(first, name)).sort(),
  );
});

test("an import that moves a task revises both owners with moved-out and moved-in", (t) => {
  const { apply, assigned, identified } = importer(t);
  const first = apply(plan());
  const task = assigned(first, TASK_FILENAME);
  const moved = apply(
    change(identified(first), TASK_FILENAME, { node: "p.md" }),
  );
  assert.deepEqual(
    moved.changes.revisions.map((value) => ({
      node_id: value.node_id,
      write: value.change.write,
      tasks: value.change.tasks,
      ids: value.tasks.map((item) => item.id),
    })),
    [
      {
        node_id: assigned(first, "o.md"),
        write: RevisionWrite.Import,
        tasks: [{ id: task, change: TaskChange.MovedOut, changed_fields: [] }],
        ids: [assigned(first, "s.md")],
      },
      {
        node_id: assigned(first, "p.md"),
        write: RevisionWrite.Import,
        tasks: [
          {
            id: task,
            change: TaskChange.MovedIn,
            changed_fields: [
              "filename",
              "name",
              "requirement",
              "criterion",
              "verifications",
              "bindings",
            ],
          },
        ],
        ids: [task],
      },
    ].sort((left, right) => left.node_id.localeCompare(right.node_id)),
  );
  assert.deepEqual(moved.changes.retired_node_ids, []);
});

test("a no-op import of a terminal node returns no error", (t) => {
  const { store, apply, assigned, identified } = importer(t);
  const first = apply(plan());
  store.database
    .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
    .run(NodeState.Completed, assigned(first, "o.md"));
  const again = apply(identified(first));
  assert.deepEqual(again.changes.revisions, []);
  assert.equal(again.mission_version, first.mission_version);
});

test("an export with a new binding revision and one new plan file creates only the new node", (t) => {
  const { mission, store, apply, assigned } = importer(t);
  const first = apply(plan());
  const completed = assigned(first, "o.md");
  store.database
    .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
    .run(NodeState.Completed, completed);
  const exported = store.transaction((tx) =>
    exportMission(tx, mission.id, ImportFormat.Json, bindings),
  );
  assert.ok("entries" in exported);
  const again = apply(
    [...exported.entries, implement("n.md"), task("n-task.md", "n.md")],
    executionEnds(),
    revisedBindings,
  );
  const added = assigned(again, "n.md");
  assert.deepEqual(
    again.changes.revisions.map((value) => value.node_id),
    [added],
  );
  const pins = (nodeId: string) =>
    store.transaction((tx) => {
      const row = readCurrentRevision(tx, nodeId);
      assert.ok(row);
      return revisionFromRow(tx, row).content.bindings;
    });
  assert.deepEqual(pins(completed), [BINDING_ID]);
  assert.deepEqual(pins(assigned(first, "p.md")), [BINDING_ID]);
  assert.deepEqual(pins(added), [REVISED_BINDING_ID]);
});

for (const [label, resolver, binding] of [
  ["renamed", renamedBindings, RENAMED_REPOSITORY],
  ["removed", tombstonedBindings, SECOND_REPOSITORY],
] as const) {
  test(`an export after the binding of finished nodes is ${label} imports one new plan file`, (t) => {
    const { mission, store, apply, assigned } = importer(t);
    const first = apply(plan());
    const finished = [assigned(first, "o.md"), assigned(first, "p.md")];
    store.database
      .prepare("UPDATE mission_node SET state = ? WHERE id IN (?, ?)")
      .run(NodeState.Completed, ...finished);
    const exported = store.transaction((tx) =>
      exportMission(tx, mission.id, ImportFormat.Json, resolver),
    );
    assert.ok("entries" in exported);
    const again = apply(
      [
        ...exported.entries,
        implement("n.md", { bindings: [binding], depends_on: ["o.md"] }),
      ],
      executionEnds(),
      resolver,
    );
    const added = assigned(again, "n.md");
    assert.deepEqual(
      again.changes.revisions.map((value) => value.node_id),
      [added],
    );
    assert.deepEqual(again.changes.added_edges, [
      { dependent_id: added, depends_on_id: finished[FIRST_ENTRY_INDEX]! },
    ]);
    for (const id of finished)
      assert.deepEqual(
        store.transaction((tx) => {
          const row = readCurrentRevision(tx, id);
          assert.ok(row);
          return revisionFromRow(tx, row).content.bindings;
        }),
        [BINDING_ID],
      );
  });
}

test("an import ignores an edited plan file of a terminal node and writes it no revision", (t) => {
  const { store, apply, assigned, identified } = importer(t);
  const first = apply(plan());
  const completed = assigned(first, "o.md");
  store.database
    .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
    .run(NodeState.Completed, completed);
  const before = store.transaction((tx) => readCurrentRevision(tx, completed));
  const edited = change(
    change(identified(first), "o.md", {
      name: "Changed",
      requirement: "Changed",
      tags: ["platform.macos"],
      commit_type: CommitType.Fix,
    }),
    "t.md",
    { name: "Changed task" },
  );
  const again = apply([...edited, entry("n.md")]);
  const added = assigned(again, "n.md");
  assert.deepEqual(
    again.changes.revisions.map((value) => value.node_id),
    [added],
  );
  assert.deepEqual(
    store.transaction((tx) => readCurrentRevision(tx, completed)),
    before,
  );
});

test("an import that retires the dependency of a terminal node keeps that edge", (t) => {
  const { store, apply, assigned, identified } = importer(t);
  const first = apply(plan());
  const retired = assigned(first, "o.md");
  const completed = assigned(first, "p.md");
  const examine = assigned(first, "a.md");
  store.database
    .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
    .run(NodeState.Completed, completed);
  const again = apply(
    change(
      identified(first).filter(
        (value) => !["o.md", "t.md", "s.md"].includes(value.filename),
      ),
      "a.md",
      { depends_on: ["p.md"] },
    ),
  );
  assert.deepEqual(again.changes.retired_node_ids, [retired]);
  assert.deepEqual(again.changes.removed_edges, [
    { dependent_id: examine, depends_on_id: retired },
  ]);
  assert.deepEqual(again.changes.revisions, []);
  assert.deepEqual(
    store.database
      .prepare(
        "SELECT depends_on_id FROM mission_dependency WHERE dependent_id = ?",
      )
      .all(completed)
      .map((row) => ({ ...row })),
    [{ depends_on_id: retired }],
  );
});

test("a content change of a node with an older pin keeps the pin", (t) => {
  const { store, apply, assigned, identified } = importer(t);
  const first = apply(plan());
  const edited = assigned(first, "p.md");
  const changedName = "Changed";
  const again = apply(
    change(identified(first), "p.md", { name: changedName }),
    executionEnds(),
    revisedBindings,
  );
  assert.deepEqual(
    again.changes.revisions.map((value) => value.node_id),
    [edited],
  );
  const row = store.transaction((tx) => readCurrentRevision(tx, edited));
  assert.ok(row);
  const revision = store.transaction((tx) => revisionFromRow(tx, row));
  assert.equal(revision.content.name, changedName);
  assert.deepEqual(revision.content.bindings, [BINDING_ID]);
});

function markdownFile(
  filename: string,
  front: string,
): {
  filename: string;
  content: string;
} {
  return {
    filename,
    content: `---\n${front}\n---\n# ${filename}\n## Requirement\nRequirement\n## Criterion\nCriterion\n`,
  };
}

function checkSet() {
  return [
    markdownFile(
      "todo-api.md",
      "intent: examine\ndepends_on: [foundation.md, contributing.md]\nbindings: [repo]\nverifications: [npm run verify]",
    ),
    markdownFile(
      "foundation.md",
      "intent: implement\nbindings: [repo]\nverifications: [npm run test:foundation, npm run lint]",
    ),
    markdownFile(
      "foundation-runtime.md",
      "node: foundation.md\nbindings: []\nverifications: [npm run test:foundation, npm run lint]",
    ),
    markdownFile(
      "contributing.md",
      "intent: implement\ndepends_on: [foundation.md]\nbindings: [repo]\nverifications: [npm run lint]",
    ),
  ];
}

function checkPreview(
  t: TestContext,
  files: ReturnType<typeof checkSet>,
): ImportPreviewResult {
  const { store, mission } = fixture(t, []);
  return store.transaction((tx) => {
    const before = readMission(tx, mission.id);
    const { preview, resolved } = prepareImport(
      tx,
      mission,
      {
        format: ImportFormat.Markdown,
        mission_id: mission.id,
        mission_version: mission.version,
        reason: REASON,
        files,
      },
      mission.id,
      bindings,
      environments,
      TEXT_MAX_BYTES,
    );
    assert.deepEqual(readMission(tx, mission.id), before);
    return {
      violations: preview.violations.map(({ code, filename, details }) => ({
        code,
        filename,
        details,
      })),
      creates: resolved?.creates ?? [],
    };
  });
}

type ImportPreviewResult = {
  violations: { code: string; filename: string | null; details: unknown }[];
  creates: string[];
};

function replaced(
  filename: string,
  from: string,
  to: string,
): ReturnType<typeof checkSet> {
  return checkSet().map((file) =>
    file.filename === filename
      ? { ...file, content: file.content.replace(from, to) }
      : file,
  );
}

test("kanthord check: the baseline check set previews with no violation", (t) => {
  assert.deepEqual(checkPreview(t, checkSet()), {
    violations: [],
    creates: [
      "contributing.md",
      "foundation-runtime.md",
      "foundation.md",
      "todo-api.md",
    ],
  });
});

test("kanthord check: an unknown front-matter field or H2 names the file", (t) => {
  for (const files of [
    replaced(
      "foundation.md",
      "intent: implement",
      "intent: implement\nowner: me",
    ),
    replaced("foundation.md", "## Criterion", "## Notes\nnone\n## Criterion"),
  ])
    assert.deepEqual(
      checkPreview(t, files).violations.map(({ code, filename }) => ({
        code,
        filename,
      })),
      [{ code: MissionErrorCode.PlanInvalid, filename: "foundation.md" }],
    );
});

test("kanthord check: a dependency on missing.md is an unresolved reference", (t) => {
  assert.deepEqual(
    checkPreview(t, replaced("todo-api.md", "contributing.md", "missing.md"))
      .violations,
    [
      {
        code: MissionErrorCode.UnresolvedReference,
        filename: "todo-api.md",
        details: { reference: "depends_on", name: "missing.md" },
      },
    ],
  );
});

test("kanthord check: two entries with the same filename are a duplicate file", (t) => {
  const files = [...checkSet(), checkSet()[1]!];
  assert.deepEqual(
    checkPreview(t, files).violations.map(({ code, filename }) => ({
      code,
      filename,
    })),
    [{ code: MissionErrorCode.DuplicateFile, filename: "foundation.md" }],
  );
});

test("kanthord check: a task file with depends_on, tags or intent names the file", (t) => {
  for (const [key, reason] of [
    ["depends_on: []", "depends_on_forbidden"],
    ["tags: []", "tags_forbidden"],
    ["intent: implement", "form_invalid"],
  ])
    assert.deepEqual(
      checkPreview(
        t,
        replaced(
          "foundation-runtime.md",
          "bindings: []",
          `${key}\nbindings: []`,
        ),
      ).violations,
      [
        {
          code: MissionErrorCode.PlanInvalid,
          filename: "foundation-runtime.md",
          details: { filename: "foundation-runtime.md", reason },
        },
      ],
    );
});

test("kanthord check: a task on an examine node is a reference kind violation", (t) => {
  assert.deepEqual(
    checkPreview(
      t,
      replaced(
        "foundation-runtime.md",
        "node: foundation.md",
        "node: todo-api.md",
      ),
    ).violations,
    [
      {
        code: MissionErrorCode.ReferenceKindInvalid,
        filename: "foundation-runtime.md",
        details: { reference: "node", name: "todo-api.md" },
      },
    ],
  );
});

test("kanthord check: an implement node with no repository binding is refused", (t) => {
  assert.deepEqual(
    checkPreview(
      t,
      replaced("contributing.md", "bindings: [repo]", "bindings: []"),
    ).violations,
    [
      {
        code: MissionErrorCode.BindingsInvalid,
        filename: "contributing.md",
        details: {
          intent: Intent.Implement,
          binding_kind: "repository",
          count: NO_BINDING_COUNT,
        },
      },
    ],
  );
});

test("kanthord check: a node verification that no task holds is uncovered", (t) => {
  assert.deepEqual(
    checkPreview(
      t,
      replaced(
        "foundation-runtime.md",
        "verifications: [npm run test:foundation, npm run lint]",
        "verifications: [npm run test:foundation]",
      ),
    ).violations,
    [
      {
        code: MissionErrorCode.VerificationUncovered,
        filename: "foundation.md",
        details: { name: "foundation.md", command: "npm run lint" },
      },
    ],
  );
});

test("kanthord check: an implement node with no task holds an empty task list", (t) => {
  const { apply, assigned } = importer(t);
  const result = apply([implement("contributing.md")]);
  const revision = result.changes.revisions.find(
    (value) => value.node_id === assigned(result, "contributing.md"),
  );
  assert.ok(revision);
  assert.deepEqual(revision.tasks, []);
  assert.equal(revision.content.intent, Intent.Implement);
});

const LINUX = "platform.linux";

test("preview reports the unmatched pairs and leaves the mission version unchanged", async (t) => {
  const reads: string[] = [];
  const h = missionHarness(t, testHumanIdentity("test", "Test", "token"), {
    bindings,
    schedulerMatch: {
      unmatchedClaims: (tx, projectId) => {
        reads.push(projectId);
        return h.service
          .claimFactsOf(tx, projectId)
          .filter((row) => row.tags.includes(LINUX))
          .flatMap((row) =>
            row.claims.map((claim) => ({
              node_id: row.node_id,
              revision: row.revision,
              claim,
            })),
          );
      },
    },
  });
  h.store.transaction((tx) => h.service.createMission(tx, PROJECT_ID, actor));
  const mission = await h.invoke("get", {
    params: { project_id: PROJECT_ID },
    query: {},
    body: null,
  });
  const [seeded] = h.store.transaction((tx) =>
    seed(tx, mission, [entry("a.md")]),
  );
  assert.ok(seeded?.id);
  const rows = () => databaseSnapshot(h.store);
  const before = rows();
  const preview = (entries: ImportEntry[]) =>
    h.invoke("import.preview", {
      params: { mission_id: mission.id },
      query: {},
      body: snapshot(entries, mission.id),
    });
  const unmatched = await preview([
    { ...entry("a.md", { tags: [LINUX] }), id: seeded.id },
    entry("b.md", { tags: [LINUX] }),
    entry("c.md"),
  ]);
  assert.deepEqual(unmatched.violations, [
    {
      code: MissionErrorCode.TagsUnmatched,
      message:
        "The node write adds a node and claimable state pair that no worker binding covers.",
      filename: "a.md",
      node_id: seeded.id,
      details: {
        claims: [
          {
            node_id: seeded.id,
            revision: VERSION + NEXT_VERSION_INCREMENT,
            claim: ClaimableState.Available,
          },
          {
            node_id: seeded.id,
            revision: VERSION + NEXT_VERSION_INCREMENT,
            claim: ClaimableState.Waiting,
          },
        ],
      },
    },
    {
      code: MissionErrorCode.TagsUnmatched,
      message:
        "The node write adds a node and claimable state pair that no worker binding covers.",
      filename: "b.md",
      node_id: null,
      details: {
        claims: [
          { node_id: null, revision: VERSION, claim: ClaimableState.Available },
          { node_id: null, revision: VERSION, claim: ClaimableState.Waiting },
        ],
      },
    },
  ]);
  assert.equal(unmatched.creates.length, ["b.md", "c.md"].length);
  assert.deepEqual(rows(), before);
  assert.equal(reads.length, ["before", "after"].length);
  const covered = await preview([
    { ...entry("a.md"), id: seeded.id },
    entry("c.md"),
  ]);
  assert.deepEqual(covered.violations, []);
  assert.deepEqual(rows(), before);
});

function mixedSet() {
  return [
    markdownFile(
      "first.md",
      `intent: implement\nbindings: [${REPOSITORY}, ${SECOND_REPOSITORY}]\nverifications: [npm run lint]`,
    ),
    markdownFile(
      "second.md",
      `intent: implement\nbindings: [${SECOND_REPOSITORY}, ${REPOSITORY}]\nverifications: [npm run lint]`,
    ),
  ];
}

function mixedPreview(t: TestContext, files: ReturnType<typeof mixedSet>) {
  const { store, mission } = fixture(t, []);
  return store.transaction((tx) =>
    prepareImport(
      tx,
      mission,
      {
        format: ImportFormat.Markdown,
        mission_id: mission.id,
        mission_version: mission.version,
        reason: REASON,
        files,
      },
      mission.id,
      bindings,
      environments,
      TEXT_MAX_BYTES,
    ).preview.violations.map(({ code, filename, details }) => ({
      code,
      filename,
      details,
    })),
  );
}

test("import preview lists the environment mix of a node file", (t) => {
  mixedAnswer = true;
  stopAfter(t, () => {
    mixedAnswer = false;
  });
  assert.deepEqual(mixedPreview(t, mixedSet().slice(0, 1)), [
    {
      code: MissionErrorCode.EnvironmentMixed,
      filename: "first.md",
      details: { bindings: [BINDING_ID, NEXT_BINDING_ID] },
    },
  ]);
});

test("import preview lists one environment mix violation for each node file", (t) => {
  mixedAnswer = true;
  stopAfter(t, () => {
    mixedAnswer = false;
  });
  assert.deepEqual(mixedPreview(t, mixedSet()), [
    {
      code: MissionErrorCode.EnvironmentMixed,
      filename: "first.md",
      details: { bindings: [BINDING_ID, NEXT_BINDING_ID] },
    },
    {
      code: MissionErrorCode.EnvironmentMixed,
      filename: "second.md",
      details: { bindings: [NEXT_BINDING_ID, BINDING_ID] },
    },
  ]);
});

test("import apply refuses the environment mix and writes no node", (t) => {
  mixedAnswer = true;
  stopAfter(t, () => {
    mixedAnswer = false;
  });
  const { store, mission } = fixture(t, []);
  const body = {
    format: ImportFormat.Markdown,
    mission_id: mission.id,
    mission_version: mission.version,
    reason: REASON,
    files: mixedSet().slice(0, 1),
  } as const;
  assert.throws(
    () =>
      store.transaction((tx) =>
        applyImport(
          tx,
          mission.id,
          { ...body, preview_digest: "none", confirmed_retirements: [] },
          actor,
          bindings,
          environments,
          workQueue,
          TEXT_MAX_BYTES,
          schedulerClaims,
          executionEnds(),
          () => undefined,
        ),
      ),
    (error) =>
      error instanceof OperationError &&
      error.status === HttpStatus.BadRequest &&
      error.code === MissionErrorCode.EnvironmentMixed,
  );
  assert.deepEqual(
    store.transaction((tx) => readMissionNodes(tx, mission.id)),
    [],
  );
});

test("import with equal stored environments lists no violation and applies", (t) => {
  const files = mixedSet().slice(0, 1);
  assert.deepEqual(mixedPreview(t, files), []);
  const { store, mission } = fixture(t, []);
  const body = {
    format: ImportFormat.Markdown,
    mission_id: mission.id,
    mission_version: mission.version,
    reason: REASON,
    files,
  } as const;
  const result = store.transaction((tx) => {
    const { preview } = prepareImport(
      tx,
      mission,
      body,
      mission.id,
      bindings,
      environments,
      TEXT_MAX_BYTES,
    );
    return applyImport(
      tx,
      mission.id,
      {
        ...body,
        preview_digest: preview.preview_digest,
        confirmed_retirements: preview.retirements,
      },
      actor,
      bindings,
      environments,
      workQueue,
      TEXT_MAX_BYTES,
      schedulerClaims,
      executionEnds(),
      () => undefined,
    );
  });
  assert.equal(result.assigned_ids.length, SINGLE_ENTRY);
});
